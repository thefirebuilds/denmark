const pool = require("../../db");

async function ensureVehicleOdometerRollupTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.vehicle_odometer_rollups (
      vehicle_id bigint PRIMARY KEY,
      vehicle_vin text NOT NULL,
      odometer_miles integer,
      source text NOT NULL DEFAULT 'unknown',
      source_trip_id bigint,
      source_reservation_id bigint,
      source_trip_start timestamptz,
      estimated_trip_miles numeric(10,1),
      confidence text NOT NULL DEFAULT 'derived',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      calculated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_rollups_vin
      ON public.vehicle_odometer_rollups (vehicle_vin)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_rollups_source_trip
      ON public.vehicle_odometer_rollups (source_trip_id)
      WHERE source_trip_id IS NOT NULL
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vehicle_odometer_rollups_vehicle_id_fkey'
      ) THEN
        ALTER TABLE public.vehicle_odometer_rollups
        ADD CONSTRAINT vehicle_odometer_rollups_vehicle_id_fkey
        FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vehicle_odometer_rollups_vehicle_vin_fkey'
      ) THEN
        ALTER TABLE public.vehicle_odometer_rollups
        ADD CONSTRAINT vehicle_odometer_rollups_vehicle_vin_fkey
        FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
}

async function refreshVehicleOdometerRollups({
  client = pool,
  vehicleVin = null,
} = {}) {
  await ensureVehicleOdometerRollupTable(client);

  const params = [];
  let vehicleFilter = "";
  if (vehicleVin) {
    params.push(String(vehicleVin).trim().toLowerCase());
    vehicleFilter = "AND LOWER(TRIM(v.vin)) = $1";
  }

  const { rows } = await client.query(
    `
    WITH rollups AS (
      SELECT
        v.id AS vehicle_id,
        v.vin AS vehicle_vin,
        selected.odometer_miles,
        selected.source,
        selected.source_trip_id,
        selected.source_reservation_id,
        selected.source_trip_start,
        selected.estimated_trip_miles,
        selected.confidence,
        jsonb_build_object(
          'vehicle_current_odometer_miles', v.current_odometer_miles,
          'latest_maintenance_odometer_miles', latest_maintenance.odometer_miles,
          'active_trip_estimated_odometer_miles', active_trip_odo.estimated_current_odometer,
          'active_trip_estimated_trip_miles', active_trip_odo.estimated_trip_miles
        ) AS metadata
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT me.odometer_miles
        FROM maintenance_events me
        WHERE me.vehicle_vin = v.vin
          AND me.odometer_miles IS NOT NULL
        ORDER BY me.performed_at DESC, me.id DESC
        LIMIT 1
      ) latest_maintenance ON TRUE
      LEFT JOIN LATERAL (
        WITH active_trip AS (
          SELECT
            t.id,
            t.reservation_id,
            t.starting_odometer,
            COALESCE(t.trip_start, ti.trip_start) AS trip_start
          FROM trips t
          LEFT JOIN trip_intelligence ti
            ON ti.id = t.id
          WHERE t.starting_odometer IS NOT NULL
            AND t.ending_odometer IS NULL
            AND LOWER(COALESCE(t.workflow_stage, '')) = 'in_progress'
            AND COALESCE(t.trip_start, ti.trip_start) IS NOT NULL
            AND (
              (
                v.turo_vehicle_id IS NOT NULL
                AND t.turo_vehicle_id = v.turo_vehicle_id
              )
              OR (
                v.nickname IS NOT NULL
                AND LOWER(TRIM(t.vehicle_name)) = LOWER(TRIM(v.nickname))
              )
            )
          ORDER BY COALESCE(t.trip_start, ti.trip_start) DESC NULLS LAST, t.id DESC
          LIMIT 1
        ),
        points AS (
          SELECT
            s.latitude::float AS lat,
            s.longitude::float AS lon,
            COALESCE(
              s.location_last_updated,
              s.vehicle_last_updated,
              s.captured_at
            ) AS seen_at
          FROM active_trip at
          JOIN vehicle_telemetry_snapshots s
            ON (
              (
                s.vin IS NOT NULL
                AND s.vin <> ''
                AND v.vin IS NOT NULL
                AND LOWER(s.vin) = LOWER(v.vin)
              )
              OR (
                s.dimo_token_id IS NOT NULL
                AND v.dimo_token_id IS NOT NULL
                AND s.dimo_token_id = v.dimo_token_id
              )
              OR (
                s.external_vehicle_key IS NOT NULL
                AND v.external_vehicle_key IS NOT NULL
                AND s.external_vehicle_key = v.external_vehicle_key
              )
            )
          WHERE s.latitude IS NOT NULL
            AND s.longitude IS NOT NULL
            AND COALESCE(
              s.location_last_updated,
              s.vehicle_last_updated,
              s.captured_at
            ) >= at.trip_start
            AND COALESCE(
              s.location_last_updated,
              s.vehicle_last_updated,
              s.captured_at
            ) <= NOW()
          ORDER BY COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) ASC, s.id ASC
        ),
        segments AS (
          SELECT
            lat,
            lon,
            LAG(lat) OVER (ORDER BY seen_at) AS prev_lat,
            LAG(lon) OVER (ORDER BY seen_at) AS prev_lon
          FROM points
        ),
        distance AS (
          SELECT SUM(
            2 * 3958.7613 * ASIN(
              SQRT(
                LEAST(
                  1,
                  POWER(SIN(RADIANS(lat - prev_lat) / 2), 2) +
                  COS(RADIANS(prev_lat)) *
                  COS(RADIANS(lat)) *
                  POWER(SIN(RADIANS(lon - prev_lon) / 2), 2)
                )
              )
            )
          ) AS miles
          FROM segments
          WHERE prev_lat IS NOT NULL
            AND prev_lon IS NOT NULL
        )
        SELECT
          at.id AS source_trip_id,
          at.reservation_id AS source_reservation_id,
          at.trip_start AS source_trip_start,
          ROUND(at.starting_odometer + COALESCE(distance.miles, 0))::integer AS estimated_current_odometer,
          ROUND(COALESCE(distance.miles, 0)::numeric, 1) AS estimated_trip_miles
        FROM active_trip at
        CROSS JOIN distance
      ) active_trip_odo ON TRUE
      LEFT JOIN LATERAL (
        SELECT *
        FROM (
          VALUES
            (
              v.current_odometer_miles::integer,
              'vehicle',
              NULL::bigint,
              NULL::bigint,
              NULL::timestamptz,
              NULL::numeric,
              'source_of_truth'
            ),
            (
              latest_maintenance.odometer_miles::integer,
              'maintenance',
              NULL::bigint,
              NULL::bigint,
              NULL::timestamptz,
              NULL::numeric,
              'manual'
            ),
            (
              active_trip_odo.estimated_current_odometer::integer,
              'active_trip_estimate',
              active_trip_odo.source_trip_id,
              active_trip_odo.source_reservation_id,
              active_trip_odo.source_trip_start,
              active_trip_odo.estimated_trip_miles,
              'derived'
            )
        ) AS candidates(
          odometer_miles,
          source,
          source_trip_id,
          source_reservation_id,
          source_trip_start,
          estimated_trip_miles,
          confidence
        )
        WHERE odometer_miles IS NOT NULL
        ORDER BY odometer_miles DESC
        LIMIT 1
      ) selected ON TRUE
      WHERE v.vin IS NOT NULL
        AND v.vin <> ''
        ${vehicleFilter}
    )
    INSERT INTO vehicle_odometer_rollups (
      vehicle_id,
      vehicle_vin,
      odometer_miles,
      source,
      source_trip_id,
      source_reservation_id,
      source_trip_start,
      estimated_trip_miles,
      confidence,
      metadata,
      calculated_at,
      updated_at
    )
    SELECT
      vehicle_id,
      vehicle_vin,
      odometer_miles,
      COALESCE(source, 'unknown'),
      source_trip_id,
      source_reservation_id,
      source_trip_start,
      estimated_trip_miles,
      COALESCE(confidence, 'unknown'),
      metadata,
      NOW(),
      NOW()
    FROM rollups
    ON CONFLICT (vehicle_id)
    DO UPDATE SET
      vehicle_vin = EXCLUDED.vehicle_vin,
      odometer_miles = EXCLUDED.odometer_miles,
      source = EXCLUDED.source,
      source_trip_id = EXCLUDED.source_trip_id,
      source_reservation_id = EXCLUDED.source_reservation_id,
      source_trip_start = EXCLUDED.source_trip_start,
      estimated_trip_miles = EXCLUDED.estimated_trip_miles,
      confidence = EXCLUDED.confidence,
      metadata = EXCLUDED.metadata,
      calculated_at = EXCLUDED.calculated_at,
      updated_at = NOW()
    RETURNING vehicle_vin, odometer_miles, source, source_trip_id
    `,
    params
  );

  return {
    refreshed: rows.length,
    rows,
  };
}

module.exports = {
  ensureVehicleOdometerRollupTable,
  refreshVehicleOdometerRollups,
};
