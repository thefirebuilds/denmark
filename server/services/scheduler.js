// -----------------------------------------------------------------------------------------------------------------------
// /server/services/scheduler.js
// This scheduler manages the periodic tasks of polling the IMAP server and collecting Bouncie snapshots.
// It ensures that only one instance of each task runs at a time, and provides functions to start and stop the scheduler.
// The IMAP polling task checks for new maintenance requests and customer-reported issues for each vehicle. This is an internal-facing
// view to help fleet managers prioritize and track work needed to keep vehicles guest-ready.
// The Bouncie snapshot task collects the latest vehicle data from the Bouncie API to keep our records up to date.
// -----------------------------------------------------------------------------------------------------------------------

// dimo connectivity
const collectDimoSnapshot = require("./dimo/collectDimoSnapshot");

// availability push
const { pushPublicAvailabilitySnapshotSafe } = require("./pushPublicAvailability");

// bank transX
const syncTellerTransactions = require("./teller/teller");

// email connectivity
const pollImap = require("./imapPoller");

// bouncie connectivity
const collectBouncieSnapshot = require("./bouncie/collectBouncieSnapshot");

// hctra connectivity (tolls)
const syncTolls = require("./tolls/syncTolls");

// Google Calendar
const { reconcileTripsToGoogle } = require("./googleCalendar/googleTripSync");
const { refreshFleetFmvIfStale } = require("./vehicles/fmvEstimateService");
const { createBusinessMetricSnapshot } = require("./metrics/businessMetricsService");

let tellerSyncInProgress = false;
let tellerSyncIntervalHandle = null;

let tollSyncInProgress = false;
let tollSyncIntervalHandle = null;

let pollInProgress = false;
let bouncieInProgress = false;

let intervalHandle = null;
let bouncieIntervalHandle = null;

let dimoInProgress = false;
let dimoIntervalHandle = null;

let googleCalendarInProgress = false;
let googleCalendarIntervalHandle = null;

let fmvInProgress = false;
let fmvIntervalHandle = null;
let businessMetricsInProgress = false;
let businessMetricsIntervalHandle = null;

const STARTUP_TASKS = [
  "teller",
  "tolls",
  "imap",
  "bouncie",
  "dimo",
  "fmv",
  "businessMetrics",
  "publicAvailability",
  "googleCalendar",
];

let startupStatus = {
  startedAt: null,
  completedAt: null,
  tasks: Object.fromEntries(
    STARTUP_TASKS.map((name) => [
      name,
      {
        name,
        state: "pending",
        startedAt: null,
        completedAt: null,
        error: null,
      },
    ])
  ),
};

function buildPendingStartupTasks() {
  return Object.fromEntries(
    STARTUP_TASKS.map((name) => [
      name,
      {
        name,
        state: "pending",
        startedAt: null,
        completedAt: null,
        error: null,
      },
    ])
  );
}

function resetStartupStatus() {
  startupStatus = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    tasks: buildPendingStartupTasks(),
  };
}

function updateStartupTask(name, patch) {
  startupStatus.tasks[name] = {
    ...startupStatus.tasks[name],
    ...patch,
  };

  const tasks = Object.values(startupStatus.tasks);
  const completed = tasks.every((task) =>
    ["succeeded", "failed", "skipped"].includes(task.state)
  );

  if (completed && !startupStatus.completedAt) {
    startupStatus.completedAt = new Date().toISOString();
  }
}

async function runStartupTask(name, taskFn) {
  updateStartupTask(name, {
    state: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  });

  try {
    await taskFn();
    updateStartupTask(name, {
      state: "succeeded",
      completedAt: new Date().toISOString(),
      error: null,
    });
  } catch (err) {
    updateStartupTask(name, {
      state: "failed",
      completedAt: new Date().toISOString(),
      error: err?.message || String(err),
    });
  }
}

function getStartupStatus() {
  const tasks = Object.values(startupStatus.tasks);

  return {
    startedAt: startupStatus.startedAt,
    completedAt: startupStatus.completedAt,
    running: tasks.filter((task) => task.state === "running").map((task) => task.name),
    pending: tasks.filter((task) => task.state === "pending").map((task) => task.name),
    failed: tasks.filter((task) => task.state === "failed").map((task) => task.name),
    completed: Boolean(startupStatus.completedAt),
    tasks,
  };
}

