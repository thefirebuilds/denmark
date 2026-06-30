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
const syncMercuryTransactions = require("./mercury/mercury");

// email connectivity
const pollImap = require("./imapPoller");

// bouncie connectivity
const collectBouncieSnapshot = require("./bouncie/collectBouncieSnapshot");

// hctra connectivity (tolls)
const syncTolls = require("./tolls/syncTolls");

// Google Calendar
const { reconcileTripsToGoogle } = require("./googleCalendar/googleTripSync");
const {
  listGoogleCalendarSyncTargets,
} = require("./googleCalendar/googleCalendarStore");
const { refreshFleetFmvIfStale } = require("./vehicles/fmvEstimateService");
const { createBusinessMetricSnapshot } = require("./metrics/businessMetricsService");
const {
  generateAndSaveDailyBrief,
  getDailyBriefRunHistory,
} = require("./dailyBriefService");
const { pruneOldTelemetryRawPayloads } = require("./telemetry/retention");
const { runFleetAlerts: runFleetAlertsCheck } = require("./alerts/fleetAlerts");
const { refreshVehicleOdometerRollups } = require("./vehicles/odometerRollupService");
const { logSystemActivity } = require("./systemActivityLog");
const { isIntegrationEnabled } = require("./integrations/integrationSettings");
const pool = require("../db");

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
let dailyBriefInProgress = false;
let dailyBriefIntervalHandle = null;
let odometerRollupInProgress = false;
let odometerRollupIntervalHandle = null;
let telemetryRetentionInProgress = false;
let telemetryRetentionIntervalHandle = null;
let fleetAlertsIntervalHandle = null;

const STARTUP_TASKS = [
  "teller",
  "tolls",
  "imap",
  "bouncie",
  "dimo",
  "fmv",
  "businessMetrics",
  "odometerRollups",
  "telemetryRetention",
  "fleetAlerts",
  "publicAvailability",
  "googleCalendar",
];
const STARTUP_RUN_SETTING_KEY = "scheduler.lastStartupRun";
const STARTUP_RUN_COOLDOWN_MS = 15 * 60 * 1000;
const STARTUP_TASK_SPACING_MS = getSchedulerNumber(
  "SCHEDULER_STARTUP_TASK_SPACING_MS",
  1500
);
const SCHEDULER_INTERVAL_OFFSET_STEP_MS = getSchedulerNumber(
  "SCHEDULER_INTERVAL_OFFSET_STEP_MS",
  45000
);
const SCHEDULER_DB_POOL_IDLE_RESERVE = getSchedulerNumber(
  "SCHEDULER_DB_POOL_IDLE_RESERVE",
  2
);
const DAILY_BRIEF_AM_HOUR = Math.min(
  23,
  Math.max(0, getSchedulerNumber("DAILY_BRIEF_AM_HOUR", 7))
);
const DAILY_BRIEF_AM_WINDOW_HOURS = Math.max(
  1,
  getSchedulerNumber("DAILY_BRIEF_AM_WINDOW_HOURS", 4)
);
const DAILY_BRIEF_TIME_ZONE =
  process.env.DAILY_BRIEF_TIME_ZONE || "America/Chicago";

function getSchedulerNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalDateParts(date = new Date(), timeZone = DAILY_BRIEF_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour || 0),
  };
}

function scheduleIntervalTask(name, intervalMs, offsetMs, taskFn) {
  let intervalHandle = null;
  const safeOffsetMs = Math.max(0, Number(offsetMs) || 0);
  const runTask = () => {
    void taskFn();
  };

  console.log(
    `[scheduler] ${name} interval scheduled | everyMs=${intervalMs} offsetMs=${safeOffsetMs}`
  );

  const timeoutHandle = setTimeout(() => {
    runTask();
    intervalHandle = setInterval(runTask, intervalMs);
    intervalHandle.unref?.();
  }, safeOffsetMs);
  timeoutHandle.unref?.();

  return () => {
    clearTimeout(timeoutHandle);
    if (intervalHandle) {
      clearInterval(intervalHandle);
    }
  };
}

