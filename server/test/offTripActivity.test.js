const test = require('node:test');
const assert = require('node:assert/strict');
const { getOffTripActivity } = require('../services/metrics/offTripActivityService');
const input = { vehicleId: '7', start: '2026-11-01T12:00:00Z', end: '2026-11-02T12:00:00Z' };

test('requires a vehicle and ordered, finite segment bounds before querying', async () => {
  const db = { query() { throw new Error('must not query'); } };
  for (const change of [{ vehicleId: 'bad' }, { start: 'bad' }, { end: input.start }, { end: '2026-10-01' }]) {
    await assert.rejects(getOffTripActivity({ ...input, ...change }, db), { status: 400 });
  }
});

test('activity stays within the selected vehicle and gap, samples the full window, and preserves endpoints', async () => {
  const result = await getOffTripActivity(input, { query: async (sql, values) => {
    assert.deepEqual(values, [7, '2026-11-01T12:00:00.000Z', '2026-11-02T12:00:00.000Z']);
    assert.match(sql, /v.id = \$1/);
    assert.match(sql, />= \$2::timestamptz/);
    assert.match(sql, /<= \$3::timestamptz/);
    assert.match(sql, /s.latitude BETWEEN -90 AND 90/);
    assert.match(sql, /CEIL\(total_points \/ 2000.0\)/);
    assert.match(sql, /OR n = total_points/);
    return { rows: [{ id: 1, lat: 30, lon: -97, n: 1, total_points: 4000 }] };
  } });
  assert.equal(result.point_count, 4000);
  assert.deepEqual(result.points, [{ id: 1, lat: 30, lon: -97 }]);
});

test('missing historical GPS returns an empty activity map', async () => {
  const result = await getOffTripActivity(input, { query: async () => ({ rows: [] }) });
  assert.deepEqual(result, { vehicle_id: 7, point_count: 0, points: [] });
});
