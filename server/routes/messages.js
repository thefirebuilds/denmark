const express = require("express");
const router = express.Router();
const db = require("../db");

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

function messageQueueRank(item) {
  if (item.type === "notification_unmatched") return -2;
  if (item.type === "handoff_ready_required") return -1;
  if (item.status === "unread") return 0;
  if (item.type === "trip_overlap_detected") return 1;
  if (item.type === "late_toll_unbilled") return 1;
  if (item.type === "closeout_required") return 1;
  if (item.type === "inspection_export_required") return 2;
  if (item.type === "trip_booked" && item.is_booking_confirmation_task) return 2;
  if (item.type === "maintenance_required") return 3;
  return 3;
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
    is_booking_confirmation_task: isBookingTask,
    reply_url: row.reply_url,
    trip_details_url: row.trip_details_url,
    parsed: parseSubject(row.subject),
  };
}

function mapUnmatchedNotificationRow(row) {
  const title = row.title || row.classification || "Turo notification";
  const body = row.body || row.big_text || row.sub_text || "";

  return {
    id: `notification-gap:${row.id}`,
    messageId: `notification-gap:${row.id}`,
    subject: `Bridge notification missing email: ${title}`,
    status: "read",
    timestamp: row.posted_at || row.received_at,
    notification_created_at: row.received_at || row.posted_at,
    type: "notification_unmatched",
    notification_event_id: row.id,
    notification_classification: row.classification,
    notification_title: row.title,
    notification_body: body,
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
  const taskLabel = `${row.open_task_count} maintenance planning item${
    Number(row.open_task_count) === 1 ? "" : "s"
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
    maintenance_task_count: Number(row.open_task_count || 0),
    maintenance_tasks: tasks,
    created_at: row.latest_task_created_at,
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
  try {
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'unread') AS unread_count,
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
        (
          SELECT COUNT(*)
          FROM (
            SELECT
              ne.*,
              COALESCE(ne.posted_at, ne.received_at) AS event_at,
              LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) AS notification_text,
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
                NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '’s trip with your', 1), '^.* ', ''), ''),
                NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '''s trip with your', 1), '^.* ', ''), '')
              ) AS booked_guest_name,
              substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'trip with your ([^.]+) is booked') AS booked_vehicle_name,
              CASE
                WHEN ne.title LIKE 'Change requested to % trip'
                THEN NULLIF(
                  split_part(
                    split_part(replace(ne.title, 'Change requested to ', ''), ' trip', 1),
                    '’',
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
              AND ne.received_at >= NOW() - INTERVAL '7 days'
              AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%prepare for checkout%'
              AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%complete checkout when your car is returned%'
              AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%has added a driver%'
              AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%additional driver%'
              AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%added another driver%'
          ) ne
          WHERE NOT EXISTS (
              SELECT 1
              FROM messages m
              WHERE (
                  ne.reservation_id IS NOT NULL
                  AND m.reservation_id IS NOT NULL
                  AND m.reservation_id = ne.reservation_id
                )
                OR (
                  ne.reservation_id IS NULL
                  AND COALESCE(ne.guest_name, '') <> ''
                  AND COALESCE(ne.vehicle_name, '') <> ''
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    COALESCE(ne.posted_at, ne.received_at) - INTERVAL '24 hours'
                    AND COALESCE(ne.posted_at, ne.received_at) + INTERVAL '24 hours'
                  AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.guest_name) || '%'
                  AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.vehicle_name) || '%'
                )
                OR (
                  (
                    ne.notification_text LIKE '%earnings payment%'
                    OR ne.notification_text LIKE '%cha-ching%'
                    OR ne.notification_text LIKE '%you’ve been paid%'
                    OR ne.notification_text LIKE '%you''ve been paid%'
                  )
                  AND m.message_type = 'payment_notice'
                  AND (
                    (
                      ne.event_amount IS NOT NULL
                      AND m.amount IS NOT NULL
                      AND m.amount = ne.event_amount
                    )
                    OR COALESCE(m.message_timestamp, m.created_at) BETWEEN
                      ne.event_at - INTERVAL '24 hours'
                      AND ne.event_at + INTERVAL '24 hours'
                  )
                )
                OR (
                  (
                    ne.notification_text LIKE '%paid the invoice%'
                    OR ne.notification_text LIKE '%reimbursement invoice%'
                    OR ne.notification_text LIKE '%paid now%'
                  )
                  AND m.message_type IN ('reimbursement_invoice', 'guest_message')
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    ne.event_at - INTERVAL '24 hours'
                    AND ne.event_at + INTERVAL '24 hours'
                  AND (
                    (
                      COALESCE(ne.guest_name, ne.paid_now_guest_name, '') <> ''
                      AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                        LIKE '%' || LOWER(COALESCE(ne.guest_name, ne.paid_now_guest_name)) || '%'
                    )
                    OR (
                      COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name, '') <> ''
                      AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
                        LIKE '%' || LOWER(COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name)) || '%'
                    )
                    OR (
                      COALESCE(ne.paid_invoice_guest_name, '') <> ''
                      AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                        LIKE '%' || LOWER(ne.paid_invoice_guest_name) || '%'
                    )
                  )
                )
                OR (
                  COALESCE(ne.paid_now_guest_name, '') <> ''
                  AND COALESCE(ne.paid_now_vehicle_name, '') <> ''
                  AND m.message_type = 'guest_message'
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    ne.event_at - INTERVAL '24 hours'
                    AND ne.event_at + INTERVAL '24 hours'
                  AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.paid_now_guest_name) || '%'
                  AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.paid_now_vehicle_name) || '%'
                )
                OR (
                  COALESCE(ne.rated_guest_name, '') <> ''
                  AND m.message_type IN ('trip_rated', 'turo_notification')
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    ne.event_at - INTERVAL '24 hours'
                    AND ne.event_at + INTERVAL '24 hours'
                  AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.rated_guest_name) || '%'
                )
                OR (
                  COALESCE(ne.change_request_guest_name, '') <> ''
                  AND m.message_type IN ('trip_changed', 'turo_notification')
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    ne.event_at - INTERVAL '24 hours'
                    AND ne.event_at + INTERVAL '24 hours'
                  AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.change_request_guest_name) || '%'
                )
                OR (
                  COALESCE(ne.trip_changed_guest_name, '') <> ''
                  AND m.message_type IN ('trip_changed', 'turo_notification')
                  AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
                    ne.event_at - INTERVAL '24 hours'
                    AND ne.event_at + INTERVAL '24 hours'
                  AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                    LIKE '%' || LOWER(ne.trip_changed_guest_name) || '%'
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
                    FROM trips returned_trip
                    WHERE LOWER(COALESCE(returned_trip.guest_name, '')) = LOWER(ne.returned_guest_name)
                      AND returned_trip.trip_end BETWEEN
                        ne.event_at - INTERVAL '3 days'
                        AND ne.event_at + INTERVAL '36 hours'
                      AND COALESCE(returned_trip.workflow_stage, '') <> 'canceled'
                      AND COALESCE(returned_trip.status, '') <> 'canceled'
                      AND (
                        COALESCE(returned_trip.workflow_stage, '') IN ('complete', 'closed')
                        OR COALESCE(returned_trip.status, '') IN ('complete', 'completed', 'closed')
                        OR COALESCE(returned_trip.closed_out, false) = true
                      )
                  )
                )
            )
        ) AS unmatched_notification_count
      FROM messages
    `;

    const result = await db.query(sql);
    const row = result.rows[0];

    res.json({
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
    });
  } catch (err) {
    console.error("message stats endpoint failed:", err);
    res.status(500).json({ error: "failed to load message stats" });
  }
});

