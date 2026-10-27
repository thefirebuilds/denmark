const test = require('node:test');
const assert = require('node:assert/strict');

test('oil icon turns red only after 1,000 overdue miles', async () => {
  const { getOilChangeIndicator } = await import('../../shared/oilChangeIndicator.mjs');
  const summary = current => ({ currentOdometerMiles: current,
    ruleStatuses: [{ ruleCode: 'oil_change', status: current < 50000 ? 'due_soon' : 'overdue', nextDueMiles: 50000 }] });
  for (const mileage of [49800, 50000, 50001, 51000]) {
    assert.equal(getOilChangeIndicator(summary(mileage)).tone, 'yellow');
  }
  assert.equal(getOilChangeIndicator(summary(51001)).tone, 'red');
  assert.match(getOilChangeIndicator(summary(51001)).label, /1,001 mi overdue/);
  assert.equal(getOilChangeIndicator(summary(null)).tone, 'yellow');
  assert.equal(getOilChangeIndicator({ ruleStatuses: [{ ruleCode: 'oil_change', status: 'ok' }] }), null);
  assert.equal(getOilChangeIndicator({ ruleStatuses: [{ ruleCode: 'brake_inspection', status: 'overdue' }] }), null);
});
