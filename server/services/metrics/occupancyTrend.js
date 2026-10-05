async function getOccupancyTrend(client, startDate, endDate, granularity) {
  const { rows } = await client.query(`
    WITH fleet AS (
      SELECT v.id, v.turo_vehicle_id, v.nickname,
        COALESCE(v.onboarding_date, (
          SELECT MIN(t.trip_start)::date FROM trips t
          WHERE t.deleted_at IS NULL AND t.canceled_at IS NULL
            AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
            AND COALESCE(t.workflow_stage, '') NOT IN ('canceled', 'cancelled')
            AND (t.turo_vehicle_id = v.turo_vehicle_id OR
              (t.turo_vehicle_id IS NULL AND LOWER(t.vehicle_name) = LOWER(v.nickname)))
        ), $1::date) AS onboarded
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) AND COALESCE(v.in_service, true)
        AND COALESCE(v.trip_eligible, true)
    ), days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ), daily AS (
      SELECT d.day, COUNT(v.id)::int AS available,
        COUNT(v.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM trips t
          WHERE t.deleted_at IS NULL AND t.canceled_at IS NULL
            AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
            AND COALESCE(t.workflow_stage, '') NOT IN ('canceled', 'cancelled')
            AND t.trip_start < d.day + INTERVAL '1 day' AND t.trip_end >= d.day
            AND (t.turo_vehicle_id = v.turo_vehicle_id OR
              (t.turo_vehicle_id IS NULL AND LOWER(t.vehicle_name) = LOWER(v.nickname)))
        ))::int AS booked
      FROM days d LEFT JOIN fleet v ON v.onboarded <= d.day
      GROUP BY d.day
    )
    SELECT to_char(date_trunc($3, day), 'YYYY-MM-DD') AS label,
      SUM(booked)::int AS booked_vehicle_days, SUM(available)::int AS available_vehicle_days,
      SUM(booked)::float / NULLIF(SUM(available), 0) AS occupancy_rate
    FROM daily GROUP BY date_trunc($3, day) ORDER BY date_trunc($3, day)
  `, [startDate, endDate, granularity === 'month' ? 'month' : 'day']);
  return { granularity, points: rows,
    basis: 'Booked calendar vehicle-days / available vehicle-days for currently active, in-service, trip-eligible fleet; excludes canceled trips and days before onboarding. Overlapping trips count once per vehicle per day.' };
}
module.exports = { getOccupancyTrend };
