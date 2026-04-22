const pool = require("../../db");

async function getTripGoogleSync(tripId, googleCalendarConnectionId, eventType) {
  const result = await pool.query(
    `
      SELECT *
      FROM trip_google_sync
      WHERE trip_id = $1
        AND google_calendar_connection_id = $2
        AND event_type = $3
      LIMIT 1
    `,
    [tripId, googleCalendarConnectionId, eventType]
  );

  return result.rows[0] || null;
}

async function getAllTripGoogleSync(tripId, googleCalendarConnectionId) {
  const result = await pool.query(
    `
      SELECT *
      FROM trip_google_sync
      WHERE trip_id = $1
        AND google_calendar_connection_id = $2
      ORDER BY event_type
    `,
    [tripId, googleCalendarConnectionId]
  );

  return result.rows;
}

async function upsertTripGoogleSync({
  tripId,
  googleCalendarConnectionId,
  eventType,
  googleEventId,
  syncStatus = "synced",
}) {
  const result = await pool.query(
    `
      INSERT INTO trip_google_sync (
        trip_id,
        google_calendar_connection_id,
        event_type,
        google_event_id,
        sync_status,
        last_synced_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
      ON CONFLICT (trip_id, google_calendar_connection_id, event_type)
      DO UPDATE
      SET google_event_id = EXCLUDED.google_event_id,
          sync_status = EXCLUDED.sync_status,
          last_synced_at = NOW(),
          updated_at = NOW()
      RETURNING *
    `,
    [tripId, googleCalendarConnectionId, eventType, googleEventId, syncStatus]
  );

  return result.rows[0];
}

async function markTripGoogleSyncDeleted(tripId, googleCalendarConnectionId, eventType) {
  const result = await pool.query(
    `
      UPDATE trip_google_sync
      SET sync_status = 'deleted',
          last_synced_at = NOW(),
          updated_at = NOW()
      WHERE trip_id = $1
        AND google_calendar_connection_id = $2
        AND event_type = $3
      RETURNING *
    `,
    [tripId, googleCalendarConnectionId, eventType]
  );

  return result.rows[0] || null;
}

module.exports = {
  getTripGoogleSync,
  getAllTripGoogleSync,
  upsertTripGoogleSync,
  markTripGoogleSyncDeleted,
};
