const pool = require("../../db");

let ensureTripRuntimeSchemaPromise = null;

async function ensureTripRuntimeSchema(client = pool) {
  if (!ensureTripRuntimeSchemaPromise) {
    ensureTripRuntimeSchemaPromise = (async () => {
      await client.query(`
        ALTER TABLE IF EXISTS public.trips
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
          ADD COLUMN IF NOT EXISTS pickup_location text,
          ADD COLUMN IF NOT EXISTS return_location text,
          ADD COLUMN IF NOT EXISTS max_speed_mph numeric,
          ADD COLUMN IF NOT EXISTS speed_over_80_count integer DEFAULT 0 NOT NULL,
          ADD COLUMN IF NOT EXISTS mileage_verified boolean DEFAULT false NOT NULL,
          ADD COLUMN IF NOT EXISTS guest_rating_received boolean DEFAULT false NOT NULL,
          ADD COLUMN IF NOT EXISTS guest_rating_received_at timestamptz,
          ADD COLUMN IF NOT EXISTS returned_at timestamptz,
          ADD COLUMN IF NOT EXISTS return_late_minutes integer,
          ADD COLUMN IF NOT EXISTS return_detection_source text,
          ADD COLUMN IF NOT EXISTS return_detected_location text,
          ADD COLUMN IF NOT EXISTS return_distance_miles numeric;

        CREATE INDEX IF NOT EXISTS idx_trips_deleted_at
          ON public.trips (deleted_at);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.trip_return_audit (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          trip_id integer NOT NULL UNIQUE,
          occurred_at timestamptz NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT NOW(),
          location text,
          source text NOT NULL,
          distance_miles numeric,
          late_minutes integer,
          is_backfilled boolean NOT NULL DEFAULT false
        );

        CREATE OR REPLACE FUNCTION public.audit_trip_return() RETURNS trigger
        LANGUAGE plpgsql AS $trip_return_audit$
        BEGIN
          IF NEW.returned_at IS NOT NULL THEN
            INSERT INTO public.trip_return_audit
              (trip_id, occurred_at, location, source, distance_miles, late_minutes)
            VALUES (NEW.id, NEW.returned_at, NEW.return_detected_location,
              COALESCE(NEW.return_detection_source, 'unknown'),
              NEW.return_distance_miles, NEW.return_late_minutes)
            ON CONFLICT (trip_id) DO NOTHING;
          END IF;
          RETURN NEW;
        END $trip_return_audit$;

        DO $install_return_audit$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'public.trips'::regclass AND tgname = 'trips_return_audit') THEN
            CREATE TRIGGER trips_return_audit
              AFTER INSERT OR UPDATE OF returned_at ON public.trips
              FOR EACH ROW EXECUTE FUNCTION public.audit_trip_return();
          END IF;
        END $install_return_audit$;

        INSERT INTO public.trip_return_audit
          (trip_id, occurred_at, location, source, distance_miles, late_minutes, is_backfilled)
        SELECT id, returned_at, return_detected_location,
          COALESCE(return_detection_source, 'unknown'), return_distance_miles, return_late_minutes, true
        FROM public.trips WHERE returned_at IS NOT NULL
        ON CONFLICT (trip_id) DO NOTHING;
      `);

      await client.query(`
        UPDATE public.trips t
        SET guest_rating_received = TRUE,
            guest_rating_received_at = COALESCE(
              t.guest_rating_received_at,
              rated.rated_at
            )
        FROM (
          SELECT
            reservation_id,
            MAX(COALESCE(message_timestamp, created_at)) AS rated_at
          FROM public.messages
          WHERE message_type = 'trip_rated'
            AND reservation_id IS NOT NULL
          GROUP BY reservation_id
        ) rated
        WHERE t.reservation_id = rated.reservation_id
          AND t.guest_rating_received = FALSE
      `);

      await client.query(`
        DO $check_in_migration$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.trips'::regclass
            AND conname = 'trips_workflow_stage_check'
            AND pg_get_constraintdef(oid) LIKE '%turnaround%') THEN
            ALTER TABLE public.trips DROP CONSTRAINT trips_workflow_stage_check;
            UPDATE public.trips SET workflow_stage = 'check_in' WHERE workflow_stage = 'turnaround';
            ALTER TABLE public.trips ADD CONSTRAINT trips_workflow_stage_check
              CHECK (workflow_stage IN ('booked','confirmed','ready_for_handoff','in_progress',
                'check_in','awaiting_expenses','complete','canceled'));
          END IF;
        END $check_in_migration$;
      `);
      await ensureDimoSpeedStoredAsMph(client);
      await normalizeLegacyUnconfirmedTripStatuses(client);
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

async function normalizeLegacyUnconfirmedTripStatuses(client) {
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
      WHERE id = 'normalize-active-trip-legacy-unconfirmed-status-v1'
      LIMIT 1
    `
  );

  if (marker.rowCount > 0) return;

  const normalized = await client.query(`
    UPDATE public.trips
    SET
      status = 'booked',
      needs_review = FALSE,
      updated_at = NOW()
    WHERE status IN ('booked_unconfirmed', 'updated_unconfirmed')
      AND COALESCE(workflow_stage, '') IN (
        'confirmed',
        'ready_for_handoff',
        'in_progress',
        'turnaround',
        'awaiting_expenses',
        'complete',
        'closed'
      )
  `);

  await client.query(
    `
      INSERT INTO public.denmark_schema_migrations (id, details)
      VALUES (
        'normalize-active-trip-legacy-unconfirmed-status-v1',
        jsonb_build_object(
          'normalizedTrips', $1::integer,
          'source', 'runtime trip schema'
        )
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [normalized.rowCount || 0]
  );
}

module.exports = {
  ensureTripRuntimeSchema,
};
