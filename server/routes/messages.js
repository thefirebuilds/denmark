const express = require("express");
const router = express.Router();
const db = require("../db");
const tripAutomationRules = require("../config/tripAutomationRules.json");

function parseSubject(subject) {
  if (!subject) return { type: "unknown" };

  let m;

  m = subject.match(/^(.+?) has sent you a message about your (.+)$/i);
  if (m) {
    return {
      type: "guest_message",
      guest: m[1],
      vehicle: m[2],
    };
  }

  m = subject.match(/^(.+?) has changed their trip with your (.+?) \((\d+)\)$/i);
  if (m) {
    return {
      type: "trip_changed",
      guest: m[1],
      vehicle: m[2],
      tripId: m[3],
    };
  }

  m = subject.match(/^Your (.+?) has been relisted/i);
  if (m) {
    return {
      type: "vehicle_relisted",
      vehicle: m[1],
    };
  }

  return { type: "unknown" };
}

const OPEN_MAINTENANCE_TASK_STATUSES = [
  "open",
  "scheduled",
  "in_progress",
  "deferred",
];
const MESSAGE_QUEUE_CACHE_MS = Number(process.env.MESSAGE_QUEUE_CACHE_MS || 10000);
const MESSAGE_STATS_CACHE_MS = Number(process.env.MESSAGE_STATS_CACHE_MS || 10000);
const EMPTY_QUERY_RESULT = Object.freeze({ rows: [] });

let messageQueueCache = null;
let messageStatsCache = null;

function getCachedPayload(cache, key, ttlMs) {
  if (!cache || cache.key !== key) return null;
  if (Date.now() - cache.createdAt > ttlMs) return null;
  return cache.payload;
}

function setMessageQueueCache(key, payload) {
  messageQueueCache = {
    key,
    payload,
    createdAt: Date.now(),
  };
}

function setMessageStatsCache(payload) {
  messageStatsCache = {
    key: "stats",
    payload,
    createdAt: Date.now(),
  };
}

function invalidateMessageCaches() {
  messageQueueCache = null;
  messageStatsCache = null;
}

let ensureNotificationAckColumnsPromise = null;

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getReturnLocationConfig() {
  const rules = Array.isArray(tripAutomationRules?.tripStageAutomations)
    ? tripAutomationRules.tripStageAutomations
    : [];
  const returnRule = rules.find(
    (rule) =>
      rule?.enabled !== false &&
      String(rule?.fromStage || "") === "in_progress" &&
      String(rule?.toStage || "") === "turnaround" &&
      Array.isArray(rule?.conditions) &&
      rule.conditions.some((condition) => condition?.type === "location")
  );
  const location = returnRule?.conditions?.find(
    (condition) => condition?.type === "location"
  );
  const lat = toNumber(location?.lat);
  const lon = toNumber(location?.lon);

  if (lat == null || lon == null) return null;

  return {
    lat,
    lon,
    radiusMiles: toNumber(location?.radiusMiles) ?? 0.15,
    label: location?.label || "configured return location",
  };
}

async function autoAcknowledgeVerifiedReturnNotifications() {
  const location = getReturnLocationConfig();
  if (!location) return { verified: 0 };

  await ensureNotificationAckColumns();

  const result = await db.query(
    `
      WITH candidate_notifications AS (
        SELECT
          ne.id,
          ne.received_at,
          COALESCE(ne.posted_at, ne.received_at) AS event_at,
          substring(ne.title from '^([^ ]+) has returned ') AS returned_guest_name,
          NULLIF(regexp_replace(ne.title, '^[^ ]+ has returned ', ''), ne.title) AS returned_vehicle_name
        FROM notification_events ne
        WHERE ne.classification = 'trip_returned'
          AND ne.acknowledged_at IS NULL
          AND ne.received_at >= NOW() - INTERVAL '72 hours'
      ),
      matched_trips AS (
        SELECT
          ne.id AS notification_id,
          ne.event_at,
          t.id AS trip_id,
          COALESCE(v.vin, '') AS vehicle_vin,
          COALESCE(v.nickname, t.vehicle_name, '') AS vehicle_name
        FROM candidate_notifications ne
        JOIN LATERAL (
          SELECT t.*
          FROM trips t
          WHERE LOWER(COALESCE(t.guest_name, '')) = LOWER(ne.returned_guest_name)
            AND t.trip_end BETWEEN ne.event_at - INTERVAL '3 days'
              AND ne.event_at + INTERVAL '36 hours'
            AND COALESCE(t.workflow_stage, '') <> 'canceled'
            AND COALESCE(t.status, '') <> 'canceled'
            AND (
              COALESCE(ne.returned_vehicle_name, '') = ''
              OR LOWER(ne.returned_vehicle_name) LIKE '%' || LOWER(COALESCE(t.vehicle_name, '')) || '%'
              OR LOWER(COALESCE(t.vehicle_name, '')) LIKE '%' || LOWER(split_part(ne.returned_vehicle_name, ' ', 1)) || '%'
            )
          ORDER BY t.trip_end DESC NULLS LAST, t.id DESC
          LIMIT 1
        ) t ON true
        LEFT JOIN vehicles v
          ON (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
      ),
      latest_locations AS (
        SELECT
          mt.notification_id,
          mt.trip_id,
          latest.latitude,
          latest.longitude,
          COALESCE(
            latest.location_last_updated,
            latest.vehicle_last_updated,
            latest.captured_at
          ) AS location_at,
          (
            3958.8 * 2 * asin(
              sqrt(
                power(sin(radians((latest.latitude::double precision - $1::double precision) / 2)), 2) +
                cos(radians($1::double precision)) *
                cos(radians(latest.latitude::double precision)) *
                power(sin(radians((latest.longitude::double precision - $2::double precision) / 2)), 2)
              )
            )
          ) AS miles_from_return_location
        FROM matched_trips mt
        JOIN LATERAL (
          SELECT
            s.latitude,
            s.longitude,
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          FROM vehicle_telemetry_snapshots s
          WHERE s.latitude IS NOT NULL
            AND s.longitude IS NOT NULL
            AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at)
              >= mt.event_at - INTERVAL '2 hours'
            AND (
              (
                mt.vehicle_vin <> ''
                AND s.vin IS NOT NULL
                AND LOWER(s.vin) = LOWER(mt.vehicle_vin)
              )
              OR (
                mt.vehicle_name <> ''
                AND s.nickname IS NOT NULL
                AND LOWER(s.nickname) = LOWER(mt.vehicle_name)
              )
            )
          ORDER BY COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST,
            s.id DESC
          LIMIT 1
        ) latest ON true
      ),
      verified AS (
        SELECT *
        FROM latest_locations
        WHERE miles_from_return_location <= $3::double precision
      )
      UPDATE notification_events ne
      SET
        acknowledged_at = NOW(),
        acknowledged_by = 'return-location-auto-check',
        acknowledged_reason = CONCAT(
          'Vehicle GPS verified within ',
          ROUND(verified.miles_from_return_location::numeric, 2),
          ' mi of ',
          $4::text
        )
      FROM verified
      WHERE ne.id = verified.notification_id
      RETURNING ne.id, verified.trip_id, verified.miles_from_return_location
    `,
    [location.lat, location.lon, location.radiusMiles, location.label]
  );

  if (result.rowCount > 0) {
    invalidateMessageCaches();
    console.log(
      `[messages] auto-acknowledged ${result.rowCount} returned vehicle notification(s) by GPS`
    );
  }

  return { verified: result.rowCount, rows: result.rows };
}

async function ensureNotificationAckColumns() {
  if (!ensureNotificationAckColumnsPromise) {
    ensureNotificationAckColumnsPromise = db
      .query(`
        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;

        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_reason TEXT;
      `)
      .catch((err) => {
        ensureNotificationAckColumnsPromise = null;
        throw err;
      });
  }

  await ensureNotificationAckColumnsPromise;
}

const AFTER_RETURN_PROJECTION_RULE_CODES = new Set([
  "cleaning",
  "fluid_leak_check",
  "tire_pressure_check",
]);

function getTaskRuleCode(task) {
  return String(
    task?.trigger_context?.ruleCode ||
      task?.trigger_context?.rule_code ||
      task?.rule_code ||
      ""
  )
    .trim()
    .toLowerCase();
}

function isProjectionTask(task) {
  const type = String(task?.task_type || "").toLowerCase();
  const triggerType = String(task?.trigger_type || "").toLowerCase();
  const title = String(task?.title || "").toLowerCase();

  return (
    type.includes("projection") ||
    triggerType.includes("projection") ||
    title.includes("likely due during")
  );
}

function isAfterReturnProjectionTask(task) {
  const context = task?.trigger_context || {};
  const ruleCode = getTaskRuleCode(task);

  return (
    isProjectionTask(task) &&
    AFTER_RETURN_PROJECTION_RULE_CODES.has(ruleCode) &&
    context.dateRisk === true &&
    context.mileageRisk !== true
  );
}

function mapMaintenanceTaskForNotice(task) {
  if (!isAfterReturnProjectionTask(task)) {
    return {
      ...task,
      planning_mode: isProjectionTask(task) ? "during_trip" : "standard",
    };
  }

  const baseTitle = String(task?.title || "Maintenance task")
    .replace(/\s+likely due during upcoming trip$/i, "")
    .trim();

  return {
    ...task,
    title: `${baseTitle} after return`,
    description: `${baseTitle} was handled for handoff. Plan the next check after this trip returns.`,
    priority: task?.priority === "high" ? "medium" : task?.priority,
    planning_mode: "after_return",
  };
}

function getMaintenanceTaskGroupKey(task) {
  const type = String(task?.task_type || "").trim();
  const title = String(task?.title || "Maintenance task")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return `${type || title}:${title}`.toLowerCase();
}

function groupMaintenanceTasksForNotice(tasks) {
  const groups = new Map();
  const priorityRank = { urgent: 4, high: 3, medium: 2, low: 1 };

  for (const task of tasks || []) {
    const key = getMaintenanceTaskGroupKey(task);

    if (!groups.has(key)) {
      groups.set(key, {
        ...task,
        duplicate_count: 0,
        task_ids: [],
      });
    }

    const group = groups.get(key);
    group.duplicate_count += 1;
    if (task?.id != null) group.task_ids.push(task.id);

    const groupRank = priorityRank[String(group.priority || "").toLowerCase()] || 0;
    const taskRank = priorityRank[String(task?.priority || "").toLowerCase()] || 0;
    if (taskRank > groupRank) group.priority = task.priority;
  }

  return Array.from(groups.values());
}

function isActionableBookingMessage(row) {
  const stage = String(row.trip_workflow_stage || "").toLowerCase();
  const status = String(row.trip_status || "").toLowerCase();
  const terminalOrConfirmedStages = new Set([
    "confirmed",
    "ready_for_handoff",
    "in_progress",
    "turnaround",
    "awaiting_expenses",
    "complete",
    "closed",
    "canceled",
  ]);

  return (
    row.message_type === "trip_booked" &&
    row.trip_id &&
    stage !== "canceled" &&
    status !== "canceled" &&
    (stage === "booked" ||
      (!terminalOrConfirmedStages.has(stage) &&
        (row.trip_needs_review === true ||
          ["booked_unconfirmed", "updated_unconfirmed"].includes(status))))
  );
}

