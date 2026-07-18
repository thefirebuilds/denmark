// --------------------------------
// /server/services/upsertTripFromMessage.js
// This service function takes a saved message object (from the Turo webhook handler),
// extracts relevant trip information, and upserts a corresponding trip record in the database.
// It handles different message types (booked, changed, canceled) and updates the trip's workflow stage and review status accordingly.
// -------------------------------- 

const pool = require("../db");
const { pushPublicAvailabilitySnapshotSafe } = require("./pushPublicAvailability");
const { deriveWorkflowStage } = require("./trips/deriveWorkflowStage");
const {
  syncTripToSelectedGoogleCalendars,
} = require("./googleCalendar/googleTripSync");
const {
  ensureVehicleAliasesTable,
} = require("./vehicles/vehicleAliases");
const { transitionTripStage } = require("./trips/transitionTripStage");

function normalizeTripStatus(messageType) {
  switch (messageType) {
    case "trip_booked":
      return "booked_unconfirmed";
    case "trip_changed":
      return "updated_unconfirmed";
    case "trip_canceled":
      return "canceled";
    default:
      return null;
  }
}

async function resolveTuroVehicleId(savedMessage) {
  const explicitVehicleId =
    savedMessage.vehicle_listing_id ||
    savedMessage.turo_vehicle_id ||
    null;

  if (explicitVehicleId) {
    return explicitVehicleId;
  }

  const vehicleName = String(savedMessage.vehicle_name || "").trim();
  if (!vehicleName) {
    return null;
  }

  await ensureVehicleAliasesTable();

  const { rows } = await pool.query(
    `
      SELECT v.turo_vehicle_id
      FROM vehicles v
      WHERE COALESCE(v.turo_vehicle_id, '') <> ''
        AND (
          LOWER(v.nickname) = LOWER($1)
          OR LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER($1)
          OR EXISTS (
            SELECT 1
            FROM vehicle_aliases va
            WHERE va.vehicle_id = v.id
              AND va.active = true
              AND LOWER(va.alias) = LOWER($1)
          )
        )
      ORDER BY
        CASE
          WHEN LOWER(v.nickname) = LOWER($1) THEN 1
          WHEN LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER($1) THEN 2
          ELSE 3
        END
      LIMIT 1
    `,
    [vehicleName]
  );

  return rows[0]?.turo_vehicle_id || null;
}

