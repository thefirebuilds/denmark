const { getPhysicalAlertConfig } = require("./config");

function createCriticalBookingRule({ alertService, config = getPhysicalAlertConfig() }) {
  return async function evaluateCriticalBooking(trip, options = {}) {
    if (!trip?.id) return null;
    if (trip.workflow_stage && trip.workflow_stage !== "booked") return null;
    const discoveredAt = options.discoveredAt ? new Date(options.discoveredAt) : new Date();
    const vehicle = trip.vehicle_name || "Vehicle";
    const start = trip.trip_start
      ? new Intl.DateTimeFormat("en-US", {
        timeZone: config.businessTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      }).format(new Date(trip.trip_start))
      : "at a pending start time";
    return alertService.createAlert({
      type: "new_critical_booking", severity: "critical", title: "New Turo Booking",
      message: `${vehicle} begins ${start}`,
      tripId: trip.id, deviceId: config.defaultDeviceId,
      dedupeKey: `new-critical-booking:${trip.id}`,
      metadata: { reservationId: trip.reservation_id || null, discoveredAt: discoveredAt.toISOString() },
    });
  };
}

module.exports = { createCriticalBookingRule };
