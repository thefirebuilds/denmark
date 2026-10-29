const pool = require("../../db");

let ensurePromise = null;

async function createVehicleRuntimeSchema(client) {
  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS battery_installed_at date,
      ADD COLUMN IF NOT EXISTS dimo_odometer_unit text NOT NULL DEFAULT 'km'
        CHECK (dimo_odometer_unit IN ('km', 'mi'))
  `);

  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS lockbox_pin_public boolean DEFAULT true NOT NULL
  `);

  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS trip_eligible boolean DEFAULT true NOT NULL
  `);
}

function ensureVehicleRuntimeSchema(client = pool) {
  // Transaction-owned clients must not cache work that could later roll back.
  if (client !== pool) return createVehicleRuntimeSchema(client);
  if (!ensurePromise) {
    ensurePromise = createVehicleRuntimeSchema(client).catch(error => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

module.exports = {
  ensureVehicleRuntimeSchema,
};
