const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('vehicle schema initialization is shared and does not repeat DDL on every fleet read', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; } };
  const context = vm.createContext({ module: { exports: {} }, require: () => pool });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../services/vehicles/vehicleRuntimeSchema.js'), 'utf8'), context);
  const ensure = context.module.exports.ensureVehicleRuntimeSchema;
  await Promise.all([ensure(), ensure(), ensure()]);
  assert.equal(calls, 3);
  await ensure();
  assert.equal(calls, 3);
  let transactionCalls = 0;
  await ensure({ query: async () => { transactionCalls++; } });
  assert.equal(transactionCalls, 3);
});

test('failed schema initialization can be retried', async () => {
  let fail = true;
  const context = vm.createContext({ module: { exports: {} }, require: () => ({
    query: async () => { if (fail) throw new Error('offline'); },
  }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../services/vehicles/vehicleRuntimeSchema.js'), 'utf8'), context);
  const ensure = context.module.exports.ensureVehicleRuntimeSchema;
  await assert.rejects(ensure());
  fail = false;
  await ensure();
});

test('maintenance enrichment limits concurrent requests and stops scheduling after unmount', async () => {
  const { mapMaintenanceRequests } = await import('../../src/utils/maintenanceRequests.js');
  let active = 0, peak = 0;
  const result = await mapMaintenanceRequests([1, 2, 3, 4, 5], async value => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
  await mapMaintenanceRequests([1], () => assert.fail('scheduled after cancellation'), () => true);
});

test('simultaneous fleet callers share one request with independently readable responses', async () => {
  const { fetchMaintenanceFleet } = await import('../../src/utils/maintenanceRequests.js');
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return new Response(JSON.stringify([{ id: 2 }])); };
  try {
    const responses = await Promise.all([fetchMaintenanceFleet(), fetchMaintenanceFleet()]);
    assert.equal(calls, 1);
    assert.deepEqual(await responses[0].json(), [{ id: 2 }]);
    assert.deepEqual(await responses[1].json(), [{ id: 2 }]);
  } finally { global.fetch = original; }
});
