const test = require('node:test');
const assert = require('node:assert/strict');
const { getTripMileageInRange } = require('../services/metrics/tripMileage');
const from = new Date('2026-09-01T00:00:00Z');
const through = new Date('2026-09-17T23:59:59Z');
const trip = { starting_odometer: 91000, ending_odometer: null,
  trip_start: '2026-09-10T12:00:00Z', trip_end: '2026-09-30T12:00:00Z' };
const anchor = { end_odometer: 92779, end_recorded_at: '2026-09-17T12:00:00Z' };

test('all observed on-trip miles count before the scheduled return', () => {
  assert.deepEqual(getTripMileageInRange(trip, anchor, from, through),
    { miles: 1779, estimated: true, missing: false });
});

test('completed trips retain their full mileage within the selected range', () => {
  assert.deepEqual(getTripMileageInRange({ ...trip, ending_odometer: 91951,
    trip_end: '2026-09-15T12:00:00Z' }, anchor, from, through),
  { miles: 951, estimated: false, missing: false });
});

test('an old incomplete trip cannot absorb subsequent off-trip mileage', () => {
  assert.deepEqual(getTripMileageInRange({ ...trip, trip_end: '2026-09-15T12:00:00Z' },
    anchor, from, through), { miles: 0, estimated: false, missing: true });
});

test('missing, regressed, future and pre-trip readings remain unknown', () => {
  for (const reading of [ {}, { ...anchor, end_odometer: 90000 },
    { ...anchor, end_recorded_at: '2026-09-20T12:00:00Z' },
    { ...anchor, end_recorded_at: '2026-09-09T12:00:00Z' } ]) {
    assert.equal(getTripMileageInRange(trip, reading, from, through).missing, true);
  }
});

test('a trip crossing the range boundary only contributes its overlapping portion', () => {
  const result = getTripMileageInRange({ ...trip, trip_start: '2026-08-25T12:00:00Z' },
    anchor, from, through);
  assert.ok(result.miles > 0 && result.miles < 1779);
  assert.equal(result.estimated, true);
});

test('canceled trips contribute no observed mileage', () => {
  assert.equal(getTripMileageInRange({ ...trip, canceled_at: '2026-09-09' },
    anchor, from, through).miles, 0);
});