function stopScheduledInterval(handle) {
  if (typeof handle === "function") {
    handle();
  }
}

function shouldDeferForDbPressure(taskName, reason) {
  if (String(reason || "").toLowerCase() === "startup") {
    return false;
  }

  const stats = typeof pool.getPoolStats === "function" ? pool.getPoolStats() : null;
  if (!stats || !stats.max) return false;

  const waiting = Number(stats.waiting || 0);
  const idle = Number(stats.idle || 0);
  const checkedOut = Number(stats.checked_out || 0);
  const max = Number(stats.max || 0);
  const reserve = Math.min(
    Math.max(0, SCHEDULER_DB_POOL_IDLE_RESERVE),
    Math.max(0, max - 1)
  );
  const underPressure =
    waiting > 0 || (max > 0 && checkedOut >= Math.max(1, max - reserve));

  if (!underPressure) return false;

  console.log(
    `[scheduler] ${taskName} skipped | reason=${reason} dbPoolPressure=true checkedOut=${checkedOut} idle=${idle} waiting=${waiting} max=${max}`
  );
  return true;
}

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
    await logSystemActivity({
      category: "automation",
      eventType: "startup_task_completed",
      actorType: "system",
      subjectType: "startup_task",
      subjectId: name,
      subjectLabel: name,
      source: "scheduler",
      details: {
        task: name,
      },
    }).catch(() => null);
  } catch (err) {
    updateStartupTask(name, {
      state: "failed",
      completedAt: new Date().toISOString(),
      error: err?.message || String(err),
    });
    await logSystemActivity({
      category: "automation",
      eventType: "startup_task_failed",
      severity: "error",
      actorType: "system",
      outcome: "failure",
      subjectType: "startup_task",
      subjectId: name,
      subjectLabel: name,
      source: "scheduler",
      details: {
        task: name,
        error: err?.message || String(err),
      },
    }).catch(() => null);
  }
}

async function runStartupTaskSequence(tasks) {
  for (const [name, taskFn] of tasks) {
    await runStartupTask(name, taskFn);
    await delay(STARTUP_TASK_SPACING_MS);
  }
}

async function getLastStartupRunAt() {
  const result = await pool.query(
    `
    SELECT value
    FROM app_settings
    WHERE key = $1
    LIMIT 1
    `,
    [STARTUP_RUN_SETTING_KEY]
  );
  const value = result.rows[0]?.value;
  const rawTimestamp =
    typeof value === "string" ? value : value?.last_run_at || value?.lastRunAt;

  if (!rawTimestamp) return null;

  const timestamp = new Date(rawTimestamp);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

async function markStartupRunAt(date = new Date()) {
  await pool.query(
    `
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [
      STARTUP_RUN_SETTING_KEY,
      JSON.stringify({
        last_run_at: date.toISOString(),
      }),
    ]
  );
}

function skipAllStartupTasks(reason) {
  const now = new Date().toISOString();

  for (const taskName of STARTUP_TASKS) {
    updateStartupTask(taskName, {
      state: "skipped",
      startedAt: now,
      completedAt: now,
      error: reason,
    });

    void logSystemActivity({
      category: "automation",
      eventType: "startup_task_skipped",
      severity: "notice",
      actorType: "system",
      outcome: "skipped",
      subjectType: "startup_task",
      subjectId: taskName,
      subjectLabel: taskName,
      source: "scheduler",
      details: {
        task: taskName,
        reason,
      },
    }).catch(() => null);
  }
}

async function shouldRunStartupTasks() {
  const lastRunAt = await getLastStartupRunAt();

  if (!lastRunAt) {
    return { run: true, lastRunAt: null, ageMs: null };
  }

  const ageMs = Date.now() - lastRunAt.getTime();

  return {
    run: ageMs >= STARTUP_RUN_COOLDOWN_MS,
    lastRunAt,
    ageMs,
  };
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
    startupCooldownMinutes: STARTUP_RUN_COOLDOWN_MS / 60000,
    tasks,
  };
}

async function runTellerSync(reason = "interval") {
  if (shouldDeferForDbPressure("teller", reason)) return;

  if (!(await isIntegrationEnabled("teller"))) {
    console.log(`[scheduler] teller skipped | reason=${reason} enabled=false`);
    return;
  }

  if (tellerSyncInProgress) {
    console.log(`[scheduler] teller skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  tellerSyncInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] teller start | reason=${reason}`);
    let processed = 0;

    try {
      const result = await syncTellerTransactions();
      processed += Number(result.processed || 0);
    } catch (err) {
      console.error(
        `[scheduler] teller source failed | reason=${reason} error=${err.message || err}`
      );
    }

    try {
      const result = await syncMercuryTransactions();
      processed += Number(result.processed || 0);
    } catch (err) {
      if (err.status === 400) {
        console.log(`[scheduler] mercury skipped | reason=${reason} configured=false`);
      } else {
        console.error(
          `[scheduler] mercury source failed | reason=${reason} error=${err.message || err}`
        );
      }
    }

    console.log(
      `[scheduler] teller done | reason=${reason} processed=${processed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`[scheduler] teller failed | reason=${reason} error=${err.message || err}`);
  } finally {
    tellerSyncInProgress = false;
  }
}