function isRedundantPrepNotice(row) {
  const type = row?.message_type || row?.type;
  const subject = String(row?.subject || "");

  return (
    type === "trip_booked" ||
    (type === "turo_notification" && /upcoming trip/i.test(subject))
  );
}

function isUncorrelatedUnreadMessage(item) {
  const type = item?.message_type || item?.type;

  return (
    item?.status === "unread" &&
    type !== "payment_notice" &&
    !item?.trip_id &&
    !item?.reservation_id
  );
}

function isGuestMessageItem(item) {
  const type = item?.message_type || item?.type;
  return type === "guest_message";
}

function getGuestMessageThreadKey(item) {
  if (item?.trip_id) return `trip:${item.trip_id}`;
  if (item?.reservation_id) return `reservation:${item.reservation_id}`;

  const guest = String(item?.guest_name || item?.parsed?.guest || "")
    .trim()
    .toLowerCase();
  const vehicle = String(
    item?.vehicle_nickname ||
      item?.vehicle_name ||
      item?.parsed?.vehicle ||
      ""
  )
    .trim()
    .toLowerCase();

  return `guest:${guest || "unknown"}:${vehicle || "unknown"}`;
}

function getQueueTimestampMs(item) {
  const value = item?.timestamp || item?.created_at || item?.notification_created_at;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

async function timeQueueQuery(timings, label, queryPromise) {
  const started = Date.now();
  try {
    return await queryPromise;
  } finally {
    timings[label] = Date.now() - started;
  }
}

function maybeLogQueueTimings(startedAt, timings, itemCount) {
  const totalMs = Date.now() - startedAt;
  const shouldLog =
    totalMs >= Number(process.env.MESSAGE_QUEUE_SLOW_MS || 1000) ||
    String(process.env.DEBUG_MESSAGE_QUEUE_TIMING || "").trim() === "1";

  if (!shouldLog) return;

  console.log(
    `[messages] queue load ${totalMs}ms items=${itemCount} timings=${JSON.stringify(
      timings
    )}`
  );
}

function setQueueTimingHeader(res, startedAt, timings) {
  const totalMs = Date.now() - startedAt;
  const timingEntries = {
    auth: res.locals?.authMs,
    ...timings,
    total: totalMs,
  };
  const header = Object.entries(timingEntries)
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([name, value]) => `${name};dur=${Number(value)}`)
    .join(", ");

  if (header) {
    res.setHeader("Server-Timing", header);
  }
  res.setHeader("X-Denmark-Route", "messages");
}

function buildQueueDebugTiming(res, startedAt, timings) {
  return {
    auth: Number(resolvedTimingValue(res.locals?.authMs)),
    ...Object.fromEntries(
      Object.entries(timings)
        .filter(([name]) => name !== "auth")
        .map(([name, value]) => [name, Number(resolvedTimingValue(value))])
    ),
    total: Date.now() - startedAt,
  };
}

function resolvedTimingValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function compactGuestMessageThreads(items) {
  const threadItems = new Map();
  const passthrough = [];

  for (const item of items || []) {
    if (item?.status !== "unread" || !isGuestMessageItem(item)) {
      passthrough.push(item);
      continue;
    }

    const key = getGuestMessageThreadKey(item);
    if (!threadItems.has(key)) threadItems.set(key, []);
    threadItems.get(key).push(item);
  }

  for (const [key, messages] of threadItems.entries()) {
    messages.sort((a, b) => getQueueTimestampMs(b) - getQueueTimestampMs(a));

    if (messages.length === 1) {
      passthrough.push(messages[0]);
      continue;
    }

    const latest = messages[0];
    const orderedOldestFirst = [...messages].reverse();
    passthrough.push({
      ...latest,
      id: `guest-thread:${key}`,
      messageId: `guest-thread:${key}`,
      type: "guest_message_thread",
      message_type: "guest_message_thread",
      status: "unread",
      subject: `${messages.length} guest messages from ${
        latest.guest_name || latest.parsed?.guest || "guest"
      }`,
      guest_message_count: messages.length,
      guest_messages: orderedOldestFirst.map((message) => ({
        id: message.id,
        messageId: message.messageId,
        timestamp: message.timestamp,
        guest_message: message.guest_message,
        subject: message.subject,
      })),
      message_ids: messages.map((message) => message.id),
      latest_message_id: latest.id,
      latest_guest_message: latest.guest_message,
      timestamp: latest.timestamp,
      created_at: latest.created_at,
    });
  }

  return passthrough;
}

function messageQueueRank(item) {
  if (isGuestMessageItem(item) || item.type === "guest_message_thread") return -3;
  if (item.type === "return_location_check") return -2;
  if (item.type === "notification_unmatched") return -2;
  if (item.type === "vehicle_diagnostic_alert") return -2;
  if (isUncorrelatedUnreadMessage(item)) return -2;
  if (item.type === "handoff_ready_required") return -1;
  if (
    item.type === "maintenance_required" &&
    Number(item.maintenance_queue_rank) === 0
  ) {
    return -1;
  }
  if (item.status === "unread") return 0;
  if (item.type === "trip_overlap_detected") return 1;
  if (item.type === "late_toll_unbilled") return 1;
  if (item.type === "closeout_required") return 1;
  if (item.type === "inspection_export_required") return 2;
  if (item.type === "trip_booked" && item.is_booking_confirmation_task) return 2;
  if (item.type === "maintenance_required") return 3;
  return 3;
}

function attachMaintenanceToPrepNotices(prepNotices, maintenanceNotices) {
  const maintenanceByTripId = new Map(
    maintenanceNotices
      .filter((item) => item.trip_id != null)
      .map((item) => [Number(item.trip_id), item])
  );

  return prepNotices.map((notice) => {
    const maintenance = maintenanceByTripId.get(Number(notice.trip_id));
    if (!maintenance) return notice;

    return {
      ...notice,
      maintenance_attached: true,
      maintenance_vehicle_name: maintenance.maintenance_vehicle_name,
      maintenance_vehicle_vin: maintenance.maintenance_vehicle_vin,
      maintenance_available_at: maintenance.maintenance_available_at,
      maintenance_task_count: maintenance.maintenance_task_count,
      maintenance_open_task_record_count:
        maintenance.maintenance_open_task_record_count,
      maintenance_tasks: maintenance.maintenance_tasks,
    };
  });
}

function compareQueueItems(a, b) {
  const rankDiff = messageQueueRank(a) - messageQueueRank(b);
  if (rankDiff !== 0) return rankDiff;

  if (a.type === "handoff_ready_required" && b.type === "handoff_ready_required") {
    const aSortAt = new Date(a.handoff_sort_at || a.trip_start || 0).getTime();
    const bSortAt = new Date(b.handoff_sort_at || b.trip_start || 0).getTime();
    const safeASortAt = Number.isFinite(aSortAt) ? aSortAt : Number.MAX_SAFE_INTEGER;
    const safeBSortAt = Number.isFinite(bSortAt) ? bSortAt : Number.MAX_SAFE_INTEGER;

    if (safeASortAt !== safeBSortAt) return safeASortAt - safeBSortAt;
  }

  if (a.type === "maintenance_required" && b.type === "maintenance_required") {
    const aMaintenanceRank = Number.isFinite(Number(a.maintenance_queue_rank))
      ? Number(a.maintenance_queue_rank)
      : 9;
    const bMaintenanceRank = Number.isFinite(Number(b.maintenance_queue_rank))
      ? Number(b.maintenance_queue_rank)
      : 9;

    if (aMaintenanceRank !== bMaintenanceRank) {
      return aMaintenanceRank - bMaintenanceRank;
    }

    const aSortAt = new Date(a.maintenance_sort_at || 0).getTime();
    const bSortAt = new Date(b.maintenance_sort_at || 0).getTime();
    const safeASortAt = Number.isFinite(aSortAt) ? aSortAt : Number.MAX_SAFE_INTEGER;
    const safeBSortAt = Number.isFinite(bSortAt) ? bSortAt : Number.MAX_SAFE_INTEGER;

    if (safeASortAt !== safeBSortAt) return safeASortAt - safeBSortAt;
  }

  if (a.type === "closeout_required" && b.type === "closeout_required") {
    const aSortAt = new Date(a.closeout_sort_at || a.trip_end || 0).getTime();
    const bSortAt = new Date(b.closeout_sort_at || b.trip_end || 0).getTime();
    const safeASortAt = Number.isFinite(aSortAt) ? aSortAt : 0;
    const safeBSortAt = Number.isFinite(bSortAt) ? bSortAt : 0;

    if (safeASortAt !== safeBSortAt) return safeBSortAt - safeASortAt;
  }

  if (a.type === "late_toll_unbilled" && b.type === "late_toll_unbilled") {
    const aSortAt = new Date(a.late_toll_latest_recorded_at || 0).getTime();
    const bSortAt = new Date(b.late_toll_latest_recorded_at || 0).getTime();
    const safeASortAt = Number.isFinite(aSortAt) ? aSortAt : 0;
    const safeBSortAt = Number.isFinite(bSortAt) ? bSortAt : 0;

    if (safeASortAt !== safeBSortAt) return safeBSortAt - safeASortAt;
  }

  if (a.type === "trip_overlap_detected" && b.type === "trip_overlap_detected") {
    const aSortAt = new Date(a.overlap_sort_at || a.trip_start || 0).getTime();
    const bSortAt = new Date(b.overlap_sort_at || b.trip_start || 0).getTime();
    const safeASortAt = Number.isFinite(aSortAt) ? aSortAt : Number.MAX_SAFE_INTEGER;
    const safeBSortAt = Number.isFinite(bSortAt) ? bSortAt : Number.MAX_SAFE_INTEGER;

    if (safeASortAt !== safeBSortAt) return safeASortAt - safeBSortAt;
  }

  const aTime = new Date(a.timestamp || a.created_at || 0).getTime();
  const bTime = new Date(b.timestamp || b.created_at || 0).getTime();
  const safeATime = Number.isFinite(aTime) ? aTime : 0;
  const safeBTime = Number.isFinite(bTime) ? bTime : 0;

  if (safeATime !== safeBTime) return safeBTime - safeATime;

  return String(b.id || "").localeCompare(String(a.id || ""));
}

