// ------------------------------
// server/routes/trips.js
// API routes for managing trips, including listing trips, fetching a single
// trip, updating trip details, transitioning workflow stage, and fetching
// related trip messages.
// Note: This file focuses on trip-related routes. Business logic related to
// trip stage transitions is handled in /services/trips/transitionTripStage.js
// ------------------------------

const express = require("express");
const pool = require("../db");
const { pushPublicAvailabilitySnapshotSafe } = require("../services/pushPublicAvailability");
const { evaluateCloseoutCompleteness } = require("../services/trips/closeoutState");
const {
  ensureTelemetryTripAttributionSchema,
  telemetryEventAtExpression,
} = require("../services/telemetry/tripAttribution");
const {
  ensureVehicleAliasesTable,
} = require("../services/vehicles/vehicleAliases");
const {
  ensureTripRuntimeSchema,
} = require("../services/trips/tripRuntimeSchema");
const {
  ensureMessageRuntimeSchema,
} = require("../services/messageRuntimeSchema");

const {
  transitionTripStage,
  ALLOWED_TRANSITIONS,
} = require("../services/trips/transitionTripStage");

const router = express.Router();

function isOverdueTrip(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const end = trip?.trip_end ? new Date(trip.trip_end) : null;

  if (
    stage === "turnaround" ||
    stage === "awaiting_expenses" ||
    stage === "complete" ||
    stage === "closed" ||
    trip?.closed_out === true
  ) {
    return false;
  }

  return (
    stage === "in_progress" &&
    end instanceof Date &&
    !Number.isNaN(end.getTime()) &&
    end.getTime() < Date.now()
  );
}

function startOfTodayChicago() {
  const now = new Date();
  const chicago = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Chicago" })
  );
  chicago.setHours(0, 0, 0, 0);
  return chicago;
}

function endOfTodayChicago() {
  const d = startOfTodayChicago();
  d.setHours(23, 59, 59, 999);
  return d;
}

function getAllowedNextStages(workflowStage) {
  return ALLOWED_TRANSITIONS?.[workflowStage] || [];
}

function mapHandoffNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";
  const guestName = row.guest_name || "guest";

  return {
    id: `handoff:${row.trip_id}`,
    message_id: `handoff:${row.trip_id}`,
    subject: `${vehicleName} needs handoff prep for ${guestName}`,
    status: "read",
    message_type: "handoff_ready_required",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    vehicle_nickname: row.vehicle_nickname,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    message_timestamp: row.trip_start,
    created_at: row.trip_start,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
  };
}

function mapInspectionExportNoticeRow(row) {
  const vehicleName = row.vehicle_nickname || row.vehicle_name || "vehicle";

  return {
    id: `inspection-export:${row.trip_id}`,
    message_id: `inspection-export:${row.trip_id}`,
    subject: `Export guest inspection sheet for ${vehicleName}`,
    status: "read",
    message_type: "inspection_export_required",
    guest_name: row.guest_name,
    vehicle_name: row.vehicle_name,
    turo_vehicle_id: row.turo_vehicle_id,
    vehicle_nickname: row.vehicle_nickname,
    vehicle_vin: row.vehicle_vin,
    reservation_id: row.reservation_id,
    trip_id: row.trip_id,
    trip_start: row.trip_start,
    trip_end: row.trip_end,
    message_timestamp: row.stage_updated_at || row.trip_start,
    created_at: row.stage_updated_at || row.trip_start,
    trip_workflow_stage: row.workflow_stage,
    trip_status: row.trip_status,
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

function computeDisplayStatus(trip) {
  const now = new Date();
  const todayStart = startOfTodayChicago();
  const todayEnd = endOfTodayChicago();

  const start = trip.trip_start ? new Date(trip.trip_start) : null;
  const end = trip.trip_end ? new Date(trip.trip_end) : null;

  if (trip.status === "canceled" || trip.workflow_stage === "canceled") {
    return "canceled";
  }

  if (!start || !end) return "unknown";

  if (end < now) return "past";

  if (start > now) {
    if (start >= todayStart && start <= todayEnd) return "starting_today";
    return "upcoming";
  }

  if (end >= todayStart && end <= todayEnd) return "ending_today";

  if (start <= now && end >= now) return "active";

  return "unknown";
}

function computeQueueBucket(trip) {
  const now = new Date();
  const start = trip.trip_start ? new Date(trip.trip_start) : null;
  const end = trip.trip_end ? new Date(trip.trip_end) : null;
  const workflowStage = String(trip.workflow_stage || "").toLowerCase();
  const status = String(trip.status || "").toLowerCase();

  const confirmedWorkflowStages = new Set([
    "confirmed",
    "ready_for_handoff",
    "in_progress",
    "turnaround",
    "awaiting_expenses",
    "complete",
    "closed",
    "canceled",
  ]);

  const isUnconfirmed =
    workflowStage === "booked" ||
    (!confirmedWorkflowStages.has(workflowStage) &&
      (trip.needs_review === true ||
        status === "booked_unconfirmed" ||
        status === "updated_unconfirmed"));

  if (workflowStage === "canceled" || status === "canceled") {
    return "canceled";
  }

  const closeoutState = evaluateCloseoutCompleteness(trip);

  // Workflow state is the return signal. A trip that is still explicitly in
  // progress after its scheduled end is overdue, not ready for closeout.
  if (workflowStage === "in_progress" && (!start || start <= now)) {
    return "in_progress";
  }

  if (closeoutState.isIncomplete && end && end < now) {
    return "needs_closeout";
  }

  if (workflowStage === "complete" || trip.closed_out) {
    return "closed";
  }

  if (workflowStage === "awaiting_expenses") {
    return "needs_closeout";
  }

  if (workflowStage === "turnaround") {
    return "needs_closeout";
  }

  if (isUnconfirmed && start && start > now) {
    return "unconfirmed";
  }

  if (start && end && start <= now && end >= now) {
    return "in_progress";
  }

  if (end && end < now) {
    return trip.closed_out ? "closed" : "needs_closeout";
  }

  if (trip.closed_out) {
    return "closed";
  }

  return "upcoming";
}

function sortTrips(a, b) {
  const aOverdue = isOverdueTrip(a);
  const bOverdue = isOverdueTrip(b);

  if (aOverdue !== bOverdue) {
    return aOverdue ? -1 : 1;
  }

  const bucketPriority = {
    needs_closeout: 1,
    in_progress: 2,
    unconfirmed: 3,
    upcoming: 4,
    canceled: 5,
    closed: 6,
  };

  const bucketA = bucketPriority[a.queue_bucket] ?? 99;
  const bucketB = bucketPriority[b.queue_bucket] ?? 99;

  if (bucketA !== bucketB) {
    return bucketA - bucketB;
  }

  const aStart = a.trip_start ? new Date(a.trip_start).getTime() : Infinity;
  const bStart = b.trip_start ? new Date(b.trip_start).getTime() : Infinity;
  const aEnd = a.trip_end ? new Date(a.trip_end).getTime() : Infinity;
  const bEnd = b.trip_end ? new Date(b.trip_end).getTime() : Infinity;

  switch (a.queue_bucket) {
    case "needs_closeout":
      return aEnd - bEnd;

    case "in_progress":
      return aEnd - bEnd;

    case "unconfirmed":
      return aStart - bStart;

    case "upcoming":
      return aStart - bStart;

    case "canceled":
      return aStart - bStart;

    case "closed":
      return bEnd - aEnd;

    default:
      return aStart - bStart;
  }
}

function isActionableBookingMessage(item) {
  const stage = String(item.trip_workflow_stage || "").toLowerCase();
  const status = String(item.trip_status || "").toLowerCase();
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
    item.message_type === "trip_booked" &&
    item.trip_id &&
    stage !== "canceled" &&
    status !== "canceled" &&
    (stage === "booked" ||
      (!terminalOrConfirmedStages.has(stage) &&
        (item.trip_needs_review === true ||
          ["booked_unconfirmed", "updated_unconfirmed"].includes(status))))
  );
}

function enrichTrip(trip) {
  return {
    ...trip,
    display_status: computeDisplayStatus(trip),
    queue_bucket: computeQueueBucket(trip),
    allowed_next_stages: getAllowedNextStages(trip.workflow_stage),
  };
}

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return null;
  return null;
}

