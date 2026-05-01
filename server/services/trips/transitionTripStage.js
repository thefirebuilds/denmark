// ------------------------------------------------------------
// /server/services/trips/transitionTripStage.js
// Core service for managing trip workflow stage transitions, enforcing allowed
// transitions, recording history of changes, and stamping odometer values
// when a trip enters or exits the in-progress lifecycle.
// ------------------------------------------------------------

const pool = require("../../db");
const { handleTripStageEntry } = require("./handleTripStageEntry");

const WORKFLOW_STAGES = [
  "booked",
  "confirmed",
  "ready_for_handoff",
  "in_progress",
  "turnaround",
  "awaiting_expenses",
  "complete",
  "canceled",
];

const ALLOWED_TRANSITIONS = {
  booked: ["confirmed", "canceled"],
  confirmed: ["booked", "ready_for_handoff", "in_progress", "canceled"],
  ready_for_handoff: ["confirmed", "in_progress", "canceled"],
  in_progress: ["turnaround", "canceled"],
  turnaround: ["awaiting_expenses", "complete"],
  awaiting_expenses: ["turnaround", "complete"],
  complete: [],
  canceled: [],
};

function isValidStage(stage) {
  return WORKFLOW_STAGES.includes(stage);
}

function getAllowedNextStages(currentStage) {
  return ALLOWED_TRANSITIONS[currentStage] || [];
}

function canTransition(currentStage, nextStage) {
  if (!currentStage || !nextStage) return false;
  if (!isValidStage(currentStage) || !isValidStage(nextStage)) return false;
  if (currentStage === nextStage) return false;

  const allowed = ALLOWED_TRANSITIONS[currentStage] || [];
  return allowed.includes(nextStage);
}

function normalizeOdometer(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function shouldCaptureStartOdometer(currentStage, nextStage) {
  return (
    (currentStage === "confirmed" && nextStage === "ready_for_handoff") ||
    (currentStage !== "in_progress" && nextStage === "in_progress")
  );
}

function shouldCaptureEndOdometer(currentStage, nextStage) {
  return currentStage === "in_progress" && nextStage !== "in_progress";
}

let vehiclesColumnCache = null;
let tripsColumnCache = null;

async function getVehiclesColumnMap(client) {
  if (vehiclesColumnCache) return vehiclesColumnCache;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'vehicles'
    `
  );

  const columns = new Set(result.rows.map((row) => row.column_name));

  vehiclesColumnCache = {
    hasTuroVehicleId: columns.has("turo_vehicle_id"),
    hasTelemetry: columns.has("telemetry"),
    hasOdometer: columns.has("odometer"),
    hasCurrentOdometer: columns.has("current_odometer"),
    hasCurrentOdometerMiles: columns.has("current_odometer_miles"),
  };

  return vehiclesColumnCache;
}

async function getTripsColumnSet(client) {
  if (tripsColumnCache) return tripsColumnCache;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'trips'
    `
  );

  tripsColumnCache = new Set(result.rows.map((row) => row.column_name));
  return tripsColumnCache;
}

async function getVehicleCurrentOdometer(client, trip) {
  const turoVehicleId =
    trip?.turo_vehicle_id == null ? null : String(trip.turo_vehicle_id).trim();

  if (!turoVehicleId) {
    return null;
  }

  const columnMap = await getVehiclesColumnMap(client);

  if (!columnMap.hasTuroVehicleId) {
    return null;
  }

  const selectParts = [];
  if (columnMap.hasCurrentOdometerMiles) {
    selectParts.push("current_odometer_miles");
  }
  if (columnMap.hasCurrentOdometer) {
    selectParts.push("current_odometer");
  }
  if (columnMap.hasOdometer) {
    selectParts.push("odometer");
  }
  if (columnMap.hasTelemetry) {
    selectParts.push("telemetry");
  }

  if (!selectParts.length) {
    return null;
  }

  const result = await client.query(
    `
      SELECT ${selectParts.join(", ")}
      FROM vehicles
      WHERE CAST(turo_vehicle_id AS text) = $1
      LIMIT 1
    `,
    [turoVehicleId]
  );

  const vehicle = result.rows[0];
  if (!vehicle) return null;

  const candidates = [
    vehicle.current_odometer_miles,
    vehicle.current_odometer,
    vehicle.odometer,
    vehicle.telemetry?.odometer,
    vehicle.telemetry?.mileage,
    vehicle.telemetry?.stats?.odometer,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOdometer(candidate);
    if (normalized != null) return normalized;
  }

  return null;
}

function toIsoTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

async function getVehicleTelemetryOdometerAt(client, trip, timestamp) {
  const turoVehicleId =
    trip?.turo_vehicle_id == null ? null : String(trip.turo_vehicle_id).trim();
  const vehicleName = String(trip?.vehicle_name || "").trim();

  if (!turoVehicleId && !vehicleName) {
    return null;
  }

  const eventTimestamp = toIsoTimestamp(timestamp);

  const result = await client.query(
    `
      WITH matched_vehicle AS (
        SELECT id, vin
        FROM vehicles
        WHERE (
            $1::text IS NOT NULL
            AND turo_vehicle_id IS NOT NULL
            AND CAST(turo_vehicle_id AS text) = $1::text
          )
          OR (
            $2 <> ''
            AND LOWER(nickname) = LOWER($2)
          )
        ORDER BY
          CASE
            WHEN $1::text IS NOT NULL
             AND turo_vehicle_id IS NOT NULL
             AND CAST(turo_vehicle_id AS text) = $1::text
              THEN 0
            ELSE 1
          END
        LIMIT 1
      ),
      snapshot_candidates AS (
        SELECT
          ROUND(s.odometer)::integer AS odometer,
          COALESCE(s.vehicle_last_updated, s.captured_at) AS recorded_at,
          0 AS source_priority
        FROM vehicle_telemetry_snapshots s
        JOIN matched_vehicle v
          ON LOWER(s.vin) = LOWER(v.vin)
        WHERE s.odometer IS NOT NULL
          AND COALESCE(s.vehicle_last_updated, s.captured_at)
            BETWEEN $3::timestamptz - INTERVAL '30 minutes'
                AND $3::timestamptz + INTERVAL '5 minutes'
      ),
      history_candidates AS (
        SELECT
          ROUND(h.odometer_miles)::integer AS odometer,
          h.recorded_at,
          1 AS source_priority
        FROM vehicle_odometer_history h
        JOIN matched_vehicle v
          ON h.vehicle_id = v.id
        WHERE h.odometer_miles IS NOT NULL
          AND h.recorded_at
            BETWEEN $3::timestamptz - INTERVAL '30 minutes'
                AND $3::timestamptz + INTERVAL '5 minutes'
      ),
      fallback_snapshot AS (
        SELECT
          ROUND(s.odometer)::integer AS odometer,
          COALESCE(s.vehicle_last_updated, s.captured_at) AS recorded_at,
          2 AS source_priority
        FROM vehicle_telemetry_snapshots s
        JOIN matched_vehicle v
          ON LOWER(s.vin) = LOWER(v.vin)
        WHERE s.odometer IS NOT NULL
          AND COALESCE(s.vehicle_last_updated, s.captured_at) <= $3::timestamptz
          AND COALESCE(s.vehicle_last_updated, s.captured_at) >= $3::timestamptz - INTERVAL '24 hours'
        ORDER BY COALESCE(s.vehicle_last_updated, s.captured_at) DESC, s.id DESC
        LIMIT 1
      ),
      fallback_history AS (
        SELECT
          ROUND(h.odometer_miles)::integer AS odometer,
          h.recorded_at,
          3 AS source_priority
        FROM vehicle_odometer_history h
        JOIN matched_vehicle v
          ON h.vehicle_id = v.id
        WHERE h.odometer_miles IS NOT NULL
          AND h.recorded_at <= $3::timestamptz
          AND h.recorded_at >= $3::timestamptz - INTERVAL '24 hours'
        ORDER BY h.recorded_at DESC, h.id DESC
        LIMIT 1
      )
      SELECT odometer
      FROM (
        SELECT * FROM snapshot_candidates
        UNION ALL
        SELECT * FROM history_candidates
        UNION ALL
        SELECT * FROM fallback_snapshot
        UNION ALL
        SELECT * FROM fallback_history
      ) candidates
      WHERE odometer IS NOT NULL
      ORDER BY
        source_priority ASC,
        ABS(EXTRACT(EPOCH FROM (recorded_at - $3::timestamptz))) ASC,
        recorded_at DESC
      LIMIT 1
    `,
    [turoVehicleId || null, vehicleName, eventTimestamp]
  );

  return normalizeOdometer(result.rows[0]?.odometer);
}

