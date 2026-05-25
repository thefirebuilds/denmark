const pool = require("../../db");

let ensurePromise = null;

function normalizeAlias(value) {
  const alias = String(value || "").trim();
  return alias || null;
}

async function createVehicleAliasesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.vehicle_aliases (
      id bigserial PRIMARY KEY,
      vehicle_id bigint NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
      alias text NOT NULL,
      source text,
      active boolean DEFAULT true NOT NULL,
      created_at timestamp without time zone DEFAULT NOW() NOT NULL,
      updated_at timestamp without time zone DEFAULT NOW() NOT NULL
    )
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_aliases_alias
    ON public.vehicle_aliases (lower(trim(alias)))
    WHERE active = true
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_aliases_vehicle_id
    ON public.vehicle_aliases (vehicle_id)
  `);

  await client.query(`
    INSERT INTO public.vehicle_aliases (
      vehicle_id,
      alias,
      source,
      active,
      created_at,
      updated_at
    )
    SELECT v.id, v.nickname, 'canonical', true, NOW(), NOW()
    FROM public.vehicles v
    WHERE COALESCE(v.nickname, '') <> ''
    ON CONFLICT DO NOTHING
  `);

  await client.query(`
    INSERT INTO public.vehicle_aliases (
      vehicle_id,
      alias,
      source,
      active,
      created_at,
      updated_at
    )
    SELECT DISTINCT v.id, t.vehicle_name, 'turo_trip_name', true, NOW(), NOW()
    FROM public.trips t
    JOIN public.vehicles v
      ON (
        t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
    WHERE COALESCE(t.vehicle_name, '') <> ''
    ON CONFLICT DO NOTHING
  `);
}

async function ensureVehicleAliasesTable(client = pool) {
  if (client !== pool) {
    return createVehicleAliasesTable(client);
  }

  if (!ensurePromise) {
    ensurePromise = createVehicleAliasesTable(client).catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }

  return ensurePromise;
}

async function addVehicleAlias(client, vehicleId, alias, source = "manual") {
  const normalizedAlias = normalizeAlias(alias);
  if (!vehicleId || !normalizedAlias) return;

  await client.query(
    `
      INSERT INTO public.vehicle_aliases (
        vehicle_id,
        alias,
        source,
        active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, true, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `,
    [vehicleId, normalizedAlias, source]
  );
}

module.exports = {
  addVehicleAlias,
  ensureVehicleAliasesTable,
};