function normalizeTollReviewStatus(value, hasTolls) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!hasTolls) {
    return "none";
  }

  if (
    normalized === "pending" ||
    normalized === "reviewed" ||
    normalized === "billed" ||
    normalized === "waived"
  ) {
    return normalized;
  }

  return "pending";
}

const TRIP_SELECT = `
  SELECT
    ti.id,
    ti.reservation_id,
    COALESCE(t.vehicle_name, ti.vehicle_name) AS vehicle_name,
    COALESCE(t.guest_name, ti.guest_name) AS guest_name,
    COALESCE(t.trip_start, ti.trip_start) AS trip_start,
    COALESCE(t.trip_end, ti.trip_end) AS trip_end,
    COALESCE(t.status, ti.status) AS status,
    COALESCE(t.amount, ti.amount) AS amount,
    COALESCE(t.needs_review, ti.needs_review) AS needs_review,
    ti.created_at,
    t.mileage_included,
    t.starting_odometer,
    t.ending_odometer,
    t.mileage_verified,
    t.has_tolls,
    t.toll_count,
    t.toll_total,
    t.toll_charged_total,
    t.toll_review_status,
    t.fuel_reimbursement_total,
    tf.ticket_reimbursed,
    t.max_engine_rpm,
    t.max_speed_mph,
    t.speed_over_80_count,
    t.guest_rating_received,
    t.guest_rating_received_at,
    ti.updated_at,
    ti.message_count,
    ti.unread_messages,
    ti.last_message_at,
    ti.last_unread_at,
    t.trip_details_url,
    t.guest_profile_url,
    t.created_from_message_id,
    t.last_message_id,
    t.closed_out,
    t.closed_out_at,
    t.turo_vehicle_id,
    t.workflow_stage,
    t.stage_updated_at,
    t.expense_status,
    t.completed_at,
    t.canceled_at,
    v.nickname AS vehicle_nickname,
    v.year AS vehicle_year,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    v.vin AS vehicle_vin,
    CASE
      WHEN current_odo_rollup.source = 'active_trip_estimate'
        AND current_odo_rollup.source_trip_id = t.id
      THEN current_odo_rollup.odometer_miles
      ELSE NULL
    END AS estimated_current_odometer,
    CASE
      WHEN current_odo_rollup.source = 'active_trip_estimate'
        AND current_odo_rollup.source_trip_id = t.id
      THEN current_odo_rollup.estimated_trip_miles::float
      ELSE NULL
    END AS estimated_trip_miles
  FROM trip_intelligence ti
  JOIN trips t
    ON t.id = ti.id
  LEFT JOIN LATERAL (
    SELECT v.*
    FROM vehicles v
    WHERE (
      t.turo_vehicle_id IS NOT NULL
      AND v.turo_vehicle_id = t.turo_vehicle_id
    )
    OR (
      COALESCE(t.vehicle_name, ti.vehicle_name, '') <> ''
      AND LOWER(v.nickname) = LOWER(COALESCE(t.vehicle_name, ti.vehicle_name))
    )
    OR (
      COALESCE(t.vehicle_name, ti.vehicle_name, '') <> ''
      AND LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER(COALESCE(t.vehicle_name, ti.vehicle_name))
    )
    OR EXISTS (
      SELECT 1
      FROM vehicle_aliases va
      WHERE va.vehicle_id = v.id
        AND va.active = true
        AND COALESCE(t.vehicle_name, ti.vehicle_name, '') <> ''
        AND LOWER(va.alias) = LOWER(COALESCE(t.vehicle_name, ti.vehicle_name))
    )
    ORDER BY
      CASE
        WHEN t.turo_vehicle_id IS NOT NULL AND v.turo_vehicle_id = t.turo_vehicle_id THEN 1
        WHEN COALESCE(t.vehicle_name, ti.vehicle_name, '') <> '' AND LOWER(v.nickname) = LOWER(COALESCE(t.vehicle_name, ti.vehicle_name)) THEN 2
        WHEN COALESCE(t.vehicle_name, ti.vehicle_name, '') <> '' AND LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER(COALESCE(t.vehicle_name, ti.vehicle_name)) THEN 3
        ELSE 4
      END
    LIMIT 1
  ) v ON true
  LEFT JOIN trip_financial_facts tf
    ON tf.trip_id = t.id
  LEFT JOIN vehicle_odometer_rollups current_odo_rollup
    ON current_odo_rollup.vehicle_id = v.id
`;