async function updateTripMaxEngineRpm(client, trip) {
  const columns = await getTripsColumnSet(client);
  if (!columns.has("max_engine_rpm") || !trip?.id) {
    return { rowCount: 0 };
  }

  return client.query(
    `
      UPDATE trips t
      SET
        max_engine_rpm = COALESCE(
          GREATEST(t.max_engine_rpm, rpm.max_engine_rpm),
          rpm.max_engine_rpm,
          t.max_engine_rpm
        ),
        updated_at = NOW()
      FROM (
        SELECT
          t2.id,
          MAX(
            COALESCE(
              (s.raw_payload -> 'rpmHistory' ->> 'maxRpm')::numeric,
              s.engine_rpm
            )
          ) AS max_engine_rpm
        FROM trips t2
        JOIN vehicles v
          ON (
            (
              t2.turo_vehicle_id IS NOT NULL
              AND v.turo_vehicle_id IS NOT NULL
              AND CAST(t2.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
            )
            OR (
              COALESCE(t2.vehicle_name, '') <> ''
              AND LOWER(t2.vehicle_name) = LOWER(v.nickname)
            )
          )
        JOIN vehicle_telemetry_snapshots s
          ON s.vin = v.vin
        WHERE s.service_name = 'dimo'
          AND s.engine_rpm IS NOT NULL
          AND s.captured_at >= t2.trip_start
          AND s.captured_at <= t2.trip_end
          AND t2.id = $1
        GROUP BY t2.id
      ) rpm
      WHERE t.id = rpm.id
        AND rpm.max_engine_rpm IS NOT NULL
    `,
    [trip.id]
  );
}

