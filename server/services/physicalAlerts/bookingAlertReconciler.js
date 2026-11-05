const { createCriticalBookingRule } = require("./bookingRule");
const { isBookingAlertEligible } = require("./bookingAlertSettings");

const checks = new WeakMap();

// Serialize checks and coalesce changes arriving during a check into one rerun.
// The rerun matters when confirmation commits while the first query is pending.
function reconcileBookingAlerts(current, options = {}) {
  let state = checks.get(current);
  if (!state) { state = { running: null, pending: null, signature: null }; checks.set(current, state); }
  state.pending = options;
  if (state.running) return state.running;
  state.running = (async () => {
    let result;
    do {
      const next = state.pending;
      state.pending = null;
      result = await checkForNewTrips(current, next, state);
    } while (state.pending);
    return result;
  })().finally(() => { state.running = null; });
  return state.running;
}

async function checkForNewTrips(current, options, state) {
  const trips = await current.repository.listUnconfirmedTrips();
  const settings = await current.repository.getBookingAlertSettings();
  const now = options.now ? new Date(options.now) : new Date();
  const eligibleTrips = trips.filter((trip) =>
    isBookingAlertEligible(trip, settings, now, current.config.businessTimeZone)
  );
  const bookedTripIds = new Set(eligibleTrips.map((trip) => Number(trip.id)));
  const activeAlerts = await current.repository.listAlerts({ active: true, limit: 500 });
  const bookingAlerts = activeAlerts.filter((alert) =>
    alert.type === "new_critical_booking" &&
    alert.metadata?.source !== "settings_mqtt_test"
  );
  const evaluateBooking = createCriticalBookingRule({
    alertService: current.alertService,
    config: current.config,
  });

  let changedAlerts = 0;
  for (const trip of eligibleTrips) {
    if (await current.repository.reopenBookingAlert(trip.id)) changedAlerts++;
    if ((await evaluateBooking(trip))?.inserted) changedAlerts++;
  }

  for (const alert of bookingAlerts) {
    if (!bookedTripIds.has(Number(alert.trip_id))) {
      await current.alertService.resolveAlert(alert.id);
      changedAlerts++;
    }
  }

  await current.alertService.publishDeviceState(current.config.defaultDeviceId);
  const signature = JSON.stringify({
    trips: trips.map(trip => [Number(trip.id), trip.trip_start, trip.workflow_stage]).sort((a, b) => a[0] - b[0]),
    eligible: [...bookedTripIds].sort((a, b) => a - b),
  });
  if (signature !== state.signature || changedAlerts) {
    console.log(`[physical-alerts] Bat Signal checked for new trips | reason=${options.reason || 'trip_changed'} unconfirmed=${trips.length} eligible=${eligibleTrips.length} alertsChanged=${changedAlerts}`);
    state.signature = signature;
  }
  return { activeTrips: eligibleTrips.length, unconfirmedTrips: trips.length };
}

module.exports = { reconcileBookingAlerts };
