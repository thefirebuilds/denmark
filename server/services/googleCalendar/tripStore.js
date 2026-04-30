const pool = require("../../db");

async function getTripById(tripId) {
  const result = await pool.query(
    `
      SELECT
        t.*,
        v.nickname AS vehicle_nickname
      FROM trips t
      LEFT JOIN vehicles v
        ON t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      WHERE t.id = $1
      LIMIT 1
    `,
    [tripId]
  );

  return result.rows[0] || null;
}

async function getTripsForGoogleCalendarReconcile(limit = 500) {
  const result = await pool.query(
    `
      SELECT
        t.*,
        v.nickname AS vehicle_nickname
      FROM trips t
      LEFT JOIN vehicles v
        ON t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      WHERE t.deleted_at IS NULL
        AND (
          t.canceled_at IS NULL
          OR t.updated_at >= NOW() - INTERVAL '14 days'
        )
        AND (
          t.workflow_stage IN ('waiting expenses', 'awaiting_expenses')
          OR t.trip_end >= NOW() - INTERVAL '14 days'
          OR t.trip_start >= NOW() - INTERVAL '14 days'
          OR t.updated_at >= NOW() - INTERVAL '14 days'
        )
      ORDER BY t.updated_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return result.rows;
}

module.exports = {
  getTripById,
  getTripsForGoogleCalendarReconcile,
};
