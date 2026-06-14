#!/usr/bin/env node

const path = require("path");
const { Pool } = require("pg");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

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