router.get("/", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();
    await ensureTripRuntimeSchema();

    const scope = String(req.query.scope || "open").toLowerCase();
    const stage = String(req.query.stage || "").trim().toLowerCase();

    const query = `
      ${TRIP_SELECT}
      ORDER BY
        ti.trip_start ASC NULLS LAST,
        ti.id ASC
    `;

    const { rows } = await pool.query(query);

    const enriched = rows.map(enrichTrip);

    let filtered = enriched;

    if (scope === "open") {
      filtered = filtered.filter((trip) =>
        ["unconfirmed", "in_progress", "needs_closeout", "upcoming"].includes(
          trip.queue_bucket
        )
      );
    } else if (scope === "review") {
      filtered = filtered.filter((trip) => trip.queue_bucket === "unconfirmed");
    } else if (scope === "active") {
      filtered = filtered.filter((trip) => trip.queue_bucket === "in_progress");
    } else if (scope === "closeout") {
      filtered = filtered.filter(
        (trip) => trip.queue_bucket === "needs_closeout"
      );
    } else if (scope === "canceled") {
      filtered = filtered.filter((trip) => trip.queue_bucket === "canceled");
    } else if (scope === "closed") {
      filtered = filtered.filter((trip) => trip.queue_bucket === "closed");
    }

    if (stage) {
      filtered = filtered.filter(
        (trip) => String(trip.workflow_stage || "").toLowerCase() === stage
      );
    }

    filtered.sort(sortTrips);

    res.json(filtered);
  } catch (err) {
    console.error("GET /api/trips failed:", err.message || err);
    res.status(500).json({ error: "Failed to load trips" });
  }
});

// Get trips for a specific vehicle, identified by either turo_vehicle_id or nickname (case-insensitive).
// Optional query parameters:
// - mode: "relevant" (default, shows unconfirmed, in_progress, needs_closeout, upcoming), "future" (shows trips with end date in the future), "all" (shows all trips regardless of dates)
// - includeCanceled: if true, includes canceled trips in the results
// Example: GET /api/trips/vehicle/delavan?mode=relevant&includeCanceled=true

router.get("/vehicle/:vehicleId", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();

    const vehicleId = String(req.params.vehicleId || "").trim();
    const mode =
      req.query.mode == null
        ? "all"
        : String(req.query.mode).trim().toLowerCase();

    const includeCanceled =
      String(req.query.includeCanceled || "false").toLowerCase() === "true";

    if (!vehicleId) {
      return res.status(400).json({ error: "Vehicle id is required" });
    }

    const query = `
      ${TRIP_SELECT}
      WHERE CAST(t.turo_vehicle_id AS text) = $1
        OR LOWER(COALESCE(t.vehicle_name, '')) = LOWER($1)
        OR LOWER(COALESCE(ti.vehicle_name, '')) = LOWER($1)
        OR LOWER(COALESCE(v.nickname, '')) = LOWER($1)
        OR LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER($1)
        OR LOWER(COALESCE(v.vin, '')) = LOWER($1)
        OR EXISTS (
          SELECT 1
          FROM vehicle_aliases va
          WHERE va.vehicle_id = v.id
            AND va.active = true
            AND LOWER(va.alias) = LOWER($1)
        )
      ORDER BY
        COALESCE(t.trip_start, ti.trip_start) ASC NULLS LAST,
        ti.id ASC
    `;

    const { rows } = await pool.query(query, [vehicleId]);

    let trips = rows.map(enrichTrip);

    if (mode === "relevant") {
      trips = trips.filter((trip) => {
        if (!includeCanceled && trip.queue_bucket === "canceled") {
          return false;
        }

        return ["unconfirmed", "in_progress", "needs_closeout", "upcoming"].includes(
          trip.queue_bucket
        );
      });
    } else if (mode === "future") {
      const now = new Date();

      trips = trips.filter((trip) => {
        if (!includeCanceled && trip.queue_bucket === "canceled") {
          return false;
        }

        const start = trip.trip_start ? new Date(trip.trip_start) : null;
        const end = trip.trip_end ? new Date(trip.trip_end) : null;

        if (!start || !end) return false;

        return end >= now;
      });
    } else if (mode === "all" && !includeCanceled) {
      trips = trips.filter((trip) => trip.queue_bucket !== "canceled");
    }

    trips.sort(sortTrips);

    res.json(trips);
  } catch (err) {
    console.error("GET /api/trips/vehicle/:vehicleId failed:", err.message || err);
    res.status(500).json({ error: "Failed to load vehicle trips" });
  }
});