function mapMessageRow(row) {
  const isBookingTask = isActionableBookingMessage(row);

  return {
    id: row.id,
    messageId: row.message_id,
    subject: row.subject,
    status: row.status,
    timestamp: row.message_timestamp,
    notification_created_at: row.created_at || row.message_timestamp,
    amount: row.amount,
    type: row.message_type,
    guest_message: row.guest_message,
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    new_trip_end: row.trip_end,
    reservation_id: row.reservation_id,
    mileage_included: row.mileage_included,
    trip_id: row.trip_id,
    trip_workflow_stage: row.trip_workflow_stage,
    trip_needs_review: row.trip_needs_review,
    trip_status: row.trip_status,
    trip_record_guest_name: row.trip_record_guest_name,
    trip_record_vehicle_name: row.trip_record_vehicle_name,
    trip_record_vehicle_nickname: row.trip_record_vehicle_nickname,
    trip_record_start: row.trip_record_start,
    trip_record_end: row.trip_record_end,
    trip_record_amount: row.trip_record_amount,
    trip_record_mileage_included: row.trip_record_mileage_included,
    trip_record_reservation_id: row.trip_record_reservation_id,
    pickup_location: row.pickup_location,
    active_trip_id: row.active_trip_id,
    active_trip_guest_name: row.active_trip_guest_name,
    active_trip_start: row.active_trip_start,
    active_trip_end: row.active_trip_end,
    active_trip_status: row.active_trip_status,
    active_trip_workflow_stage: row.active_trip_workflow_stage,
    is_booking_confirmation_task: isBookingTask,
    reply_url: row.reply_url,
    trip_details_url: row.trip_details_url,
    parsed: parseSubject(row.subject),
  };
}

function cleanPickupLocation(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/g, "")
    .trim();

  if (!cleaned) return null;
  if (/^(starting|from|to|is booked|will pick up)\b/i.test(cleaned)) return null;
  if (cleaned.length > 140) return null;
  return cleaned;
}

function extractPickupLocationFromNoticeText(value) {
  const text = String(value || "");
  const patterns = [
    /Map of\s+([^:\n]+):/i,
    /\btrip with your .+?\s+at\s+(.+?)\s+starting on\b/i,
    /\btrip with your .+?\s+at\s+(.+?)\s+is booked from\b/i,
    /\bdeliver the car to .+?\s+at\s+(.+?)\s+on\b/i,
    /\bpick up the car (?:at|from)\s+(.+?)\s+on\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const location = cleanPickupLocation(match?.[1]);
    if (location) return location;
  }

  return null;
}

function mapUnmatchedNotificationRow(row) {
  const title = row.title || row.classification || "Turo notification";
  const body = row.body || row.big_text || row.sub_text || "";
  const isReturnLocationCheck = row.classification === "trip_returned";

  return {
    id: `notification-gap:${row.id}`,
    messageId: `notification-gap:${row.id}`,
    subject: isReturnLocationCheck
      ? `Return location check: ${title}`
      : `Bridge notification missing email: ${title}`,
    status: "read",
    timestamp: row.posted_at || row.received_at,
    notification_created_at: row.received_at || row.posted_at,
    type: isReturnLocationCheck ? "return_location_check" : "notification_unmatched",
    notification_event_id: row.id,
    notification_classification: row.classification,
    notification_title: row.title,
    notification_body: body,
    return_location_text: body,
    notification_app: row.app,
    notification_package_name: row.package_name,
    notification_device: row.device,
    notification_received_at: row.received_at,
    notification_posted_at: row.posted_at,
    notification_key: row.notification_key,
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    created_at: row.received_at || row.posted_at,
  };
}

function mapHandoffNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";
  const guestName = row.guest_name || "guest";

  return {
    id: `handoff:${row.trip_id}`,
    messageId: `handoff:${row.trip_id}`,
    subject: `${vehicleName} needs handoff prep for ${guestName}`,
    status: "read",
    timestamp: row.trip_start,
    type: "handoff_ready_required",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    handoff_sort_at: row.trip_start,
    notification_created_at: row.stage_updated_at || row.trip_start,
    created_at: row.stage_updated_at || row.trip_start,
  };
}

function mapInspectionExportNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";
  const guestName = row.guest_name || "guest";

  return {
    id: `inspection-export:${row.trip_id}`,
    messageId: `inspection-export:${row.trip_id}`,
    subject: `Export guest inspection sheet for ${vehicleName}`,
    status: "read",
    timestamp: row.stage_updated_at || row.trip_start,
    notification_created_at: row.stage_updated_at || row.trip_start,
    type: "inspection_export_required",
    guest_name: guestName,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    vehicle_vin: row.vehicle_vin,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    created_at: row.stage_updated_at || row.trip_start,
  };
}

function mapCloseoutNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";
  const guestName = row.guest_name || "guest";
  const fuelLevel =
    row.latest_fuel_level == null ? null : Number(row.latest_fuel_level);
  const fuelLow = Boolean(row.fuel_reminder_pending);
  const reasons = [];

  if (row.workflow_incomplete) reasons.push("advance workflow");
  if (row.missing_starting_odometer) reasons.push("starting odometer");
  if (row.missing_ending_odometer) reasons.push("ending odometer");
  if (row.expenses_pending) reasons.push("expense review");
  if (row.tolls_pending) reasons.push("toll billing");
  if (fuelLow) reasons.push("fuel before next guest");
  if (row.closeout_flag_incomplete) reasons.push("closeout flag");

  return {
    id: `closeout:${row.trip_id}`,
    messageId: `closeout:${row.trip_id}`,
    subject: `Close out ${vehicleName}'s trip for ${guestName}`,
    status: "read",
    timestamp: row.trip_end,
    notification_created_at: row.trip_end,
    type: "closeout_required",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    closeout_sort_at: row.trip_end,
    closeout_reasons: reasons,
    closeout_workflow_incomplete: row.workflow_incomplete,
    closeout_missing_starting_odometer: row.missing_starting_odometer,
    closeout_missing_ending_odometer: row.missing_ending_odometer,
    closeout_expenses_pending: row.expenses_pending,
    closeout_tolls_pending: row.tolls_pending,
    closeout_fuel_low: fuelLow,
    closeout_fuel_threshold: 97,
    closeout_latest_fuel_level: Number.isFinite(fuelLevel) ? fuelLevel : null,
    closeout_latest_fuel_source: row.latest_fuel_source,
    closeout_latest_fuel_at: row.latest_fuel_at,
    closeout_next_trip_start: row.next_trip_start,
    closeout_next_guest_name: row.next_guest_name,
    closeout_flag_incomplete: row.closeout_flag_incomplete,
    closeout_expense_status: row.expense_status,
    closeout_toll_review_status: row.toll_review_status,
    closeout_toll_count: row.toll_count,
    closeout_toll_total: row.toll_total,
    starting_odometer: row.starting_odometer,
    ending_odometer: row.ending_odometer,
    has_tolls: row.has_tolls,
    closed_out: row.closed_out,
    created_at: row.trip_end,
  };
}

function mapLateTollNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";
  const guestName = row.guest_name || "guest";

  return {
    id: `late-toll:${row.trip_id}`,
    messageId: `late-toll:${row.trip_id}`,
    subject: `Late tolls need billing for ${vehicleName}`,
    status: "read",
    timestamp: row.latest_recorded_at,
    notification_created_at: row.latest_recorded_at,
    type: "late_toll_unbilled",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    late_toll_count: row.late_toll_count,
    late_toll_total: row.late_toll_total,
    late_toll_first_recorded_at: row.first_recorded_at,
    late_toll_latest_recorded_at: row.latest_recorded_at,
    late_toll_first_transaction_at: row.first_transaction_at,
    late_toll_latest_transaction_at: row.latest_transaction_at,
    late_toll_hours_after_trip_end: row.hours_after_trip_end,
    late_toll_charged_total: row.toll_charged_total,
    late_toll_review_status: row.toll_review_status,
    created_at: row.latest_recorded_at,
    guest_display_name: guestName,
  };
}

function mapMaintenanceNoticeRow(row) {
  const now = Date.now();
  const tripStart = row.trip_start ? new Date(row.trip_start).getTime() : null;
  const tripEnd = row.trip_end ? new Date(row.trip_end).getTime() : null;
  const tasks = Array.isArray(row.tasks)
    ? row.tasks.map(mapMaintenanceTaskForNotice)
    : [];
  const groupedTasks = groupMaintenanceTasksForNotice(tasks);
  const hasProjectionTasks = tasks.some((task) =>
    task?.planning_mode === "during_trip"
  );
  const hasAfterReturnTasks = tasks.some((task) =>
    task?.planning_mode === "after_return"
  );
  const hasPostTripTasks = tasks.some((task) =>
    String(task?.task_type || "").toLowerCase().startsWith("post_trip")
  );
  const isActiveTrip =
    Number.isFinite(tripStart) &&
    Number.isFinite(tripEnd) &&
    tripStart <= now &&
    tripEnd > now;
  const isUpcomingTrip = Number.isFinite(tripStart) && tripStart > now;
  const vehicleName = row.vehicle_name || "vehicle";
  const taskLabel = `${groupedTasks.length} maintenance planning item${
    groupedTasks.length === 1 ? "" : "s"
  }`;
  const subject = hasProjectionTasks
    ? isActiveTrip
      ? `${taskLabel} during ${vehicleName}'s current trip`
      : `${taskLabel} will come due during ${vehicleName}'s trip`
    : hasAfterReturnTasks || isActiveTrip
    ? `${taskLabel} after ${vehicleName} returns`
    : isUpcomingTrip
    ? `${taskLabel} before ${vehicleName} goes out`
    : hasPostTripTasks
    ? `${taskLabel} while ${vehicleName} is home`
    : `${taskLabel} for ${vehicleName}`;
  const maintenanceQueueRank = isUpcomingTrip ? 0 : isActiveTrip ? 2 : 1;
  const maintenanceSortAt = isUpcomingTrip
    ? row.trip_start
    : row.maintenance_available_at || row.trip_end || row.latest_task_created_at;

  return {
    id: `maintenance:${row.trip_id}`,
    messageId: `maintenance:${row.trip_id}`,
    subject,
    status: "read",
    timestamp: row.latest_task_created_at || row.trip_start || row.created_at,
    notification_created_at: row.latest_task_created_at || row.created_at,
    type: "maintenance_required",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
    maintenance_vehicle_name: row.vehicle_name,
    maintenance_vehicle_vin: row.vehicle_vin,
    maintenance_available_at: row.maintenance_available_at,
    maintenance_queue_rank: maintenanceQueueRank,
    maintenance_sort_at: maintenanceSortAt,
    maintenance_task_count: groupedTasks.length,
    maintenance_open_task_record_count: Number(row.open_task_count || 0),
    maintenance_tasks: groupedTasks,
    created_at: row.latest_task_created_at,
  };
}

