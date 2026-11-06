const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestMaintenanceLabor, HISTORY_LIMIT } = require('../services/maintenance/laborSuggestion');

test('common maintenance prefers the historical mean over an old zero or preset estimate', async () => {
  const db = { query: async (sql, values) => {
    assert.match(sql, /AVG\(hours\)/);
    assert.match(sql, /actual_labor_hours > 0/);
    assert.match(sql, /status = 'resolved'/);
    assert.match(sql, /COALESCE\(me.status, 'completed'\) = 'completed'/);
    assert.match(sql, /performed_at <= NOW\(\)/);
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /completedTaskId/);
    assert.match(sql, /LIMIT \$2/);
    assert.doesNotMatch(sql, /estimated_labor_hours/);
    assert.deepEqual(values.slice(0, 2), ['oil_change', HISTORY_LIMIT]);
    return { rows: [{ hours: '0.9166666667', sample_count: 3 }] };
  } };
  assert.deepEqual(await suggestMaintenanceLabor(db, { ruleCode: 'oil_change', title: 'Oil change', task: { actual_labor_hours: 0, estimated_labor_hours: 0.75 } }), {
    hours: 0.917, source: 'historical_mean', sampleCount: 3, ruleCode: 'oil_change',
  });
});

test('preset fallback uses existing task/rule estimates, while unknown tasks stay blank rather than zero', async () => {
  const db = { query: async () => ({ rows: [{ hours: null, sample_count: 0 }] }) };
  const task = await suggestMaintenanceLabor(db, { ruleCode: 'oil_change', task: { estimated_labor_hours: 0.5 } });
  assert.equal(task.hours, 0.5);
  assert.equal(task.source, 'task_estimate');
  assert.equal((await suggestMaintenanceLabor(db, { ruleCode: 'oil_change', task: { estimated_labor_hours: 0 } })).hours, 0.75);
  assert.equal((await suggestMaintenanceLabor(db, { ruleCode: 'custom_unknown_task' })).hours, null);
});

test('manual to-dos and already entered actual hours are not replaced by common-task averages', async () => {
  const db = { query: () => assert.fail('should not query history') };
  assert.equal((await suggestMaintenanceLabor(db, { task: { source: 'manual', estimated_labor_hours: 2 } })).hours, 2);
  assert.equal((await suggestMaintenanceLabor(db, { task: { task_type: 'manual_todo', actual_labor_hours: 0 } })).hours, 0);
  const actual = await suggestMaintenanceLabor(db, { ruleCode: 'oil_change', task: { actual_labor_hours: 1.25 } });
  assert.equal(actual.hours, 1.25);
  assert.equal(actual.source, 'existing_actual');
});

test('legacy maintenance task types map to the same history as their inspection rule', async () => {
  const db = { query: async (_, values) => {
    assert.ok(values[2].includes('post_trip_tire_pressure_check'));
    return { rows: [{ hours: 0.2, sample_count: 5 }] };
  } };
  assert.equal((await suggestMaintenanceLabor(db, { ruleCode: 'tire_pressure_check' })).hours, 0.2);
});
