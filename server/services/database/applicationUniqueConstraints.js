const pool = require("../../db");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REQUIRED_UNIQUE_CONSTRAINTS = [
  { table: "api_auth_tokens", name: "api_auth_tokens_service_name_key", columns: ["service_name"] },
  { table: "app_settings", name: "app_settings_key_key", columns: ["key"] },
  { table: "app_users", name: "app_users_email_unique", columns: ["email"] },
  { table: "app_users", name: "app_users_provider_subject_unique", columns: ["provider", "provider_subject"] },
  { table: "business_financial_settings", name: "business_financial_settings_id_key", columns: ["id"] },
  { table: "database_import_jobs", name: "database_import_jobs_id_key", columns: ["id"] },
  { table: "denmark_schema_migrations", name: "denmark_schema_migrations_id_key", columns: ["id"] },
  { table: "fleet_alert_deliveries", name: "fleet_alert_deliveries_alert_key_key", columns: ["alert_key"] },
  { table: "maintenance_rule_templates", name: "maintenance_rule_templates_rule_code_key", columns: ["rule_code"] },
  { table: "maintenance_tasks", name: "maintenance_tasks_source_key_key", columns: ["source_key"] },
  { table: "marketplace_listings", name: "marketplace_listings_url_key", columns: ["url"] },
  { table: "marketplace_preferences", name: "marketplace_preferences_preference_key_key", columns: ["preference_key"] },
  { table: "messages", name: "messages_message_id_key", columns: ["message_id"] },
  { table: "metric_period_snapshots", name: "metric_period_snapshots_period_key_key", columns: ["period_key"] },
  { table: "notification_events", name: "notification_events_event_hash_key", columns: ["event_hash"] },
  { table: "service_tokens", name: "service_tokens_token_hash_unique", columns: ["token_hash"] },
  { table: "teller_transactions", name: "teller_transactions_teller_transaction_id_key", columns: ["teller_transaction_id"] },
  { table: "toll_charges", name: "toll_charges_source_fingerprint_key", columns: ["source", "external_fingerprint"] },
  { table: "trip_financial_facts", name: "trip_financial_facts_trip_id_key", columns: ["trip_id"] },
  { table: "trip_google_sync", name: "trip_google_sync_trip_calendar_event_key", columns: ["trip_id", "google_calendar_connection_id", "event_type"] },
  { table: "trips", name: "trips_reservation_id_key", columns: ["reservation_id"] },
  { table: "vehicle_diagnostic_suppressions", name: "vehicle_diagnostic_suppressions_diagnostic_key_key", columns: ["diagnostic_key"] },
  { table: "vehicle_financial_profiles", name: "vehicle_financial_profiles_vehicle_id_key", columns: ["vehicle_id"] },
  { table: "vehicle_odometer_rollups", name: "vehicle_odometer_rollups_vehicle_id_key", columns: ["vehicle_id"] },
  { table: "vehicle_telemetry_raw_payloads", name: "vehicle_telemetry_raw_payloads_snapshot_id_key", columns: ["snapshot_id"] },
];

function quoteIdentifier(value) {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function formatColumnList(columns) {
  return columns.map(quoteIdentifier).join(", ");
}

async function tableExists(client, table) {
  const { rows } = await client.query(
    "SELECT to_regclass($1) AS table_name",
    [`public.${table}`]
  );
  return Boolean(rows[0]?.table_name);
}

async function hasUsableUniqueIndex(client, table, columns) {
  const { rows } = await client.query(
    `
      SELECT COALESCE(bool_or(index_columns = $2::text[]), false) AS exists
      FROM (
        SELECT array_agg(att.attname ORDER BY ord.n) AS index_columns
        FROM pg_index idx
        JOIN pg_class rel ON rel.oid = idx.indrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN unnest(idx.indkey) WITH ORDINALITY AS ord(attnum, n) ON true
        JOIN pg_attribute att
          ON att.attrelid = rel.oid
         AND att.attnum = ord.attnum
        WHERE ns.nspname = 'public'
          AND rel.relname = $1
          AND idx.indisunique = true
          AND idx.indpred IS NULL
        GROUP BY idx.indexrelid
      ) unique_indexes
    `,
    [table, columns]
  );
  return rows[0]?.exists === true;
}

async function assertNoDuplicateKey(client, { table, columns }) {
  const whereClause = columns
    .map((column) => `${quoteIdentifier(column)} IS NOT NULL`)
    .join(" AND ");
  const jsonFields = columns
    .map((column) => `'${column}', ${quoteIdentifier(column)}`)
    .join(", ");
  const groupBy = formatColumnList(columns);

  const { rows } = await client.query(`
    SELECT jsonb_build_object(${jsonFields}) AS value, COUNT(*)::int AS count
    FROM public.${quoteIdentifier(table)}
    WHERE ${whereClause}
    GROUP BY ${groupBy}
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 5
  `);

  if (!rows.length) return;

  const details = rows
    .map((row) => `${JSON.stringify(row.value)} (${row.count} rows)`)
    .join(", ");
  throw new Error(
    `Cannot add unique constraint on public.${table}(${columns.join(
      ", "
    )}); duplicate values found: ${details}`
  );
}

async function ensureUniqueConstraint(client, constraint) {
  if (!(await tableExists(client, constraint.table))) {
    throw new Error(`public.${constraint.table} is missing`);
  }

  if (await hasUsableUniqueIndex(client, constraint.table, constraint.columns)) return false;

  await assertNoDuplicateKey(client, constraint);

  await client.query(`
    ALTER TABLE public.${quoteIdentifier(constraint.table)}
    ADD CONSTRAINT ${quoteIdentifier(constraint.name)}
    UNIQUE (${formatColumnList(constraint.columns)})
  `);

  return true;
}

async function ensureApplicationUniqueConstraints(client = pool, { log = null } = {}) {
  for (const constraint of REQUIRED_UNIQUE_CONSTRAINTS) {
    if (typeof log === "function") {
      log(
        `[db:schema] ensuring unique constraint ${constraint.name} on ${constraint.table}(${constraint.columns.join(
          ", "
        )})`
      );
    }
    await ensureUniqueConstraint(client, constraint);
  }
}

module.exports = {
  REQUIRED_UNIQUE_CONSTRAINTS,
  ensureApplicationUniqueConstraints,
};
