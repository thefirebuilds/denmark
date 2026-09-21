const pool = require('../../db');

// Operator-confirmed non-owned vehicles. Match the complete description rather
// than treating every telemetry-only vehicle as unowned. Keep all history.
async function retireTransferredTrackerVehicles(client = pool) {
  const { rows } = await client.query(`
    WITH cleanup AS (
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('migrations.retire_transferred_tracker_vehicles_20260920',
        '{"completed":true}'::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    )
    UPDATE vehicles v
    SET is_active = false, in_service = false, trip_eligible = false, updated_at = NOW()
    FROM (VALUES
      ('yogi', 'volvo', 'xc90', 2023),
      ('phantom', 'nissan', 'rogue', 2026),
      ('cocaina', 'chrysler', 'pacifica', 2024)
    ) AS unwanted(nickname, make, model, year)
    WHERE EXISTS (SELECT 1 FROM cleanup)
      AND LOWER(TRIM(v.nickname)) = unwanted.nickname
      AND LOWER(TRIM(v.make)) = unwanted.make
      AND LOWER(TRIM(v.model)) = unwanted.model
      AND v.year = unwanted.year
    RETURNING v.id, v.nickname
  `);
  if (rows.length) console.log(`[vehicles] retired ${rows.length} operator-identified non-owned vehicles`);
  return rows;
}

module.exports = { retireTransferredTrackerVehicles };
