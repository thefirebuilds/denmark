#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const ROOT_DIR = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT_DIR, ".env") });

const appPool = require("../server/db");
const { ensureAuthTables } = require("../server/auth/store");
const {
  ensureGoogleCalendarConnectionHealthColumns,
} = require("../server/services/googleCalendar/googleCalendarStore");
const {
  ensureVehicleFmvEstimatesTable,
} = require("../server/services/vehicles/fmvEstimateService");
const {
  ensureBusinessMetricsTables,
} = require("../server/services/metrics/businessMetricsService");
const {
  ensureVehicleOdometerRollupTable,
} = require("../server/services/vehicles/odometerRollupService");
const {
  ensureVehicleAliasesTable,
} = require("../server/services/vehicles/vehicleAliases");
const {
  ensureSystemActivityLogTable,
} = require("../server/services/systemActivityLog");
const { ensureIncomeTables } = require("../server/services/income/incomeService");
const { ensureFleetAlertTables } = require("../server/services/alerts/fleetAlerts");

const SCHEMA_PATH = path.join(ROOT_DIR, "server/db/schema.sql");
const FORCE_RESET = process.argv.includes("--force-reset");
const BASE_SCHEMA_TABLES = [
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
  "service_tokens",
];
const RUNTIME_ENSURED_TABLES = ["income_transactions"];
const REQUIRED_TABLES = [...BASE_SCHEMA_TABLES, ...RUNTIME_ENSURED_TABLES];

function getConnectionConfig() {
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "denmark",
    user: process.env.PGUSER || "postgres",
    password: String(process.env.PGPASSWORD || ""),
  };
}

function loadRepaveSchemaSql() {
  const raw = fs.readFileSync(SCHEMA_PATH, "utf8");
  const start = raw.indexOf("DROP SCHEMA IF EXISTS public;");

  if (start < 0) {
    throw new Error(`Could not find schema body in ${SCHEMA_PATH}`);
  }

  return raw
    .slice(start)
    .replace("DROP SCHEMA IF EXISTS public;", "DROP SCHEMA IF EXISTS public CASCADE;");
}

async function getExistingRequiredTables(client) {
  const result = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [BASE_SCHEMA_TABLES]
  );

  return new Set(result.rows.map((row) => row.table_name));
}

async function ensureBootstrapMarker(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.denmark_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  await client.query(
    `
      INSERT INTO public.denmark_schema_migrations (id, details)
      VALUES (
        'bootstrap-schema',
        jsonb_build_object(
          'requiredTables', $1::text[],
          'source', 'server/db/schema.sql'
        )
      )
      ON CONFLICT (id)
      DO UPDATE SET
        applied_at = now(),
        details = EXCLUDED.details
    `,
    [REQUIRED_TABLES]
  );
}

async function runRuntimeEnsures() {
  await ensureAuthTables();
  await ensureGoogleCalendarConnectionHealthColumns();
  await ensureVehicleFmvEstimatesTable();
  await ensureBusinessMetricsTables();
  await ensureVehicleOdometerRollupTable();
  await ensureVehicleAliasesTable();
  await ensureSystemActivityLogTable();
  await ensureIncomeTables();
  await ensureFleetAlertTables();
}

async function main() {
  const config = getConnectionConfig();
  const pool = new Pool(config);
  const client = await pool.connect();

  try {
    console.log(
      `[db:bootstrap] connecting to ${config.user}@${config.host}:${config.port}/${config.database}`
    );

    const existing = await getExistingRequiredTables(client);
    const missing = BASE_SCHEMA_TABLES.filter((table) => !existing.has(table));

    if (existing.size === BASE_SCHEMA_TABLES.length && !FORCE_RESET) {
      await ensureBootstrapMarker(client);
      await runRuntimeEnsures();
      console.log("[db:bootstrap] schema already initialized; ensured runtime tables");
      return;
    }

    if (existing.size > 0 && !FORCE_RESET) {
      console.error("[db:bootstrap] database appears partially initialized.");
      console.error(`[db:bootstrap] existing required tables: ${existing.size}`);
      console.error(`[db:bootstrap] missing required tables: ${missing.join(", ")}`);
      console.error(
        "[db:bootstrap] refusing to reset a non-empty schema. Re-run with -- --force-reset only if this database contains no data you need."
      );
      process.exitCode = 2;
      return;
    }

    if (FORCE_RESET) {
      console.warn("[db:bootstrap] --force-reset supplied; public schema will be rebuilt");
    }

    const schemaSql = loadRepaveSchemaSql();
    await client.query("BEGIN");
    await client.query(schemaSql);
    await ensureBootstrapMarker(client);
    await client.query("COMMIT");

    await runRuntimeEnsures();
    console.log(
      `[db:bootstrap] created Denmark schema with ${REQUIRED_TABLES.length} required tables`
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Ignore rollback failures; the original error is more useful.
    }

    console.error("[db:bootstrap] failed:", err.message || err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
    await appPool.end();
  }
}

main();
