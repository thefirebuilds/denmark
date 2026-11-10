const pool = require('../../db');
const { NON_OWNED_NAMES } = require('./nonOwnedVehicles');

// Operator-confirmed non-owned tracker vehicles. Reconcile on every startup:
// incomplete provider metadata or an earlier cleanup must not bypass retirement.
// Keep all history. An accidentally linked rental listing is not ownership proof.
async function retireTransferredTrackerVehicles(client = pool) {
  const { rows } = await client.query(`
    UPDATE vehicles v
    SET is_active = false, in_service = false, trip_eligible = false, updated_at = NOW()
    WHERE (LOWER(TRIM(v.nickname)) = ANY($1::text[])
      OR LOWER(TRIM(v.turo_vehicle_name)) = ANY($1::text[])
      OR EXISTS (SELECT 1 FROM vehicle_aliases a WHERE a.vehicle_id=v.id AND a.active=true AND LOWER(TRIM(a.alias))=ANY($1::text[])))
      AND (v.is_active IS DISTINCT FROM false
        OR v.in_service IS DISTINCT FROM false
        OR v.trip_eligible IS DISTINCT FROM false)
    RETURNING v.id, v.nickname
  `, [NON_OWNED_NAMES]);
  if (rows.length) console.log(`[vehicles] retired ${rows.length} operator-identified non-owned vehicles`);
  return rows;
}

module.exports = { retireTransferredTrackerVehicles };
