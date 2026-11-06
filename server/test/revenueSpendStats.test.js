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
