const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function maintenanceContext(pool = {}) {
  const context = vm.createContext({ module: { exports: {} }, require: () => pool, Date, Map });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../services/maintenance/getVehicleMaintenanceSummary.js'), 'utf8'), context);
  return context;
}

test('maintenance history queries run one at a time and stop on failure', async () => {
  const run = vm.runInContext('runQueriesSequentially', maintenanceContext());
  let active = 0;
  let peak = 0;
  const result = await run([1, 2, 3, 4, 5].map(value => async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return value;
  }));
  assert.equal(peak, 1);
  assert.equal(Array.from(result).join(','), '1,2,3,4,5');
  let ranAfterFailure = false;
  await assert.rejects(run([
    async () => { throw new Error('database failed'); },
    async () => { ranAfterFailure = true; },
  ]), /database failed/);
  assert.equal(ranAfterFailure, false);
});

test('concurrent battery history reads share work, failures retry, transactions bypass cache', async () => {
  let calls = 0;
  let fail = false;
  const pool = { query: async () => {
    calls++;
    await new Promise(resolve => setImmediate(resolve));
    if (fail) throw new Error('query failed');
    return { rows: [] };
  } };
  const read = vm.runInContext('getSharedBatteryVoltageHealth', maintenanceContext(pool));
  await Promise.all([read(pool, 'VIN'), read(pool, 'vin'), read(pool, 'VIN')]);
  await read(pool, 'VIN');
  assert.equal(calls, 1);
  const transaction = { query: pool.query };
  await read(transaction, 'VIN');
  await read(transaction, 'VIN');
  assert.equal(calls, 3);
  fail = true;
  await assert.rejects(read(pool, 'OTHER'), /query failed/);
  fail = false;
  await read(pool, 'OTHER');
  assert.equal(calls, 5);
});

test('startup tolerates unavailable preferences but preserves access failures', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/hooks/useStartup.ts'), 'utf8');
  const start = source.indexOf('          let mergedSettings = DEFAULT_DISPATCH_SETTINGS;');
  const end = source.indexOf('          if (cancelled) return;', start);
  const code = `(async () => { ${source.slice(start, end)} return mergedSettings; })()`;
  const defaults = { openTripsSort: 'priority' };
  const context = vm.createContext({
    DEFAULT_DISPATCH_SETTINGS: defaults,
    API_BASE: '', Error, console: { warn: () => {} },
    mergeDispatchSettings: value => value,
    timedStartupFetch: async () => { throw new Error('timed out'); },
  });
  assert.equal(await vm.runInContext(code, context), defaults);
  context.timedStartupFetch = async () => ({ status: 200, ok: true,
    json: async () => ({ value: { openTripsSort: 'date' } }) });
  assert.equal((await vm.runInContext(code, context)).openTripsSort, 'date');
  context.timedStartupFetch = async () => ({ status: 401, ok: false });
  await assert.rejects(vm.runInContext(code, context), /access denied: 401/);
});
