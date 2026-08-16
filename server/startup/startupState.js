const startScheduler = require("../services/scheduler");
const {
  RETRY_AFTER_SECONDS,
  isDatabaseSchemaError,
  markDatabaseReady,
  markDatabaseSchemaMissing,
  markDatabaseUnavailable,
  onDatabaseUnavailable,
  summarizeError,
} = require("../dbHealth");
const { initializeStartupTables } = require("./initializeStartupTables");

const state = {
  startupTablesReady: false,
  startupTablesInitializing: false,
  schedulerStarted: false,
  startupRetryHandle: null,
};

function getStartupState() {
  return {
    tables_ready: state.startupTablesReady,
    tables_initializing: state.startupTablesInitializing,
    scheduler_started: state.schedulerStarted,
  };
}

function markStartupTablesNotReady() {
  state.startupTablesReady = false;
}

async function initializeStartupTablesWithRetry() {
  if (state.startupTablesReady || state.startupTablesInitializing) return;

  if (state.startupRetryHandle) {
    clearTimeout(state.startupRetryHandle);
    state.startupRetryHandle = null;
  }

  state.startupTablesInitializing = true;

  try {
    await initializeStartupTables();
    state.startupTablesReady = true;
    markDatabaseReady();
    console.log("[server] startup tables ready");

    const { startPhysicalAlertRuntime } = require("../services/physicalAlerts/runtime");
    await startPhysicalAlertRuntime();

    if (!state.schedulerStarted) {
      state.schedulerStarted = true;
      startScheduler();
    }
  } catch (err) {
    if (isDatabaseSchemaError(err)) {
      markDatabaseSchemaMissing(err);
      console.warn(
        `[server] database schema not initialized. Run npm run db:bootstrap. Retrying in ${RETRY_AFTER_SECONDS}s. ${summarizeError(err)}`
      );
    } else {
      markDatabaseUnavailable(err);
      console.warn(
        `[server] database unavailable; startup tables not ready. Retrying in ${RETRY_AFTER_SECONDS}s. ${summarizeError(err)}`
      );
    }

    state.startupRetryHandle = setTimeout(() => {
      state.startupRetryHandle = null;
      void initializeStartupTablesWithRetry();
    }, RETRY_AFTER_SECONDS * 1000);
    state.startupRetryHandle.unref?.();
  } finally {
    state.startupTablesInitializing = false;
  }
}

onDatabaseUnavailable(() => {
  markStartupTablesNotReady();
  void initializeStartupTablesWithRetry();
});

module.exports = {
  getStartupState,
  initializeStartupTablesWithRetry,
  markStartupTablesNotReady,
  startupState: state,
};
