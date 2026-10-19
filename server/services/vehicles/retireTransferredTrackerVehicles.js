const pool = require('../../db');

// Operator-confirmed non-owned tracker vehicles. Reconcile on every startup:
// incomplete provider metadata or an earlier cleanup must not bypass retirement.
// Keep all history and leave explicitly configured rental listings untouched.
async function retireTransferredTrackerVehicles(client = pool) {
  const { rows } = await client.query(`
    UPDATE vehicles v
    SET is_active = false, in_service = false, trip_eligible = false, updated_at = NOW()
    FROM (VALUES
      ('yogi'), ('phantom'), ('cocaina')
    ) AS unwanted(nickname)
    WHERE LOWER(TRIM(v.nickname)) = unwanted.nickname
      AND NULLIF(TRIM(CAST(v.turo_vehicle_id AS text)), '') IS NULL
      AND (v.is_active IS DISTINCT FROM false
        OR v.in_service IS DISTINCT FROM false
        OR v.trip_eligible IS DISTINCT FROM false)
    RETURNING v.id, v.nickname
  `);
  if (rows.length) console.log(`[vehicles] retired ${rows.length} operator-identified non-owned vehicles`);
  return rows;
}

module.exports = { retireTransferredTrackerVehicles };
