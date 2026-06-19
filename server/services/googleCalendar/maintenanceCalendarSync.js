const { google } = require("googleapis");
const pool = require("../../db");
const { getOAuthClient } = require("./googleCalendarAuth");
const {
  getGoogleCalendarConnection,
  listGoogleCalendarSyncTargets,
  markGoogleCalendarConnectionHealth,
} = require("./googleCalendarStore");

const HIGH_PRIORITY_LEVELS = new Set(["urgent", "high"]);
const SYNC_CACHE_MS = Number(
  process.env.MAINTENANCE_CALENDAR_SYNC_CACHE_MS || 30 * 60 * 1000
);
const EVENT_DURATION_MS = Number(
  process.env.MAINTENANCE_CALENDAR_EVENT_DURATION_MS || 2 * 60 * 60 * 1000
);
const recentSyncs = new Map();
let ensureTablePromise = null;

function getGoogleApiErrorCode(err) {
  return (
    err?.response?.data?.error ||
    err?.errors?.[0]?.reason ||
    err?.code ||
    err?.message ||
    "unknown_error"
  );
}

async function ensureMaintenanceGoogleSyncTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS public.maintenance_google_sync (
        id bigserial PRIMARY KEY,
        maintenance_key text NOT NULL,
        google_calendar_connection_id bigint NOT NULL REFERENCES public.google_calendar_connections(id) ON DELETE CASCADE,
        google_event_id text,
        sync_status text NOT NULL DEFAULT 'synced',
        last_synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (maintenance_key, google_calendar_connection_id)
      );

      CREATE INDEX IF NOT EXISTS idx_maintenance_google_sync_key
        ON public.maintenance_google_sync (maintenance_key);
    `);
  }

  await ensureTablePromise;
}

function pruneRecentSyncs(now = Date.now()) {
  for (const [key, timestamp] of recentSyncs.entries()) {
    if (now - timestamp > SYNC_CACHE_MS) {
      recentSyncs.delete(key);
    }
  }
}

function getHighPriorityTasks(notice) {
  return (Array.isArray(notice?.maintenance_tasks) ? notice.maintenance_tasks : []).filter(
    (task) => HIGH_PRIORITY_LEVELS.has(String(task?.priority || "").toLowerCase())
  );
}

function getMaintenanceKey(notice, tasks) {
  const vehicleKey =
    notice?.maintenance_vehicle_vin ||
    notice?.maintenance_vehicle_name ||
    notice?.vehicle_name ||
    "vehicle";
  const tripKey = notice?.trip_id || notice?.reservation_id || "unscheduled";
  const taskKey = tasks
    .map((task) => task.id || task.title)
    .filter(Boolean)
    .sort()
    .join("-");

  return `maintenance:${tripKey}:${vehicleKey}:${taskKey || "high-priority"}`;
}

function formatEventDate(value) {
  if (!value) return "Available now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Available now";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildMaintenanceEventPayload(notice, tasks) {
  const availableAt = new Date(notice.maintenance_available_at);
  if (Number.isNaN(availableAt.getTime())) return null;

  const endAt = new Date(availableAt.getTime() + EVENT_DURATION_MS);
  const vehicleName =
    notice.maintenance_vehicle_name || notice.vehicle_name || "Vehicle";
  const reservationLine = notice.reservation_id
    ? `Reservation: #${notice.reservation_id}`
    : null;
  const taskLines = tasks.map((task) => {
    const title = task.title || "Maintenance task";
    const priority = String(task.priority || "high").toUpperCase();
    const description = task.description ? ` - ${task.description}` : "";
    return `- [${priority}] ${title}${description}`;
  });

  return {
    summary: `Maintenance: ${vehicleName}`,
    description: [
      `High priority maintenance items are ready to schedule for ${vehicleName}.`,
      `Available: ${formatEventDate(notice.maintenance_available_at)}`,
      reservationLine,
      "",
      ...taskLines,
    ]
      .filter((line) => line !== null)
      .join("\n"),
    start: {
      dateTime: availableAt.toISOString(),
      timeZone: "America/Chicago",
    },
    end: {
      dateTime: endAt.toISOString(),
      timeZone: "America/Chicago",
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 0 },
      ],
    },
    extendedProperties: {
      private: {
        denmarkEventType: "maintenance_required",
        denmarkMaintenanceKey: getMaintenanceKey(notice, tasks),
      },
    },
  };
}

