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
  query_timeout: getRuntimeNumber("PGQUERY_TIMEOUT_MS", 45000),
  statement_timeout: getRuntimeNumber("PGSTATEMENT_TIMEOUT_MS", 45000),
  keepAlive: true,
  keepAliveInitialDelayMillis: getRuntimeNumber(
    "PGKEEPALIVE_INITIAL_DELAY_MS",
    10000
  ),
});

const activePoolQueries = new Map();
const activePoolClients = new Map();
let querySequence = 0;
let clientSequence = 0;
let lastPoolPressureLogAt = 0;

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

function getUsefulStackCaller(stack) {
  return String(stack || "")
    .split("\n")
    .slice(2)
    .find((line) => !line.includes("server\\db.js") && !line.includes("server/db.js"))
    ?.trim();
}

function startClientTracking(stack) {
  const id = ++clientSequence;
  const startedAt = Date.now();
  const caller = getUsefulStackCaller(stack);

  activePoolClients.set(id, {
    id,
    source: "pool.connect",
    caller: caller || null,
    startedAt,
  });

  return () => {
    activePoolClients.delete(id);
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

function wrapConnectedClient(client, stack) {
  if (!client || client.__denmarkTrackedClient) return client;

  const finishClient = startClientTracking(stack);
  const originalRelease = client.release.bind(client);
  const originalQuery = client.query.bind(client);
  let released = false;

  client.query = wrapQueryFunction(originalQuery, "client.query");
  client.release = (...args) => {
    if (!released) {
      released = true;
      finishClient();
    }
    return originalRelease(...args);
  };
  Object.defineProperty(client, "__denmarkTrackedClient", {
    value: true,
    enumerable: false,
  });

  return client;
}

function describeQueryEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    source: entry.source,
    age_ms: now - entry.startedAt,
    sql: entry.sql,
  };
}

function describeClientEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    source: entry.source,
    age_ms: now - entry.startedAt,
    caller: entry.caller,
  };
}

const originalPoolQuery = pool.query.bind(pool);
pool.query = wrapQueryFunction(originalPoolQuery, "pool.query");
const originalPoolConnect = pool.connect.bind(pool);
pool.connect = function trackedConnect(...args) {
  const callbackIndex = args.findIndex((arg) => typeof arg === "function");
  const stack = new Error().stack || "";

  if (callbackIndex >= 0) {
    return originalPoolConnect(...args);
  }

  return originalPoolConnect(...args).then((client) =>
    wrapConnectedClient(client, stack)
  );
};

pool.on("error", (err) => {
  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    console.warn(`[db] connection lost: ${summarizeError(err)}`);
    return;
  }

  console.error("[db] unexpected pool error:", err);
});

function getPoolStats() {
  const stats = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options?.max || null,
    checked_out: Math.max(0, pool.totalCount - pool.idleCount),
    active_queries: activePoolQueries.size,
    checked_out_clients: activePoolClients.size,
  };

  maybeLogPoolPressure(stats);
  return stats;
}

function maybeLogPoolPressure(stats) {
  const max = Number(stats.max || 0);
  const checkedOut = Number(stats.checked_out || 0);
  const waiting = Number(stats.waiting || 0);
  const pressure =
    waiting > 0 || (max > 0 && checkedOut >= Math.max(1, max - 1));

  if (!pressure) return;

  const now = Date.now();
  const intervalMs = getRuntimeNumber("PGPOOL_PRESSURE_LOG_INTERVAL_MS", 15000);
  if (now - lastPoolPressureLogAt < intervalMs) return;
  lastPoolPressureLogAt = now;

  console.warn(
    `[db] pool pressure ${JSON.stringify({
      ...stats,
      activity: getPoolActivitySnapshot({ limit: 12 }),
    })}`
  );
}

function getPoolActivitySnapshot({ limit = 8 } = {}) {
  const now = Date.now();
  const activeQueries = [...activePoolQueries.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, limit)
    .map((entry) => describeQueryEntry(entry, now));
  const checkedOutClients = [...activePoolClients.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, limit)
    .map((entry) => describeClientEntry(entry, now));

  return {
    active_queries: activeQueries,
    checked_out_clients: checkedOutClients,
  };
}

module.exports = pool;
module.exports.getPoolStats = getPoolStats;
module.exports.getPoolActivitySnapshot = getPoolActivitySnapshot;
