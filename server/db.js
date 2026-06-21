require("dotenv").config({ path: "../.env" });
const { Pool } = require("pg");
const {
  isDatabaseConnectionError,
  markDatabaseUnavailable,
  summarizeError,
} = require("./dbHealth");
const {
  getRuntimeNumber,
  getRuntimeSecret,
} = require("./config/runtimeSecrets");

const pool = new Pool({
  host: getRuntimeSecret("PGHOST", "localhost"),
  port: getRuntimeNumber("PGPORT", 5432),
  database: getRuntimeSecret("PGDATABASE", "denmark"),
  user: getRuntimeSecret("PGUSER", "postgres"),
  password: getRuntimeSecret("PGPASSWORD", ""),
  max: getRuntimeNumber("PGPOOL_MAX", 6),
  idleTimeoutMillis: getRuntimeNumber("PGIDLE_TIMEOUT_MS", 30000),
  connectionTimeoutMillis: getRuntimeNumber("PGCONNECT_TIMEOUT_MS", 5000),
  keepAlive: true,
  keepAliveInitialDelayMillis: getRuntimeNumber(
    "PGKEEPALIVE_INITIAL_DELAY_MS",
    10000
  ),
});

pool.on("error", (err) => {
  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    console.warn(`[db] connection lost: ${summarizeError(err)}`);
    return;
  }

  console.error("[db] unexpected pool error:", err);
});

module.exports = pool;