router.get("/automation-notices", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();

    const query = `
      WITH notice_settings AS (
        SELECT COALESCE(
          (
            SELECT value->'acknowledgedHistoryIds'
            FROM app_settings
            WHERE key = 'ui.automation_stage_notices'
            LIMIT 1
          ),
          '[]'::jsonb
        ) AS acknowledged_history_ids
      )
      SELECT
        h.id AS history_id,
        h.previous_stage,
        h.next_stage,
        h.changed_at,
        h.changed_by,
        h.reason,
        trip_data.*
      FROM trip_stage_history h
      CROSS JOIN notice_settings ns
      JOIN LATERAL (
        ${TRIP_SELECT}
        WHERE ti.id = h.trip_id
        LIMIT 1
      ) trip_data ON true
      WHERE h.next_stage = 'in_progress'
        AND COALESCE(h.changed_by, '') LIKE 'system:%'
        AND h.changed_at >= NOW() - INTERVAL '14 days'
        AND NOT (ns.acknowledged_history_ids ? h.id::text)
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT 5
    `;

    const { rows } = await pool.query(query);

    const notices = rows.map((row) => {
      const trip = enrichTrip(row);
      const vehicleName = trip.vehicle_nickname || trip.vehicle_name || "vehicle";
      const guestName = trip.guest_name || "guest";

      return {
        id: `automation:${row.history_id}`,
        history_id: row.history_id,
        previous_stage: row.previous_stage,
        next_stage: row.next_stage,
        changed_at: row.changed_at,
        changed_by: row.changed_by,
        reason: row.reason,
        subject: `${vehicleName} auto-started for ${guestName}`,
        trip_id: trip.id,
        reservation_id: trip.reservation_id,
        vehicle_name: trip.vehicle_name,
        vehicle_nickname: trip.vehicle_nickname,
        guest_name: trip.guest_name,
        trip_start: trip.trip_start,
        trip_end: trip.trip_end,
        trip,
      };
    });

    res.json(notices);
  } catch (err) {
    console.error("GET /api/trips/automation-notices failed:", err);
    res.status(500).json({ error: "Failed to load automation notices" });
  }
});

