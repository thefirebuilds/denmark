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

const {
  transitionTripStage,
  ALLOWED_TRANSITIONS,
} = require("../services/trips/transitionTripStage");

const router = express.Router();

function isOverdueTrip(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const end = trip?.trip_end ? new Date(trip.trip_end) : null;

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

  const isUnconfirmed =
    trip.workflow_stage === "booked" ||
    trip.status === "booked_unconfirmed" ||
    trip.status === "updated_unconfirmed" ||
    trip.needs_review === true;

  if (trip.workflow_stage === "canceled" || trip.status === "canceled") {
    return "canceled";
  }

  if (trip.workflow_stage === "complete" || trip.closed_out) {
    return "closed";
  }

  if (trip.workflow_stage === "awaiting_expenses") {
    return "needs_closeout";
  }

  if (trip.workflow_stage === "turnaround") {
    return "needs_closeout";
  }

  if (trip.workflow_stage === "in_progress") {
    return "in_progress";
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
    normalized === "submitted" ||
    normalized === "resolved"
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
    t.has_tolls,
    t.toll_count,
    t.toll_total,
    t.toll_review_status,
    t.fuel_reimbursement_total,
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
    v.vin AS vehicle_vin
  FROM trip_intelligence ti
  JOIN trips t
    ON t.id = ti.id
  LEFT JOIN vehicles v
    ON v.turo_vehicle_id = t.turo_vehicle_id
`;

router.get("/", async (req, res) => {
  try {
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

router.get("/:id", async (req, res) => {
  try {
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
    has_tolls,
    toll_count,
    toll_total,
    toll_review_status,
    fuel_reimbursement_total,
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

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
          FROM vehicles
          WHERE LOWER(nickname) = LOWER($1)
          LIMIT 1
        `,
        [nickname]
      );

      if (!vehicleLookup.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Vehicle nickname not found: ${nickname}`,
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
          updated_at = NOW()
        WHERE id = $17
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
        tripId,
      ]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found" });
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
    const tripId = Number(req.params.id);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const query = `
      SELECT
        id,
        trip_id,
        reservation_id,
        message_id,
        subject,
        sender,
        status,
        message_type,
        amount,
        guest_name,
        vehicle_name,
        received_at,
        message_timestamp,
        text_body,
        normalized_text_body,
        guest_message,
        reply_url,
        trip_details_url,
        created_at
      FROM messages
      WHERE trip_id = $1
      ORDER BY
        COALESCE(received_at, message_timestamp, created_at) DESC,
        id DESC
    `;

    const { rows } = await pool.query(query, [tripId]);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/trips/:id/messages failed:", err.message || err);
    res.status(500).json({ error: "Failed to load trip messages" });
  }
});

module.exports = router;