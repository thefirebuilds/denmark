const pool = require("../../db");

async function ensureVehicleRuntimeSchema(client = pool) {
  await client.query(`
    ALTER TABLE public.vehicles
      ADD COLUMN IF NOT EXISTS battery_installed_at date
  `);
}

module.exports = {
  ensureVehicleRuntimeSchema,
};