router.patch("/automation-notices/:historyId/ack", async (req, res) => {
  const historyId = Number(req.params.historyId);

  if (!Number.isInteger(historyId) || historyId <= 0) {
    return res.status(400).json({ error: "Invalid automation notice id" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
        SELECT value
        FROM app_settings
        WHERE key = 'ui.automation_stage_notices'
        FOR UPDATE
      `
    );

    const currentValue =
      rows[0]?.value && typeof rows[0].value === "object" ? rows[0].value : {};
    const existingIds = Array.isArray(currentValue.acknowledgedHistoryIds)
      ? currentValue.acknowledgedHistoryIds.map((value) => String(value))
      : [];
    const nextIds = [String(historyId), ...existingIds]
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, 200);
    const nextValue = {
      ...currentValue,
      acknowledgedHistoryIds: nextIds,
    };

    const result = await client.query(
      `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('ui.automation_stage_notices', $1::jsonb, NOW())
        ON CONFLICT (key)
        DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = NOW()
        RETURNING key, value, updated_at
      `,
      [JSON.stringify(nextValue)]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      history_id: historyId,
      setting: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/trips/automation-notices/:historyId/ack failed:", err);
    res.status(500).json({ error: "Failed to acknowledge automation notice" });
  } finally {
    client.release();
  }
});

router.get("/:id/telemetry-path", async (req, res) => {
  try {
    await ensureTelemetryTripAttributionSchema(pool);

    const tripId = Number(req.params.id);
    const limit = Math.min(
      5000,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 2000)
    );

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const eventAt = telemetryEventAtExpression("s");
    const { rows } = await pool.query(
      `
        WITH path AS (
          SELECT
            s.id,
            s.trip_id,
            s.service_name,
            s.latitude::float AS lat,
            s.longitude::float AS lon,
            s.speed::float AS speed,
            s.heading::float AS heading,
            s.is_running,
            ${eventAt} AS seen_at,
            s.captured_at AT TIME ZONE 'UTC' AS captured_at,
            COUNT(*) OVER()::int AS total_points
          FROM vehicle_telemetry_snapshots s
          WHERE s.trip_id = $1
            AND s.latitude IS NOT NULL
            AND s.longitude IS NOT NULL
          ORDER BY ${eventAt} ASC, s.id ASC
          LIMIT $2
        )
        SELECT *
        FROM path
      `,
      [tripId, limit]
    );

    res.json({
      trip_id: tripId,
      point_count: rows[0]?.total_points || 0,
      returned_point_count: rows.length,
      points: rows.map(({ total_points, ...row }) => row),
    });
  } catch (err) {
    console.error("GET /api/trips/:id/telemetry-path failed:", err.message || err);
    res.status(500).json({ error: "Failed to load trip telemetry path" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();

    const tripId = Number(req.params.id);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const query = `
      ${TRIP_SELECT}
      WHERE ti.id = $1
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [tripId]);

    if (!rows.length) {
      return res.status(404).json({ error: "Trip not found" });
    }

    res.json(enrichTrip(rows[0]));
  } catch (err) {
    console.error("GET /api/trips/:id failed:", err.message || err);
    res.status(500).json({ error: "Failed to load trip" });
  }
});

router.patch("/:id", async (req, res) => {
  const tripId = Number(req.params.id);

  if (!Number.isInteger(tripId) || tripId <= 0) {
    return res.status(400).json({ error: "Invalid trip id" });
  }

  const {
    guest_name,
    vehicle_name,
    turo_vehicle_id,
    trip_start,
    trip_end,
    amount,
    status,
    needs_review,
    mileage_included,
    starting_odometer,
    ending_odometer,
    mileage_verified,
    has_tolls,
    toll_count,
    toll_total,
    toll_review_status,
    fuel_reimbursement_total,
    ticket_reimbursed,
    expense_status,
    guest_rating_received,
    closed_out,
    closed_out_at,
  } = req.body || {};

  const normalizedVehicleId =
    turo_vehicle_id == null ? "" : String(turo_vehicle_id).trim();

  const normalizedHasTolls = toNullableBoolean(has_tolls);
  const normalizedTollCount = toNullableNumber(toll_count);
  const normalizedTollTotal = toNullableNumber(toll_total);

  const effectiveHasTolls =
    normalizedHasTolls != null
      ? normalizedHasTolls
      : normalizedTollCount > 0 || normalizedTollTotal > 0
      ? true
      : null;

  const effectiveTollCount =
    effectiveHasTolls === false ? 0 : normalizedTollCount;

  const effectiveTollTotal =
    effectiveHasTolls === false ? 0 : normalizedTollTotal;

  const effectiveTollReviewStatus =
    effectiveHasTolls == null
      ? null
      : normalizeTollReviewStatus(toll_review_status, effectiveHasTolls);

  const normalizedClosedOut = toNullableBoolean(closed_out);
  const normalizedGuestRatingReceived = toNullableBoolean(guest_rating_received);
  const normalizedMileageVerified = toNullableBoolean(mileage_verified);
  const normalizedTicketReimbursed = toNullableNumber(ticket_reimbursed);
  const ticketFieldWasProvided = Object.prototype.hasOwnProperty.call(
    req.body || {},
    "ticket_reimbursed"
  );
  const normalizedExpenseStatus =
    typeof expense_status === "string" && expense_status.trim() !== ""
      ? expense_status.trim().toLowerCase()
      : null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await ensureVehicleAliasesTable(client);

    const existingTripResult = await client.query(
      `
        SELECT
          id,
          starting_odometer,
          ending_odometer,
          mileage_verified,
          expense_status,
          has_tolls,
          toll_review_status,
          guest_rating_received,
          closed_out
        FROM trips
        WHERE id = $1
        LIMIT 1
      `,
      [tripId]
    );

    if (!existingTripResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found" });
    }

    const existingTrip = existingTripResult.rows[0];

    let resolvedVehicleId = null;
    let resolvedVehicleName = null;

    if (normalizedVehicleId !== "") {
      const vehicleLookup = await client.query(
        `
          SELECT turo_vehicle_id, nickname
          FROM vehicles
          WHERE CAST(turo_vehicle_id AS text) = $1
          LIMIT 1
        `,
        [normalizedVehicleId]
      );

      if (!vehicleLookup.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Vehicle id not found: ${turo_vehicle_id}`,
        });
      }

      resolvedVehicleId = vehicleLookup.rows[0].turo_vehicle_id;
      resolvedVehicleName = vehicleLookup.rows[0].nickname;
    } else if (vehicle_name != null && String(vehicle_name).trim() !== "") {
      const nickname = String(vehicle_name).trim();

      const vehicleLookup = await client.query(
        `
          SELECT turo_vehicle_id, nickname
          FROM vehicles v
          WHERE LOWER(v.nickname) = LOWER($1)
            OR LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER($1)
            OR EXISTS (
              SELECT 1
              FROM vehicle_aliases va
              WHERE va.vehicle_id = v.id
                AND va.active = true
                AND LOWER(va.alias) = LOWER($1)
            )
          ORDER BY
            CASE
              WHEN LOWER(v.nickname) = LOWER($1) THEN 1
              WHEN LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER($1) THEN 2
              ELSE 3
            END
          LIMIT 1
        `,
        [nickname]
      );

      if (!vehicleLookup.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Vehicle not found: ${nickname}`,
        });
      }

      resolvedVehicleId = vehicleLookup.rows[0].turo_vehicle_id;
      resolvedVehicleName = vehicleLookup.rows[0].nickname;
    }

    const updateResult = await client.query(
      `
        UPDATE trips
        SET
          guest_name = COALESCE($1, guest_name),
          vehicle_name = COALESCE($2, vehicle_name),
          trip_start = COALESCE($3, trip_start),
          trip_end = COALESCE($4, trip_end),
          amount = COALESCE($5, amount),
          status = COALESCE($6, status),
          needs_review = COALESCE($7, needs_review),
          turo_vehicle_id = COALESCE($8, turo_vehicle_id),
          mileage_included = COALESCE($9, mileage_included),
          starting_odometer = COALESCE($10, starting_odometer),
          ending_odometer = COALESCE($11, ending_odometer),
          has_tolls = COALESCE($12, has_tolls),
          toll_count = COALESCE($13, toll_count),
          toll_total = COALESCE($14, toll_total),
          toll_review_status = COALESCE($15, toll_review_status),
          fuel_reimbursement_total = COALESCE($16, fuel_reimbursement_total),
          closed_out = COALESCE($17, closed_out),
          closed_out_at = CASE
            WHEN $17::boolean = TRUE THEN COALESCE($18::timestamptz, closed_out_at, NOW())
            WHEN $17::boolean = FALSE THEN NULL
            ELSE closed_out_at
          END,
          expense_status = COALESCE($19, expense_status),
          guest_rating_received = COALESCE($20, guest_rating_received),
          guest_rating_received_at = CASE
            WHEN $20::boolean = TRUE THEN COALESCE(guest_rating_received_at, NOW())
            WHEN $20::boolean = FALSE THEN NULL
            ELSE guest_rating_received_at
          END,
          mileage_verified = COALESCE($21, mileage_verified),
          updated_at = NOW()
        WHERE id = $22
        RETURNING id
      `,
      [
        guest_name ?? null,
        resolvedVehicleName ?? vehicle_name ?? null,
        trip_start || null,
        trip_end || null,
        amount === "" || amount == null ? null : Number(amount),
        status ?? null,
        typeof needs_review === "boolean" ? needs_review : null,
        resolvedVehicleId,
        mileage_included === "" || mileage_included == null
          ? null
          : Number(mileage_included),
        starting_odometer === "" || starting_odometer == null
          ? null
          : Number(starting_odometer),
        ending_odometer === "" || ending_odometer == null
          ? null
          : Number(ending_odometer),
        effectiveHasTolls,
        effectiveTollCount,
        effectiveTollTotal,
        effectiveTollReviewStatus,
        fuel_reimbursement_total === "" || fuel_reimbursement_total == null
          ? null
          : Number(fuel_reimbursement_total),
        normalizedClosedOut,
        closed_out_at || null,
        normalizedExpenseStatus,
        normalizedGuestRatingReceived,
        normalizedMileageVerified,
        tripId,
      ]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found" });
    }

    if (ticketFieldWasProvided) {
      await client.query(
        `
          INSERT INTO trip_financial_facts (
            trip_id,
            reservation_id,
            vehicle_id,
            ticket_reimbursed,
            source_payload,
            created_at,
            updated_at
          )
          SELECT
            t.id,
            t.reservation_id,
            v.id,
            $2::numeric,
            jsonb_build_object(
              'manual_ticket_update', true,
              'source', 'trip_reconciliation',
              'updated_at', NOW()
            ),
            NOW(),
            NOW()
          FROM trips t
          LEFT JOIN vehicles v
            ON CAST(v.turo_vehicle_id AS text) = CAST(t.turo_vehicle_id AS text)
          WHERE t.id = $1
          ON CONFLICT (trip_id)
          DO UPDATE SET
            ticket_reimbursed = EXCLUDED.ticket_reimbursed,
            source_payload =
              COALESCE(trip_financial_facts.source_payload, '{}'::jsonb) ||
              EXCLUDED.source_payload,
            updated_at = NOW()
        `,
        [tripId, normalizedTicketReimbursed]
      );
    }

    const proposedTrip = {
      ...existingTrip,
      starting_odometer:
        starting_odometer === "" || starting_odometer == null
          ? existingTrip.starting_odometer
          : Number(starting_odometer),
      ending_odometer:
        ending_odometer === "" || ending_odometer == null
          ? existingTrip.ending_odometer
          : Number(ending_odometer),
      mileage_verified:
        normalizedMileageVerified == null
          ? existingTrip.mileage_verified
          : normalizedMileageVerified,
      expense_status:
        normalizedExpenseStatus == null
          ? existingTrip.expense_status
          : normalizedExpenseStatus,
      has_tolls:
        effectiveHasTolls == null ? existingTrip.has_tolls : effectiveHasTolls,
      toll_review_status:
        effectiveTollReviewStatus == null
          ? existingTrip.toll_review_status
          : effectiveTollReviewStatus,
      guest_rating_received:
        normalizedGuestRatingReceived == null
          ? existingTrip.guest_rating_received
          : normalizedGuestRatingReceived,
      closed_out:
        normalizedClosedOut == null ? existingTrip.closed_out : normalizedClosedOut,
    };

    const closeoutState = evaluateCloseoutCompleteness(proposedTrip);

    if (proposedTrip.closed_out === true && closeoutState.isIncomplete) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Trip cannot be marked closed out until ${closeoutState.reasons.join(", ")} ${closeoutState.reasons.length === 1 ? "is" : "are"} complete`,
      });
    }

    const refreshed = await client.query(
      `
        ${TRIP_SELECT}
        WHERE ti.id = $1
        LIMIT 1
      `,
      [tripId]
    );

    await client.query("COMMIT");

    if (status != null) {
      void pushPublicAvailabilitySnapshotSafe("trip status changed");
    }

    if (!refreshed.rows.length) {
      return res.json({ id: tripId });
    }

    return res.json(enrichTrip(refreshed.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/trips/:id failed:", {
      message: err.message,
      tripId,
      body: req.body,
      stack: err.stack,
    });
    return res.status(500).json({ error: "Failed to update trip" });
  } finally {
    client.release();
  }
});

router.patch("/:id/stage", async (req, res) => {
  try {
    const tripId = Number(req.params.id);
    const nextStage = String(req.body?.workflow_stage || "").trim();
    const force = req.body?.force === true;

    if (!Number.isInteger(tripId) || tripId <= 0 || !nextStage) {
      return res.status(400).json({
        error: "trip id and workflow_stage are required",
      });
    }

    const updatedTrip = await transitionTripStage(tripId, nextStage, {
      changedBy: force ? "manual_override" : "manual",
      force,
    });

    void pushPublicAvailabilitySnapshotSafe("trip stage changed");

    res.json({
      ...updatedTrip,
      allowed_next_stages: getAllowedNextStages(updatedTrip.workflow_stage),
    });
  } catch (err) {
    console.error(`PATCH /api/trips/${req.params.id}/stage failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to transition trip stage",
    });
  }
});

