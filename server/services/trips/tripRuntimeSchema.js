const pool = require("../../db");

let ensureTripRuntimeSchemaPromise = null;

async function ensureTripRuntimeSchema(client = pool) {
  if (!ensureTripRuntimeSchemaPromise) {
    ensureTripRuntimeSchemaPromise = client
      .query(`
        ALTER TABLE IF EXISTS public.trips
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
          ADD COLUMN IF NOT EXISTS max_speed_mph numeric,
          ADD COLUMN IF NOT EXISTS speed_over_80_count integer DEFAULT 0 NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_trips_deleted_at
          ON public.trips (deleted_at);
      `)
      .catch((err) => {
        ensureTripRuntimeSchemaPromise = null;
        throw err;
      });
  }

  return ensureTripRuntimeSchemaPromise;
}

module.exports = {
  ensureTripRuntimeSchema,
};
