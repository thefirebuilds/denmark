const pool = require("../../db");

const DENMARK_SUMMARY_PREFIXES = [
  "Turo unconfirmed:",
  "Turo pickup:",
  "Turo return:",
  "Turo closeout:",
  "Maintenance:",
];

function isDenmarkEvent(event) {
  const privateProps = event?.extendedProperties?.private || {};
  if (privateProps.denmarkTripEventKey || privateProps.denmarkMaintenanceKey) {
    return true;
  }

  return String(event?.id || "").startsWith("denmark");
}

function getEventTimeKey(event, side) {
  const value = event?.[side];
  return value?.dateTime || value?.date || "";
}

function getDedupeKey(event) {
  const privateProps = event?.extendedProperties?.private || {};
  if (privateProps.denmarkTripEventKey) {
    return `trip:${privateProps.denmarkTripEventKey}`;
  }
  if (privateProps.denmarkMaintenanceKey) {
    return [
      "maintenance",
      String(event?.summary || "").trim().toLowerCase(),
      getEventTimeKey(event, "start"),
      getEventTimeKey(event, "end"),
    ].join("|");
  }

  return [
    "fallback",
    String(event?.summary || "").trim().toLowerCase(),
    getEventTimeKey(event, "start"),
    getEventTimeKey(event, "end"),
  ].join("|");
}

function getEventUpdatedMs(event) {
  const ms = event?.updated ? new Date(event.updated).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function chooseEventToKeep(events) {
  return [...events].sort((a, b) => {
    const aDeterministic = String(a.id || "").startsWith("denmark") ? 1 : 0;
    const bDeterministic = String(b.id || "").startsWith("denmark") ? 1 : 0;
    if (aDeterministic !== bDeterministic) return bDeterministic - aDeterministic;

    return getEventUpdatedMs(b) - getEventUpdatedMs(a);
  })[0];
}

function serializeEvent(event) {
  return {
    id: event.id,
    summary: event.summary || "",
    start: getEventTimeKey(event, "start"),
    end: getEventTimeKey(event, "end"),
    updated: event.updated || null,
    htmlLink: event.htmlLink || null,
  };
}

async function listCalendarEvents(calendar, calendarId, { pastDays = 365, futureDays = 365 } = {}) {
  const now = Date.now();
  const timeMin = new Date(now - pastDays * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now + futureDays * 24 * 60 * 60 * 1000).toISOString();
  const events = [];
  let pageToken = null;

  do {
    const response = await calendar.events.list({
      calendarId,
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      orderBy: "startTime",
      timeMin,
      timeMax,
      pageToken,
    });

    events.push(...(response.data.items || []));
    pageToken = response.data.nextPageToken || null;
  } while (pageToken);

  return events;
}

function findDuplicateGroups(events) {
  const groups = new Map();

  for (const event of events) {
    if (!isDenmarkEvent(event)) continue;

    const key = getDedupeKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  return [...groups.entries()]
    .map(([key, groupEvents]) => {
      if (groupEvents.length < 2) return null;

      const keep = chooseEventToKeep(groupEvents);
      const remove = groupEvents.filter((event) => event.id !== keep.id);

      return {
        key,
        summary: keep.summary || remove[0]?.summary || "Denmark event",
        start: getEventTimeKey(keep, "start"),
        keep: serializeEvent(keep),
        remove: remove.map(serializeEvent),
      };
    })
    .filter(Boolean);
}

async function markDeletedSyncRows(eventIds) {
  if (!eventIds.length) return;

  const { rows } = await pool.query(
    `
      SELECT
        to_regclass('public.trip_google_sync') IS NOT NULL AS has_trip_sync,
        to_regclass('public.maintenance_google_sync') IS NOT NULL AS has_maintenance_sync
    `
  );

  if (rows[0]?.has_trip_sync) {
    await pool.query(
      `
        UPDATE public.trip_google_sync
        SET sync_status = 'deleted',
            updated_at = NOW()
        WHERE google_event_id = ANY($1::text[])
      `,
      [eventIds]
    );
  }

  if (rows[0]?.has_maintenance_sync) {
    await pool.query(
      `
        UPDATE public.maintenance_google_sync
        SET sync_status = 'deleted',
            updated_at = NOW()
        WHERE google_event_id = ANY($1::text[])
      `,
      [eventIds]
    );
  }
}

async function previewGoogleCalendarDuplicateCleanup(calendar, calendarId, options = {}) {
  const events = await listCalendarEvents(calendar, calendarId, options);
  const duplicateGroups = findDuplicateGroups(events);
  const removableEvents = duplicateGroups.reduce(
    (total, group) => total + group.remove.length,
    0
  );

  return {
    ok: true,
    calendarId,
    scannedEvents: events.length,
    duplicateGroups,
    removableEvents,
    safety: {
      rule: "metadata_or_deterministic_denmark_id_only",
      ignoredPrefixOnlyEvents: events.filter((event) => {
        const privateProps = event?.extendedProperties?.private || {};
        const hasMetadata =
          privateProps.denmarkTripEventKey || privateProps.denmarkMaintenanceKey;
        const hasDenmarkId = String(event?.id || "").startsWith("denmark");
        const hasPrefix = DENMARK_SUMMARY_PREFIXES.some((prefix) =>
          String(event?.summary || "").startsWith(prefix)
        );
        return hasPrefix && !hasMetadata && !hasDenmarkId;
      }).length,
    },
  };
}

async function runGoogleCalendarDuplicateCleanup(calendar, calendarId, options = {}) {
  const preview = await previewGoogleCalendarDuplicateCleanup(calendar, calendarId, options);
  const removed = [];
  const failed = [];

  for (const group of preview.duplicateGroups) {
    for (const event of group.remove) {
      try {
        await calendar.events.delete({ calendarId, eventId: event.id });
        removed.push({ ...event, groupKey: group.key });
      } catch (err) {
        const status = err?.code || err?.response?.status;
        if (status === 404 || status === 410) {
          removed.push({ ...event, groupKey: group.key });
        } else {
          failed.push({
            ...event,
            groupKey: group.key,
            error: err.message || "delete failed",
          });
        }
      }
    }
  }

  await markDeletedSyncRows(removed.map((event) => event.id));

  return {
    ok: failed.length === 0,
    calendarId,
    scannedEvents: preview.scannedEvents,
    duplicateGroups: preview.duplicateGroups.length,
    removedEvents: removed.length,
    failedEvents: failed.length,
    removed,
    failed,
  };
}

module.exports = {
  previewGoogleCalendarDuplicateCleanup,
  runGoogleCalendarDuplicateCleanup,
};
