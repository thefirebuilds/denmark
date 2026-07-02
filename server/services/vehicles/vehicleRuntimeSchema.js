const pool = require("../../db");

async function ensureVehicleRuntimeSchema(client = pool) {
  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS battery_installed_at date
  `);

  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS lockbox_pin_public boolean DEFAULT true NOT NULL
  `);
}

module.exports = {
  ensureVehicleRuntimeSchema,
};
