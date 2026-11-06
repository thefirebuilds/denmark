const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const flush = () => new Promise(resolve => setImmediate(resolve));
const read = file => fs.readFileSync(path.join(__dirname, '../', file), 'utf8');

function limiter() {
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} },
    require: () => ({}), setTimeout, clearTimeout });
  vm.runInContext(read('services/metrics/metricReadLimiter.js'), context);
  return context.module.exports.createMetricReadLimiter;
}
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}

test('metrics recheck pressure after waiting and release their admission slot', async () => {
  let busy = false;
  const gate = limiter()({ db: { getPoolStats: () => ({ max: 6,
    checked_out: busy ? 4 : 0, waiting: 0 }) } });
  let finish;
  let secondCalls = 0;
  const first = gate.limitMetricRead(() => new Promise(resolve => { finish = resolve; }));
  const second = gate.limitMetricRead(async () => { secondCalls++; });
  const one = first({}, response());
  await flush();
  const res = response();
  const two = second({}, res);
  busy = true;
  finish();
  await Promise.all([one, two]);
  assert.equal(secondCalls, 0);
  assert.equal(res.code, 503);
  busy = false;
  await second({}, response());
  assert.equal(secondCalls, 1);
});

test('metrics queue bounds, timeout and handler errors cannot leak admission slots', async () => {
  const gate = limiter()({ db: {}, queueMax: 1, queueTimeoutMs: 10 });
  let finish;
  const slow = gate.limitMetricRead(() => new Promise(resolve => { finish = resolve; }));
  const active = slow({}, response());
  await flush();
  const waiting = response();
  const queued = slow({}, waiting);
  const overflow = response();
  await slow({}, overflow);
  assert.equal(overflow.code, 503);
  await queued;
  assert.equal(waiting.code, 503);
  finish();
  await active;
  await assert.rejects(gate.limitMetricRead(async () => { throw new Error('read failed'); })({}, response()),
    /read failed/);
  let ran = false;
  await gate.limitMetricRead(async () => { ran = true; })({}, response());
  assert.equal(ran, true);
});

test('abandoned queued requests do not run database work', async () => {
  const gate = limiter()({ db: {} });
  let finish;
  let calls = 0;
  const one = gate.limitMetricRead(() => new Promise(resolve => { finish = resolve; }))({}, response());
  await flush();
  const req = {};
  const two = gate.limitMetricRead(async () => { calls++; })(req, response());
  req.aborted = true;
  finish();
  await Promise.all([one, two]);
  assert.equal(calls, 0);
});

test('main and business metrics routers use one shared admission budget', async () => {
  const gate = limiter()({ db: {} });
  let finish;
  let settingsCalls = 0;
  function load(file) {
    const routes = new Map();
    const router = {};
    for (const method of ['get', 'post', 'patch', 'put', 'delete', 'all']) {
      router[method] = (url, handler) => routes.set(`${method}:${url}`, handler);
    }
    const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, console,
      require: name => {
        if (name === 'express') return { Router: () => router };
        if (name.endsWith('/metricReadLimiter')) return gate;
        if (name.endsWith('/metricReportCache')) return { savedMetricReport: () => async () => {} };
        if (name.endsWith('/summaryService')) return {
          getTollMetricsDetail: () => new Promise(resolve => { finish = resolve; }),
        };
        if (name.endsWith('/businessMetricsService')) return {
          getBusinessFinancialSettings: async () => { settingsCalls++; return {}; },
        };
        return {};
      },
    });
    vm.runInContext(read(file), context);
    return routes;
  }
  const main = load('routes/metrics.js');
  const business = load('routes/businessMetrics.js');
  const one = main.get('get:/tolls/detail')({ query: {} }, response());
  await flush();
  const two = business.get('get:/settings')({ query: {} }, response());
  await flush();
  assert.equal(settingsCalls, 0);
  finish({ vehicles: [] });
  await Promise.all([one, two]);
  assert.equal(settingsCalls, 1);
});

test('business metrics input reads execute sequentially and stop after failure', async () => {
  const source = read('services/metrics/businessMetricsService.js');
  const prefix = source.slice(source.indexOf('async function computeBusinessMetricsForWindow('),
    source.indexOf('  const vehicleOps = Array.isArray(vehicleOpsPayload'));
  let active = 0;
  let peak = 0;
  const calls = [];
  let fail;
  const readInput = name => async () => {
    calls.push(name);
    peak = Math.max(peak, ++active);
    await flush();
    active--;
    if (fail === name) throw new Error('input failed');
    return {};
  };
  const context = vm.createContext({ pool: {},
    ensureBusinessMetricsTables: async () => {}, ensureMaintenanceRuntimeSchema: async () => {},
    syncTripFinancialFacts: async () => {},
  });
  const names = ['getBusinessFinancialSettings', 'fetchVehiclesWithProfiles', 'getVehicleMetrics',
    'fetchTripsForBusinessMetrics', 'fetchExpensesForBusinessMetrics', 'fetchStartupBasisByVehicle',
    'fetchMaintenanceLaborForBusinessMetrics'];
  for (const name of names) context[name] = readInput(name);
  vm.runInContext(`${prefix}\nreturn {};\n}`, context);
  await context.computeBusinessMetricsForWindow({ key: '30d' });
  assert.equal(peak, 1);
  assert.deepEqual(calls, names);
  calls.length = 0;
  fail = names[1];
  await assert.rejects(context.computeBusinessMetricsForWindow({ key: '30d' }), /input failed/);
  assert.deepEqual(calls, names.slice(0, 2));
});

test('queued idle-client handoffs do not defer Metrics reads or refreshes', async () => {
  const gate = limiter()({ db: { getPoolStats: () => ({ max: 6, checked_out: 1, idle: 2, waiting: 1 }) } });
  assert.equal(gate.isDbPoolUnderPressure(), false);
  let calls = 0;
  await gate.limitMetricRead(async () => { calls++; })({}, response());
  await gate.tryRunMetricRefresh(async () => { calls++; });
  assert.equal(calls, 2);
});

test('a report calculation cannot occupy the HTTP read slot or overlap a second refresh', async () => {
  const gate = limiter()({ db: { getPoolStats: () => ({ max: 6, checked_out: 2, idle: 1, waiting: 0 }) } });
  let finish;
  const refresh = gate.tryRunMetricRefresh(() => new Promise(resolve => { finish = resolve; }));
  await flush();
  assert.equal((await gate.tryRunMetricRefresh(() => assert.fail())).deferred, true);
  let read = false;
  await gate.limitMetricRead(async () => { read = true; })({}, response());
  assert.equal(read, true, 'small reads proceed before the background calculation finishes');
  finish(); await refresh;
  await gate.tryRunMetricRefresh(async () => { read = false; });
  assert.equal(read, false, 'refresh guard releases after completion');
});

test('capacity deferrals are request-local and keep their retry instruction', async () => {
  const gate = limiter()({ db: { getPoolStats: () => ({ max: 6, checked_out: 6, idle: 0, waiting: 1 }) } });
  const headers = {};
  const res = response();
  res.setHeader = (key, value) => { headers[key] = value; };
  await gate.limitMetricRead(() => assert.fail())({}, res);
  assert.equal(res.code, 503);
  assert.equal(headers['X-Denmark-Error-Scope'], 'request');
  assert.equal(headers['Retry-After'], '10');
});
