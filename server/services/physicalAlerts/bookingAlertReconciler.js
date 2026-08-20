const { createCriticalBookingRule } = require("./bookingRule");

async function reconcileBookingAlerts(current) {
  const trips = await current.repository.listUnconfirmedTrips();
  const bookedTripIds = new Set(trips.map((trip) => Number(trip.id)));
  const activeAlerts = await current.repository.listAlerts({ active: true, limit: 500 });
  const bookingAlerts = activeAlerts.filter((alert) => alert.type === "new_critical_booking");
  const evaluateBooking = createCriticalBookingRule({
    alertService: current.alertService,
    config: current.config,
  });

  for (const trip of trips) {
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
    `[physical-alerts] booking reconciliation complete | unconfirmed=${trips.length} active_booking_alerts=${trips.length}`
  );
  return { activeTrips: trips.length };
}

module.exports = { reconcileBookingAlerts };
