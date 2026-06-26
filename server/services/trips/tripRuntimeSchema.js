const pool = require("../../db");

let ensureTripRuntimeSchemaPromise = null;

async function ensureTripRuntimeSchema(client = pool) {
  if (!ensureTripRuntimeSchemaPromise) {
    ensureTripRuntimeSchemaPromise = (async () => {
      await client.query(`
        ALTER TABLE IF EXISTS public.trips
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
          ADD COLUMN IF NOT EXISTS max_speed_mph numeric,
          ADD COLUMN IF NOT EXISTS speed_over_80_count integer DEFAULT 0 NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_trips_deleted_at
          ON public.trips (deleted_at);
      `);

      await ensureDimoSpeedStoredAsMph(client);
    })().catch((err) => {
      ensureTripRuntimeSchemaPromise = null;
      throw err;
    });
  }

  return ensureTripRuntimeSchemaPromise;
}

async function ensureDimoSpeedStoredAsMph(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.denmark_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  const marker = await client.query(
    `
      SELECT 1
      FROM public.denmark_schema_migrations
      WHERE id = 'dimo-speed-mph-v1'
      LIMIT 1
    `
  );

  if (marker.rowCount > 0) return;

  const converted = await client.query(`
    UPDATE public.vehicle_telemetry_snapshots
    SET speed = speed * 0.621371
    WHERE service_name = 'dimo'
      AND speed IS NOT NULL
      AND speed >= 0
  `);

  const recalculated = await client.query(`
    WITH speed_points AS (
      SELECT
        t.id AS trip_id,
        s.id AS snapshot_id,
        s.speed::numeric AS speed_mph,
        COALESCE(s.speed_last_updated, s.vehicle_last_updated, s.captured_at) AS recorded_at,
        LAG(s.speed::numeric) OVER (
          PARTITION BY t.id
          ORDER BY COALESCE(s.speed_last_updated, s.vehicle_last_updated, s.captured_at), s.id
        ) AS previous_speed_mph
      FROM public.trips t
      JOIN public.vehicles v
        ON (
          (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id IS NOT NULL
            AND CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(t.vehicle_name) = LOWER(v.nickname)
          )
        )
      JOIN public.vehicle_telemetry_snapshots s
        ON s.vin = v.vin
      WHERE s.speed IS NOT NULL
        AND s.speed::numeric >= 0
        AND COALESCE(s.speed_last_updated, s.vehicle_last_updated, s.captured_at) >= t.trip_start
        AND COALESCE(s.speed_last_updated, s.vehicle_last_updated, s.captured_at) <= t.trip_end
    ),
    speed_stats AS (
      SELECT
        trip_id,
        MAX(speed_mph) AS max_speed_mph,
        COUNT(*) FILTER (
          WHERE speed_mph > 80
            AND COALESCE(previous_speed_mph, 0) <= 80
        )::integer AS speed_over_80_count
      FROM speed_points
      GROUP BY trip_id
    )
    UPDATE public.trips t
    SET
      max_speed_mph = speed_stats.max_speed_mph,
      speed_over_80_count = COALESCE(speed_stats.speed_over_80_count, 0),
      updated_at = NOW()
    FROM speed_stats
    WHERE t.id = speed_stats.trip_id
      AND speed_stats.max_speed_mph IS NOT NULL
  `);

  await client.query(
    `
      INSERT INTO public.denmark_schema_migrations (id, details)
      VALUES (
        'dimo-speed-mph-v1',
        jsonb_build_object(
          'convertedDimoTelemetryRows', $1::integer,
          'recalculatedTripRows', $2::integer,
          'source', 'runtime trip schema'
        )
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [converted.rowCount || 0, recalculated.rowCount || 0]
  );
}

module.exports = {
  ensureTripRuntimeSchema,
};
