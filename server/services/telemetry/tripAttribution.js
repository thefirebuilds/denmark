const pool = require("../../db");

let schemaReady = false;
let schemaReadyPromise = null;

async function ensureTelemetryTripAttributionSchema(client = pool) {
  if (schemaReady) return;
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    await client.query(`
      ALTER TABLE vehicle_telemetry_snapshots
        ADD COLUMN IF NOT EXISTS trip_id integer
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'vehicle_telemetry_snapshots_trip_id_fkey'
        ) THEN
          ALTER TABLE vehicle_telemetry_snapshots
            ADD CONSTRAINT vehicle_telemetry_snapshots_trip_id_fkey
            FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_telemetry_snapshots_trip_id
        ON vehicle_telemetry_snapshots (trip_id, captured_at DESC)
        WHERE trip_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vehicle_telemetry_snapshots_trip_path
        ON vehicle_telemetry_snapshots (trip_id, COALESCE(location_last_updated, vehicle_last_updated, captured_at), id)
        WHERE trip_id IS NOT NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
    `);

    schemaReady = true;
  })().finally(() => {
    schemaReadyPromise = null;
  });

  return schemaReadyPromise;
}

function telemetryEventAtExpression(alias = "s") {
  return `
    COALESCE(
      CASE
        WHEN ${alias}.service_name = 'dimo'
          THEN ${alias}.location_last_updated AT TIME ZONE 'America/Chicago'
        ELSE ${alias}.location_last_updated AT TIME ZONE 'UTC'
      END,
      CASE
        WHEN ${alias}.service_name = 'dimo'
          THEN ${alias}.vehicle_last_updated AT TIME ZONE 'America/Chicago'
        ELSE ${alias}.vehicle_last_updated AT TIME ZONE 'UTC'
      END,
      ${alias}.captured_at AT TIME ZONE 'UTC'
    )
  `;
}

async function assignTripToTelemetrySnapshot(snapshotId, client = pool) {
  if (!snapshotId) return null;
  await ensureTelemetryTripAttributionSchema(client);

  const eventAt = telemetryEventAtExpression("s");
  const result = await client.query(
    `
      WITH target AS (
        SELECT
          s.id,
          s.vin,
          s.dimo_token_id,
          s.external_vehicle_key,
          ${eventAt} AS event_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.id = $1
        LIMIT 1
      ),
      matched AS (
        SELECT
          target.id AS snapshot_id,
          t.id AS trip_id
        FROM target
        JOIN vehicles v
          ON (
            target.vin IS NOT NULL
            AND target.vin <> ''
            AND v.vin IS NOT NULL
            AND LOWER(target.vin) = LOWER(v.vin)
          )
          OR (
            target.dimo_token_id IS NOT NULL
            AND v.dimo_token_id IS NOT NULL
            AND target.dimo_token_id = v.dimo_token_id
          )
          OR (
            target.external_vehicle_key IS NOT NULL
            AND v.external_vehicle_key IS NOT NULL
            AND target.external_vehicle_key = v.external_vehicle_key
          )
        JOIN LATERAL (
          SELECT t.*
          FROM trips t
          WHERE t.trip_start IS NOT NULL
            AND t.trip_end IS NOT NULL
            AND target.event_at >= t.trip_start
            AND target.event_at <= t.trip_end
            AND COALESCE(t.workflow_stage, '') <> 'canceled'
            AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
            AND (
              (
                t.turo_vehicle_id IS NOT NULL
                AND v.turo_vehicle_id IS NOT NULL
                AND CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
              )
              OR (
                COALESCE(t.vehicle_name, '') <> ''
                AND COALESCE(t.turo_vehicle_id, '') = ''
                AND LOWER(TRIM(t.vehicle_name)) IN (
                  LOWER(TRIM(v.nickname)),
                  LOWER(TRIM(COALESCE(v.turo_vehicle_name, '')))
                )
              )
              OR EXISTS (
                SELECT 1
                FROM vehicle_aliases va
                WHERE va.vehicle_id = v.id
                  AND va.active = true
                  AND COALESCE(t.vehicle_name, '') <> ''
                  AND COALESCE(t.turo_vehicle_id, '') = ''
                  AND LOWER(TRIM(va.alias)) = LOWER(TRIM(t.vehicle_name))
              )
            )
          ORDER BY
            CASE WHEN COALESCE(t.workflow_stage, '') = 'in_progress' THEN 0 ELSE 1 END,
            t.trip_start DESC,
            t.id DESC
          LIMIT 1
        ) t ON true
        LIMIT 1
      )
      UPDATE vehicle_telemetry_snapshots s
      SET trip_id = matched.trip_id
      FROM matched
      WHERE s.id = matched.snapshot_id
      RETURNING s.id, s.trip_id
    `,
    [snapshotId]
  );

  return result.rows[0] || null;
}

