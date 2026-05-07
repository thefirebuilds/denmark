const pool = require("../../db");
const { ensureTelemetryRawPayloadTable } = require("./rawPayloadStore");

const DEFAULT_RAW_PAYLOAD_RETENTION_DAYS = 90;
const DEFAULT_RUN_INTERVAL_DAYS = 7;
const RETENTION_SETTING_KEY = "telemetry.rawPayloadRetention.lastRun";

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalPositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getRawPayloadRetentionDays() {
  return parsePositiveInteger(
    process.env.TELEMETRY_RAW_PAYLOAD_RETENTION_DAYS,
    DEFAULT_RAW_PAYLOAD_RETENTION_DAYS
  );
}

function getRetentionRunIntervalDays() {
  return parsePositiveInteger(
    process.env.TELEMETRY_RAW_PAYLOAD_PRUNE_INTERVAL_DAYS,
    DEFAULT_RUN_INTERVAL_DAYS
  );
}

function getArchiveRetentionDays() {
  return parseOptionalPositiveInteger(
    process.env.TELEMETRY_RAW_PAYLOAD_ARCHIVE_RETENTION_DAYS
  );
}

async function getLastRunAt(client) {
  const result = await client.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [RETENTION_SETTING_KEY]
  );

  const value = result.rows[0]?.value;
  const rawTimestamp =
    typeof value === "string" ? value : value?.last_run_at || value?.lastRunAt;
  if (!rawTimestamp) return null;

  const timestamp = new Date(rawTimestamp);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

async function markRun(client, summary) {
  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `,
    [
      RETENTION_SETTING_KEY,
      JSON.stringify({
        last_run_at: new Date().toISOString(),
        ...summary,
      }),
    ]
  );
}

async function pruneOldTelemetryRawPayloads(options = {}) {
  const retentionDays = parsePositiveInteger(
    options.retentionDays,
    getRawPayloadRetentionDays()
  );
  const force = options.force === true;
  const intervalDays = parsePositiveInteger(
    options.intervalDays,
    getRetentionRunIntervalDays()
  );
  const client = await pool.connect();

  try {
    const lastRunAt = await getLastRunAt(client);
    const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

    if (!force && lastRunAt && Date.now() - lastRunAt.getTime() < intervalMs) {
      return {
        ran: false,
        reason: "recently_ran",
        lastRunAt: lastRunAt.toISOString(),
        retentionDays,
        intervalDays,
        archiveRetentionDays: getArchiveRetentionDays(),
        archivePrunedRows: 0,
        legacySnapshotRows: 0,
      };
    }

    await ensureTelemetryRawPayloadTable(client);

    const legacySnapshotResult = await client.query(
      `
        UPDATE vehicle_telemetry_snapshots
        SET raw_payload = NULL
        WHERE raw_payload IS NOT NULL
          AND COALESCE(vehicle_last_updated, captured_at) < NOW() - ($1::int * INTERVAL '1 day')
      `,
      [retentionDays]
    );

    const archiveRetentionDays = parseOptionalPositiveInteger(
      options.archiveRetentionDays
    ) || getArchiveRetentionDays();
    let rawPayloadResult = { rowCount: 0 };

    if (archiveRetentionDays) {
      rawPayloadResult = await client.query(
        `
          DELETE FROM vehicle_telemetry_raw_payloads raw
          USING vehicle_telemetry_snapshots s
          WHERE raw.snapshot_id = s.id
            AND COALESCE(s.vehicle_last_updated, s.captured_at) < NOW() - ($1::int * INTERVAL '1 day')
        `,
        [archiveRetentionDays]
      );
    }

    const summary = {
      ran: true,
      retention_days: retentionDays,
      interval_days: intervalDays,
      archive_retention_days: archiveRetentionDays,
      archive_pruned_rows: Number(rawPayloadResult.rowCount || 0),
      legacy_snapshot_rows: Number(legacySnapshotResult.rowCount || 0),
    };

    await markRun(client, summary);

    return {
      ran: true,
      retentionDays,
      intervalDays,
      archiveRetentionDays,
      archivePrunedRows: Number(rawPayloadResult.rowCount || 0),
      legacySnapshotRows: Number(legacySnapshotResult.rowCount || 0),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_RAW_PAYLOAD_RETENTION_DAYS,
  DEFAULT_RUN_INTERVAL_DAYS,
  pruneOldTelemetryRawPayloads,
};
