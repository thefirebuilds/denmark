const { toNumber, getTripMiles, getTripProratedValue } = require('./metricHelpers');

// Only dated readings within the trip can supply a missing checkout odometer.
// Never use today's vehicle odometer for an old, incomplete trip.
function getTripMileageInRange(trip, anchor, rangeStart, rangeEnd) {
  const start = toNumber(trip.starting_odometer, null);
  const end = toNumber(trip.ending_odometer, null);
  const tripStart = new Date(trip.trip_start).getTime();
  const tripEnd = new Date(trip.trip_end).getTime();
  if (trip.canceled_at || start == null || !Number.isFinite(tripStart)) {
    return { miles: 0, estimated: false, missing: !trip.canceled_at };
  }
  if (end != null) {
    return {
      miles: getTripProratedValue(getTripMiles(trip), trip.trip_start, trip.trip_end, rangeStart, rangeEnd),
      estimated: !!(rangeStart && tripStart < new Date(rangeStart).getTime()) ||
        tripEnd > new Date(rangeEnd).getTime(),
      missing: end < start,
    };
  }

  const observed = toNumber(anchor?.end_odometer, null);
  const observedTime = anchor?.end_recorded_at ? new Date(anchor.end_recorded_at).getTime() : NaN;
  if (observed == null || observed < start || !Number.isFinite(observedTime) ||
      observedTime < tripStart || observedTime > tripEnd ||
      observedTime > new Date(rangeEnd).getTime()) {
    return { miles: 0, estimated: false, missing: true };
  }
  // Use elapsed time through the reading, not the scheduled return date:
  // future booked days must not dilute miles already driven.
  return {
    miles: getTripProratedValue(observed - start, trip.trip_start,
      new Date(observedTime), rangeStart, rangeEnd),
    estimated: true,
    missing: false,
  };
}

module.exports = { getTripMileageInRange };