function mapVehicleDiagnosticNoticeRow(row) {
  const codes = Array.isArray(row.qualified_dtc_list)
    ? row.qualified_dtc_list
        .map((item) => {
          if (typeof item === "string") return item;
          return item?.code || item?.dtc || item?.name || "";
        })
        .map((item) => String(item || "").trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const vehicleName = row.vehicle_nickname || row.nickname || row.vin || "vehicle";
  const hasMil = row.mil_on === true;
  const label = codes.length
    ? codes.join(", ")
    : hasMil
    ? "MIL/check-engine light on"
    : `${Number(row.dtc_count || 1)} DTC active`;

  return {
    id: `vehicle-diagnostic:${row.service_name}:${row.vin || row.id}`,
    messageId: `vehicle-diagnostic:${row.service_name}:${row.vin || row.id}`,
    subject: `${vehicleName} needs diagnostic review`,
    status: "read",
    timestamp: row.vehicle_last_updated || row.captured_at,
    notification_created_at: row.vehicle_last_updated || row.captured_at,
    type: "vehicle_diagnostic_alert",
    vehicle_name: vehicleName,
    vehicle_nickname: row.vehicle_nickname,
    vehicle_vin: row.vin,
    diagnostic_source: row.service_name,
    diagnostic_label: label,
    diagnostic_codes: codes,
    diagnostic_mil_on: hasMil,
    diagnostic_dtc_count: Number(row.dtc_count || codes.length || 0),
    diagnostic_last_seen: row.vehicle_last_updated || row.captured_at,
    created_at: row.vehicle_last_updated || row.captured_at,
  };
}

function mapTripOverlapNoticeRow(row) {
  const vehicleName =
    row.vehicle_nickname ||
    row.primary_vehicle_name ||
    row.secondary_vehicle_name ||
    "vehicle";
  const primaryGuest = row.primary_guest_name || "guest";
  const secondaryGuest = row.secondary_guest_name || "guest";

  return {
    id: `trip-overlap:${row.primary_trip_id}:${row.secondary_trip_id}`,
    messageId: `trip-overlap:${row.primary_trip_id}:${row.secondary_trip_id}`,
    subject: `${vehicleName} has overlapping trips`,
    status: "read",
    timestamp: row.overlap_start || row.primary_trip_start,
    notification_created_at: row.overlap_start || row.primary_trip_start,
    type: "trip_overlap_detected",
    guest_name: `${primaryGuest} / ${secondaryGuest}`,
    vehicle_name: row.primary_vehicle_name || row.secondary_vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    reservation_id: row.primary_reservation_id,
    trip_id: row.primary_trip_id,
    trip_start: row.primary_trip_start,
    trip_end: row.primary_trip_end,
    trip_workflow_stage: row.primary_workflow_stage,
    trip_status: row.primary_trip_status,
    overlap_sort_at: row.overlap_start || row.primary_trip_start,
    overlap_start: row.overlap_start,
    overlap_end: row.overlap_end,
    overlapping_trip_id: row.secondary_trip_id,
    overlapping_reservation_id: row.secondary_reservation_id,
    overlapping_guest_name: row.secondary_guest_name,
    overlapping_trip_start: row.secondary_trip_start,
    overlapping_trip_end: row.secondary_trip_end,
    primary_guest_name: row.primary_guest_name,
    primary_reservation_id: row.primary_reservation_id,
    primary_trip_start: row.primary_trip_start,
    primary_trip_end: row.primary_trip_end,
    primary_vehicle_name: row.primary_vehicle_name,
    secondary_vehicle_name: row.secondary_vehicle_name,
    created_at: row.overlap_start || row.primary_trip_start,
  };
}

router.get("/stats", async (req, res) => {
  const statsStartedAt = Date.now();
  try {
    const cached = getCachedPayload(messageStatsCache, "stats", MESSAGE_STATS_CACHE_MS);
    if (cached) {
      return res.json(cached);
    }

    await ensureNotificationAckColumns();

    const sql = `
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'unread'
            AND COALESCE(message_type, '') <> 'payment_notice'
        ) AS unread_count,
        COUNT(*) FILTER (WHERE status = 'read') AS read_count,
        COUNT(*) FILTER (WHERE message_type = 'guest_message') AS guest_message_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_booked') AS trip_booked_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_changed') AS trip_changed_count,
        COUNT(*) FILTER (WHERE message_type = 'payment_notice') AS payment_notice_count,
        COUNT(*) FILTER (WHERE message_type = 'trip_rated') AS trip_rated_count,
        COUNT(*) FILTER (WHERE message_type IS NULL OR message_type = 'unknown') AS unknown_count,
        COUNT(*) AS total_count,
        MAX(message_timestamp) AS last_received,
        (
          SELECT jsonb_build_object(
            'received_at', hb.received_at,
            'posted_at', hb.posted_at,
            'device', hb.device,
            'age_minutes',
              CASE
                WHEN hb.received_at IS NULL THEN NULL
                ELSE ROUND((EXTRACT(EPOCH FROM (NOW() - hb.received_at)) / 60.0)::numeric, 1)
              END,
            'stale',
              CASE
                WHEN hb.received_at IS NULL THEN TRUE
                ELSE hb.received_at < NOW() - INTERVAL '35 minutes'
              END
          )
          FROM notification_events hb
          WHERE hb.classification = 'bridge_heartbeat'
          ORDER BY hb.received_at DESC NULLS LAST, hb.id DESC
          LIMIT 1
        ) AS bridge_heartbeat,
        0 AS unmatched_notification_count
      FROM messages
    `;

    const result = await db.query(sql);
    const statsMs = Date.now() - statsStartedAt;
    if (
      statsMs >= Number(process.env.MESSAGE_QUEUE_SLOW_MS || 1000) ||
      String(process.env.DEBUG_MESSAGE_QUEUE_TIMING || "").trim() === "1"
    ) {
      console.log(`[messages] stats load ${statsMs}ms`);
    }
    const row = result.rows[0];

    const payload = {
      unread: Number(row.unread_count || 0),
      read: Number(row.read_count || 0),
      guestMessages: Number(row.guest_message_count || 0),
      tripsBooked: Number(row.trip_booked_count || 0),
      tripsChanged: Number(row.trip_changed_count || 0),
      paymentNotices: Number(row.payment_notice_count || 0),
      tripsRated: Number(row.trip_rated_count || 0),
      unknown: Number(row.unknown_count || 0),
      total: Number(row.total_count || 0),
      lastReceived: row.last_received,
      bridgeHeartbeat: row.bridge_heartbeat || null,
      unmatchedNotifications: Number(row.unmatched_notification_count || 0),
    };

    setMessageStatsCache(payload);
    res.json(payload);
  } catch (err) {
    console.error("message stats endpoint failed:", err);
    res.status(500).json({ error: "failed to load message stats" });
  }
});

function clampRawFeedLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(Math.max(Math.floor(parsed), 1), 50);
}

function clampRawFeedPage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(Math.floor(parsed), 1);
}

