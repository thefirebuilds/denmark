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

//availability push
const { pushPublicAvailabilitySnapshotSafe } = require("./pushPublicAvailability");

//bank transX
const syncTellerTransactions = require("./teller/teller");

//email connectivity
const pollImap = require("./imapPoller");

//bouncie connectivity
const collectBouncieSnapshot = require("./bouncie/collectBouncieSnapshot");

//hctra connectivity (tolls)
const syncTolls = require("./tolls/syncTolls");

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

async function runTellerSync(reason = "interval") {
  if (tellerSyncInProgress) {
    console.log(`Skipping Teller sync (${reason}) because one is already running`);
    return;
  }

  tellerSyncInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running Teller sync (${reason})`);
    const result = await syncTellerTransactions();

    console.log(
      `Teller sync (${reason}) ok | processed=${result.processed} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`Teller sync failed (${reason}):`, err.message || err);
  } finally {
    tellerSyncInProgress = false;
  }
}

async function runTollSync(reason = "interval") {
  if (tollSyncInProgress) {
    console.log(`Skipping toll sync (${reason}) because one is already running`);
    return;
  }

  tollSyncInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running toll sync (${reason})`);
    const result = await syncTolls();

    console.log(
      `Toll sync (${reason}) ok | seen=${result.recordsSeen} imported=${result.recordsImported} skipped=${result.recordsSkipped} vehicleMatched=${result.recordsMatchedVehicle} tripMatched=${result.recordsMatchedTrip} runId=${result.runId} durationMs=${Date.now() - startedAt}`
    );
  } catch (err) {
    console.error(`Toll sync failed (${reason}):`, err.message || err);
  } finally {
    tollSyncInProgress = false;
  }
}

async function runPoll(reason = "interval") {
  if (pollInProgress) {
    console.log(`Skipping IMAP poll (${reason}) because one is already running`);
    return;
  }

  pollInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running IMAP poll (${reason})`);
    await pollImap();
  } catch (err) {
    console.error(`IMAP poll failed (${reason}):`, err.message || err);
  } finally {
    console.log(
      `IMAP poll finished (${reason}) in ${Date.now() - startedAt}ms`
    );
    pollInProgress = false;
  }
}

async function runBouncie(reason = "interval") {
  if (bouncieInProgress) {
    console.log(`Skipping Bouncie snapshot (${reason}) because one is already running`);
    return;
  }

  bouncieInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running Bouncie snapshot (${reason})`);
    await collectBouncieSnapshot();
  } catch (err) {
    console.error(`Bouncie snapshot failed (${reason}):`, err.message || err);
  } finally {
    console.log(
      `Bouncie snapshot finished (${reason}) in ${Date.now() - startedAt}ms`
    );
    bouncieInProgress = false;
  }
}

async function runDimo(reason = "interval") {
  if (dimoInProgress) {
    console.log(`Skipping DIMO snapshot (${reason}) because one is already running`);
    return;
  }

  dimoInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running DIMO snapshot (${reason})`);
    const summary = await collectDimoSnapshot();
    console.log(
      `DIMO snapshot (${reason}) ok | total=${summary.total} succeeded=${summary.succeeded} degraded=${summary.degraded} failed=${summary.failed}`
    );
  } catch (err) {
    console.error(`DIMO snapshot failed (${reason}):`, err.message || err);
  } finally {
    console.log(
      `DIMO snapshot finished (${reason}) in ${Date.now() - startedAt}ms`
    );
    dimoInProgress = false;
  }
}

function startScheduler() {
  console.log("Scheduler started");
  const everyEightHoursMs = 8 * 60 * 60 * 1000;
  const everyTwoHoursMs = 2 * 60 * 60 * 1000;

  // Teller sync immediately
  void runTellerSync("startup");

  // Toll sync immediately
  void runTollSync("startup");

  // IMAP immediately
  void runPoll("startup");

  // Bouncie immediately
  void runBouncie("startup");

  // DIMO immediately
  void runDimo("startup");

  // Public availability push immediately
  pushPublicAvailabilitySnapshotSafe("server startup");

  // Teller sync every 8 hours
  tellerSyncIntervalHandle = setInterval(() => {
    void runTellerSync("interval");
  }, everyTwoHoursMs);

  // Toll sync every 8 hours
  tollSyncIntervalHandle = setInterval(() => {
    void runTollSync("interval");
  }, everyTwoHoursMs);

  // IMAP every 5 minutes
  const everyFiveMinutesMs = 5 * 60 * 1000;
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
  console.log("Scheduler stopped");
}

module.exports = startScheduler;
module.exports.stopScheduler = stopScheduler;
