const RETRY_AFTER_SECONDS = Number(process.env.DB_RETRY_AFTER_SECONDS || 15);

const state = {
  ready: false,
  lastError: null,
  lastErrorAt: null,
  lastReadyAt: null,
};
const unavailableListeners = new Set();

function summarizeError(error) {
  const message = String(error?.message || error || "Unknown database error");
  const cause = error?.cause?.message ? String(error.cause.message) : "";
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

function isDatabaseConnectionError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();

  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "57P01" ||
    text.includes("connection terminated") ||
    text.includes("connection timeout") ||
    text.includes("connect econnrefused") ||
    text.includes("timeout expired") ||
    text.includes("terminating connection")
  );
}

function markDatabaseReady() {
  state.ready = true;
  state.lastReadyAt = new Date().toISOString();
  state.lastError = null;
  state.lastErrorAt = null;
}

function markDatabaseUnavailable(error) {
  state.ready = false;
  state.lastError = summarizeError(error);
  state.lastErrorAt = new Date().toISOString();

  for (const listener of unavailableListeners) {
    try {
      listener(error);
    } catch (listenerError) {
      console.warn(
        `[db] database unavailable listener failed: ${summarizeError(listenerError)}`
      );
    }
  }
}

function getDatabaseHealth() {
  return {
    ready: state.ready,
    retry_after_seconds: RETRY_AFTER_SECONDS,
    last_ready_at: state.lastReadyAt,
    last_error_at: state.lastErrorAt,
    last_error: state.lastError,
  };
}

function buildDatabaseUnavailablePayload() {
  return {
    ok: false,
    error: "database unavailable",
    message:
      "The backend is running, but PostgreSQL is not reachable yet. Database-backed API routes are temporarily unavailable.",
    database: getDatabaseHealth(),
  };
}

function databaseUnavailableMiddleware(req, res, next) {
  if (state.ready) return next();
  if (req.path === "/health" || req.path === "/database/health") return next();

  res.set("Retry-After", String(RETRY_AFTER_SECONDS));
  return res.status(503).json(buildDatabaseUnavailablePayload());
}

function onDatabaseUnavailable(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }

  unavailableListeners.add(listener);
  return () => unavailableListeners.delete(listener);
}

module.exports = {
  RETRY_AFTER_SECONDS,
  buildDatabaseUnavailablePayload,
  databaseUnavailableMiddleware,
  getDatabaseHealth,
  isDatabaseConnectionError,
  markDatabaseReady,
  markDatabaseUnavailable,
  onDatabaseUnavailable,
  summarizeError,
};
