const test = require('node:test');
const assert = require('node:assert/strict');

test('daily spend gap works backward from saved totals and keeps the direction of each daily change', async () => {
  const { dailySpendGap } = await import('../../src/utils/revenueSpendStats.js');
  const report = { revenue: 50, expenses: 100, _report: { calculated_at: '2026-11-25T13:00:00Z' } };
  const trends = { granularity: 'day', _report: { calculated_at: '2026-11-25T12:00:00Z' }, points: [
    { label: '2026-11-24', revenue: 0, expenses: 25 },
    { label: '2026-11-25', revenue: 10.32, expenses: 0 },
  ] };
  assert.deepEqual(dailySpendGap(report, trends), [
    { label: '2026-11-24', gap: 60.32, change: 25 },
    { label: '2026-11-25', gap: 50, change: -10.32 },
  ]);
  assert.deepEqual(dailySpendGap(report, { ...trends, _report: { calculated_at: '2026-11-24T12:00:00Z' } }), []);
  const ninetyDays = Array.from({ length: 90 }, (_, index) => ({
    label: new Date(Date.UTC(2026, 10, 25 - (89 - index))).toISOString().slice(0, 10),
    revenue: 1,
    expenses: 0,
  }));
  const extended = dailySpendGap(report, { ...trends, points: ninetyDays });
  assert.equal(extended.length, 90);
  assert.equal(extended[0].gap, 139);
  assert.equal(extended.at(-1).gap, 50);
});
test('complete daily history populates while the all-time summary is absent or from another day', async () => {
  const { dailySpendGap } = await import('../../src/utils/revenueSpendStats.js');
  const trends = { range: 'daily-all', granularity: 'day', _report: { calculated_at: '2026-11-25T23:00:00Z' }, points: [
    { label: '2026-11-24', revenue: 0, expenses: 25 },
    { label: '2026-11-25', revenue: 10.32, expenses: 0 },
  ] };
  const expected = [
    { label: '2026-11-24', gap: 25, change: 25 },
    { label: '2026-11-25', gap: 14.68, change: -10.32 },
  ];
  assert.deepEqual(dailySpendGap(null, trends), expected);
  assert.deepEqual(dailySpendGap({ revenue: 50, expenses: 100, _report: { calculated_at: '2026-11-26T00:05:00Z' } }, trends), expected);
});

test('daily spend gap offers five history ranges that end on the same date', async () => {
  const { selectSpendGapRange } = await import('../../src/utils/revenueSpendStats.js');
  const points = Array.from({ length: 800 }, (_, index) => ({
    label: new Date(Date.UTC(2024, 1, 29 - (799 - index))).toISOString().slice(0, 10),
  }));
  for (const [range, days] of [['30d', 30], ['90d', 90], ['180d', 180], ['12mo', 366], ['all', 800]]) {
    const selected = selectSpendGapRange(points, range);
    assert.equal(selected.length, days);
    assert.equal(selected.at(-1), points.at(-1));
  }
});

test('revenue versus spend shows coverage and net balance without adding capital basis twice', async () => {
  const { revenueSpendStats } = await import('../../src/utils/revenueSpendStats.js');
  assert.deepEqual(revenueSpendStats({ revenue: 75, expenses: 100, capital_basis: 50 }), { revenue: 75, spend: 100, net: -25, coveragePct: 75, fillPct: 75 });
  assert.deepEqual(revenueSpendStats({ revenue: '150', expenses: '100' }), { revenue: 150, spend: 100, net: 50, coveragePct: 150, fillPct: 100 });
});
test('missing data, zero spend and net refunds never pretend to be 100 percent covered', async () => {
  const { revenueSpendStats } = await import('../../src/utils/revenueSpendStats.js');
  for (const report of [null, {}, { revenue: 5 }, { revenue: 1, expenses: 'invalid' }]) assert.equal(revenueSpendStats(report), null);
  assert.equal(revenueSpendStats({ revenue: 50, expenses: 0 }).coveragePct, null);
  assert.equal(revenueSpendStats({ revenue: 50, expenses: -10 }).net, 60);
  assert.equal(revenueSpendStats({ revenue: -10, expenses: 100 }).fillPct, 0);
});

test('spend outlook projects the all-time shortfall using trailing net revenue, not gross revenue', async () => {
  const { spendPayoffOutlook } = await import('../../src/utils/revenueSpendStats.js');
  const now = Date.parse('2026-11-06T18:00:00Z');
  const result = spendPayoffOutlook({ revenue: 10000, expenses: 20000 }, { revenue: 3000, expenses: 1500, calendar_days: 30 }, now);
  assert.equal(result.status, 'projected');
  assert.equal(result.monthlyNet, 1521.875);
  assert.equal(Date.parse(result.breakEvenDate), now + 200 * 86400000);
});

test('spend outlook distinguishes covered totals, missing pace and nonpositive recovery', async () => {
  const { spendPayoffOutlook } = await import('../../src/utils/revenueSpendStats.js');
  const shortfall = { revenue: 50, expenses: 100 };
  assert.equal(spendPayoffOutlook(null, null), null);
  assert.equal(spendPayoffOutlook(shortfall, null).status, 'unavailable');
  assert.equal(spendPayoffOutlook(shortfall, { revenue: 50, expenses: 10 }).status, 'unavailable');
  for (const expenses of [50, 100]) {
    const result = spendPayoffOutlook(shortfall, { revenue: 50, expenses, calendar_days: 30 });
    assert.equal(result.status, 'not_recovering');
    assert.equal(result.breakEvenDate, null);
  }
  assert.equal(spendPayoffOutlook({ revenue: 100, expenses: 100 }, null).status, 'covered');
  assert.equal(spendPayoffOutlook({ revenue: 150, expenses: 100 }, null).status, 'covered');
});
