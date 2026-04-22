const pool = require("../../db");

async function getTripById(tripId) {
  const result = await pool.query(
    `
      SELECT *
      FROM trips
      WHERE id = $1
      LIMIT 1
    `,
    [tripId]
  );

  return result.rows[0] || null;
}

async function getTripsForGoogleCalendarReconcile(limit = 500) {
  const result = await pool.query(
    `
      SELECT *
      FROM trips
      WHERE deleted_at IS NULL
        AND (
          canceled_at IS NULL
          OR updated_at >= NOW() - INTERVAL '14 days'
        )
        AND (
          workflow_stage IN ('waiting expenses', 'awaiting_expenses')
          OR trip_end >= NOW() - INTERVAL '14 days'
          OR trip_start >= NOW() - INTERVAL '14 days'
          OR updated_at >= NOW() - INTERVAL '14 days'
        )
      ORDER BY updated_at DESC
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
