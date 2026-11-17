const test = require('node:test');
const assert = require('node:assert/strict');
const { validateActivity, saveAdminActivity, getAdminActivityHours } = require('../services/metrics/adminActivityService');

const activity = { session_id: '12345678-1234-1234-1234-123456789abc', panel: 'metrics', activity_date: '2026-11-16', seconds: 90 };

test('rejects invalid counters and panel identifiers', () => {
  for (const change of [{ seconds: -1 }, { seconds: Infinity }, { seconds: 86401 }, { panel: '../metrics' }, { session_id: 'bad' }, { activity_date: 'yesterday' }]) {
    assert.throws(() => validateActivity({ ...activity, ...change }), { status: 400 });
  }
});

test('uses monotonic upsert so retries cannot double credit time', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await saveAdminActivity(activity, db);
  await saveAdminActivity(activity, db);
  const writes = calls.filter(call => call.values);
  assert.equal(writes.length, 2);
  assert.match(writes[0].sql, /GREATEST\(utility_admin_activity.seconds, EXCLUDED.seconds\)/);
  assert.deepEqual(writes[0].values, writes[1].values);
});

test('admin hours are bounded by the selected metrics dates', async () => {
  const db = { query: async (sql, values) => {
    assert.match(sql, /activity_date >= \$1::date/);
    assert.match(sql, /activity_date <= \$2::date/);
    assert.deepEqual(values, ['2026-11-01', '2026-11-30']);
    return { rows: [{ hours: '1.5' }] };
  } };
  assert.equal(await getAdminActivityHours('2026-11-01', '2026-11-30', db), 1.5);
});
