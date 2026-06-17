#!/usr/bin/env node

const fs = require("fs");
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
  ensureVehicleIdentityConstraints,
} = require("../server/services/vehicles/vehicleIdentityConstraints");
const {
  ensureApplicationUniqueConstraints,
} = require("../server/services/database/applicationUniqueConstraints");
const {
  ensureSystemActivityLogTable,
} = require("../server/services/systemActivityLog");
const { ensureIncomeTables } = require("../server/services/income/incomeService");
const { ensureFleetAlertTables } = require("../server/services/alerts/fleetAlerts");
const {
  ensureAuthPublicUrlSettings,
} = require("../server/services/authPublicUrlSettings");

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
  "database_import_jobs",
  "service_tokens",
];
const RUNTIME_ENSURED_TABLES = ["income_transactions"];
const REQUIRED_TABLES = [...BASE_SCHEMA_TABLES, ...RUNTIME_ENSURED_TABLES];
const RUNTIME_DEPENDENCY_TABLES = ["vehicles", "trips", "teller_transactions"];

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

function splitSqlStatements(sql) {
  const statements = [];
  let statement = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (dollarQuoteTag) {
      const maybeTag = sql.slice(i, i + dollarQuoteTag.length);
      if (maybeTag === dollarQuoteTag) {
        statement += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      } else {
        statement += char;
      }
      continue;
    }

    if (inLineComment) {
      statement += char;
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      statement += char;
      if (char === "*" && next === "/") {
        statement += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "-" && next === "-") {
      statement += char + next;
      i += 1;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "/" && next === "*") {
      statement += char + next;
      i += 1;
      inBlockComment = true;
      continue;
    }

    if (!inDoubleQuote && char === "'") {
      statement += char;
      if (inSingleQuote && next === "'") {
        statement += next;
        i += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (!inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
      statement += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && char === "$") {
      const rest = sql.slice(i);
      const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuoteTag = match[0];
        statement += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && char === ";") {
      const trimmed = statement.trim();
      if (trimmed) statements.push(`${trimmed};`);
      statement = "";
      continue;
    }

    statement += char;
  }

  const trailing = statement.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function describeSqlStatement(statement) {
  const sql = statement
    .replace(/^\s*--.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  const patterns = [
    [/^CREATE UNIQUE INDEX\s+([^\s]+)/i, "create unique index"],
    [/^CREATE INDEX\s+([^\s]+)/i, "create index"],
    [/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([^\s(]+)/i, "create table"],
    [/^ALTER TABLE(?: ONLY)?\s+([^\s]+)/i, "alter table"],
    [/^CREATE SEQUENCE\s+([^\s]+)/i, "create sequence"],
    [/^CREATE VIEW\s+([^\s]+)/i, "create view"],
    [/^CREATE TRIGGER\s+([^\s]+)/i, "create trigger"],
    [/^DROP SCHEMA\s+IF EXISTS\s+([^\s;]+)/i, "drop schema"],
  ];

  for (const [pattern, action] of patterns) {
    const match = sql.match(pattern);
    if (match) return `${action} ${match[1]}`;
  }

  return sql.slice(0, 100);
}

async function runSchemaSql(client, schemaSql) {
  const statements = splitSqlStatements(schemaSql);
  console.log(`[db:bootstrap] applying base schema (${statements.length} statements)`);

  for (const statement of statements) {
    const label = describeSqlStatement(statement);
    console.log(`[db:bootstrap] ${label}`);

    try {
      await client.query(statement);
    } catch (err) {
      err.message = `schema statement failed during ${label}: ${err.message}`;
      throw err;
    }
  }
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
      UPDATE public.denmark_schema_migrations
      SET
        applied_at = now(),
        details = jsonb_build_object(
          'requiredTables', $1::text[],
          'source', 'server/db/schema.sql'
        )
      WHERE id = 'bootstrap-schema'
    `,
    [REQUIRED_TABLES]
  );

  await client.query(
    `
      INSERT INTO public.denmark_schema_migrations (id, details)
      SELECT
        'bootstrap-schema',
        jsonb_build_object(
          'requiredTables', $1::text[],
          'source', 'server/db/schema.sql'
        )
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.denmark_schema_migrations
        WHERE id = 'bootstrap-schema'
      )
    `,
    [REQUIRED_TABLES]
  );
}

async function assertRuntimeDependencies(client) {
  const existing = await getExistingRequiredTables(client);
  const missing = RUNTIME_DEPENDENCY_TABLES.filter((table) => !existing.has(table));

  if (missing.length) {
    throw new Error(
      `base schema missing runtime dependency tables before support-table creation: ${missing.join(
        ", "
      )}`
    );
  }
}

async function runRuntimeEnsures() {
  await ensureVehicleIdentityConstraints();
  await ensureApplicationUniqueConstraints(undefined, {
    log(message) {
      console.log(message.replace("[db:schema]", "[db:bootstrap]"));
    },
  });
  await ensureAuthTables();
  await ensureGoogleCalendarConnectionHealthColumns();
  await ensureVehicleFmvEstimatesTable();
  await ensureBusinessMetricsTables();
  await ensureVehicleOdometerRollupTable();
  await ensureVehicleAliasesTable();
  await ensureSystemActivityLogTable();
  await ensureIncomeTables();
  await ensureFleetAlertTables();
  await ensureAuthPublicUrlSettings();
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
      await assertRuntimeDependencies(client);
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
    await runSchemaSql(client, schemaSql);
    await ensureBootstrapMarker(client);
    await client.query("COMMIT");

    console.log("[db:bootstrap] ensuring runtime support tables");
    await assertRuntimeDependencies(client);
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
