const { getPhysicalAlertConfig, isTripWithinCriticalWindow, isWithinQuietHours } = require("./config");

function createCriticalBookingRule({ alertService, config = getPhysicalAlertConfig(), now = () => new Date() }) {
  return async function evaluateCriticalBooking(trip, options = {}) {
    if (!trip?.id || !trip?.trip_start) return null;
    const discoveredAt = options.discoveredAt ? new Date(options.discoveredAt) : now();
    if (!isWithinQuietHours(discoveredAt, {
      start: config.quietHoursStart, end: config.quietHoursEnd, timeZone: config.businessTimeZone,
    })) return null;
    if (!isTripWithinCriticalWindow(discoveredAt, trip.trip_start, config.criticalTripWindowHours)) return null;
    const vehicle = trip.vehicle_name || "Vehicle";
    const start = new Intl.DateTimeFormat("en-US", {
      timeZone: config.businessTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(trip.trip_start));
    return alertService.createAlert({
      type: "new_critical_booking", severity: "critical", title: "New Turo Booking",
      message: `${vehicle} begins ${start}`, tripId: trip.id, deviceId: config.defaultDeviceId,
      dedupeKey: `new-critical-booking:${trip.id}`,
      metadata: { reservationId: trip.reservation_id || null, discoveredAt: discoveredAt.toISOString() },
    });
  };
}

module.exports = { createCriticalBookingRule };
