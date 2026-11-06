const test = require('node:test');
const assert = require('node:assert/strict');
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