async function runTollSync(reason = "interval") {
  if (shouldDeferForDbPressure("tolls", reason)) return;

  if (!(await isIntegrationEnabled("tolls"))) {
    console.log(`[scheduler] tolls skipped | reason=${reason} enabled=false`);
    return;
  }

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
  if (shouldDeferForDbPressure("imap", reason)) return;

  if (!(await isIntegrationEnabled("imap"))) {
    console.log(`[scheduler] imap skipped | reason=${reason} enabled=false`);
    return;
  }

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
  if (shouldDeferForDbPressure("bouncie", reason)) return;

  if (!(await isIntegrationEnabled("bouncie"))) {
    console.log(`[scheduler] bouncie skipped | reason=${reason} enabled=false`);
    return;
  }

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
  if (shouldDeferForDbPressure("dimo", reason)) return;

  if (!(await isIntegrationEnabled("dimo"))) {
    console.log(`[scheduler] dimo skipped | reason=${reason} enabled=false`);
    return;
  }

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
  if (shouldDeferForDbPressure("googleCalendar", reason)) return;

  if (!(await isIntegrationEnabled("googleCalendar"))) {
    console.log(`[scheduler] googleCalendar skipped | reason=${reason} enabled=false`);
    return;
  }

  if (googleCalendarInProgress) {
    console.log(`[scheduler] googleCalendar skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  googleCalendarInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] googleCalendar start | reason=${reason}`);
    const targets = await listGoogleCalendarSyncTargets();

    if (!targets.length) {
      console.log(`[scheduler] googleCalendar skipped | reason=${reason} noSelectedCalendar=true`);
      return;
    }

    let processed = 0;
    let failed = 0;

    for (const target of targets) {
      const result = await reconcileTripsToGoogle({
        userId: target.user_id,
        limit: 500,
      });
      const targetFailed = (result.results || []).filter((item) => !item.ok).length;

      processed += result.processed;
      failed += targetFailed;

      console.log(
        `[scheduler] googleCalendar target done | reason=${reason} userId=${target.user_id ?? "legacy"} calendar="${target.calendar_summary || target.calendar_id}" processed=${result.processed} failed=${targetFailed}`
      );
    }

    if (failed > 0) {
      throw new Error(`Google Calendar reconcile completed with ${failed} failed trip syncs`);
    }

    console.log(
      `[scheduler] googleCalendar done | reason=${reason} targets=${targets.length} processed=${processed} durationMs=${Date.now() - startedAt}`
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
  if (shouldDeferForDbPressure("fmv", reason)) return;

  if (!(await isIntegrationEnabled("fmv"))) {
    console.log(`[scheduler] fmv skipped | reason=${reason} enabled=false`);
    return;
  }

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
  if (shouldDeferForDbPressure("businessMetrics", reason)) return;

  if (!(await isIntegrationEnabled("businessMetrics"))) {
    console.log(`[scheduler] businessMetrics skipped | reason=${reason} enabled=false`);
    return;
  }

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

async function runDailyBriefGeneration(reason = "interval") {
  if (shouldDeferForDbPressure("dailyBrief", reason)) return;

  if (!(await isIntegrationEnabled("dailyBrief"))) {
    console.log(`[scheduler] dailyBrief skipped | reason=${reason} enabled=false`);
    return;
  }

  if (dailyBriefInProgress) {
    console.log(`[scheduler] dailyBrief skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  const local = getLocalDateParts();
  if (!Number.isFinite(local.hour) || local.hour < DAILY_BRIEF_AM_HOUR) {
    console.log(
      `[scheduler] dailyBrief skipped | reason=${reason} beforeAmHour=true localHour=${local.hour} targetHour=${DAILY_BRIEF_AM_HOUR}`
    );
    return;
  }

  if (local.hour >= DAILY_BRIEF_AM_HOUR + DAILY_BRIEF_AM_WINDOW_HOURS) {
    console.log(
      `[scheduler] dailyBrief skipped | reason=${reason} outsideAmWindow=true localHour=${local.hour} targetHour=${DAILY_BRIEF_AM_HOUR} windowHours=${DAILY_BRIEF_AM_WINDOW_HOURS}`
    );
    return;
  }

  const history = await getDailyBriefRunHistory();
  if (history[local.date]) {
    console.log(
      `[scheduler] dailyBrief skipped | reason=${reason} alreadyGenerated=true date=${local.date}`
    );
    return;
  }

  dailyBriefInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] dailyBrief start | reason=${reason} date=${local.date}`);
    const result = await generateAndSaveDailyBrief({
      date: local.date,
      timeZone: DAILY_BRIEF_TIME_ZONE,
    });
    console.log(
      `[scheduler] dailyBrief done | reason=${reason} date=${result.date} chars=${String(result.brief || "").length} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(
      `[scheduler] dailyBrief failed | reason=${reason} error=${err.message || err}`
    );
  } finally {
    dailyBriefInProgress = false;
  }
}

async function runVehicleOdometerRollups(reason = "interval") {
  if (shouldDeferForDbPressure("odometerRollups", reason)) return;

  if (odometerRollupInProgress) {
    console.log(`[scheduler] odometerRollups skipped | reason=${reason} alreadyRunning=true`);
    return;
  }

  odometerRollupInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] odometerRollups start | reason=${reason}`);
    const result = await refreshVehicleOdometerRollups();

    console.log(
      `[scheduler] odometerRollups done | reason=${reason} refreshed=${result.refreshed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(
      `[scheduler] odometerRollups failed | reason=${reason} error=${err.message || err}`
    );
  } finally {
    odometerRollupInProgress = false;
  }
}

async function runFleetAlertCheck(reason = "interval") {
  if (shouldDeferForDbPressure("fleetAlerts", reason)) return;

  if (!(await isIntegrationEnabled("fleetAlerts"))) {
    console.log(`[scheduler] fleetAlerts skipped | reason=${reason} enabled=false`);
    return;
  }

  try {
    await runFleetAlertsCheck(reason);
  } catch (err) {
    console.error(
      `[scheduler] fleetAlerts failed | reason=${reason} error=${err.message || err}`
    );
  }
}

async function runTelemetryRetention(reason = "interval") {
  if (shouldDeferForDbPressure("telemetryRetention", reason)) return;

  if (telemetryRetentionInProgress) {
    console.log(
      `[scheduler] telemetryRetention skipped | reason=${reason} alreadyRunning=true`
    );
    return;
  }

  telemetryRetentionInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`[scheduler] telemetryRetention start | reason=${reason}`);
    const result = await pruneOldTelemetryRawPayloads();

    console.log(
      `[scheduler] telemetryRetention done | reason=${reason} ran=${result.ran} prunedRows=${result.prunedRows} retentionDays=${result.retentionDays} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(
      `[scheduler] telemetryRetention failed | reason=${reason} error=${err.message || err}`
    );
  } finally {
    telemetryRetentionInProgress = false;
  }
}

async function runPublicAvailabilityPush(reason = "interval") {
  if (shouldDeferForDbPressure("publicAvailability", reason)) return;

  if (!(await isIntegrationEnabled("publicAvailability"))) {
    console.log(`[scheduler] publicAvailability skipped | reason=${reason} enabled=false`);
    return;
  }

  await pushPublicAvailabilitySnapshotSafe(reason);
}

function startScheduler() {
  console.log("[scheduler] started");
  void logSystemActivity({
    category: "automation",
    eventType: "scheduler_started",
    severity: "notice",
    actorType: "system",
    source: "scheduler",
    details: {
      startupTasks: STARTUP_TASKS,
    },
  }).catch(() => null);

  const everyFifteenMinutesMs = 15 * 60 * 1000;
  const everyHourMs = 60 * 60 * 1000;
  const everyTwoHoursMs = 2 * 60 * 60 * 1000;
  const everyFiveMinutesMs = 5 * 60 * 1000;
  const everyTwentyFourHoursMs = 24 * 60 * 60 * 1000;
  const everySevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  resetStartupStatus();

  void (async () => {
    try {
      const startupDecision = await shouldRunStartupTasks();

      if (!startupDecision.run) {
        const ageMinutes = Math.max(
          0,
          Math.round((startupDecision.ageMs || 0) / 60000)
        );
        const reason = `Startup tasks skipped; last startup run was ${ageMinutes} minute${
          ageMinutes === 1 ? "" : "s"
        } ago.`;

        console.log(`[scheduler] startup tasks skipped | ageMinutes=${ageMinutes}`);
        skipAllStartupTasks(reason);
        return;
      }

      await markStartupRunAt();

      console.log(
        `[scheduler] startup tasks running sequentially | spacingMs=${STARTUP_TASK_SPACING_MS}`
      );

      await runStartupTaskSequence([
        ["teller", () => runTellerSync("startup")],
        ["tolls", () => runTollSync("startup")],
        ["imap", () => runPoll("startup")],
        ["bouncie", () => runBouncie("startup")],
        ["dimo", () => runDimo("startup")],
        ["fmv", () => runFleetFmvRefresh("startup")],
        ["businessMetrics", () => runBusinessMetricsSnapshot("startup")],
        ["odometerRollups", () => runVehicleOdometerRollups("startup")],
        ["telemetryRetention", () => runTelemetryRetention("startup")],
        ["fleetAlerts", () => runFleetAlertCheck("startup")],
        ["publicAvailability", () => runPublicAvailabilityPush("server startup")],
        ["googleCalendar", () => runGoogleCalendarReconcile("startup")],
      ]);
    } catch (err) {
      const message = `Startup task guard failed: ${err.message || err}`;
      console.error(`[scheduler] startup guard failed | error=${err.message || err}`);
      skipAllStartupTasks(message);
    }
  })();

  tellerSyncIntervalHandle = scheduleIntervalTask(
    "teller",
    everyTwoHoursMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 8,
    () => runTellerSync("interval")
  );

  tollSyncIntervalHandle = scheduleIntervalTask(
    "tolls",
    everyTwoHoursMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 9,
    () => runTollSync("interval")
  );

  intervalHandle = scheduleIntervalTask(
    "imap",
    everyFiveMinutesMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 0,
    () => runPoll("interval")
  );

  bouncieIntervalHandle = scheduleIntervalTask(
    "bouncie",
    everyFiveMinutesMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 1,
    () => runBouncie("interval")
  );

  dimoIntervalHandle = scheduleIntervalTask(
    "dimo",
    everyFiveMinutesMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 2,
    () => runDimo("interval")
  );

  fleetAlertsIntervalHandle = scheduleIntervalTask(
    "fleetAlerts",
    everyFiveMinutesMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 3,
    () => runFleetAlertCheck("interval")
  );

  fmvIntervalHandle = scheduleIntervalTask(
    "fmv",
    everyTwentyFourHoursMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 10,
    () => runFleetFmvRefresh("interval")
  );

  businessMetricsIntervalHandle = scheduleIntervalTask(
    "businessMetrics",
    everyTwentyFourHoursMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 11,
    () => runBusinessMetricsSnapshot("interval")
  );

  dailyBriefIntervalHandle = scheduleIntervalTask(
    "dailyBrief",
    everyHourMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 13,
    () => runDailyBriefGeneration("interval")
  );

  odometerRollupIntervalHandle = scheduleIntervalTask(
    "odometerRollups",
    everyHourMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 6,
    () => runVehicleOdometerRollups("interval")
  );

  telemetryRetentionIntervalHandle = scheduleIntervalTask(
    "telemetryRetention",
    everySevenDaysMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 12,
    () => runTelemetryRetention("interval")
  );

  googleCalendarIntervalHandle = scheduleIntervalTask(
    "googleCalendar",
    everyFifteenMinutesMs,
    SCHEDULER_INTERVAL_OFFSET_STEP_MS * 5,
    () => runGoogleCalendarReconcile("interval")
  );
}

function stopScheduler() {
  if (tellerSyncIntervalHandle) {
    stopScheduledInterval(tellerSyncIntervalHandle);
    tellerSyncIntervalHandle = null;
  }

  if (tollSyncIntervalHandle) {
    stopScheduledInterval(tollSyncIntervalHandle);
    tollSyncIntervalHandle = null;
  }

  if (intervalHandle) {
    stopScheduledInterval(intervalHandle);
    intervalHandle = null;
  }

  if (bouncieIntervalHandle) {
    stopScheduledInterval(bouncieIntervalHandle);
    bouncieIntervalHandle = null;
  }

  if (dimoIntervalHandle) {
    stopScheduledInterval(dimoIntervalHandle);
    dimoIntervalHandle = null;
  }

  if (googleCalendarIntervalHandle) {
    stopScheduledInterval(googleCalendarIntervalHandle);
    googleCalendarIntervalHandle = null;
  }

  if (fmvIntervalHandle) {
    stopScheduledInterval(fmvIntervalHandle);
    fmvIntervalHandle = null;
  }

  if (businessMetricsIntervalHandle) {
    stopScheduledInterval(businessMetricsIntervalHandle);
    businessMetricsIntervalHandle = null;
  }

  if (dailyBriefIntervalHandle) {
    stopScheduledInterval(dailyBriefIntervalHandle);
    dailyBriefIntervalHandle = null;
  }

  if (odometerRollupIntervalHandle) {
    stopScheduledInterval(odometerRollupIntervalHandle);
    odometerRollupIntervalHandle = null;
  }

  if (telemetryRetentionIntervalHandle) {
    stopScheduledInterval(telemetryRetentionIntervalHandle);
    telemetryRetentionIntervalHandle = null;
  }

  if (fleetAlertsIntervalHandle) {
    stopScheduledInterval(fleetAlertsIntervalHandle);
    fleetAlertsIntervalHandle = null;
  }

  console.log("[scheduler] stopped");
  void logSystemActivity({
    category: "automation",
    eventType: "scheduler_stopped",
    severity: "notice",
    actorType: "system",
    source: "scheduler",
  }).catch(() => null);
}

module.exports = startScheduler;
module.exports.stopScheduler = stopScheduler;
module.exports.getStartupStatus = getStartupStatus;