async function backfillTelemetryTripAttribution(options = {}, client = pool) {
  await ensureTelemetryTripAttributionSchema(client);

  const rawLimit = Number.parseInt(options.limit, 10);
  const limit =
    options.all === true || rawLimit <= 0
      ? null
      : Math.min(50000, Math.max(1, rawLimit || 5000));
  const eventAt = telemetryEventAtExpression("s");
  const limitSql = limit == null ? "" : "LIMIT $1";
  const params = limit == null ? [] : [limit];

  const result = await client.query(
    `
      WITH candidates AS (
        SELECT
          s.id,
          s.vin,
          s.dimo_token_id,
          s.external_vehicle_key,
          ${eventAt} AS event_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.trip_id IS NULL
          AND (s.latitude IS NOT NULL OR s.longitude IS NOT NULL)
        ORDER BY s.captured_at DESC, s.id DESC
        ${limitSql}
      ),
      matched AS (
        SELECT
          candidates.id AS snapshot_id,
          trip_match.id AS trip_id
        FROM candidates
        JOIN vehicles v
          ON (
            candidates.vin IS NOT NULL
            AND candidates.vin <> ''
            AND v.vin IS NOT NULL
            AND LOWER(candidates.vin) = LOWER(v.vin)
          )
          OR (
            candidates.dimo_token_id IS NOT NULL
            AND v.dimo_token_id IS NOT NULL
            AND candidates.dimo_token_id = v.dimo_token_id
          )
          OR (
            candidates.external_vehicle_key IS NOT NULL
            AND v.external_vehicle_key IS NOT NULL
            AND candidates.external_vehicle_key = v.external_vehicle_key
          )
        JOIN LATERAL (
          SELECT t.id
          FROM trips t
          WHERE t.trip_start IS NOT NULL
            AND t.trip_end IS NOT NULL
            AND candidates.event_at >= t.trip_start
            AND candidates.event_at <= t.trip_end
            AND COALESCE(t.workflow_stage, '') <> 'canceled'
            AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
            AND (
              (
                t.turo_vehicle_id IS NOT NULL
                AND v.turo_vehicle_id IS NOT NULL
                AND CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
              )
              OR (
                COALESCE(t.vehicle_name, '') <> ''
                AND COALESCE(t.turo_vehicle_id, '') = ''
                AND LOWER(TRIM(t.vehicle_name)) IN (
                  LOWER(TRIM(v.nickname)),
                  LOWER(TRIM(COALESCE(v.turo_vehicle_name, '')))
                )
              )
              OR EXISTS (
                SELECT 1
                FROM vehicle_aliases va
                WHERE va.vehicle_id = v.id
                  AND va.active = true
                  AND COALESCE(t.vehicle_name, '') <> ''
                  AND COALESCE(t.turo_vehicle_id, '') = ''
                  AND LOWER(TRIM(va.alias)) = LOWER(TRIM(t.vehicle_name))
              )
            )
          ORDER BY
            CASE WHEN COALESCE(t.workflow_stage, '') = 'in_progress' THEN 0 ELSE 1 END,
            t.trip_start DESC,
            t.id DESC
          LIMIT 1
        ) trip_match ON true
      )
      UPDATE vehicle_telemetry_snapshots s
      SET trip_id = matched.trip_id
      FROM matched
      WHERE s.id = matched.snapshot_id
      RETURNING s.id, s.trip_id
    `,
    params
  );

  return {
    scannedLimit: limit || "all",
    updated: result.rowCount,
  };
}

module.exports = {
  assignTripToTelemetrySnapshot,
  backfillTelemetryTripAttribution,
  ensureTelemetryTripAttributionSchema,
  telemetryEventAtExpression,
};
