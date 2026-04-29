// --------------------------------
// /server/services/upsertTripFromMessage.js
// This service function takes a saved message object (from the Turo webhook handler),
// extracts relevant trip information, and upserts a corresponding trip record in the database.
// It handles different message types (booked, changed, canceled) and updates the trip's workflow stage and review status accordingly.
// -------------------------------- 

const pool = require("../db");
const { pushPublicAvailabilitySnapshotSafe } = require("./pushPublicAvailability");
const { deriveWorkflowStage } = require("./trips/deriveWorkflowStage");

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

function resolveTuroVehicleId(savedMessage) {
  return (
    savedMessage.vehicle_listing_id ||
    savedMessage.turo_vehicle_id ||
    null
  );
}

async function upsertTripFromMessage(savedMessage) {
  if (!savedMessage?.reservation_id) {
    return null;
  }

  const tripStatus = normalizeTripStatus(savedMessage.message_type);
  const turoVehicleId = resolveTuroVehicleId(savedMessage);

  if (!tripStatus) {
    const existing = await pool.query(
      `
        UPDATE trips
        SET
          turo_vehicle_id = COALESCE(turo_vehicle_id, $2),
          vehicle_name = COALESCE(vehicle_name, $3),
          guest_name = COALESCE(guest_name, $4),
          last_message_id = COALESCE($5, last_message_id),
          updated_at = CASE
            WHEN turo_vehicle_id IS NULL AND $2 IS NOT NULL THEN NOW()
            WHEN vehicle_name IS NULL AND $3 IS NOT NULL THEN NOW()
            WHEN guest_name IS NULL AND $4 IS NOT NULL THEN NOW()
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
        savedMessage.message_id || null,
      ]
    );

    return existing.rows[0] || null;
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
      status,
      amount,
      mileage_included,
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
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, NOW(), NOW(), NOW(),
      CASE WHEN $16 THEN NOW() ELSE NULL END,
      CASE WHEN $16 THEN TRUE ELSE FALSE END,
      CASE WHEN $16 THEN NOW() ELSE NULL END
    )
    ON CONFLICT (reservation_id)
    DO UPDATE SET
      vehicle_name = COALESCE(EXCLUDED.vehicle_name, trips.vehicle_name),
      guest_name = COALESCE(EXCLUDED.guest_name, trips.guest_name),
      trip_start = COALESCE(EXCLUDED.trip_start, trips.trip_start),
      trip_end = COALESCE(EXCLUDED.trip_end, trips.trip_end),
      amount = COALESCE(EXCLUDED.amount, trips.amount),
      mileage_included = COALESCE(EXCLUDED.mileage_included, trips.mileage_included),
      trip_details_url = COALESCE(EXCLUDED.trip_details_url, trips.trip_details_url),
      guest_profile_url = COALESCE(EXCLUDED.guest_profile_url, trips.guest_profile_url),
      turo_vehicle_id = COALESCE(EXCLUDED.turo_vehicle_id, trips.turo_vehicle_id),
      last_message_id = EXCLUDED.last_message_id,

      workflow_stage = CASE
        WHEN EXCLUDED.status = 'canceled' THEN 'canceled'
        WHEN trips.workflow_stage IS NULL THEN EXCLUDED.workflow_stage
        ELSE trips.workflow_stage
      END,

      stage_updated_at = CASE
        WHEN EXCLUDED.status = 'canceled'
          AND COALESCE(trips.workflow_stage, '') <> 'canceled'
        THEN NOW()
        WHEN trips.workflow_stage IS NULL
        THEN NOW()
        ELSE trips.stage_updated_at
      END,

      status = CASE
        WHEN trips.status = 'canceled' THEN 'canceled'
        WHEN EXCLUDED.status = 'canceled' THEN 'canceled'
        WHEN trips.status = 'acknowledged' THEN 'acknowledged'
        ELSE EXCLUDED.status
      END,

      needs_review = CASE
        WHEN trips.status = 'canceled' THEN FALSE
        WHEN EXCLUDED.status = 'canceled' THEN FALSE
        ELSE TRUE
      END,

      canceled_at = CASE
        WHEN EXCLUDED.status = 'canceled' AND trips.canceled_at IS NULL THEN NOW()
        ELSE trips.canceled_at
      END,

      closed_out = CASE
        WHEN EXCLUDED.status = 'canceled' THEN TRUE
        ELSE trips.closed_out
      END,

      closed_out_at = CASE
        WHEN EXCLUDED.status = 'canceled' AND trips.closed_out_at IS NULL THEN NOW()
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
      status,
      amount, 
      mileage_included,
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

  return result.rows[0] || null;
}

module.exports = upsertTripFromMessage;