router.get("/:id/messages", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();
    await ensureTripRuntimeSchema();
    await ensureMessageRuntimeSchema();

    const tripId = Number(req.params.id);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const query = `
      SELECT
        m.id,
        m.trip_id,
        m.reservation_id,
        m.message_id,
        m.subject,
        m.status,
        m.message_type,
        m.amount,
        m.guest_name,
        m.vehicle_name,
        m.trip_start,
        m.trip_end,
        m.message_timestamp,
        m.text_body,
        m.normalized_text_body,
        m.guest_message,
        m.reply_url,
        m.trip_details_url,
        m.created_at,
        t.workflow_stage AS trip_workflow_stage,
        t.needs_review AS trip_needs_review,
        t.status AS trip_status,
        t.guest_name AS trip_record_guest_name,
        t.vehicle_name AS trip_record_vehicle_name,
        t.trip_start AS trip_record_start,
        t.trip_end AS trip_record_end,
        t.amount AS trip_record_amount,
        t.reservation_id AS trip_record_reservation_id
      FROM messages m
      LEFT JOIN trips t
        ON t.id = m.trip_id
      WHERE m.trip_id = $1
      ORDER BY
        CASE
          WHEN m.status = 'unread'
            AND COALESCE(m.message_type, '') NOT IN ('payment_notice', 'renter_activity')
            AND m.trip_id IS NULL
            AND m.reservation_id IS NULL
            THEN -1
          WHEN m.status = 'unread'
            AND COALESCE(m.message_type, '') NOT IN ('payment_notice', 'renter_activity')
            THEN 0
          WHEN m.message_type = 'trip_booked'
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
            THEN 1
          ELSE 2
        END,
        COALESCE(m.message_timestamp, m.created_at) DESC,
        m.id DESC
    `;

    const maintenanceQuery = `
      WITH active_maintenance_tasks AS (
        SELECT mt.*
        FROM maintenance_tasks mt
        WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
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
      )
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.trip_start,
        t.trip_end,
        t.workflow_stage,
        t.status AS trip_status,
        COALESCE(resolved_vehicle.nickname, t.vehicle_name, mt.vehicle_vin) AS vehicle_name,
        COALESCE(resolved_vehicle.vin, mt.vehicle_vin) AS vehicle_vin,
        COALESCE(
          (
            SELECT MIN(active.trip_end)
            FROM trips active
            LEFT JOIN LATERAL (
              SELECT v.*
              FROM vehicles v
              WHERE (
                  active.turo_vehicle_id IS NOT NULL
                  AND v.turo_vehicle_id = active.turo_vehicle_id
                )
                OR (
                  COALESCE(active.vehicle_name, '') <> ''
                  AND LOWER(v.nickname) = LOWER(active.vehicle_name)
                )
                OR EXISTS (
                  SELECT 1
                  FROM vehicle_aliases va
                  WHERE va.vehicle_id = v.id
                    AND va.active = true
                    AND COALESCE(active.vehicle_name, '') <> ''
                    AND LOWER(va.alias) = LOWER(active.vehicle_name)
                )
              ORDER BY
                CASE
                  WHEN active.turo_vehicle_id IS NOT NULL AND v.turo_vehicle_id = active.turo_vehicle_id THEN 1
                  WHEN COALESCE(active.vehicle_name, '') <> '' AND LOWER(v.nickname) = LOWER(active.vehicle_name) THEN 2
                  ELSE 3
                END
              LIMIT 1
            ) active_v ON true
            WHERE COALESCE(active.workflow_stage, '') NOT IN ('complete', 'closed', 'canceled')
              AND COALESCE(active.status, '') <> 'canceled'
              AND COALESCE(active.closed_out, false) = false
              AND active.trip_start <= NOW()
              AND active.trip_end > NOW()
              AND (
                (
                  resolved_vehicle.id IS NOT NULL
                  AND active_v.id = resolved_vehicle.id
                )
                OR (
                  resolved_vehicle.id IS NULL
                  AND resolved_vehicle.turo_vehicle_id IS NOT NULL
                  AND active.turo_vehicle_id = resolved_vehicle.turo_vehicle_id
                )
                OR (
                  resolved_vehicle.id IS NULL
                  AND mt.vehicle_vin IS NOT NULL
                  AND active_v.vin = mt.vehicle_vin
                )
                OR (
                  resolved_vehicle.id IS NULL
                  AND COALESCE(resolved_vehicle.nickname, '') <> ''
                  AND LOWER(COALESCE(active.vehicle_name, '')) = LOWER(resolved_vehicle.nickname)
                )
                OR EXISTS (
                  SELECT 1
                  FROM vehicle_aliases va
                  WHERE va.vehicle_id = active_v.id
                    AND va.active = true
                    AND resolved_vehicle.id IS NULL
                    AND COALESCE(active.vehicle_name, '') <> ''
                    AND LOWER(va.alias) = LOWER(resolved_vehicle.nickname)
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
            'needs_review', mt.needs_review
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
      JOIN trips t
        ON t.id = mt.related_trip_id
      LEFT JOIN LATERAL (
        SELECT v.*
        FROM vehicles v
        WHERE (
            COALESCE(mt.vehicle_vin, '') <> ''
            AND v.vin = mt.vehicle_vin
          )
          OR (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
          OR EXISTS (
            SELECT 1
            FROM vehicle_aliases va
            WHERE va.vehicle_id = v.id
              AND va.active = true
              AND COALESCE(t.vehicle_name, '') <> ''
              AND LOWER(va.alias) = LOWER(t.vehicle_name)
          )
        ORDER BY
          CASE
            WHEN COALESCE(mt.vehicle_vin, '') <> '' AND v.vin = mt.vehicle_vin THEN 1
            WHEN t.turo_vehicle_id IS NOT NULL AND v.turo_vehicle_id = t.turo_vehicle_id THEN 2
            WHEN COALESCE(t.vehicle_name, '') <> '' AND LOWER(v.nickname) = LOWER(t.vehicle_name) THEN 3
            ELSE 4
          END
        LIMIT 1
      ) resolved_vehicle ON true
      WHERE mt.related_trip_id = $1
        AND t.trip_end > NOW()
      GROUP BY
        t.id,
        t.reservation_id,
        t.guest_name,
        t.trip_start,
        t.trip_end,
        t.workflow_stage,
        t.status,
        t.turo_vehicle_id,
        mt.vehicle_vin,
        resolved_vehicle.id,
        resolved_vehicle.nickname,
        resolved_vehicle.vin,
        resolved_vehicle.turo_vehicle_id,
        COALESCE(resolved_vehicle.nickname, t.vehicle_name, mt.vehicle_vin),
        COALESCE(resolved_vehicle.vin, mt.vehicle_vin)
    `;

    const handoffQuery = `
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        v.nickname AS vehicle_nickname,
        t.trip_start,
        t.trip_end,
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
      WHERE t.id = $1
        AND t.trip_start > NOW()
        AND t.trip_start <= NOW() + INTERVAL '12 hours'
        AND COALESCE(t.workflow_stage, '') = 'confirmed'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
      LIMIT 1
    `;

    const inspectionExportQuery = `
      SELECT
        t.id AS trip_id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        t.turo_vehicle_id,
        v.nickname AS vehicle_nickname,
        v.vin AS vehicle_vin,
        t.trip_start,
        t.trip_end,
        t.workflow_stage,
        t.status AS trip_status,
        t.stage_updated_at
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
      WHERE t.id = $1
        AND t.trip_start > NOW() - INTERVAL '2 hours'
        AND t.trip_start <= NOW() + INTERVAL '24 hours'
        AND COALESCE(t.workflow_stage, '') = 'ready_for_handoff'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
        AND t.deleted_at IS NULL
      LIMIT 1
    `;

    let rows;
    try {
      const result = await pool.query(query, [tripId]);
      rows = result.rows;
    } catch (err) {
      err.tripMessagePhase = "base messages";
      throw err;
    }

    async function runOptionalTripMessageQuery(name, sql) {
      try {
        const result = await pool.query(sql, [tripId]);
        return result.rows;
      } catch (err) {
        console.warn(`GET /api/trips/:id/messages optional ${name} failed:`, {
          tripId,
          message: err.message || String(err),
          code: err.code,
          detail: err.detail,
          hint: err.hint,
          position: err.position,
          table: err.table,
          column: err.column,
          constraint: err.constraint,
        });
        return [];
      }
    }

    const [maintenanceRows, handoffRows, inspectionExportRows] = await Promise.all([
      runOptionalTripMessageQuery("maintenance notices", maintenanceQuery),
      runOptionalTripMessageQuery("handoff notices", handoffQuery),
      runOptionalTripMessageQuery("inspection export notices", inspectionExportQuery),
    ]);

    const maintenanceNotices = maintenanceRows.map((row) => {
      const now = Date.now();
      const tripStart = row.trip_start ? new Date(row.trip_start).getTime() : null;
      const tripEnd = row.trip_end ? new Date(row.trip_end).getTime() : null;
      const isActiveTrip =
        Number.isFinite(tripStart) &&
        Number.isFinite(tripEnd) &&
        tripStart <= now &&
        tripEnd > now;
      const isUpcomingTrip = Number.isFinite(tripStart) && tripStart > now;
      const vehicleName = row.vehicle_name || "vehicle";
      const groupedTasks = groupMaintenanceTasksForNotice(row.tasks || []);
      const taskLabel = `${groupedTasks.length} maintenance item${
        groupedTasks.length === 1 ? "" : "s"
      }`;
      const subject = isActiveTrip
        ? `${taskLabel} after ${vehicleName} returns`
        : isUpcomingTrip
        ? `${taskLabel} due during ${vehicleName}'s upcoming trip`
        : `${taskLabel} before ${vehicleName} goes out`;

      return {
        id: `maintenance:${row.trip_id}`,
        message_id: `maintenance:${row.trip_id}`,
        subject,
        status: "read",
        message_type: "maintenance_required",
        guest_name: row.guest_name,
        vehicle_name: row.vehicle_name,
        reservation_id: row.reservation_id,
        trip_id: row.trip_id,
        trip_start: row.trip_start,
        trip_end: row.trip_end,
        message_timestamp: row.latest_task_created_at,
        created_at: row.latest_task_created_at,
        trip_workflow_stage: row.workflow_stage,
        trip_status: row.trip_status,
        maintenance_vehicle_name: row.vehicle_name,
        maintenance_vehicle_vin: row.vehicle_vin,
        maintenance_available_at: row.maintenance_available_at,
        maintenance_queue_rank: isUpcomingTrip ? 0 : isActiveTrip ? 2 : 1,
        maintenance_task_count: groupedTasks.length,
        maintenance_open_task_record_count: Number(row.open_task_count || 0),
        maintenance_tasks: groupedTasks,
      };
    });

    const handoffNotices = handoffRows.map(mapHandoffNoticeRow);
    const inspectionExportNotices = inspectionExportRows.map(
      mapInspectionExportNoticeRow
    );
    const hasPrepTask =
      handoffNotices.length > 0 || inspectionExportNotices.length > 0;
    const attachedHandoffNotices = attachMaintenanceToPrepNotices(
      handoffNotices,
      maintenanceNotices
    );
    const attachedInspectionExportNotices = attachMaintenanceToPrepNotices(
      inspectionExportNotices,
      maintenanceNotices
    );
    const visibleMaintenanceNotices = hasPrepTask ? [] : maintenanceNotices;
    const visibleRows = hasPrepTask
      ? rows.filter((row) => !isRedundantPrepNotice(row))
      : rows;
    const combined = [
      ...attachedHandoffNotices,
      ...attachedInspectionExportNotices,
      ...visibleRows,
      ...visibleMaintenanceNotices,
    ].sort((a, b) => {
      const rank = (item) => {
        if (item.message_type === "handoff_ready_required") return -1;
        if (isUncorrelatedUnreadMessage(item)) return -1;
        if (
          item.message_type === "maintenance_required" &&
          Number(item.maintenance_queue_rank) === 0
        ) {
          return -1;
        }
        if (item.status === "unread") return 0;
        if (item.message_type === "inspection_export_required") return 1;
        if (isActionableBookingMessage(item)) return 1;
        if (item.message_type === "maintenance_required") return 2;
        return 3;
      };

      const rankDiff = rank(a) - rank(b);
      if (rankDiff !== 0) return rankDiff;

      const aTime = new Date(a.message_timestamp || a.created_at || 0).getTime();
      const bTime = new Date(b.message_timestamp || b.created_at || 0).getTime();
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    res.json(combined);
  } catch (err) {
    console.error("GET /api/trips/:id/messages failed:", {
      tripId: req.params.id,
      phase: err.tripMessagePhase || "route",
      message: err.message || String(err),
      code: err.code,
      detail: err.detail,
      hint: err.hint,
      position: err.position,
      table: err.table,
      column: err.column,
      constraint: err.constraint,
    });
    res.status(500).json({ error: "Failed to load trip messages" });
  }
});

module.exports = router;