router.get("/raw", async (req, res) => {
  try {
    const type = String(req.query.type || "emails").trim().toLowerCase();
    const page = clampRawFeedPage(req.query.page);
    const limit = clampRawFeedLimit(req.query.limit);
    const offset = (page - 1) * limit;

    if (!["emails", "internal", "android"].includes(type)) {
      return res.status(400).json({ error: "invalid raw feed type" });
    }

    if (type === "android") {
      await autoAcknowledgeVerifiedReturnNotifications();

      const countResult = await db.query(`
        SELECT COUNT(*)::integer AS total
        FROM notification_events
        WHERE COALESCE(classification, '') <> 'bridge_heartbeat'
          AND COALESCE(source, '') <> 'android_bridge_heartbeat'
      `);
      const result = await db.query(
        `
          SELECT
            id,
            source,
            app,
            package_name,
            title,
            body,
            big_text,
            sub_text,
            posted_at,
            received_at,
            device,
            notification_key,
            classification,
            reservation_id,
            vehicle_name,
            guest_name,
            acknowledged_at,
            acknowledged_reason
          FROM notification_events
          WHERE COALESCE(classification, '') <> 'bridge_heartbeat'
            AND COALESCE(source, '') <> 'android_bridge_heartbeat'
          ORDER BY received_at DESC NULLS LAST, id DESC
          LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );

      return res.json({
        type,
        page,
        limit,
        total: Number(countResult.rows[0]?.total || 0),
        items: result.rows,
      });
    }

    const emailPredicate =
      "(message_id IS NOT NULL OR imap_uid IS NOT NULL OR from_header IS NOT NULL OR raw_headers IS NOT NULL)";
    const predicate =
      type === "emails" ? emailPredicate : `NOT ${emailPredicate}`;
    const countResult = await db.query(`
      SELECT COUNT(*)::integer AS total
      FROM messages
      WHERE ${predicate}
    `);
    const result = await db.query(
      `
        SELECT
          id,
          message_id,
          subject,
          status,
          mailbox,
          imap_uid,
          from_header,
          to_header,
          date_header,
          message_timestamp,
          created_at,
          ingested_at,
          message_type,
          reservation_id,
          guest_name,
          vehicle_name,
          amount,
          guest_message,
          normalized_text_body
        FROM messages
        WHERE ${predicate}
        ORDER BY COALESCE(message_timestamp, ingested_at, created_at) DESC NULLS LAST, id DESC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    return res.json({
      type,
      page,
      limit,
      total: Number(countResult.rows[0]?.total || 0),
      items: result.rows,
    });
  } catch (err) {
    console.error("raw message feed failed:", err);
    res.status(500).json({ error: "failed to load raw message feed" });
  }
});

router.get("/", async (req, res) => {
  const queueStartedAt = Date.now();
  const queueTimings = {};
  try {
    const limit = Number(req.query.limit) || 100;
    const candidateLimit = Math.max(limit * 20, 100);
    const fast = String(req.query.fast || "").trim() === "1";
    const includeDebug = String(req.query.debug || "").trim() === "1";
    const cacheKey = `limit:${limit}:fast:${fast ? "1" : "0"}`;
    const cached = getCachedPayload(
      messageQueueCache,
      cacheKey,
      MESSAGE_QUEUE_CACHE_MS
    );

    if (cached) {
      setQueueTimingHeader(res, queueStartedAt, { cache: 0 });
      if (includeDebug) {
        return res.json({
          items: cached,
          debugTiming: {
            ...buildQueueDebugTiming(res, queueStartedAt, { cache: 0 }),
            cached: true,
          },
        });
      }
      return res.json(cached);
    }

    if (!fast) {
      await ensureNotificationAckColumns();
      await timeQueueQuery(
        queueTimings,
        "returnLocationAutoAck",
        autoAcknowledgeVerifiedReturnNotifications()
      );
    }

    const messagesSql = `
      SELECT
        id,
        message_id,
        subject,
        mailbox,
        message_timestamp,
        created_at,
        status,
        amount,
        guest_message,
        message_type,
        guest_name,
        vehicle_name,
        vehicle_nickname,
        trip_start,
        trip_end,
        mileage_included,
        reservation_id,
        trip_id,
        trip_workflow_stage,
        trip_needs_review,
        trip_status,
        trip_record_guest_name,
        trip_record_vehicle_name,
        trip_record_vehicle_nickname,
        trip_record_start,
        trip_record_end,
        trip_record_amount,
        trip_record_mileage_included,
        trip_record_reservation_id,
        normalized_text_body,
        active_trip_id,
        active_trip_guest_name,
        active_trip_start,
        active_trip_end,
        active_trip_status,
        active_trip_workflow_stage,
        reply_url,
        trip_details_url
      FROM (
        SELECT
          m.id,
          m.message_id,
          m.subject,
          m.mailbox,
          m.message_timestamp,
          m.created_at,
          m.status,
          m.amount,
          m.guest_message,
          m.message_type,
          m.guest_name,
          m.vehicle_name,
          COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
          m.trip_start,
          m.trip_end,
          m.mileage_included,
          m.reservation_id,
          COALESCE(m.trip_id, t.id) AS trip_id,
          t.workflow_stage AS trip_workflow_stage,
          t.needs_review AS trip_needs_review,
          t.status AS trip_status,
          t.guest_name AS trip_record_guest_name,
          t.vehicle_name AS trip_record_vehicle_name,
          COALESCE(v.nickname, t.vehicle_name) AS trip_record_vehicle_nickname,
          t.trip_start AS trip_record_start,
          t.trip_end AS trip_record_end,
          t.amount AS trip_record_amount,
          t.mileage_included AS trip_record_mileage_included,
          t.reservation_id AS trip_record_reservation_id,
          m.normalized_text_body,
          active_trip.id AS active_trip_id,
          active_trip.guest_name AS active_trip_guest_name,
          active_trip.trip_start AS active_trip_start,
          active_trip.trip_end AS active_trip_end,
          active_trip.status AS active_trip_status,
          active_trip.workflow_stage AS active_trip_workflow_stage,
          m.reply_url,
          m.trip_details_url
        FROM messages m
        LEFT JOIN trips t
          ON t.id = m.trip_id
          OR (
            m.reservation_id IS NOT NULL
            AND t.reservation_id IS NOT NULL
            AND m.reservation_id = t.reservation_id
          )
        LEFT JOIN vehicles v
          ON (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
        LEFT JOIN LATERAL (
          SELECT
            active.id,
            active.guest_name,
            active.trip_start,
            active.trip_end,
            active.status,
            active.workflow_stage
          FROM trips active
          WHERE active.trip_start <= NOW()
            AND active.trip_end > NOW()
            AND COALESCE(active.status, '') <> 'canceled'
            AND COALESCE(active.workflow_stage, '') <> 'canceled'
            AND (
              (
                t.turo_vehicle_id IS NOT NULL
                AND active.turo_vehicle_id IS NOT NULL
                AND active.turo_vehicle_id = t.turo_vehicle_id
              )
              OR (
                COALESCE(t.vehicle_name, m.vehicle_name, '') <> ''
                AND LOWER(active.vehicle_name) = LOWER(COALESCE(t.vehicle_name, m.vehicle_name))
              )
            )
          ORDER BY active.trip_start DESC NULLS LAST, active.id DESC
          LIMIT 1
        ) active_trip ON TRUE
        WHERE
          (
            m.status = 'unread'
            AND COALESCE(m.message_type, '') <> 'payment_notice'
            AND NOT (
              LOWER(COALESCE(m.subject, '')) LIKE '%has not responded to your reimbursement invoice%'
              AND EXISTS (
                SELECT 1
                FROM messages sibling
                WHERE sibling.id <> m.id
                  AND sibling.message_type = 'reimbursement_invoice'
                  AND LOWER(COALESCE(sibling.subject, '')) NOT LIKE '%has not responded to your reimbursement invoice%'
                  AND COALESCE(sibling.message_timestamp, sibling.created_at) BETWEEN
                    COALESCE(m.message_timestamp, m.created_at) - INTERVAL '10 minutes'
                    AND COALESCE(m.message_timestamp, m.created_at) + INTERVAL '10 minutes'
                  AND (
                    (
                      m.trip_id IS NOT NULL
                      AND sibling.trip_id = m.trip_id
                    )
                    OR (
                      m.reservation_id IS NOT NULL
                      AND sibling.reservation_id = m.reservation_id
                    )
                  )
                  AND (
                    m.amount IS NULL
                    OR sibling.amount IS NULL
                    OR sibling.amount = m.amount
                  )
              )
            )
          )
          OR (
            m.message_type = 'trip_booked'
            AND t.id IS NOT NULL
            AND COALESCE(t.workflow_stage, '') <> 'canceled'
            AND COALESCE(t.status, '') <> 'canceled'
            AND (
              t.workflow_stage = 'booked'
              OR (
                COALESCE(t.workflow_stage, '') NOT IN (
                  'confirmed',
                  'ready_for_handoff',
                  'in_progress',
                  'turnaround',
                  'awaiting_expenses',
                  'complete',
                  'closed',
                  'canceled'
                )
                AND (
                  t.needs_review = TRUE
                  OR t.status IN ('booked_unconfirmed', 'updated_unconfirmed')
                )
              )
            )
          )
      ) actionable_messages
      ORDER BY
        CASE
          WHEN status = 'unread'
            AND COALESCE(message_type, '') <> 'payment_notice'
            AND trip_id IS NULL
            AND reservation_id IS NULL
            THEN -1
          WHEN status = 'unread' THEN 0
          WHEN message_type = 'trip_booked'
            AND trip_id IS NOT NULL
            AND COALESCE(trip_workflow_stage, '') <> 'canceled'
            AND COALESCE(trip_status, '') <> 'canceled'
            AND (
              trip_workflow_stage = 'booked'
              OR (
                COALESCE(trip_workflow_stage, '') NOT IN (
                  'confirmed',
                  'ready_for_handoff',
                  'in_progress',
                  'turnaround',
                  'awaiting_expenses',
                  'complete',
                  'closed',
                  'canceled'
                )
                AND (
                  trip_needs_review = TRUE
                  OR trip_status IN ('booked_unconfirmed', 'updated_unconfirmed')
                )
              )
            )
            THEN 1
          ELSE 3
        END,
        COALESCE(message_timestamp, NOW()) DESC NULLS LAST,
        id DESC
      LIMIT $1
    `;

    const fastMessagesSql = `
      SELECT
        m.id,
        m.message_id,
        m.subject,
        m.mailbox,
        m.message_timestamp,
        m.created_at,
        m.status,
        m.amount,
        m.guest_message,
        m.message_type,
        m.guest_name,
        m.vehicle_name,
        COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
        m.trip_start,
        m.trip_end,
        m.mileage_included,
        m.reservation_id,
        COALESCE(m.trip_id, t.id) AS trip_id,
        t.workflow_stage AS trip_workflow_stage,
        t.needs_review AS trip_needs_review,
        t.status AS trip_status,
        t.guest_name AS trip_record_guest_name,
        t.vehicle_name AS trip_record_vehicle_name,
        COALESCE(v.nickname, t.vehicle_name) AS trip_record_vehicle_nickname,
        t.trip_start AS trip_record_start,
        t.trip_end AS trip_record_end,
        t.amount AS trip_record_amount,
        t.mileage_included AS trip_record_mileage_included,
        t.reservation_id AS trip_record_reservation_id,
        m.normalized_text_body,
        NULL::integer AS active_trip_id,
        NULL::text AS active_trip_guest_name,
        NULL::timestamp with time zone AS active_trip_start,
        NULL::timestamp with time zone AS active_trip_end,
        NULL::text AS active_trip_status,
        NULL::text AS active_trip_workflow_stage,
        m.reply_url,
        m.trip_details_url
      FROM messages m
      LEFT JOIN trips t
        ON t.id = m.trip_id
      LEFT JOIN vehicles v
        ON t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      WHERE m.status = 'unread'
        AND COALESCE(m.message_type, '') <> 'payment_notice'
      ORDER BY
        CASE
          WHEN m.message_type = 'guest_message' THEN -2
          WHEN m.trip_id IS NULL AND m.reservation_id IS NULL THEN -1
          ELSE 0
        END,
        COALESCE(m.message_timestamp, m.created_at) DESC NULLS LAST,
        m.id DESC
      LIMIT $1
    `;

    const unmatchedNotificationsSql = `
      WITH recent_messages AS MATERIALIZED (
        SELECT
          m.*,
          COALESCE(m.message_timestamp, m.created_at) AS message_at,
          LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, '')) AS guest_search_text,
          LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, '')) AS vehicle_search_text
        FROM messages m
        WHERE COALESCE(m.message_timestamp, m.created_at) >= NOW() - INTERVAL '9 days'
      ),
      candidate_notifications AS MATERIALIZED (
        SELECT
          ne.*,
          COALESCE(ne.posted_at, ne.received_at) AS event_at,
          LOWER(CONCAT_WS(
            ' ',
            ne.title,
            ne.body,
            ne.big_text,
            ne.sub_text
          )) AS notification_text,
          NULLIF(
            REPLACE(
              (regexp_match(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '\\$([0-9][0-9,]*(\\.[0-9]{2})?)'))[1],
              ',',
              ''
            ),
            ''
          )::numeric AS event_amount,
          substring(ne.title from '^Your trip with (.+) starts soon$') AS reminder_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'About ([^:]+) from ([^:]+):') AS paid_now_vehicle_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'About [^:]+ from ([^:]+):') AS paid_now_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from '([A-Z][A-Za-z]+) paid (the|your)') AS paid_invoice_guest_name,
          substring(ne.title from '^([^ ]+) rated their trip$') AS rated_guest_name,
          substring(ne.title from '^([^ ]+) has returned ') AS returned_guest_name,
          NULLIF(regexp_replace(ne.title, '^[^ ]+ has returned ', ''), ne.title) AS returned_vehicle_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from '([^ ]+) has cancelled their trip') AS canceled_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'trip with your ([^.]+)') AS canceled_vehicle_name,
          COALESCE(
            substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from '([A-Za-z]+).s trip with your'),
            NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), 'â€™s trip with your', 1), '^.* ', ''), ''),
            NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '''s trip with your', 1), '^.* ', ''), '')
          ) AS booked_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'trip with your ([^.]+) is booked') AS booked_vehicle_name,
          CASE
            WHEN ne.title LIKE 'Change requested to % trip'
            THEN NULLIF(
              split_part(
                split_part(replace(ne.title, 'Change requested to ', ''), ' trip', 1),
                'â€™',
                1
              ),
              ''
            )
            ELSE NULL
          END AS change_request_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from '([^ ]+) changed their trip with your') AS trip_changed_guest_name
        FROM notification_events ne
        WHERE COALESCE(ne.classification, '') NOT IN ('bridge_heartbeat', 'bridge_test')
          AND COALESCE(ne.source, '') <> 'android_bridge_heartbeat'
          AND ne.acknowledged_at IS NULL
          AND ne.received_at >= NOW() - INTERVAL '48 hours'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%prepare for checkout%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%complete checkout when your car is returned%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%has added a driver%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%additional driver%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%added another driver%'
        ORDER BY ne.received_at DESC NULLS LAST, ne.id DESC
        LIMIT 75
      )
      SELECT
        ne.id,
        ne.source,
        ne.app,
        ne.package_name,
        ne.title,
        ne.body,
        ne.big_text,
        ne.sub_text,
        ne.posted_at,
        ne.received_at,
        ne.device,
        ne.notification_key,
        ne.classification,
        ne.reservation_id,
        ne.vehicle_name,
        ne.guest_name,
        COALESCE(t.id, returned_trip.id) AS trip_id,
        COALESCE(t.trip_start, returned_trip.trip_start) AS trip_start,
        COALESCE(t.trip_end, returned_trip.trip_end) AS trip_end,
        COALESCE(t.workflow_stage, returned_trip.workflow_stage) AS workflow_stage,
        COALESCE(t.status, returned_trip.status) AS trip_status
      FROM candidate_notifications ne
      LEFT JOIN trips t
        ON ne.reservation_id IS NOT NULL
        AND t.reservation_id = ne.reservation_id
      LEFT JOIN LATERAL (
        SELECT
          rt.id,
          rt.trip_start,
          rt.trip_end,
          rt.workflow_stage,
          rt.status
        FROM trips rt
        WHERE COALESCE(ne.returned_guest_name, '') <> ''
          AND LOWER(COALESCE(rt.guest_name, '')) = LOWER(ne.returned_guest_name)
          AND rt.trip_end BETWEEN
            ne.event_at - INTERVAL '3 days'
            AND ne.event_at + INTERVAL '36 hours'
          AND COALESCE(rt.workflow_stage, '') <> 'canceled'
          AND COALESCE(rt.status, '') <> 'canceled'
          AND (
            COALESCE(ne.returned_vehicle_name, '') = ''
            OR LOWER(ne.returned_vehicle_name) LIKE '%' || LOWER(COALESCE(rt.vehicle_name, '')) || '%'
            OR LOWER(COALESCE(rt.vehicle_name, '')) LIKE '%' || LOWER(split_part(ne.returned_vehicle_name, ' ', 1)) || '%'
          )
        ORDER BY rt.trip_end DESC NULLS LAST, rt.id DESC
        LIMIT 1
      ) returned_trip ON true
      WHERE NOT EXISTS (
        SELECT 1
        FROM recent_messages m
        WHERE (
            ne.reservation_id IS NOT NULL
            AND m.reservation_id IS NOT NULL
            AND m.reservation_id = ne.reservation_id
          )
          OR (
            ne.reservation_id IS NULL
            AND COALESCE(ne.guest_name, '') <> ''
            AND COALESCE(ne.vehicle_name, '') <> ''
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND m.guest_search_text LIKE '%' || LOWER(ne.guest_name) || '%'
            AND m.vehicle_search_text LIKE '%' || LOWER(ne.vehicle_name) || '%'
          )
          OR (
            (
              ne.notification_text LIKE '%earnings payment%'
              OR ne.notification_text LIKE '%cha-ching%'
              OR ne.notification_text LIKE '%youâ€™ve been paid%'
              OR ne.notification_text LIKE '%you''ve been paid%'
            )
            AND m.message_type = 'payment_notice'
            AND (
              (
                ne.event_amount IS NOT NULL
                AND m.amount IS NOT NULL
                AND m.amount = ne.event_amount
              )
              OR m.message_at BETWEEN
                ne.event_at - INTERVAL '24 hours'
                AND ne.event_at + INTERVAL '24 hours'
            )
          )
          OR (
            COALESCE(ne.paid_now_guest_name, '') <> ''
            AND COALESCE(ne.paid_now_vehicle_name, '') <> ''
            AND m.message_type = 'guest_message'
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND m.guest_search_text LIKE '%' || LOWER(ne.paid_now_guest_name) || '%'
            AND m.vehicle_search_text LIKE '%' || LOWER(ne.paid_now_vehicle_name) || '%'
          )
          OR (
            (
              ne.notification_text LIKE '%paid the invoice%'
              OR ne.notification_text LIKE '%reimbursement invoice%'
              OR ne.notification_text LIKE '%paid now%'
            )
            AND m.message_type IN ('reimbursement_invoice', 'guest_message')
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND (
              (
                COALESCE(ne.guest_name, ne.paid_now_guest_name, '') <> ''
                AND m.guest_search_text LIKE '%' || LOWER(COALESCE(ne.guest_name, ne.paid_now_guest_name)) || '%'
              )
              OR (
                COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name, '') <> ''
                AND m.vehicle_search_text LIKE '%' || LOWER(COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name)) || '%'
              )
              OR (
                COALESCE(ne.paid_invoice_guest_name, '') <> ''
                AND m.guest_search_text LIKE '%' || LOWER(ne.paid_invoice_guest_name) || '%'
              )
            )
          )
          OR (
            COALESCE(ne.rated_guest_name, '') <> ''
            AND m.message_type IN ('trip_rated', 'turo_notification')
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND m.guest_search_text LIKE '%' || LOWER(ne.rated_guest_name) || '%'
          )
          OR (
            COALESCE(ne.change_request_guest_name, '') <> ''
            AND m.message_type IN ('trip_changed', 'turo_notification')
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND m.guest_search_text LIKE '%' || LOWER(ne.change_request_guest_name) || '%'
          )
          OR (
            COALESCE(ne.trip_changed_guest_name, '') <> ''
            AND m.message_type IN ('trip_changed', 'turo_notification')
            AND m.message_at BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND m.guest_search_text LIKE '%' || LOWER(ne.trip_changed_guest_name) || '%'
          )
          OR (
            ne.reminder_guest_name IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM trips reminder_trip
              WHERE LOWER(COALESCE(reminder_trip.guest_name, '')) = LOWER(ne.reminder_guest_name)
                AND reminder_trip.trip_start BETWEEN
                  ne.event_at - INTERVAL '12 hours'
                  AND ne.event_at + INTERVAL '7 days'
                AND COALESCE(reminder_trip.workflow_stage, '') <> 'canceled'
                AND COALESCE(reminder_trip.status, '') <> 'canceled'
            )
          )
          OR (
            COALESCE(ne.canceled_guest_name, '') <> ''
            AND EXISTS (
              SELECT 1
              FROM trips canceled_trip
              WHERE LOWER(COALESCE(canceled_trip.guest_name, '')) = LOWER(ne.canceled_guest_name)
                AND canceled_trip.created_at BETWEEN
                  ne.event_at - INTERVAL '2 days'
                  AND ne.event_at + INTERVAL '2 days'
                AND (
                  COALESCE(canceled_trip.workflow_stage, '') = 'canceled'
                  OR COALESCE(canceled_trip.status, '') = 'canceled'
                )
                AND (
                  COALESCE(ne.canceled_vehicle_name, '') = ''
                  OR LOWER(ne.canceled_vehicle_name) LIKE '%' || LOWER(COALESCE(canceled_trip.vehicle_name, '')) || '%'
                  OR LOWER(COALESCE(canceled_trip.vehicle_name, '')) LIKE '%' || LOWER(split_part(ne.canceled_vehicle_name, ' ', 1)) || '%'
                )
            )
          )
          OR (
            COALESCE(ne.booked_guest_name, '') <> ''
            AND EXISTS (
              SELECT 1
              FROM trips booked_trip
              WHERE LOWER(COALESCE(booked_trip.guest_name, '')) = LOWER(ne.booked_guest_name)
                AND booked_trip.created_at BETWEEN
                  ne.event_at - INTERVAL '2 days'
                  AND ne.event_at + INTERVAL '2 days'
            )
          )
          OR (
            COALESCE(ne.returned_guest_name, '') <> ''
            AND EXISTS (
              SELECT 1
              FROM trips completed_return_trip
              WHERE LOWER(COALESCE(completed_return_trip.guest_name, '')) = LOWER(ne.returned_guest_name)
                AND completed_return_trip.trip_end BETWEEN
                  ne.event_at - INTERVAL '3 days'
                  AND ne.event_at + INTERVAL '36 hours'
                AND COALESCE(completed_return_trip.workflow_stage, '') <> 'canceled'
                AND COALESCE(completed_return_trip.status, '') <> 'canceled'
                AND (
                  COALESCE(completed_return_trip.workflow_stage, '') IN ('complete', 'closed')
                  OR COALESCE(completed_return_trip.status, '') IN ('complete', 'completed', 'closed')
                  OR COALESCE(completed_return_trip.closed_out, false) = true
                )
            )
          )
      )
      ORDER BY ne.received_at DESC NULLS LAST, ne.id DESC
      LIMIT 10
    `;

    const diagnosticSql = `
      SELECT
        latest.*,
        v.nickname AS vehicle_nickname
      FROM vehicles v
      JOIN LATERAL (
        SELECT
          s.id,
          s.service_name,
          s.vin,
          s.imei,
          s.nickname,
          s.mil_on,
          s.mil_last_updated,
          s.qualified_dtc_list,
          s.dtc_count,
          s.vehicle_last_updated,
          s.captured_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.vin IS NOT NULL
          AND s.vin <> ''
          AND LOWER(s.vin) = LOWER(v.vin)
        ORDER BY COALESCE(s.vehicle_last_updated, s.mil_last_updated, s.captured_at) DESC NULLS LAST,
          s.id DESC
        LIMIT 1
      ) latest ON true
      WHERE COALESCE(v.is_active, true) = true
        AND (
          COALESCE(latest.mil_on, false) = true
          OR COALESCE(latest.dtc_count, 0) > 0
          OR (
            jsonb_typeof(COALESCE(latest.qualified_dtc_list, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(latest.qualified_dtc_list, '[]'::jsonb)) > 0
          )
        )
      ORDER BY COALESCE(latest.vehicle_last_updated, latest.mil_last_updated, latest.captured_at) DESC NULLS LAST
      LIMIT 10
    `;

    const maintenanceSql = `
      WITH active_maintenance_tasks AS (
        SELECT mt.*
        FROM maintenance_tasks mt
        WHERE mt.status = ANY($1::text[])
          AND NOT EXISTS (
            SELECT 1
            FROM maintenance_events me
            JOIN maintenance_rules mr
              ON mr.id = me.rule_id
            WHERE me.vehicle_vin = mt.vehicle_vin
              AND me.result IN ('pass', 'performed', 'measured', 'not_applicable')
              AND COALESCE(me.performed_at, me.created_at) >= mt.created_at
              AND (
                mt.rule_id = me.rule_id
                OR (
                  COALESCE(mt.trigger_context->>'ruleCode', '') <> ''
                  AND mr.rule_code = mt.trigger_context->>'ruleCode'
                )
              )
          )
      ),
      open_vehicle_tasks AS (
        SELECT
          COALESCE(
            NULLIF(v.turo_vehicle_id, ''),
            NULLIF(CAST(related_trip.turo_vehicle_id AS text), ''),
            NULLIF(mt.vehicle_vin, ''),
            LOWER(NULLIF(COALESCE(v.nickname, related_trip.vehicle_name, mt.vehicle_vin), ''))
          ) AS vehicle_key,
          COALESCE(v.nickname, related_trip.vehicle_name, mt.vehicle_vin) AS vehicle_name,
          mt.vehicle_vin,
          COUNT(*) AS open_task_count,
          MAX(mt.created_at) AS latest_task_created_at,
          jsonb_agg(
            jsonb_build_object(
              'id', mt.id,
              'title', mt.title,
              'description', mt.description,
              'task_type', mt.task_type,
              'priority', mt.priority,
              'status', mt.status,
              'blocks_rental', mt.blocks_rental,
              'blocks_guest_export', mt.blocks_guest_export,
              'needs_review', mt.needs_review,
              'trigger_context', mt.trigger_context
            )
            ORDER BY
              CASE mt.priority
                WHEN 'urgent' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                ELSE 5
              END,
              mt.created_at DESC,
              mt.id DESC
          ) AS tasks
        FROM active_maintenance_tasks mt
        LEFT JOIN vehicles v
          ON v.vin = mt.vehicle_vin
        LEFT JOIN trips related_trip
          ON related_trip.id = mt.related_trip_id
        WHERE COALESCE(v.is_active, true) = true
          AND COALESCE(v.in_service, true) = true
        GROUP BY
          COALESCE(
            NULLIF(v.turo_vehicle_id, ''),
            NULLIF(CAST(related_trip.turo_vehicle_id AS text), ''),
            NULLIF(mt.vehicle_vin, ''),
            LOWER(NULLIF(COALESCE(v.nickname, related_trip.vehicle_name, mt.vehicle_vin), ''))
          ),
          COALESCE(v.nickname, related_trip.vehicle_name, mt.vehicle_vin),
          mt.vehicle_vin
      ),
      scheduled_vehicle_tasks AS (
        SELECT
          open_vehicle_tasks.vehicle_key,
          COALESCE(next_trip.id, active_trip.id) AS trip_id,
          COALESCE(next_trip.reservation_id, active_trip.reservation_id) AS reservation_id,
          COALESCE(next_trip.guest_name, active_trip.guest_name) AS guest_name,
          COALESCE(next_trip.trip_start, active_trip.trip_start) AS trip_start,
          COALESCE(next_trip.trip_end, active_trip.trip_end) AS trip_end,
          COALESCE(next_trip.workflow_stage, active_trip.workflow_stage) AS workflow_stage,
          COALESCE(next_trip.status, active_trip.status) AS trip_status,
          open_vehicle_tasks.vehicle_name,
          open_vehicle_tasks.vehicle_vin,
          CASE
            WHEN active_trip.id IS NOT NULL THEN active_trip.trip_end
            ELSE next_trip.trip_start
          END AS maintenance_available_at,
          open_vehicle_tasks.open_task_count,
          open_vehicle_tasks.latest_task_created_at,
          open_vehicle_tasks.tasks
        FROM open_vehicle_tasks
        LEFT JOIN LATERAL (
          SELECT
            active.id,
            active.reservation_id,
            active.guest_name,
            active.trip_start,
            active.trip_end,
            active.workflow_stage,
            active.status
          FROM trips active
          LEFT JOIN vehicles active_v
            ON active_v.turo_vehicle_id = active.turo_vehicle_id
          WHERE active.trip_start <= NOW()
            AND active.trip_end > NOW()
            AND COALESCE(active.workflow_stage, '') NOT IN ('complete', 'closed', 'canceled')
            AND COALESCE(active.status, '') <> 'canceled'
            AND COALESCE(active.closed_out, false) = false
            AND (
              (
                active.turo_vehicle_id IS NOT NULL
                AND NULLIF(CAST(active.turo_vehicle_id AS text), '') = open_vehicle_tasks.vehicle_key
              )
              OR (
                open_vehicle_tasks.vehicle_vin IS NOT NULL
                AND active_v.vin = open_vehicle_tasks.vehicle_vin
              )
              OR (
                COALESCE(active.vehicle_name, '') <> ''
                AND LOWER(active.vehicle_name) = LOWER(open_vehicle_tasks.vehicle_name)
              )
            )
          ORDER BY active.trip_start ASC NULLS LAST, active.id ASC
          LIMIT 1
        ) active_trip ON true
        LEFT JOIN LATERAL (
          SELECT
            upcoming.id,
            upcoming.reservation_id,
            upcoming.guest_name,
            upcoming.trip_start,
            upcoming.trip_end,
            upcoming.workflow_stage,
            upcoming.status
          FROM trips upcoming
          LEFT JOIN vehicles upcoming_v
            ON upcoming_v.turo_vehicle_id = upcoming.turo_vehicle_id
          WHERE active_trip.id IS NULL
            AND upcoming.trip_start > NOW()
            AND COALESCE(upcoming.workflow_stage, '') NOT IN ('complete', 'closed', 'canceled')
            AND COALESCE(upcoming.status, '') <> 'canceled'
            AND COALESCE(upcoming.closed_out, false) = false
            AND (
              (
                upcoming.turo_vehicle_id IS NOT NULL
                AND NULLIF(CAST(upcoming.turo_vehicle_id AS text), '') = open_vehicle_tasks.vehicle_key
              )
              OR (
                open_vehicle_tasks.vehicle_vin IS NOT NULL
                AND upcoming_v.vin = open_vehicle_tasks.vehicle_vin
              )
              OR (
                COALESCE(upcoming.vehicle_name, '') <> ''
                AND LOWER(upcoming.vehicle_name) = LOWER(open_vehicle_tasks.vehicle_name)
              )
            )
          ORDER BY upcoming.trip_start ASC NULLS LAST, upcoming.id ASC
          LIMIT 1
        ) next_trip ON true
        WHERE COALESCE(next_trip.id, active_trip.id) IS NOT NULL
      )
      SELECT *
      FROM scheduled_vehicle_tasks
    `;

    const handoffSql = `
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        v.nickname AS vehicle_nickname,
        t.trip_start,
        t.trip_end,
        t.stage_updated_at,
        t.workflow_stage,
        t.status AS trip_status
      FROM trips t
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(v.nickname) = LOWER(t.vehicle_name)
        )
      WHERE t.trip_start > NOW()
        AND t.trip_start <= NOW() + INTERVAL '12 hours'
        AND COALESCE(t.workflow_stage, '') = 'confirmed'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
      ORDER BY t.trip_start ASC NULLS LAST, t.id ASC
    `;

    const inspectionExportSql = `
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        v.nickname AS vehicle_nickname,
        v.vin AS vehicle_vin,
        t.trip_start,
        t.trip_end,
        t.stage_updated_at,
        t.workflow_stage,
        t.status AS trip_status
      FROM trips t
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(v.nickname) = LOWER(t.vehicle_name)
        )
      WHERE t.trip_start > NOW() - INTERVAL '2 hours'
        AND t.trip_start <= NOW() + INTERVAL '24 hours'
        AND COALESCE(t.workflow_stage, '') = 'ready_for_handoff'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
      ORDER BY t.trip_start ASC NULLS LAST, t.id ASC
    `;

    const closeoutSql = `
      WITH closeout_candidates AS (
        SELECT
          t.id AS trip_id,
          t.reservation_id,
          t.guest_name,
          t.vehicle_name,
          v.nickname AS vehicle_nickname,
          v.vin AS vehicle_vin,
          t.turo_vehicle_id,
          t.trip_start,
          t.trip_end,
          t.workflow_stage,
          t.status AS trip_status,
          t.closed_out,
          t.starting_odometer,
          t.ending_odometer,
          t.expense_status,
          t.has_tolls,
          t.toll_count,
          t.toll_total,
          t.toll_review_status
        FROM trips t
        LEFT JOIN vehicles v
          ON (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
        WHERE t.trip_end <= NOW() - INTERVAL '24 hours'
          AND t.trip_end >= NOW() - INTERVAL '45 days'
          AND COALESCE(t.workflow_stage, '') <> 'canceled'
          AND COALESCE(t.status, '') <> 'canceled'
      ),
      candidate_vins AS (
        SELECT DISTINCT LOWER(vehicle_vin) AS vin_key
        FROM closeout_candidates
        WHERE vehicle_vin IS NOT NULL
      ),
      latest_fuel AS (
        SELECT DISTINCT ON (LOWER(s.vin))
          LOWER(s.vin) AS vin_key,
          s.fuel_level,
          s.service_name,
          COALESCE(s.fuel_level_last_updated, s.vehicle_last_updated, s.captured_at) AS fuel_at
        FROM vehicle_telemetry_snapshots s
        JOIN candidate_vins cv
          ON cv.vin_key = LOWER(s.vin)
        WHERE s.fuel_level IS NOT NULL
        ORDER BY
          LOWER(s.vin),
          COALESCE(s.fuel_level_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST,
          s.id DESC
      )
      SELECT
        c.trip_id,
        c.reservation_id,
        c.guest_name,
        c.vehicle_name,
        c.vehicle_nickname,
        c.trip_start,
        c.trip_end,
        c.workflow_stage,
        c.trip_status,
        c.closed_out,
        c.starting_odometer,
        c.ending_odometer,
        c.expense_status,
        c.has_tolls,
        c.toll_count,
        c.toll_total,
        c.toll_review_status,
        latest_fuel.fuel_level AS latest_fuel_level,
        latest_fuel.service_name AS latest_fuel_source,
        latest_fuel.fuel_at AS latest_fuel_at,
        next_trip.trip_start AS next_trip_start,
        next_trip.guest_name AS next_guest_name,
        (
          latest_fuel.fuel_level < 97
          AND (
            next_trip.trip_start IS NULL
            OR next_trip.trip_start > NOW()
          )
        ) AS fuel_reminder_pending,
        COALESCE(c.workflow_stage, '') NOT IN ('complete', 'closed') AS workflow_incomplete,
        c.starting_odometer IS NULL AS missing_starting_odometer,
        c.ending_odometer IS NULL AS missing_ending_odometer,
        COALESCE(c.expense_status, '') IN ('', 'pending', 'needs_review') AS expenses_pending,
        (
          (
            COALESCE(c.has_tolls, false) = true
            OR COALESCE(c.toll_count, 0) > 0
            OR COALESCE(c.toll_total, 0) > 0
          )
          AND COALESCE(c.toll_review_status, '') NOT IN ('billed', 'waived')
        ) AS tolls_pending,
        COALESCE(c.closed_out, false) = false AS closeout_flag_incomplete
      FROM closeout_candidates c
      LEFT JOIN latest_fuel
        ON c.vehicle_vin IS NOT NULL
        AND latest_fuel.vin_key = LOWER(c.vehicle_vin)
      LEFT JOIN LATERAL (
        SELECT nt.trip_start, nt.guest_name
        FROM trips nt
        WHERE nt.id <> c.trip_id
          AND nt.trip_start > c.trip_end
          AND COALESCE(nt.workflow_stage, '') <> 'canceled'
          AND COALESCE(nt.status, '') <> 'canceled'
          AND (
            (
              nt.turo_vehicle_id IS NOT NULL
              AND c.turo_vehicle_id IS NOT NULL
              AND CAST(nt.turo_vehicle_id AS text) = CAST(c.turo_vehicle_id AS text)
            )
            OR (
              COALESCE(nt.vehicle_name, '') <> ''
              AND COALESCE(c.vehicle_nickname, '') <> ''
              AND LOWER(nt.vehicle_name) = LOWER(c.vehicle_nickname)
            )
          )
        ORDER BY nt.trip_start ASC
        LIMIT 1
      ) next_trip ON true
      WHERE
        COALESCE(c.closed_out, false) = false
          OR
          COALESCE(c.workflow_stage, '') NOT IN ('complete', 'closed')
          OR c.starting_odometer IS NULL
          OR c.ending_odometer IS NULL
          OR COALESCE(c.expense_status, '') IN ('', 'pending', 'needs_review')
          OR (
            (
              COALESCE(c.has_tolls, false) = true
              OR COALESCE(c.toll_count, 0) > 0
              OR COALESCE(c.toll_total, 0) > 0
            )
            AND COALESCE(c.toll_review_status, '') NOT IN ('billed', 'waived')
          )
          OR (
            latest_fuel.fuel_level < 97
            AND (
              next_trip.trip_start IS NULL
              OR next_trip.trip_start > NOW()
            )
          )
      ORDER BY c.trip_end DESC NULLS LAST, c.trip_id DESC
      LIMIT 25
    `;

    const lateTollSql = `
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        v.nickname AS vehicle_nickname,
        t.trip_start,
        t.trip_end,
        t.workflow_stage,
        t.status AS trip_status,
        t.toll_review_status,
        t.toll_charged_total,
        COUNT(tc.id)::integer AS late_toll_count,
        COALESCE(SUM(tc.amount), 0)::numeric(10,2) AS late_toll_total,
        MIN(tc.created_at) AS first_recorded_at,
        MAX(tc.created_at) AS latest_recorded_at,
        MIN(tc.trxn_at) AS first_transaction_at,
        MAX(tc.trxn_at) AS latest_transaction_at,
        EXTRACT(EPOCH FROM (MAX(tc.created_at) - t.trip_end)) / 3600.0 AS hours_after_trip_end
      FROM trips t
      JOIN toll_charges tc
        ON tc.matched_trip_id = t.id
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(v.nickname) = LOWER(t.vehicle_name)
        )
      WHERE t.trip_end < NOW()
        AND t.trip_end >= NOW() - INTERVAL '90 days'
        AND tc.created_at > t.trip_end
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.toll_review_status, '') NOT IN ('billed', 'waived')
      GROUP BY
        t.id,
        v.nickname
      HAVING COALESCE(SUM(tc.amount), 0) > 0
      ORDER BY MAX(tc.created_at) DESC NULLS LAST, t.trip_end DESC NULLS LAST
      LIMIT 25
    `;

    const overlapSql = `
      WITH candidate_trips AS (
        SELECT
          t.id,
          t.reservation_id,
          t.guest_name,
          t.vehicle_name,
          t.trip_start,
          t.trip_end,
          t.workflow_stage,
          t.status,
          t.turo_vehicle_id,
          COALESCE(v.nickname, t.vehicle_name) AS vehicle_nickname,
          COALESCE(
            NULLIF(CAST(t.turo_vehicle_id AS text), ''),
            LOWER(NULLIF(COALESCE(v.nickname, t.vehicle_name), ''))
          ) AS vehicle_key
        FROM trips t
        LEFT JOIN vehicles v
          ON (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
        WHERE t.trip_start IS NOT NULL
          AND t.trip_end IS NOT NULL
          AND COALESCE(t.workflow_stage, '') <> 'canceled'
          AND COALESCE(t.status, '') <> 'canceled'
          AND t.trip_end >= NOW() - INTERVAL '60 days'
      )
      SELECT
        earlier.id AS primary_trip_id,
        earlier.reservation_id AS primary_reservation_id,
        earlier.guest_name AS primary_guest_name,
        earlier.vehicle_name AS primary_vehicle_name,
        earlier.vehicle_nickname,
        earlier.trip_start AS primary_trip_start,
        earlier.trip_end AS primary_trip_end,
        earlier.workflow_stage AS primary_workflow_stage,
        earlier.status AS primary_trip_status,
        later.id AS secondary_trip_id,
        later.reservation_id AS secondary_reservation_id,
        later.guest_name AS secondary_guest_name,
        later.vehicle_name AS secondary_vehicle_name,
        later.trip_start AS secondary_trip_start,
        later.trip_end AS secondary_trip_end,
        GREATEST(earlier.trip_start, later.trip_start) AS overlap_start,
        LEAST(earlier.trip_end, later.trip_end) AS overlap_end
      FROM candidate_trips earlier
      JOIN candidate_trips later
        ON later.vehicle_key = earlier.vehicle_key
        AND later.id > earlier.id
        AND earlier.trip_start < later.trip_end
        AND later.trip_start < earlier.trip_end
      ORDER BY
        GREATEST(earlier.trip_start, later.trip_start) ASC,
        earlier.id ASC,
        later.id ASC
      LIMIT 25
    `;

    const [
      handoffResult,
      inspectionExportResult,
      closeoutResult,
      lateTollResult,
      overlapResult,
      messagesResult,
      unmatchedNotificationsResult,
      diagnosticResult,
      maintenanceResult,
    ] = await Promise.all([
      timeQueueQuery(queueTimings, "handoff", db.query(handoffSql)),
      timeQueueQuery(queueTimings, "inspectionExport", db.query(inspectionExportSql)),
      fast
        ? Promise.resolve(EMPTY_QUERY_RESULT)
        : timeQueueQuery(queueTimings, "closeout", db.query(closeoutSql)),
      fast
        ? Promise.resolve(EMPTY_QUERY_RESULT)
        : timeQueueQuery(queueTimings, "lateToll", db.query(lateTollSql)),
      fast
        ? Promise.resolve(EMPTY_QUERY_RESULT)
        : timeQueueQuery(queueTimings, "overlap", db.query(overlapSql)),
      timeQueueQuery(
        queueTimings,
        fast ? "messagesFast" : "messages",
        db.query(fast ? fastMessagesSql : messagesSql, [candidateLimit])
      ),
      timeQueueQuery(
        queueTimings,
        "unmatchedNotifications",
        db.query(unmatchedNotificationsSql)
      ),
      timeQueueQuery(queueTimings, "diagnostics", db.query(diagnosticSql)),
      fast
        ? Promise.resolve(EMPTY_QUERY_RESULT)
        : timeQueueQuery(
            queueTimings,
            "maintenance",
            db.query(maintenanceSql, [OPEN_MAINTENANCE_TASK_STATUSES])
          ),
    ]);

    messagesResult.rows.forEach((row) => {
      row.pickup_location = extractPickupLocationFromNoticeText(
        row.normalized_text_body || row.subject || ""
      );
    });
    const handoffNotices = handoffResult.rows.map(mapHandoffNoticeRow);
    const inspectionExportNotices = inspectionExportResult.rows.map(
      mapInspectionExportNoticeRow
    );
    const maintenanceNotices = maintenanceResult.rows.map(mapMaintenanceNoticeRow);
    const prepTaskTripIds = new Set(
      [...handoffNotices, ...inspectionExportNotices]
        .map((row) => row.trip_id)
        .filter((id) => id != null)
        .map((id) => Number(id))
    );
    const visibleMessageRows = messagesResult.rows.filter(
      (row) =>
        !(
          row.trip_id &&
          prepTaskTripIds.has(Number(row.trip_id)) &&
          isRedundantPrepNotice(row)
        )
    );
    const attachedHandoffNotices = attachMaintenanceToPrepNotices(
      handoffNotices,
      maintenanceNotices
    );
    const attachedInspectionExportNotices = attachMaintenanceToPrepNotices(
      inspectionExportNotices,
      maintenanceNotices
    );
    const visibleMaintenanceNotices = maintenanceNotices.filter(
      (item) => !prepTaskTripIds.has(Number(item.trip_id))
    );

    const queueItems = compactGuestMessageThreads([
      ...attachedHandoffNotices,
      ...attachedInspectionExportNotices,
      ...closeoutResult.rows.map(mapCloseoutNoticeRow),
      ...lateTollResult.rows.map(mapLateTollNoticeRow),
      ...overlapResult.rows.map(mapTripOverlapNoticeRow),
      ...visibleMessageRows.map(mapMessageRow),
      ...unmatchedNotificationsResult.rows.map(mapUnmatchedNotificationRow),
      ...diagnosticResult.rows.map(mapVehicleDiagnosticNoticeRow),
      ...visibleMaintenanceNotices,
    ])
      .sort(compareQueueItems)
      .slice(0, limit);

    setQueueTimingHeader(res, queueStartedAt, queueTimings);
    maybeLogQueueTimings(queueStartedAt, queueTimings, queueItems.length);
    setMessageQueueCache(cacheKey, queueItems);
    if (includeDebug) {
      return res.json({
        items: queueItems,
        debugTiming: buildQueueDebugTiming(res, queueStartedAt, queueTimings),
      });
    }
    res.json(queueItems);
  } catch (err) {
    console.error("messages endpoint failed:", err);
    res.status(500).json({ error: "failed to load messages" });
  }
});

router.patch("/notifications/:id/ack", async (req, res) => {
  try {
    await ensureNotificationAckColumns();

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid notification id" });
    }

    const reason =
      typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 120)
        : "acknowledged";

    const result = await db.query(
      `
        UPDATE notification_events
        SET
          acknowledged_at = NOW(),
          acknowledged_by = 'dashboard',
          acknowledged_reason = $2
        WHERE id = $1
        RETURNING id, acknowledged_at, acknowledged_reason
      `,
      [id, reason]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "notification not found" });
    }

    invalidateMessageCaches();
    res.json(result.rows[0]);
  } catch (err) {
    console.error("ack notification failed:", err);
    res.status(500).json({ error: "failed to acknowledge notification" });
  }
});