async function transitionTripStage(tripId, nextStage, options = {}) {
  const normalizedTripId = Number(tripId);
  const normalizedNextStage = String(nextStage || "").trim();

  if (!Number.isInteger(normalizedTripId) || normalizedTripId <= 0) {
    const err = new Error("Invalid trip id");
    err.statusCode = 400;
    throw err;
  }

  if (!isValidStage(normalizedNextStage)) {
    const err = new Error(`Invalid workflow stage: ${normalizedNextStage}`);
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
        SELECT
          id,
          reservation_id,
          vehicle_name,
          guest_name,
          trip_start,
          trip_end,
          status,
          workflow_stage,
          stage_updated_at,
          needs_review,
          turo_vehicle_id,
          expense_status,
          completed_at,
          canceled_at,
          starting_odometer,
          ending_odometer
        FROM trips
        WHERE id = $1
        FOR UPDATE
      `,
      [normalizedTripId]
    );

    const trip = existingResult.rows[0];

    if (!trip) {
      const err = new Error(`Trip ${normalizedTripId} not found`);
      err.statusCode = 404;
      throw err;
    }

    const currentStage = trip.workflow_stage;

    if (currentStage === normalizedNextStage) {
      await client.query("ROLLBACK");
      return {
        ...trip,
        allowed_next_stages: getAllowedNextStages(currentStage),
      };
    }

    if (!options.force && !canTransition(currentStage, normalizedNextStage)) {
      const err = new Error(
        `Invalid trip stage transition: ${currentStage} -> ${normalizedNextStage}`
      );
      err.statusCode = 400;
      throw err;
    }

    const transitionTimestamp = toIsoTimestamp(options.changedAt);
    let capturedOdometer = null;
    const captureStart = shouldCaptureStartOdometer(
      currentStage,
      normalizedNextStage
    );
    const captureEnd = shouldCaptureEndOdometer(
      currentStage,
      normalizedNextStage
    );

    if (captureStart || captureEnd) {
      capturedOdometer =
        normalizeOdometer(options.currentOdometer) ??
        (await getVehicleTelemetryOdometerAt(
          client,
          trip,
          transitionTimestamp
        )) ??
        (await getVehicleCurrentOdometer(client, trip));
    }

    const startingOdometerToSet =
      captureStart && trip.starting_odometer == null ? capturedOdometer : null;

    const endingOdometerToSet =
      captureEnd && trip.ending_odometer == null ? capturedOdometer : null;

    const updateResult = await client.query(
  `
    UPDATE trips
    SET
      workflow_stage = $2,
      stage_updated_at = $5::timestamptz,

      status = CASE
        WHEN $2 = 'confirmed'
          AND status IN ('booked_unconfirmed', 'updated_unconfirmed')
          THEN 'booked'
        ELSE status
      END,

      needs_review = CASE
        WHEN $2 = 'confirmed' THEN FALSE
        ELSE needs_review
      END,

      starting_odometer = COALESCE(
        starting_odometer,
        $3::integer
      ),

      ending_odometer = COALESCE(
        ending_odometer,
        $4::integer
      ),

      completed_at = CASE
        WHEN $2 = 'complete' AND completed_at IS NULL THEN $5::timestamptz
        ELSE completed_at
      END,

      closed_out = CASE
        WHEN $2 = 'complete' THEN TRUE
        ELSE closed_out
      END,

      closed_out_at = CASE
        WHEN $2 = 'complete' AND closed_out_at IS NULL THEN $5::timestamptz
        ELSE closed_out_at
      END,

      canceled_at = CASE
        WHEN $2 = 'canceled' AND canceled_at IS NULL THEN $5::timestamptz
        ELSE canceled_at
      END,

      expense_status = CASE
        WHEN $2 = 'awaiting_expenses' AND expense_status IS NULL THEN 'pending'
        ELSE expense_status
      END,

      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      reservation_id,
      vehicle_name,
      guest_name,
      trip_start,
      trip_end,
      status,
      workflow_stage,
      stage_updated_at,
      needs_review,
      turo_vehicle_id,
      expense_status,
      completed_at,
      closed_out,
      closed_out_at,
      canceled_at,
      starting_odometer,
      ending_odometer
  `,
  [
    normalizedTripId,
    normalizedNextStage,
    startingOdometerToSet,
    endingOdometerToSet,
    transitionTimestamp,
  ]
);

    const updatedTrip = updateResult.rows[0];

    if (captureEnd || normalizedNextStage === "complete") {
      await updateTripMaxEngineRpm(client, updatedTrip);
    }

    await client.query(
      `
        INSERT INTO trip_stage_history (
          trip_id,
          previous_stage,
          next_stage,
          changed_at,
          changed_by,
          reason
        )
        VALUES ($1, $2, $3, $6::timestamptz, $4, $5)
      `,
      [
        updatedTrip.id,
        currentStage,
        normalizedNextStage,
        options.changedBy || "manual",
        options.reason || null,
        transitionTimestamp,
      ]
    );

    await handleTripStageEntry(client, updatedTrip, currentStage);

    await client.query("COMMIT");

    return {
      ...updatedTrip,
      allowed_next_stages: getAllowedNextStages(updatedTrip.workflow_stage),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  transitionTripStage,
  canTransition,
  isValidStage,
  getAllowedNextStages,
  ALLOWED_TRANSITIONS,
  WORKFLOW_STAGES,
};
