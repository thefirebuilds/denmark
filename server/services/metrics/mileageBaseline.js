const { toNumber } = require('./metricHelpers');

function resolveMileageStart(anchor, rangeStart = null) {
  const birth = toNumber(anchor?.first_trip_start_odometer, null);
  for (const [field, source] of [
    ['start_before_odometer', 'before_range'],
    ['start_in_range_odometer', 'in_range'],
  ]) {
    const reading = toNumber(anchor?.[field], null);
    if (reading != null && (birth == null || reading >= birth)) {
      return { odometer: reading, source };
    }
  }
  // A lifetime baseline cannot stand in for a missing monthly reading.
  const birthTime = anchor?.first_trip_start ? new Date(anchor.first_trip_start).getTime() : NaN;
  if (rangeStart && !(birthTime >= new Date(rangeStart).getTime())) {
    return { odometer: null, source: 'missing' };
  }
  return { odometer: birth, source: birth == null ? 'missing' : 'first_trip' };
}

function applyMileageBaseline(trip, birthOdometer) {
  const birth = toNumber(birthOdometer, null);
  if (birth == null) return trip;
  const result = { ...trip };
  for (const field of ['starting_odometer', 'ending_odometer']) {
    const reading = toNumber(trip[field], null);
    if (reading != null && reading < birth) result[field] = null;
  }
  return result;
}

module.exports = { resolveMileageStart, applyMileageBaseline };
