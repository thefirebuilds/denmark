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
const checkedOutClients = new Map();
let querySequence = 0;
let clientSequence = 0;

function summarizeSql(input) {
  const text =
    typeof input === "string"
      ? input
      : typeof input?.text === "string"
      ? input.text
      : "";
  return text.replace(/\s+/g, " ").trim().slice(0, 260) || "(unknown query)";
}

function startQueryTracking({ sql, source, clientId = null }) {
  const id = ++querySequence;
  const startedAt = Date.now();
  const entry = {
    id,
    clientId,
    source,
    sql: summarizeSql(sql),
    startedAt,
  };

  activePoolQueries.set(id, entry);

  if (clientId && checkedOutClients.has(clientId)) {
    const clientEntry = checkedOutClients.get(clientId);
    clientEntry.currentQueryId = id;
    clientEntry.lastQuery = entry.sql;
    clientEntry.lastQueryStartedAt = startedAt;
  }

  return () => {
    activePoolQueries.delete(id);
    if (clientId && checkedOutClients.has(clientId)) {
      const clientEntry = checkedOutClients.get(clientId);
      if (clientEntry.currentQueryId === id) {
        clientEntry.currentQueryId = null;
        clientEntry.lastQueryFinishedAt = Date.now();
      }
    }
  };
}

function wrapQueryFunction(originalQuery, source, getClientId = () => null) {
  return function trackedQuery(...args) {
    const callbackIndex = args.findIndex((arg) => typeof arg === "function");
    const finish = startQueryTracking({
      sql: args[0],
      source,
      clientId: getClientId(),
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
    client_id: entry.clientId,
    age_ms: now - entry.startedAt,
    sql: entry.sql,
  };
}

function describeClientEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    age_ms: now - entry.checkedOutAt,
    current_query_id: entry.currentQueryId,
    current_query_age_ms:
      entry.currentQueryId && activePoolQueries.has(entry.currentQueryId)
        ? now - activePoolQueries.get(entry.currentQueryId).startedAt
        : null,
    last_query_age_ms: entry.lastQueryStartedAt ? now - entry.lastQueryStartedAt : null,
    last_query: entry.lastQuery || null,
  };
}

const originalPoolQuery = pool.query.bind(pool);
pool.query = wrapQueryFunction(originalPoolQuery, "pool.query");

function trackCheckedOutClient(client) {
  if (!client) return client;

  const clientId = ++clientSequence;
  checkedOutClients.set(clientId, {
    id: clientId,
    checkedOutAt: Date.now(),
    currentQueryId: null,
    lastQuery: null,
    lastQueryStartedAt: null,
    lastQueryFinishedAt: null,
  });

  if (!client.__denmarkOriginalQuery) {
    client.__denmarkOriginalQuery = client.query.bind(client);
    client.query = wrapQueryFunction(
      client.__denmarkOriginalQuery,
      "client.query",
      () => client.__denmarkClientId || null
    );
  }

  if (!client.__denmarkOriginalRelease) {
    client.__denmarkOriginalRelease = client.release.bind(client);
  }

  client.__denmarkClientId = clientId;

  client.release = (...releaseArgs) => {
    checkedOutClients.delete(clientId);
    if (client.__denmarkClientId === clientId) {
      client.__denmarkClientId = null;
    }
    return client.__denmarkOriginalRelease(...releaseArgs);
  };

  return client;
}

const originalPoolConnect = pool.connect.bind(pool);
pool.connect = function trackedConnect(...args) {
  const callbackIndex = args.findIndex((arg) => typeof arg === "function");

  if (callbackIndex >= 0) {
    return originalPoolConnect(...args);
  }

  return originalPoolConnect(...args).then((client) => trackCheckedOutClient(client));
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
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: pool.options?.max || null,
    checked_out: checkedOutClients.size,
    active_queries: activePoolQueries.size,
  };
}

function getPoolActivitySnapshot({ limit = 8 } = {}) {
  const now = Date.now();
  const activeQueries = [...activePoolQueries.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(0, limit)
    .map((entry) => describeQueryEntry(entry, now));
  const checkedOut = [...checkedOutClients.values()]
    .sort((a, b) => a.checkedOutAt - b.checkedOutAt)
    .slice(0, limit)
    .map((entry) => describeClientEntry(entry, now));

  return {
    active_queries: activeQueries,
    checked_out_clients: checkedOut,
  };
}

module.exports = pool;
module.exports.getPoolStats = getPoolStats;
module.exports.getPoolActivitySnapshot = getPoolActivitySnapshot;
