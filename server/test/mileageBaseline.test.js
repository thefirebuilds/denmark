const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMileageStart, applyMileageBaseline } = require('../services/metrics/mileageBaseline');
const { getTripMiles } = require('../services/metrics/metricHelpers');

test('Delavan starts at its first trip odometer, not a zero history anchor', () => {
  assert.deepEqual(resolveMileageStart({
    first_trip_start_odometer: 80183,
    start_before_odometer: 0,
    start_in_range_odometer: 0,
  }), { odometer: 80183, source: 'first_trip' });
  assert.equal(getTripMiles({ starting_odometer: 80183, ending_odometer: 90223 }), 10040);
});

test('a later reporting period keeps its valid starting anchor', () => {
  assert.deepEqual(resolveMileageStart({ first_trip_start_odometer: 80183,
    start_before_odometer: 89000 }), { odometer: 89000, source: 'before_range' });
});

test('readings below the birth odometer cannot become whole-odometer trip mileage', () => {
  const trip = { starting_odometer: 0, ending_odometer: 90161 };
  const normalized = applyMileageBaseline(trip, 80183);
  assert.equal(getTripMiles(normalized), 0);
  assert.equal(normalized.starting_odometer, null);
  assert.equal(trip.starting_odometer, 0);
  assert.equal(getTripMiles(applyMileageBaseline({ starting_odometer: 89000,
    ending_odometer: 90161 }, 80183)), 1161);
});

test('missing birth data preserves existing range anchors without inventing zero', () => {
  assert.deepEqual(resolveMileageStart({}), { odometer: null, source: 'missing' });
  assert.deepEqual(resolveMileageStart({ start_in_range_odometer: 89000 }),
    { odometer: 89000, source: 'in_range' });
});

test('a monthly range cannot fall back to lifetime mileage', () => {
  assert.deepEqual(resolveMileageStart({ first_trip_start_odometer: 80183,
    first_trip_start: '2026-02-21', start_before_odometer: 0 }, new Date('2026-09-01')),
  { odometer: null, source: 'missing' });
  assert.deepEqual(resolveMileageStart({ first_trip_start_odometer: 80183,
    first_trip_start: '2026-02-21' }, new Date('2026-02-01')),
  { odometer: 80183, source: 'first_trip' });
});
