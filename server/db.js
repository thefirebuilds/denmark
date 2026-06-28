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

const activePoolQueries = new Map();
let querySequence = 0;

function summarizeSql(input) {
  const text =
    typeof input === "string"
      ? input
      : typeof input?.text === "string"
      ? input.text
      : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 260) || "(unknown query)";
}

function startQueryTracking({ sql, source }) {
  const id = ++querySequence;
  const startedAt = Date.now();
  const entry = {
    id,
    source,
    sql: summarizeSql(sql),
    startedAt,
  };

  activePoolQueries.set(id, entry);

  return () => {
    activePoolQueries.delete(id);
  };
}

function wrapQueryFunction(originalQuery, source) {
  return function trackedQuery(...args) {
    const callbackIndex = args.findIndex((arg) => typeof arg === "function");
    const finish = startQueryTracking({
      sql: args[0],
      source,
    });

    if (callbackIndex >= 0) {
      const originalCallback = args[callbackIndex];
      args[callbackIndex] = (...callbackArgs) => {
        finish();
        return originalCallback(...callbackArgs);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (err) {
        finish();
        throw err;
      }
    }

    try {
      const result = originalQuery.apply(this, args);
      if (result?.finally) {
        return result.finally(finish);
      }
      finish();
      return result;
    } catch (err) {
      finish();
      throw err;
    }
  };
}

function describeQueryEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    source: entry.source,
    age_ms: now - entry.startedAt,
    sql: entry.sql,
  };
}

const originalPoolQuery = pool.query.bind(pool);
pool.query = wrapQueryFunction(originalPoolQuery, "pool.query");

pool.on("error", (err) => {
  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    console.warn(`[db] connection lost: ${summarizeError(err)}`);
    return;
  }

  console.error("[db] unexpected pool error:", err);
});

function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options?.max || null,
    checked_out: Math.max(0, pool.totalCount - pool.idleCount),
    active_queries: activePoolQueries.size,
  };
}

function getPoolActivitySnapshot({ limit = 8 } = {}) {
  const now = Date.now();
  const activeQueries = [...activePoolQueries.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, limit)
    .map((entry) => describeQueryEntry(entry, now));

  return {
    active_queries: activeQueries,
  };
}

module.exports = pool;
module.exports.getPoolStats = getPoolStats;
module.exports.getPoolActivitySnapshot = getPoolActivitySnapshot;
