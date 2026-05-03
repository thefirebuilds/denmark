require("dotenv").config({ path: "../.env" });
const { Pool } = require("pg");
const {
  isDatabaseConnectionError,
  markDatabaseUnavailable,
  summarizeError,
} = require("./dbHealth");

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "denmark",
  user: process.env.PGUSER || "postgres",
  password: String(process.env.PGPASSWORD || ""),
  max: Number(process.env.PGPOOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.PGIDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 5000),
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(
    process.env.PGKEEPALIVE_INITIAL_DELAY_MS || 10000
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