router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const candidateLimit = Math.max(limit * 20, 100);

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
        WHERE
          m.status = 'unread'
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

    const unmatchedNotificationsSql = `
      WITH candidate_notifications AS (
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
            NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '’s trip with your', 1), '^.* ', ''), ''),
            NULLIF(regexp_replace(split_part(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text), '''s trip with your', 1), '^.* ', ''), '')
          ) AS booked_guest_name,
          substring(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text) from 'trip with your ([^.]+) is booked') AS booked_vehicle_name,
          CASE
            WHEN ne.title LIKE 'Change requested to % trip'
            THEN NULLIF(
              split_part(
                split_part(replace(ne.title, 'Change requested to ', ''), ' trip', 1),
                '’',
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
          AND ne.received_at >= NOW() - INTERVAL '7 days'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%prepare for checkout%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%complete checkout when your car is returned%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%has added a driver%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%additional driver%'
          AND LOWER(CONCAT_WS(' ', ne.title, ne.body, ne.big_text, ne.sub_text)) NOT LIKE '%added another driver%'
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
        FROM messages m
        WHERE (
            ne.reservation_id IS NOT NULL
            AND m.reservation_id IS NOT NULL
            AND m.reservation_id = ne.reservation_id
          )
          OR (
            ne.reservation_id IS NULL
            AND COALESCE(ne.guest_name, '') <> ''
            AND COALESCE(ne.vehicle_name, '') <> ''
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.guest_name) || '%'
            AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.vehicle_name) || '%'
          )
          OR (
            (
              ne.notification_text LIKE '%earnings payment%'
              OR ne.notification_text LIKE '%cha-ching%'
              OR ne.notification_text LIKE '%you’ve been paid%'
              OR ne.notification_text LIKE '%you''ve been paid%'
            )
            AND m.message_type = 'payment_notice'
            AND (
              (
                ne.event_amount IS NOT NULL
                AND m.amount IS NOT NULL
                AND m.amount = ne.event_amount
              )
              OR COALESCE(m.message_timestamp, m.created_at) BETWEEN
                ne.event_at - INTERVAL '24 hours'
                AND ne.event_at + INTERVAL '24 hours'
            )
          )
          OR (
            COALESCE(ne.paid_now_guest_name, '') <> ''
            AND COALESCE(ne.paid_now_vehicle_name, '') <> ''
            AND m.message_type = 'guest_message'
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.paid_now_guest_name) || '%'
            AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.paid_now_vehicle_name) || '%'
          )
          OR (
            (
              ne.notification_text LIKE '%paid the invoice%'
              OR ne.notification_text LIKE '%reimbursement invoice%'
              OR ne.notification_text LIKE '%paid now%'
            )
            AND m.message_type IN ('reimbursement_invoice', 'guest_message')
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND (
              (
                COALESCE(ne.guest_name, ne.paid_now_guest_name, '') <> ''
                AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                  LIKE '%' || LOWER(COALESCE(ne.guest_name, ne.paid_now_guest_name)) || '%'
              )
              OR (
                COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name, '') <> ''
                AND LOWER(COALESCE(m.vehicle_name, m.subject, m.normalized_text_body, ''))
                  LIKE '%' || LOWER(COALESCE(ne.vehicle_name, ne.paid_now_vehicle_name)) || '%'
              )
              OR (
                COALESCE(ne.paid_invoice_guest_name, '') <> ''
                AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
                  LIKE '%' || LOWER(ne.paid_invoice_guest_name) || '%'
              )
            )
          )
          OR (
            COALESCE(ne.rated_guest_name, '') <> ''
            AND m.message_type IN ('trip_rated', 'turo_notification')
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.rated_guest_name) || '%'
          )
          OR (
            COALESCE(ne.change_request_guest_name, '') <> ''
            AND m.message_type IN ('trip_changed', 'turo_notification')
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.change_request_guest_name) || '%'
          )
          OR (
            COALESCE(ne.trip_changed_guest_name, '') <> ''
            AND m.message_type IN ('trip_changed', 'turo_notification')
            AND COALESCE(m.message_timestamp, m.created_at) BETWEEN
              ne.event_at - INTERVAL '24 hours'
              AND ne.event_at + INTERVAL '24 hours'
            AND LOWER(COALESCE(m.guest_name, m.subject, m.normalized_text_body, ''))
              LIKE '%' || LOWER(ne.trip_changed_guest_name) || '%'
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

    const maintenanceSql = `
      WITH open_vehicle_tasks AS (
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
        FROM maintenance_tasks mt
        LEFT JOIN vehicles v
          ON v.vin = mt.vehicle_vin
        LEFT JOIN trips related_trip
          ON related_trip.id = mt.related_trip_id
        WHERE mt.status = ANY($1::text[])
          AND COALESCE(v.is_active, true) = true
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
        t.closed_out,
        t.starting_odometer,
        t.ending_odometer,
        t.expense_status,
        t.has_tolls,
        t.toll_count,
        t.toll_total,
        t.toll_review_status,
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
        COALESCE(t.workflow_stage, '') NOT IN ('complete', 'closed') AS workflow_incomplete,
        t.starting_odometer IS NULL AS missing_starting_odometer,
        t.ending_odometer IS NULL AS missing_ending_odometer,
        COALESCE(t.expense_status, '') IN ('', 'pending', 'needs_review') AS expenses_pending,
        (
          (
            COALESCE(t.has_tolls, false) = true
            OR COALESCE(t.toll_count, 0) > 0
            OR COALESCE(t.toll_total, 0) > 0
          )
          AND COALESCE(t.toll_review_status, '') NOT IN ('billed', 'waived')
        ) AS tolls_pending,
        COALESCE(t.closed_out, false) = false AS closeout_flag_incomplete
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
      LEFT JOIN LATERAL (
        SELECT
          s.fuel_level,
          s.service_name,
          COALESCE(s.fuel_level_last_updated, s.vehicle_last_updated, s.captured_at) AS fuel_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.fuel_level IS NOT NULL
          AND v.vin IS NOT NULL
          AND LOWER(s.vin) = LOWER(v.vin)
        ORDER BY COALESCE(s.fuel_level_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST,
          s.id DESC
        LIMIT 1
      ) latest_fuel ON true
      LEFT JOIN LATERAL (
        SELECT nt.trip_start, nt.guest_name
        FROM trips nt
        WHERE nt.id <> t.id
          AND nt.trip_start > t.trip_end
          AND COALESCE(nt.workflow_stage, '') <> 'canceled'
          AND COALESCE(nt.status, '') <> 'canceled'
          AND (
            (
              nt.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id IS NOT NULL
              AND CAST(nt.turo_vehicle_id AS text) = CAST(t.turo_vehicle_id AS text)
            )
            OR (
              COALESCE(nt.vehicle_name, '') <> ''
              AND COALESCE(v.nickname, '') <> ''
              AND LOWER(nt.vehicle_name) = LOWER(v.nickname)
            )
          )
        ORDER BY nt.trip_start ASC
        LIMIT 1
      ) next_trip ON true
      WHERE t.trip_end <= NOW() - INTERVAL '24 hours'
        AND t.trip_end >= NOW() - INTERVAL '45 days'
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND (
          COALESCE(t.closed_out, false) = false
          OR
          COALESCE(t.workflow_stage, '') NOT IN ('complete', 'closed')
          OR t.starting_odometer IS NULL
          OR t.ending_odometer IS NULL
          OR COALESCE(t.expense_status, '') IN ('', 'pending', 'needs_review')
          OR (
            (
              COALESCE(t.has_tolls, false) = true
              OR COALESCE(t.toll_count, 0) > 0
              OR COALESCE(t.toll_total, 0) > 0
            )
            AND COALESCE(t.toll_review_status, '') NOT IN ('billed', 'waived')
          )
          OR (
            latest_fuel.fuel_level < 97
            AND (
              next_trip.trip_start IS NULL
              OR next_trip.trip_start > NOW()
            )
          )
        )
      ORDER BY t.trip_end DESC NULLS LAST, t.id DESC
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
      maintenanceResult,
    ] = await Promise.all([
      db.query(handoffSql),
      db.query(inspectionExportSql),
      db.query(closeoutSql),
      db.query(lateTollSql),
      db.query(overlapSql),
      db.query(messagesSql, [candidateLimit]),
      db.query(unmatchedNotificationsSql),
      db.query(maintenanceSql, [OPEN_MAINTENANCE_TASK_STATUSES]),
    ]);

    const queueItems = [
      ...handoffResult.rows.map(mapHandoffNoticeRow),
      ...inspectionExportResult.rows.map(mapInspectionExportNoticeRow),
      ...closeoutResult.rows.map(mapCloseoutNoticeRow),
      ...lateTollResult.rows.map(mapLateTollNoticeRow),
      ...overlapResult.rows.map(mapTripOverlapNoticeRow),
      ...messagesResult.rows.map(mapMessageRow),
      ...unmatchedNotificationsResult.rows.map(mapUnmatchedNotificationRow),
      ...maintenanceResult.rows.map(mapMaintenanceNoticeRow),
    ]
      .sort(compareQueueItems)
      .slice(0, limit);

    res.json(queueItems);
  } catch (err) {
    console.error("messages endpoint failed:", err);
    res.status(500).json({ error: "failed to load messages" });
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
