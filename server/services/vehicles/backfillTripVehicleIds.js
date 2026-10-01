const pool = require('../../db');
const { extractTuroVehicle } = require('./extractTuroVehicle');

async function backfillTripVehicleIds() {
  // Repair identity only. Do not replay bookings, alter money or change stages.
  const { rows } = await pool.query(`SELECT m.id, m.reservation_id, m.vehicle_listing_id, m.html_body
    FROM messages m JOIN trips t ON t.reservation_id = m.reservation_id
    WHERE NULLIF(TRIM(t.turo_vehicle_id), '') IS NULL AND t.deleted_at IS NULL
      AND (m.vehicle_listing_id IS NOT NULL OR m.html_body IS NOT NULL)
    ORDER BY m.message_timestamp DESC NULLS LAST, m.id DESC`);
  const candidates = new Map();
  for (const row of rows) {
    const id = String(row.vehicle_listing_id || extractTuroVehicle(row.html_body).id || '');
    if (!id) continue;
    if (!candidates.has(row.reservation_id)) candidates.set(row.reservation_id, new Set());
    candidates.get(row.reservation_id).add(id);
  }
  for (const [reservation, ids] of candidates) {
    if (ids.size !== 1) continue;
    const [id] = ids;
    await pool.query(`UPDATE trips SET turo_vehicle_id = $2, updated_at = NOW()
      WHERE reservation_id = $1 AND NULLIF(TRIM(turo_vehicle_id), '') IS NULL
        AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM vehicles WHERE turo_vehicle_id = $2)`,
    [reservation, id]);
  }
}
module.exports = { backfillTripVehicleIds };
