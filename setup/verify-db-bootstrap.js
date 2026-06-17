#!/usr/bin/env node

const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

function requireAppDependency(name) {
  try {
    return require(name);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return require(path.join(ROOT_DIR, "server/node_modules", name));
  }
}

const { Pool } = requireAppDependency("pg");
requireAppDependency("dotenv").config({ path: path.join(ROOT_DIR, ".env") });
const {
  REQUIRED_UNIQUE_CONSTRAINTS,
} = require("../server/services/database/applicationUniqueConstraints");

const REQUIRED_TABLES = [
  "api_auth_tokens",
  "app_settings",
  "business_financial_settings",
  "trip_financial_facts",
  "metric_period_snapshots",
  "vehicle_period_snapshots",
  "metric_data_quality_flags",
  "ai_metric_reviews",
  "vehicle_financial_profiles",
  "vehicle_fmv_estimates",
  "expenses",
  "fleet_alert_deliveries",
  "vehicle_diagnostic_suppressions",
  "google_calendar_connections",
  "maintenance_events",
  "maintenance_rule_templates",
  "maintenance_rules",
  "maintenance_tasks",
  "marketplace_listings",
  "marketplace_preferences",
  "notification_events",
  "messages",
  "teller_ignore_rules",
  "teller_tokens",
  "teller_transactions",
  "toll_charges",
  "toll_sync_runs",
  "trip_stage_history",
  "trips",
  "trip_google_sync",
  "vehicle_condition_notes",
  "vehicle_odometer_history",
  "vehicle_odometer_rollups",
  "vehicle_telemetry_signal_values",
  "vehicle_telemetry_snapshots",
  "vehicle_telemetry_raw_payloads",
  "vehicles",
  "vehicle_aliases",
  "app_users",
  "auth_audit_log",
  "system_activity_log",
  "database_import_jobs",
  "service_tokens",
  "income_transactions",
  "denmark_schema_migrations",
];

function getConnectionConfig() {
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "denmark",
    user: process.env.PGUSER || "postgres",
    password: String(process.env.PGPASSWORD || ""),
  };
}

async function verifyTables(pool) {
  const { rows } = await pool.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [REQUIRED_TABLES]
  );
  const found = new Set(rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((table) => !found.has(table));

  if (missing.length) {
    throw new Error(`missing tables: ${missing.join(", ")}`);
  }

  console.log(`[db:verify] found ${REQUIRED_TABLES.length} required tables`);
}

async function verifyVehicleIdentityConstraints(pool) {
  const { rows } = await pool.query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.vehicles'::regclass
        AND contype IN ('p', 'u')
        AND conname = ANY($1::text[])
    `,
    [["vehicles_id_key", "vehicles_vin_key", "vehicles_pkey"]]
  );
  const found = new Set(rows.map((row) => row.conname));

  if (!found.has("vehicles_id_key")) {
    throw new Error("missing vehicles_id_key unique constraint");
  }
  if (!found.has("vehicles_vin_key") && !found.has("vehicles_pkey")) {
    throw new Error("missing vehicles vin unique/primary key constraint");
  }

  console.log("[db:verify] vehicle identity constraints ok");
}

async function verifyApplicationUniqueConstraints(pool) {
  for (const constraint of REQUIRED_UNIQUE_CONSTRAINTS) {
    const { rows } = await pool.query(
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
      [constraint.table, constraint.columns]
    );

    if (rows[0]?.exists !== true) {
      throw new Error(
        `missing unique constraint/index for ${constraint.table}(${constraint.columns.join(
          ", "
        )})`
      );
    }
  }

  console.log(
    `[db:verify] application unique constraints ok (${REQUIRED_UNIQUE_CONSTRAINTS.length})`
  );
}

async function verifyApi() {
  const baseUrl = String(process.env.DENMARK_VERIFY_API_BASE_URL || "").trim();
  if (!baseUrl) return;

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/metrics`);
  const body = await response.text();

  if (body.includes('relation "public.vehicles" does not exist')) {
    throw new Error("/api/metrics still fails because public.vehicles is missing");
  }

  if (response.status >= 500) {
    throw new Error(`/api/metrics returned ${response.status}: ${body.slice(0, 300)}`);
  }

  console.log(`[db:verify] /api/metrics returned HTTP ${response.status}`);
}

async function main() {
  const config = getConnectionConfig();
  const pool = new Pool(config);

  try {
    console.log(
      `[db:verify] checking ${config.user}@${config.host}:${config.port}/${config.database}`
    );
    await verifyTables(pool);
    await verifyVehicleIdentityConstraints(pool);
    await verifyApplicationUniqueConstraints(pool);
    await verifyApi();
    console.log("[db:verify] ok");
  } catch (err) {
    console.error("[db:verify] failed:", err.message || err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