function syncTripToGoogleCalendar(trip, reason, options = {}) {
  if (!trip?.id) return;

  void syncTripToSelectedGoogleCalendars(trip.id, options)
    .then((result) => {
      if (!result.ok) {
        console.warn(
          `[google-calendar] trip ${trip.id} calendar sync completed with failures | reason=${reason}`,
          result.results
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[google-calendar] trip ${trip.id} calendar sync failed | reason=${reason}:`,
        err.message || err
      );
    });
}

async function upsertTripFromMessage(savedMessage) {
  if (!savedMessage?.reservation_id) {
    return null;
  }

  const tripStatus = normalizeTripStatus(savedMessage.message_type);
  const turoVehicleId = await resolveTuroVehicleId(savedMessage);

  if (!tripStatus) {
    const existing = await pool.query(
      `
        UPDATE trips
        SET
          turo_vehicle_id = COALESCE(turo_vehicle_id, $2),
          vehicle_name = COALESCE(vehicle_name, $3),
          guest_name = COALESCE(guest_name, $4),
          pickup_location = COALESCE(pickup_location, $5),
          return_location = COALESCE(return_location, $6),
          last_message_id = COALESCE($7, last_message_id),
          guest_rating_received = CASE
            WHEN $8::boolean THEN TRUE
            ELSE guest_rating_received
          END,
          guest_rating_received_at = CASE
            WHEN $8::boolean THEN COALESCE(
              guest_rating_received_at,
              $9::timestamptz,
              NOW()
            )
            ELSE guest_rating_received_at
          END,
          updated_at = CASE
            WHEN turo_vehicle_id IS NULL AND $2 IS NOT NULL THEN NOW()
            WHEN vehicle_name IS NULL AND $3 IS NOT NULL THEN NOW()
            WHEN guest_name IS NULL AND $4 IS NOT NULL THEN NOW()
            WHEN pickup_location IS NULL AND $5 IS NOT NULL THEN NOW()
            WHEN return_location IS NULL AND $6 IS NOT NULL THEN NOW()
            WHEN $8::boolean THEN NOW()
            ELSE updated_at
          END
        WHERE reservation_id = $1
        RETURNING
          id,
          reservation_id,
          status,
          workflow_stage,
          needs_review,
          turo_vehicle_id
      `,
      [
        savedMessage.reservation_id,
        turoVehicleId,
        savedMessage.vehicle_name || null,
        savedMessage.guest_name || null,
        savedMessage.pickup_location || null,
        savedMessage.return_location || null,
        savedMessage.message_id || null,
        savedMessage.message_type === "trip_rated",
        savedMessage.message_timestamp || savedMessage.created_at || null,
      ]
    );

    let existingTrip = existing.rows[0] || null;

    if (
      existingTrip?.id &&
      savedMessage.message_type === "trip_rated" &&
      ["in_progress", "turnaround"].includes(existingTrip.workflow_stage)
    ) {
      const reason = "Turo rating confirms the guest completed the trip";

      if (existingTrip.workflow_stage === "in_progress") {
        existingTrip = await transitionTripStage(existingTrip.id, "turnaround", {
          changedBy: "system:trip-rated-message",
          reason,
          changedAt: savedMessage.message_timestamp || savedMessage.created_at,
        });
      }

      existingTrip = await transitionTripStage(existingTrip.id, "awaiting_expenses", {
        changedBy: "system:trip-rated-message",
        reason,
        changedAt: savedMessage.message_timestamp || savedMessage.created_at,
      });
    }

    return existingTrip;
  }

  const isCanceledMessage = tripStatus === "canceled";

  const workflowStage = deriveWorkflowStage({
    status: tripStatus,
    tripStart: savedMessage.trip_start || null,
    tripEnd: savedMessage.trip_end || null,
  });

  const query = `
        INSERT INTO trips (
      reservation_id,
      vehicle_name,
      guest_name,
      trip_start,
      trip_end,
      pickup_location,
      return_location,
      status,
      amount,
      mileage_included,
      starting_odometer,
      ending_odometer,
      trip_details_url,
      guest_profile_url,
      created_from_message_id,
      last_message_id,
      turo_vehicle_id,
      workflow_stage,
      needs_review,
      created_at,
      updated_at,
        stage_updated_at,
      canceled_at,
      closed_out,
      closed_out_at
    )
    VALUES (
      $1, $2, $3,
      CASE WHEN $18 THEN NOW() ELSE $4 END,
      CASE WHEN $18 THEN NOW() ELSE $5 END,
      $6, $7,
      $8, $9, $10,
      CASE WHEN $18 THEN 0 ELSE NULL END,
      CASE WHEN $18 THEN 0 ELSE NULL END,
      $11, $12,
      $13, $14, $15, $16, $17, NOW(), NOW(), NOW(),
      CASE WHEN $18 THEN NOW() ELSE NULL END,
      FALSE,
      NULL
    )
    ON CONFLICT (reservation_id)
    DO UPDATE SET
      vehicle_name = COALESCE(EXCLUDED.vehicle_name, trips.vehicle_name),
      guest_name = COALESCE(EXCLUDED.guest_name, trips.guest_name),
      trip_start = CASE
        WHEN EXCLUDED.status = 'canceled' THEN COALESCE(trips.trip_start, EXCLUDED.trip_start)
        WHEN trips.status = 'canceled' OR trips.canceled_at IS NOT NULL THEN trips.trip_start
        WHEN EXCLUDED.status = 'booked_unconfirmed' AND trips.trip_start IS NOT NULL
          THEN trips.trip_start
        ELSE COALESCE(EXCLUDED.trip_start, trips.trip_start)
      END,
      trip_end = CASE
        WHEN EXCLUDED.status = 'canceled' THEN COALESCE(trips.trip_end, EXCLUDED.trip_end)
        WHEN trips.status = 'canceled' OR trips.canceled_at IS NOT NULL THEN trips.trip_end
        WHEN EXCLUDED.status = 'booked_unconfirmed' AND trips.trip_end IS NOT NULL
          THEN trips.trip_end
        ELSE COALESCE(EXCLUDED.trip_end, trips.trip_end)
      END,
      pickup_location = COALESCE(EXCLUDED.pickup_location, trips.pickup_location),
      return_location = COALESCE(EXCLUDED.return_location, trips.return_location),
      amount = COALESCE(EXCLUDED.amount, trips.amount),
      mileage_included = CASE
        WHEN EXCLUDED.status = 'canceled' THEN 0
        WHEN trips.status = 'canceled' OR trips.canceled_at IS NOT NULL THEN trips.mileage_included
        ELSE COALESCE(EXCLUDED.mileage_included, trips.mileage_included)
      END,
      starting_odometer = CASE
        WHEN EXCLUDED.status = 'canceled' THEN 0
        ELSE trips.starting_odometer
      END,
      ending_odometer = CASE
        WHEN EXCLUDED.status = 'canceled' THEN 0
        ELSE trips.ending_odometer
      END,
      trip_details_url = COALESCE(EXCLUDED.trip_details_url, trips.trip_details_url),
      guest_profile_url = COALESCE(EXCLUDED.guest_profile_url, trips.guest_profile_url),
      turo_vehicle_id = COALESCE(EXCLUDED.turo_vehicle_id, trips.turo_vehicle_id),
      last_message_id = EXCLUDED.last_message_id,

      workflow_stage = CASE
        WHEN EXCLUDED.status = 'canceled' THEN 'canceled'
        WHEN trips.canceled_at IS NOT NULL THEN 'canceled'
        WHEN trips.workflow_stage IS NULL THEN EXCLUDED.workflow_stage
        ELSE trips.workflow_stage
      END,

      stage_updated_at = CASE
        WHEN EXCLUDED.status = 'canceled'
          AND COALESCE(trips.workflow_stage, '') <> 'canceled'
        THEN NOW()
        WHEN trips.canceled_at IS NOT NULL
          AND COALESCE(trips.workflow_stage, '') <> 'canceled'
        THEN NOW()
        WHEN trips.workflow_stage IS NULL
        THEN NOW()
        ELSE trips.stage_updated_at
      END,

      status = CASE
        WHEN trips.status = 'canceled' THEN 'canceled'
        WHEN trips.canceled_at IS NOT NULL THEN 'canceled'
        WHEN EXCLUDED.status = 'canceled' THEN 'canceled'
        WHEN trips.status = 'acknowledged' THEN 'acknowledged'
        WHEN EXCLUDED.status IN ('booked_unconfirmed', 'updated_unconfirmed')
          AND COALESCE(trips.workflow_stage, '') IN (
            'confirmed',
            'ready_for_handoff',
            'in_progress',
            'turnaround',
            'awaiting_expenses',
            'complete',
            'closed'
          )
        THEN CASE
          WHEN trips.status IN ('booked_unconfirmed', 'updated_unconfirmed') THEN 'booked'
          ELSE trips.status
        END
        ELSE EXCLUDED.status
      END,

      needs_review = CASE
        WHEN trips.status = 'canceled' THEN trips.needs_review
        WHEN trips.canceled_at IS NOT NULL THEN trips.needs_review
        WHEN EXCLUDED.status = 'canceled' THEN TRUE
        WHEN EXCLUDED.status IN ('booked_unconfirmed', 'updated_unconfirmed')
          AND COALESCE(trips.workflow_stage, '') IN (
            'confirmed',
            'ready_for_handoff',
            'in_progress',
            'turnaround',
            'awaiting_expenses',
            'complete',
            'closed'
          )
        THEN FALSE
        ELSE TRUE
      END,

      canceled_at = CASE
        WHEN EXCLUDED.status = 'canceled' AND trips.canceled_at IS NULL THEN NOW()
        ELSE trips.canceled_at
      END,

      closed_out = CASE
        WHEN trips.status = 'canceled' THEN trips.closed_out
        WHEN trips.canceled_at IS NOT NULL THEN trips.closed_out
        WHEN EXCLUDED.status = 'canceled' THEN FALSE
        ELSE trips.closed_out
      END,

      closed_out_at = CASE
        WHEN trips.status = 'canceled' THEN trips.closed_out_at
        WHEN trips.canceled_at IS NOT NULL THEN trips.closed_out_at
        WHEN EXCLUDED.status = 'canceled' THEN NULL
        ELSE trips.closed_out_at
      END,

      updated_at = NOW()
    RETURNING
      id,
      reservation_id,
      vehicle_name,
      guest_name,
      trip_start,
      trip_end,
      pickup_location,
      return_location,
      status,
      amount, 
      mileage_included,
      starting_odometer,
      ending_odometer,
      workflow_stage,
      stage_updated_at,
      needs_review,
      turo_vehicle_id,
      canceled_at;
  `;

    const values = [
    savedMessage.reservation_id,
    savedMessage.vehicle_name || null,
    savedMessage.guest_name || null,
    savedMessage.trip_start || null,
    savedMessage.trip_end || null,
    savedMessage.pickup_location || null,
    savedMessage.return_location || null,
    tripStatus,
    savedMessage.amount ?? null,
    savedMessage.mileage_included ??
      savedMessage.allowed_miles ??
      savedMessage.trip_miles_included ??
      null,
    savedMessage.trip_details_url || null,
    savedMessage.guest_profile_url || null,
    savedMessage.message_id || null,
    savedMessage.message_id || null,
    turoVehicleId,
    workflowStage,
    isCanceledMessage ? false : true,
    isCanceledMessage,
  ];

  const result = await pool.query(query, values);

  void pushPublicAvailabilitySnapshotSafe("trip status changed");

  if (isCanceledMessage) {
    syncTripToGoogleCalendar(result.rows[0], "trip_canceled", {
      retryDeletedEvents: true,
    });
  } else if (["trip_booked", "trip_changed"].includes(savedMessage.message_type)) {
    syncTripToGoogleCalendar(result.rows[0], savedMessage.message_type);
  }

  return result.rows[0] || null;
}

module.exports = upsertTripFromMessage;
