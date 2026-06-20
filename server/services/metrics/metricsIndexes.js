const pool = require("../../db");

let ensureMetricsIndexesPromise = null;

async function ensureMetricsIndexes(client = pool) {
  if (!ensureMetricsIndexesPromise) {
    ensureMetricsIndexesPromise = (async () => {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vts_dimo_token_odometer_recorded
        ON public.vehicle_telemetry_snapshots (
          dimo_token_id,
          COALESCE(odometer_last_updated, vehicle_last_updated, captured_at)
        )
        WHERE service_name = 'dimo'
          AND odometer IS NOT NULL
          AND dimo_token_id IS NOT NULL
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vts_dimo_vin_odometer_recorded
        ON public.vehicle_telemetry_snapshots (
          lower(vin),
          COALESCE(odometer_last_updated, vehicle_last_updated, captured_at)
        )
        WHERE service_name = 'dimo'
          AND odometer IS NOT NULL
          AND vin IS NOT NULL
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_trips_metrics_window
        ON public.trips (trip_start, trip_end)
        WHERE canceled_at IS NULL OR amount > 0
      `);
    })().catch((error) => {
      ensureMetricsIndexesPromise = null;
      throw error;
    });
  }

  return ensureMetricsIndexesPromise;
}

module.exports = {
  ensureMetricsIndexes,
};