router.patch("/maintenance/resolve", async (req, res) => {
  try {
    const taskIds = Array.isArray(req.body?.task_ids)
      ? req.body.task_ids
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      : [];

    if (!taskIds.length) {
      return res.status(400).json({ error: "task_ids are required" });
    }

    const result = await db.query(
      `
        UPDATE maintenance_tasks
        SET
          status = 'resolved',
          updated_at = NOW()
        WHERE id = ANY($1::bigint[])
          AND status IN ('open', 'scheduled', 'in_progress', 'deferred')
        RETURNING id, status
      `,
      [taskIds]
    );

    invalidateMessageCaches();
    res.json({
      ok: true,
      resolved_count: result.rowCount,
      resolved: result.rows,
    });
  } catch (err) {
    console.error("resolve maintenance tasks failed:", err);
    res.status(500).json({ error: "failed to resolve maintenance tasks" });
  }
});

router.patch("/:id/read", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid message id" });
    }

    const sql = `
      UPDATE messages
      SET status = 'read'
      WHERE id = $1
      RETURNING id, status
    `;

    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "message not found" });
    }

    invalidateMessageCaches();
    res.json({
      success: true,
      id: result.rows[0].id,
      status: result.rows[0].status,
    });
  } catch (err) {
    console.error("mark as read failed:", err);
    res.status(500).json({ error: "failed to mark message as read" });
  }
});

router.get("/:id", async (req, res) => {
  try {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "invalid message id" });
    }

const sql = `
  SELECT
    id,
    message_id,
    subject,
    created_at,
    status,
    mailbox,
    imap_uid,
    from_header,
    to_header,
    date_header,
    message_timestamp,
    content_type_header,
    flags,
    ingested_at,
    amount,
    normalized_text_body,
    html_body,
    guest_name,
    guest_phone,
    guest_profile_url,
    vehicle_name,
    vehicle_year,
    reservation_id,
    trip_start,
    trip_end,
    mileage_included,
    guest_message,
    reply_url,
    trip_details_url,
    message_type,
    vehicle_listing_id
  FROM messages
  WHERE id = $1
  LIMIT 1
`;

    const result = await db.query(sql, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "message not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("message detail endpoint failed:", err);
    res.status(500).json({ error: "failed to load message" });
  }
});


module.exports = router;



