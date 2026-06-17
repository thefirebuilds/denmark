const pool = require("../../db");

async function ensureNoDuplicateVehicleIdentity(client, columnName) {
  const { rows } = await client.query(
    `
      SELECT ${columnName} AS value, COUNT(*)::int AS count
      FROM public.vehicles
      WHERE ${columnName} IS NOT NULL
      GROUP BY ${columnName}
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, ${columnName}
      LIMIT 5
    `
  );

  if (!rows.length) return;

  const details = rows
    .map((row) => `${columnName}=${row.value} (${row.count} rows)`)
    .join(", ");
  throw new Error(
    `Cannot add vehicles ${columnName} uniqueness required for restored tenant schema; duplicate values found: ${details}`
  );
}

async function ensureVehicleIdentityConstraints(client = pool) {
  const { rows } = await client.query(`
    SELECT to_regclass('public.vehicles') AS vehicles_table
  `);

  if (!rows[0]?.vehicles_table) {
    throw new Error("public.vehicles is missing");
  }

  await ensureNoDuplicateVehicleIdentity(client, "id");
  await ensureNoDuplicateVehicleIdentity(client, "vin");

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.vehicles'::regclass
          AND conname = 'vehicles_id_key'
      ) THEN
        ALTER TABLE public.vehicles
        ADD CONSTRAINT vehicles_id_key UNIQUE (id);
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.vehicles'::regclass
          AND conname = 'vehicles_vin_key'
      ) THEN
        ALTER TABLE public.vehicles
        ADD CONSTRAINT vehicles_vin_key UNIQUE (vin);
      END IF;
    END $$;
  `);
}

module.exports = {
  ensureVehicleIdentityConstraints,
};
