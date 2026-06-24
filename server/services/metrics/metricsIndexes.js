const pool = require("../../db");

let ensureMetricsIndexesPromise = null;

async function ensureMetricsIndexes(client = pool) {
  if (!ensureMetricsIndexesPromise) {
    ensureMetricsIndexesPromise = (async () => {
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vts_location_lower_vin_latest
        ON public.vehicle_telemetry_snapshots (
          lower(vin),
          COALESCE(location_last_updated, vehicle_last_updated, captured_at) DESC NULLS LAST,
          id DESC
        )
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND vin IS NOT NULL
          AND vin <> ''
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vts_location_dimo_token_latest
        ON public.vehicle_telemetry_snapshots (
          dimo_token_id,
          COALESCE(location_last_updated, vehicle_last_updated, captured_at) DESC NULLS LAST,
          id DESC
        )
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND dimo_token_id IS NOT NULL
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vts_location_external_key_latest
        ON public.vehicle_telemetry_snapshots (
          external_vehicle_key,
          COALESCE(location_last_updated, vehicle_last_updated, captured_at) DESC NULLS LAST,
          id DESC
        )
        WHERE latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND external_vehicle_key IS NOT NULL
          AND external_vehicle_key <> ''
      `);

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
