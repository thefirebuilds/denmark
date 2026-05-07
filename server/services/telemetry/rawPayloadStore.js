async function ensureTelemetryRawPayloadTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vehicle_telemetry_raw_payloads (
      snapshot_id bigint PRIMARY KEY REFERENCES vehicle_telemetry_snapshots(id) ON DELETE CASCADE,
      raw_payload jsonb NOT NULL,
      created_at timestamp without time zone DEFAULT now() NOT NULL
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_telemetry_raw_payloads_created_at
      ON vehicle_telemetry_raw_payloads (created_at)
  `);
}

async function saveTelemetryRawPayload(client, snapshotId, rawPayload) {
  if (!snapshotId || rawPayload == null) return { rowCount: 0 };

  await ensureTelemetryRawPayloadTable(client);

  return client.query(
    `
      INSERT INTO vehicle_telemetry_raw_payloads (snapshot_id, raw_payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (snapshot_id)
      DO UPDATE SET
        raw_payload = EXCLUDED.raw_payload,
        created_at = NOW()
    `,
    [
      snapshotId,
      typeof rawPayload === "string" ? rawPayload : JSON.stringify(rawPayload),
    ]
  );
}

module.exports = {
  ensureTelemetryRawPayloadTable,
  saveTelemetryRawPayload,
};