async function getExistingSync(maintenanceKey, connectionId) {
  const result = await pool.query(
    `
      SELECT *
      FROM public.maintenance_google_sync
      WHERE maintenance_key = $1
        AND google_calendar_connection_id = $2
      LIMIT 1
    `,
    [maintenanceKey, connectionId]
  );

  return result.rows[0] || null;
}

async function upsertMaintenanceSync({
  maintenanceKey,
  googleCalendarConnectionId,
  googleEventId,
  syncStatus = "synced",
}) {
  await pool.query(
    `
      INSERT INTO public.maintenance_google_sync (
        maintenance_key,
        google_calendar_connection_id,
        google_event_id,
        sync_status,
        last_synced_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW())
      ON CONFLICT (maintenance_key, google_calendar_connection_id)
      DO UPDATE
      SET google_event_id = EXCLUDED.google_event_id,
          sync_status = EXCLUDED.sync_status,
          last_synced_at = NOW(),
          updated_at = NOW()
    `,
    [maintenanceKey, googleCalendarConnectionId, googleEventId, syncStatus]
  );
}

async function syncNoticeToConnection(notice, target) {
  const tasks = getHighPriorityTasks(notice);
  if (!tasks.length || !notice?.maintenance_available_at) return null;

  const maintenanceKey = getMaintenanceKey(notice, tasks);
  const eventPayload = buildMaintenanceEventPayload(notice, tasks);
  if (!eventPayload) return null;

  const connection = await getGoogleCalendarConnection(target.user_id ?? null);
  if (!connection?.refresh_token || !connection.calendar_id) return null;

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({ refresh_token: connection.refresh_token });
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const existingSync = await getExistingSync(maintenanceKey, connection.id);

  try {
    const event =
      existingSync?.google_event_id && existingSync.sync_status !== "deleted"
        ? await calendar.events.patch({
            calendarId: connection.calendar_id,
            eventId: existingSync.google_event_id,
            requestBody: eventPayload,
          })
        : await calendar.events.insert({
            calendarId: connection.calendar_id,
            requestBody: eventPayload,
          });

    await upsertMaintenanceSync({
      maintenanceKey,
      googleCalendarConnectionId: connection.id,
      googleEventId: event.data.id,
      syncStatus: "synced",
    });
    await markGoogleCalendarConnectionHealth({
      connectionId: connection.id,
      tokenStatus: "valid",
      tokenError: null,
    });

    return { ok: true, maintenanceKey, eventId: event.data.id };
  } catch (err) {
    await markGoogleCalendarConnectionHealth({
      connectionId: connection.id,
      tokenStatus: "invalid",
      tokenError: getGoogleApiErrorCode(err),
    });
    throw err;
  }
}

async function syncHighPriorityMaintenanceCalendarNotices(notices = []) {
  const candidates = notices.filter((notice) => {
    const tasks = getHighPriorityTasks(notice);
    return tasks.length > 0 && notice?.maintenance_available_at;
  });

  if (!candidates.length) return { ok: true, processed: 0, results: [] };

  pruneRecentSyncs();
  await ensureMaintenanceGoogleSyncTable();

  const targets = await listGoogleCalendarSyncTargets();
  if (!targets.length) return { ok: true, processed: 0, results: [] };

  const results = [];

  for (const notice of candidates) {
    const tasks = getHighPriorityTasks(notice);
    const maintenanceKey = getMaintenanceKey(notice, tasks);
    if (recentSyncs.has(maintenanceKey)) continue;

    for (const target of targets) {
      try {
        const result = await syncNoticeToConnection(notice, target);
        if (result) results.push(result);
      } catch (err) {
        results.push({
          ok: false,
          maintenanceKey,
          error: err.message || "maintenance calendar sync failed",
        });
      }
    }

    recentSyncs.set(maintenanceKey, Date.now());
  }

  return {
    ok: results.every((result) => result.ok !== false),
    processed: results.length,
    results,
  };
}

module.exports = {
  ensureMaintenanceGoogleSyncTable,
  syncHighPriorityMaintenanceCalendarNotices,
};