async function runTellerSync(reason = "interval") {
  if (tellerSyncInProgress) {
    console.log(`[scheduler] teller skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  tellerSyncInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] teller start | reason=${reason}`);
    const result = await syncTellerTransactions();

    console.log(
      `[scheduler] teller done | reason=${reason} processed=${result.processed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`[scheduler] teller failed | reason=${reason} error=${err.message || err}`);
  } finally {
    tellerSyncInProgress = false;
  }
}

async function runTollSync(reason = "interval") {
  if (tollSyncInProgress) {
    console.log(`[scheduler] tolls skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  tollSyncInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] tolls start | reason=${reason}`);
    const result = await syncTolls();

    console.log(
      `[scheduler] tolls done | reason=${reason} seen=${result.recordsSeen} imported=${result.recordsImported} skipped=${result.recordsSkipped} vehicleMatched=${result.recordsMatchedVehicle} tripMatched=${result.recordsMatchedTrip} runId=${result.runId} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`[scheduler] tolls failed | reason=${reason} error=${err.message || err}`);
  } finally {
    tollSyncInProgress = false;
  }
}

async function runPoll(reason = "interval") {
  if (pollInProgress) {
    console.log(`[scheduler] imap skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  pollInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] imap start | reason=${reason}`);
    await pollImap();
  } catch (err) {
    console.error(`[scheduler] imap failed | reason=${reason} error=${err.message || err}`);
  } finally {
    console.log(
      `[scheduler] imap done | reason=${reason} durationMs=${Date.now() - startedAt}`
    );
    pollInProgress = false;
  }
}

async function runBouncie(reason = "interval") {
  if (bouncieInProgress) {
    console.log(`[scheduler] bouncie skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  bouncieInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] bouncie start | reason=${reason}`);
    await collectBouncieSnapshot();
  } catch (err) {
    console.error(`[scheduler] bouncie failed | reason=${reason} error=${err.message || err}`);
  } finally {
    console.log(
      `[scheduler] bouncie done | reason=${reason} durationMs=${Date.now() - startedAt}`
    );
    bouncieInProgress = false;
  }
}

async function runDimo(reason = "interval") {
  if (dimoInProgress) {
    console.log(`[scheduler] dimo skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  dimoInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] dimo start | reason=${reason}`);
    const summary = await collectDimoSnapshot();
    console.log(
      `[scheduler] dimo done | reason=${reason} total=${summary.total} succeeded=${summary.succeeded} degraded=${summary.degraded} failed=${summary.failed}`
    );
  } catch (err) {
    console.error(`[scheduler] dimo failed | reason=${reason} error=${err.message || err}`);
  } finally {
    console.log(
      `[scheduler] dimo finished | reason=${reason} durationMs=${Date.now() - startedAt}`
    );
    dimoInProgress = false;
  }
}

async function runGoogleCalendarReconcile(reason = "interval") {
  if (googleCalendarInProgress) {
    console.log(`[scheduler] googleCalendar skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  googleCalendarInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] googleCalendar start | reason=${reason}`);
    const result = await reconcileTripsToGoogle({ userId: null, limit: 500 });

    console.log(
      `[scheduler] googleCalendar done | reason=${reason} processed=${result.processed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(
      `[scheduler] googleCalendar failed | reason=${reason} error=${err.message || err}`
    );
  } finally {
    googleCalendarInProgress = false;
  }
}

async function runFleetFmvRefresh(reason = "interval") {
  if (fmvInProgress) {
    console.log(`[scheduler] fmv skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  fmvInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] fmv check start | reason=${reason}`);
    const result = await refreshFleetFmvIfStale({ maxAgeDays: 7 });

    if (!result.ran) {
      console.log(
        `[scheduler] fmv check done | reason=${reason} action=skip stale=${result.stale} latest=${result.latest_estimated_at || "none"} durationMs=${Date.now() - startedAt}`
      );
      return;
    }

    const succeeded = (result.results || []).filter((item) => item.ok).length;
    const failed = (result.results || []).filter((item) => !item.ok).length;

    console.log(
      `[scheduler] fmv refresh done | reason=${reason} action=run trigger=${result.reason} succeeded=${succeeded} failed=${failed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`[scheduler] fmv failed | reason=${reason} error=${err.message || err}`);
  } finally {
    fmvInProgress = false;
  }
}

