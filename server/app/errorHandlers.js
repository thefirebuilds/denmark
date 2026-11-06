const {
  RETRY_AFTER_SECONDS,
  buildDatabaseUnavailablePayload,
  isDatabaseConnectionError,
  isDatabasePoolTimeout,
  isDatabaseSchemaError,
  markDatabaseSchemaMissing,
  markDatabaseUnavailable,
} = require("../dbHealth");
const {
  initializeStartupTablesWithRetry,
  markStartupTablesNotReady,
} = require("../startup/startupState");

function jsonParseErrorHandler(err, req, res, next) {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
  }

  return next(err);
}

function appErrorHandler(err, req, res, next) {
  if (!err) return next();

  if (isDatabasePoolTimeout(err)) {
    res.set('Retry-After', '10');
    res.set('X-Denmark-Error-Scope', 'request');
    return res.status(503).json({ ok: false, error: 'database busy',
      message: 'Database connections are busy. Please retry shortly.' });
  }

  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    markStartupTablesNotReady();
    void initializeStartupTablesWithRetry();
    res.set("Retry-After", String(RETRY_AFTER_SECONDS));
    return res.status(503).json(buildDatabaseUnavailablePayload());
  }

  if (isDatabaseSchemaError(err)) {
    markDatabaseSchemaMissing(err);
    markStartupTablesNotReady();
    void initializeStartupTablesWithRetry();
    res.set("Retry-After", String(RETRY_AFTER_SECONDS));
    return res.status(503).json(buildDatabaseUnavailablePayload());
  }

  return res.status(err.statusCode || err.status || 500).json({
    ok: false,
    error: err.statusCode || err.status ? err.message : "internal server error",
  });
}

module.exports = {
  appErrorHandler,
  jsonParseErrorHandler,
};
