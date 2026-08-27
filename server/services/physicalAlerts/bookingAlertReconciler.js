const { createCriticalBookingRule } = require("./bookingRule");
const { isBookingAlertEligible } = require("./bookingAlertSettings");

async function reconcileBookingAlerts(current, options = {}) {
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

  for (const trip of eligibleTrips) {
    await current.repository.reopenBookingAlert(trip.id);
    await evaluateBooking(trip);
  }

  for (const alert of bookingAlerts) {
    if (!bookedTripIds.has(Number(alert.trip_id))) {
      await current.alertService.resolveAlert(alert.id);
    }
  }

  await current.alertService.publishDeviceState(current.config.defaultDeviceId);
  console.log(
    `[physical-alerts] booking reconciliation complete | unconfirmed=${trips.length} eligible=${eligibleTrips.length}`
  );
  return { activeTrips: eligibleTrips.length, unconfirmedTrips: trips.length };
}

module.exports = { reconcileBookingAlerts };