async function runBusinessMetricsSnapshot(reason = "interval") {
  if (businessMetricsInProgress) {
    console.log(`[scheduler] businessMetrics skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  businessMetricsInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] businessMetrics start | reason=${reason}`);
    const snapshot = await createBusinessMetricSnapshot("quarterly");
    console.log(
      `[scheduler] businessMetrics done | reason=${reason} period=${snapshot.period_key} vehicles=${snapshot.vehicles.length} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(
      `[scheduler] businessMetrics failed | reason=${reason} error=${err.message || err}`
    );
  } finally {
    businessMetricsInProgress = false;
  }
}

function startScheduler() {
  console.log("[scheduler] started");

  const everyEightHoursMs = 8 * 60 * 60 * 1000;
  const everyTwoHoursMs = 2 * 60 * 60 * 1000;
  const everyFiveMinutesMs = 5 * 60 * 1000;
  const everyTwentyFourHoursMs = 24 * 60 * 60 * 1000;

  resetStartupStatus();

  // Teller sync immediately
  void runStartupTask("teller", () => runTellerSync("startup"));

  // Toll sync immediately
  void runStartupTask("tolls", () => runTollSync("startup"));

  // IMAP immediately
  void runStartupTask("imap", () => runPoll("startup"));

  // Bouncie immediately
  void runStartupTask("bouncie", () => runBouncie("startup"));

  // DIMO immediately
  void runStartupTask("dimo", () => runDimo("startup"));

  // FMV check immediately (only refreshes if stale or missing)
  void runStartupTask("fmv", () => runFleetFmvRefresh("startup"));

  // Business metrics snapshot immediately
  void runStartupTask("businessMetrics", () =>
    runBusinessMetricsSnapshot("startup")
  );

  // Public availability push immediately
  void runStartupTask("publicAvailability", () =>
    pushPublicAvailabilitySnapshotSafe("server startup")
  );

  // Google Calendar reconcile immediately
  void runStartupTask("googleCalendar", () =>
    runGoogleCalendarReconcile("startup")
  );

  // Teller sync every 2 hours
  tellerSyncIntervalHandle = setInterval(() => {
    void runTellerSync("interval");
  }, everyTwoHoursMs);

  // Toll sync every 2 hours
  tollSyncIntervalHandle = setInterval(() => {
    void runTollSync("interval");
  }, everyTwoHoursMs);

  // IMAP every 5 minutes
  intervalHandle = setInterval(() => {
    void runPoll("interval");
  }, everyFiveMinutesMs);

  // Bouncie every 5 minutes
  bouncieIntervalHandle = setInterval(() => {
    void runBouncie("interval");
  }, everyFiveMinutesMs);

  // DIMO every 5 minutes
  dimoIntervalHandle = setInterval(() => {
    void runDimo("interval");
  }, everyFiveMinutesMs);

  // FMV freshness check daily; actual estimates run only if older than a week
  fmvIntervalHandle = setInterval(() => {
    void runFleetFmvRefresh("interval");
  }, everyTwentyFourHoursMs);

  // Business metrics snapshot daily
  businessMetricsIntervalHandle = setInterval(() => {
    void runBusinessMetricsSnapshot("interval");
  }, everyTwentyFourHoursMs);

  // Google Calendar reconcile every 8 hours
  googleCalendarIntervalHandle = setInterval(() => {
    void runGoogleCalendarReconcile("interval");
  }, everyEightHoursMs);
}

function stopScheduler() {
  if (tellerSyncIntervalHandle) {
    clearInterval(tellerSyncIntervalHandle);
    tellerSyncIntervalHandle = null;
  }

  if (tollSyncIntervalHandle) {
    clearInterval(tollSyncIntervalHandle);
    tollSyncIntervalHandle = null;
  }

  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  if (bouncieIntervalHandle) {
    clearInterval(bouncieIntervalHandle);
    bouncieIntervalHandle = null;
  }

  if (dimoIntervalHandle) {
    clearInterval(dimoIntervalHandle);
    dimoIntervalHandle = null;
  }

  if (googleCalendarIntervalHandle) {
    clearInterval(googleCalendarIntervalHandle);
    googleCalendarIntervalHandle = null;
  }

  if (fmvIntervalHandle) {
    clearInterval(fmvIntervalHandle);
    fmvIntervalHandle = null;
  }

  if (businessMetricsIntervalHandle) {
    clearInterval(businessMetricsIntervalHandle);
    businessMetricsIntervalHandle = null;
  }

  console.log("[scheduler] stopped");
}

module.exports = startScheduler;
module.exports.stopScheduler = stopScheduler;
module.exports.getStartupStatus = getStartupStatus;
