const pool = require('../../db');
const { telemetryEventAtExpression } = require('../telemetry/tripAttribution');

async function getOffTripActivity(input, db = pool) {
  const vehicleId = Number(input.vehicleId);
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (!Number.isSafeInteger(vehicleId) || vehicleId <= 0 ||
      !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw Object.assign(new Error('Valid vehicle and segment start/end required'), { status: 400 });
  }
  const eventAt = telemetryEventAtExpression('s');
  const { rows } = await db.query(`
    WITH activity AS (
      SELECT s.id, s.latitude::float AS lat, s.longitude::float AS lon,
        ${eventAt} AS seen_at
      FROM vehicle_telemetry_snapshots s
      JOIN vehicles v ON v.id = $1 AND (
        (NULLIF(v.vin, '') IS NOT NULL AND LOWER(s.vin) = LOWER(v.vin)) OR
        (v.dimo_token_id IS NOT NULL AND s.dimo_token_id = v.dimo_token_id) OR
        (v.external_vehicle_key IS NOT NULL AND s.external_vehicle_key = v.external_vehicle_key)
      )
      WHERE ${eventAt} >= $2::timestamptz
        AND ${eventAt} <= $3::timestamptz
        AND s.latitude BETWEEN -90 AND 90 AND s.longitude BETWEEN -180 AND 180
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY seen_at, id) AS n,
        COUNT(*) OVER ()::int AS total_points FROM activity
    )
    SELECT * FROM ranked
    WHERE MOD(n - 1, GREATEST(1, CEIL(total_points / 2000.0)::bigint)) = 0 OR n = total_points
    ORDER BY seen_at, id
  `, [vehicleId, start.toISOString(), end.toISOString()]);
  return {
    vehicle_id: vehicleId, point_count: rows[0]?.total_points || 0,
    points: rows.map(({ n, total_points, ...point }) => point),
  };
}

module.exports = { getOffTripActivity };
