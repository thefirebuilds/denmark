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
  if (item.type === "handoff_ready_required") return -1;
  if (item.status === "unread") return 0;
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
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    new_trip_end: row.trip_end,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_workflow_stage: row.trip_workflow_stage,
    trip_needs_review: row.trip_needs_review,
    trip_status: row.trip_status,
    trip_record_guest_name: row.trip_record_guest_name,
    trip_record_vehicle_name: row.trip_record_vehicle_name,
    trip_record_start: row.trip_record_start,
    trip_record_end: row.trip_record_end,
    trip_record_amount: row.trip_record_amount,
    trip_record_reservation_id: row.trip_record_reservation_id,
    is_booking_confirmation_task: isBookingTask,
    reply_url: row.reply_url,
    trip_details_url: row.trip_details_url,
    parsed: parseSubject(row.subject),
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
  const reasons = [];

  if (row.workflow_incomplete) reasons.push("advance workflow");
  if (row.missing_starting_odometer) reasons.push("starting odometer");
  if (row.missing_ending_odometer) reasons.push("ending odometer");
  if (row.expenses_pending) reasons.push("expense review");
  if (row.tolls_pending) reasons.push("toll billing");
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
    closeout_flag_incomplete: row.closeout_flag_incomplete,
    closeout_expense_status: row.expense_status,
    closeout_toll_review_status: row.toll_review_status,
    starting_odometer: row.starting_odometer,
    ending_odometer: row.ending_odometer,
    has_tolls: row.has_tolls,
    closed_out: row.closed_out,
    created_at: row.trip_end,
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
    : hasAfterReturnTasks || hasPostTripTasks || isActiveTrip
    ? `${taskLabel} after ${vehicleName} returns`
    : isUpcomingTrip
    ? `${taskLabel} before ${vehicleName} goes out`
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
        MAX(message_timestamp) AS last_received
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
        trip_start,
        trip_end,
        reservation_id,
        trip_id,
        trip_workflow_stage,
        trip_needs_review,
        trip_status,
        trip_record_guest_name,
        trip_record_vehicle_name,
        trip_record_start,
        trip_record_end,
        trip_record_amount,
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
          m.trip_start,
          m.trip_end,
          m.reservation_id,
          COALESCE(m.trip_id, t.id) AS trip_id,
          t.workflow_stage AS trip_workflow_stage,
          t.needs_review AS trip_needs_review,
          t.status AS trip_status,
          t.guest_name AS trip_record_guest_name,
          t.vehicle_name AS trip_record_vehicle_name,
          t.trip_start AS trip_record_start,
          t.trip_end AS trip_record_end,
          t.amount AS trip_record_amount,
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

    const maintenanceSql = `
      WITH trip_tasks AS (
        SELECT
          COALESCE(
            NULLIF(CAST(t.turo_vehicle_id AS text), ''),
            NULLIF(mt.vehicle_vin, ''),
            LOWER(NULLIF(COALESCE(v.nickname, t.vehicle_name, mt.vehicle_vin), ''))
          ) AS vehicle_key,
          t.id AS trip_id,
          t.reservation_id,
          t.guest_name,
          t.trip_start,
          t.trip_end,
          t.workflow_stage,
          t.status AS trip_status,
          COALESCE(v.nickname, t.vehicle_name, mt.vehicle_vin) AS vehicle_name,
          mt.vehicle_vin,
          COALESCE(
            (
              SELECT MIN(active.trip_end)
              FROM trips active
              LEFT JOIN vehicles active_v
                ON active_v.turo_vehicle_id = active.turo_vehicle_id
              WHERE COALESCE(active.workflow_stage, '') NOT IN ('complete', 'closed', 'canceled')
                AND COALESCE(active.status, '') <> 'canceled'
                AND COALESCE(active.closed_out, false) = false
                AND active.trip_start <= NOW()
                AND active.trip_end > NOW()
                AND (
                  (
                    t.turo_vehicle_id IS NOT NULL
                    AND active.turo_vehicle_id = t.turo_vehicle_id
                  )
                  OR (
                    mt.vehicle_vin IS NOT NULL
                    AND active_v.vin = mt.vehicle_vin
                  )
                  OR (
                    COALESCE(t.vehicle_name, '') <> ''
                    AND LOWER(COALESCE(active.vehicle_name, '')) = LOWER(t.vehicle_name)
                  )
                )
            ),
            NOW()
          ) AS maintenance_available_at,
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
        JOIN trips t
          ON t.id = mt.related_trip_id
        LEFT JOIN vehicles v
          ON v.vin = mt.vehicle_vin
        WHERE mt.status = ANY($1::text[])
          AND t.trip_end > NOW()
          AND COALESCE(t.workflow_stage, '') NOT IN ('complete', 'closed', 'canceled')
          AND COALESCE(t.status, '') <> 'canceled'
          AND COALESCE(t.closed_out, false) = false
        GROUP BY
          COALESCE(
            NULLIF(CAST(t.turo_vehicle_id AS text), ''),
            NULLIF(mt.vehicle_vin, ''),
            LOWER(NULLIF(COALESCE(v.nickname, t.vehicle_name, mt.vehicle_vin), ''))
          ),
          t.id,
          t.reservation_id,
          t.guest_name,
          t.trip_start,
          t.trip_end,
          t.workflow_stage,
          t.status,
          t.turo_vehicle_id,
          COALESCE(v.nickname, t.vehicle_name, mt.vehicle_vin),
          mt.vehicle_vin
      ),
      ranked_trip_tasks AS (
        SELECT
          trip_tasks.*,
          ROW_NUMBER() OVER (
            PARTITION BY vehicle_key
            ORDER BY
              trip_start ASC NULLS LAST,
              trip_id ASC
          ) AS rn
        FROM trip_tasks
      )
      SELECT *
      FROM ranked_trip_tasks
      WHERE rn = 1
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
        t.toll_review_status,
        COALESCE(t.workflow_stage, '') NOT IN ('complete', 'closed') AS workflow_incomplete,
        t.starting_odometer IS NULL AS missing_starting_odometer,
        t.ending_odometer IS NULL AS missing_ending_odometer,
        COALESCE(t.expense_status, '') IN ('', 'pending', 'needs_review') AS expenses_pending,
        (
          COALESCE(t.has_tolls, false) = true
          AND COALESCE(t.toll_review_status, '') IN ('', 'pending', 'needs_review')
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
      WHERE t.trip_end < NOW()
        AND t.trip_end >= NOW() - INTERVAL '45 days'
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
        AND (
          COALESCE(t.workflow_stage, '') NOT IN ('complete', 'closed')
          OR t.starting_odometer IS NULL
          OR t.ending_odometer IS NULL
          OR COALESCE(t.expense_status, '') IN ('', 'pending', 'needs_review')
          OR (
            COALESCE(t.has_tolls, false) = true
            AND COALESCE(t.toll_review_status, '') IN ('', 'pending', 'needs_review')
          )
        )
      ORDER BY t.trip_end DESC NULLS LAST, t.id DESC
      LIMIT 25
    `;

    const [
      handoffResult,
      inspectionExportResult,
      closeoutResult,
      messagesResult,
      maintenanceResult,
    ] = await Promise.all([
      db.query(handoffSql),
      db.query(inspectionExportSql),
      db.query(closeoutSql),
      db.query(messagesSql, [candidateLimit]),
      db.query(maintenanceSql, [OPEN_MAINTENANCE_TASK_STATUSES]),
    ]);

    const queueItems = [
      ...handoffResult.rows.map(mapHandoffNoticeRow),
      ...inspectionExportResult.rows.map(mapInspectionExportNoticeRow),
      ...closeoutResult.rows.map(mapCloseoutNoticeRow),
      ...messagesResult.rows.map(mapMessageRow),
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
