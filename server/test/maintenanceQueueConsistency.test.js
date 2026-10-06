const test = require('node:test');
const assert = require('node:assert/strict');

test('dispatch and maintenance share filtering for satisfied oil checks and duplicate tasks', async () => {
  const shared = await import('../../shared/maintenanceQueue.mjs');
  const frontend = await import('../../src/utils/maintUtils.js');
  assert.equal(shared.buildQueueItemsFromSummary, frontend.buildQueueItemsFromSummary);
  const summary = {
    ruleStatuses: [{ ruleId: 7, ruleCode: 'oil_level', title: 'Oil level', status: 'ok' }],
    tasks: [1, 2, 3, 4].map(id => ({ id, rule_id: 7, title: 'Check oil level', status: 'open',
      task_type: 'post_trip_oil_check', trigger_context: { ruleCode: 'oil_level' } })),
  };
  assert.equal(shared.buildQueueItemsFromSummary(summary).length, 0);
  const pending = { tasks: [1, 2, 3, 4].map(id => ({ id, title: 'Check oil level', status: 'open' })) };
  assert.equal(shared.buildQueueItemsFromSummary(pending).length, 1);
  assert.equal(shared.buildQueueItemsFromSummary({ tasks: [{ id: 9, title: 'Completed', status: 'completed' }] }).length, 0);
});
