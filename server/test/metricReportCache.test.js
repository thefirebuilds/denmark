const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const flush = () => new Promise(resolve => setImmediate(resolve));
const source = fs.readFileSync(path.join(__dirname, '../services/metrics/metricReportCache.js'), 'utf8');
const context = vm.createContext({ module: { exports: {} }, console: { log() {}, warn() {} },
  require: name => name === 'node:crypto' ? require(name)
    : name === './metricHelpers' ? require('../services/metrics/metricHelpers')
    : name === './metricReadLimiter' ? { tryRunMetricRefresh: work => work(), limitMetricRead: handler => handler } : {},
});
vm.runInContext(source, context);
const { createMetricReportCache, describeReport } = context.module.exports;

function database() {
  let now = Date.parse('2026-11-03T12:00:00Z');
  let locked = false;
  const rows = new Map();
  const queries = [];
  let releases = 0;
  async function query(sql, values = []) {
    queries.push(sql);
    if (sql.includes('INSERT INTO public.metric_report_cache')) {
      let row = rows.get(values[0]);
      if (!row) {
        row = { cache_key: values[0], report_kind: values[1], params: JSON.parse(values[2]),
          payload: null, calculated_at: null, refresh_after: new Date(now), next_attempt_at: new Date(now) };
        rows.set(values[0], row);
      }
      row.requested_at = new Date(now);
      return { rows: [{ ...row }] };
    }
    if (sql.includes('SELECT cache_key, report_kind')) {
      const due = [...rows.values()].filter(row => row.requested_at >= now - 7 * 86400000 &&
        row.next_attempt_at <= now && (row.payload == null || row.refresh_after <= now));
      due.sort((a, b) => Number(b.payload == null) - Number(a.payload == null) ||
        Number(a.last_attempt_at || 0) - Number(b.last_attempt_at || 0));
      return { rows: due.slice(0, 1).map(row => ({ ...row })) };
    }
    if (sql.includes('SET last_attempt_at')) {
      Object.assign(rows.get(values[0]), { last_attempt_at: new Date(now), next_attempt_at: new Date(now + 900000) });
      return { rows: [] };
    }
    if (sql.includes('SET payload =')) {
      Object.assign(rows.get(values[0]), { payload: JSON.parse(values[1]), calculated_at: new Date(now),
        refresh_after: new Date(now + values[2]), next_attempt_at: new Date(now), last_error_at: null });
      return { rows: [] };
    }
    if (sql.includes('SET last_error_at')) {
      Object.assign(rows.get(values[0]), { last_error_at: new Date(now), next_attempt_at: new Date(now + 900000) });
      return { rows: [] };
    }
    assert.fail(`Unexpected query: ${sql}`);
  }
  return { rows, queries, advance: ms => { now += ms; }, clock: () => now,
    releases: () => releases,
    query,
    connect: async () => {
      let ownsLock = false;
      return {
        query: async (sql, values) => {
          if (sql.includes('pg_try_advisory_lock')) {
            ownsLock = !locked;
            if (ownsLock) locked = true;
            return { rows: [{ locked: ownsLock }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            assert.equal(ownsLock, true);
            ownsLock = false;
            locked = false;
            return { rows: [] };
          }
          return query(sql, values);
        },
        release: error => {
          releases++;
          if (error && ownsLock) locked = false;
          else assert.equal(ownsLock, false, 'advisory lock must not leak into the pool');
        },
      };
    },
  };
}

function service(db, compute, runRefresh = work => work()) {
  return createMetricReportCache({ db, compute, clock: db.clock, runRefresh });
}

test('report GETs return pending or persisted data without performing any calculation', async () => {
  const db = database();
  let calls = 0;
  const cache = service(db, async () => { calls++; return { revenue: 123 }; });
  assert.equal((await cache.getSavedReport('summary', { range: '30d' })).meta.pending, true);
  assert.equal(calls, 0);
  assert.equal(db.queries.length, 1);
  assert.ok(db.queries.every(sql => !/CREATE|ALTER|vehicle_telemetry/.test(sql)));
  await cache.refreshDueReport();
  assert.equal(calls, 1);
  // A new service instance reads the same persisted snapshot after restart.
  const restarted = service(db, () => assert.fail('request must never calculate'));
  const saved = await restarted.getSavedReport('summary', { range: '30' });
  assert.equal(saved.payload.revenue, 123);
  assert.equal(saved.meta.pending, false);
  assert.equal(saved.meta.refresh_interval_hours, 1);
});

test('current reports refresh hourly and historical reports every four hours', async () => {
  const db = database();
  const calls = [];
  const cache = service(db, async kind => { calls.push(kind); return { kind }; });
  await cache.getSavedReport('summary', {});
  await cache.getSavedReport('trends', {});
  await cache.refreshDueReport();
  await cache.refreshDueReport();
  assert.equal(calls.length, 2);
  db.advance(3600001);
  assert.equal((await cache.getSavedReport('summary', {})).meta.stale, true);
  assert.equal((await cache.getSavedReport('trends', {})).meta.stale, false);
  await cache.refreshDueReport();
  assert.equal(calls.filter(kind => kind === 'summary').length, 2);
  assert.equal(calls.filter(kind => kind === 'trends').length, 1);
  db.advance(3 * 3600000);
  assert.equal((await cache.getSavedReport('trends', {})).meta.stale, true);
});

test('failed refresh keeps the last snapshot and backs off before retrying', async () => {
  const db = database();
  let fail = false;
  let calls = 0;
  const cache = service(db, async () => { calls++; if (fail) throw new Error('SQL failed'); return { revenue: 123 }; });
  await cache.getSavedReport('summary', {});
  await cache.refreshDueReport();
  const original = await cache.getSavedReport('summary', {});
  db.advance(3600001);
  fail = true;
  await cache.refreshDueReport();
  const saved = await cache.getSavedReport('summary', {});
  assert.equal(saved.payload.revenue, 123);
  assert.equal(saved.meta.calculated_at.getTime(), original.meta.calculated_at.getTime());
  assert.equal(saved.meta.refresh_failed, true);
  await cache.refreshDueReport();
  assert.equal(calls, 2);
  db.advance(900001);
  fail = false;
  await cache.refreshDueReport();
  assert.equal(calls, 3);
  assert.equal((await cache.getSavedReport('summary', {})).meta.refresh_failed, false);
});

test('one worker per process and the session lock prevent overlapping calculations across processes', async () => {
  const db = database();
  let finish;
  let calls = 0;
  const compute = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = service(db, compute);
  const second = service(db, compute);
  await first.getSavedReport('summary', {});
  const pending = first.refreshDueReport();
  await flush();
  assert.equal((await first.refreshDueReport()).deferred, true);
  assert.equal((await second.refreshDueReport()).deferred, true);
  assert.equal(calls, 1);
  assert.equal((await first.getSavedReport('summary', {})).meta.pending, true);
  finish({ revenue: 1 });
  await pending;
  assert.equal(db.releases(), 2);
});

test('busy admission defers report work before acquiring any database client', async () => {
  const db = { connect: () => assert.fail('busy worker must not check out a client') };
  const cache = service(db, () => assert.fail('busy worker must not compute'),
    async () => ({ deferred: true }));
  assert.equal((await cache.refreshDueReport()).deferred, true);
});

test('database failures release the coordinator and allow the next worker attempt', async () => {
  let destroyed = false;
  let attempts = 0;
  const failure = new Error('connection lost');
  const cache = service({ connect: async () => ({
    query: async () => { attempts++; throw failure; },
    release: error => { assert.equal(error, failure); destroyed = true; },
  }) }, () => assert.fail('must not calculate without coordination'));
  await assert.rejects(cache.refreshDueReport(), /connection lost/);
  assert.equal(destroyed, true);
  await assert.rejects(cache.refreshDueReport(), /connection lost/);
  assert.equal(attempts, 2, 'failed worker must clear its running guard');
});

test('report endpoint distinguishes pending from real results and exposes saved calculation times', async () => {
  const db = database();
  const cache = service(db, async () => ({ revenue: 123 }));
  function response() { return { code: 200, setHeader() {},
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
  const handler = cache.savedMetricReport('summary');
  const pending = response();
  await handler({ query: {} }, pending);
  assert.equal(pending.code, 202);
  assert.equal(pending.body.revenue, undefined);
  await cache.refreshDueReport();
  const ready = response();
  await handler({ query: {} }, ready);
  assert.equal(ready.code, 200);
  assert.equal(ready.body.revenue, 123);
  assert.ok(ready.body._report.calculated_at);
});

test('cache keys isolate ranges and vehicles while canonicalizing equivalent ranges', () => {
  assert.equal(describeReport('summary', { range: '30' }).cacheKey,
    describeReport('summary', { range: '30d' }).cacheKey);
  assert.notEqual(describeReport('summary', { range: '7d' }).cacheKey,
    describeReport('summary', { range: '30d' }).cacheKey);
  assert.notEqual(describeReport('vehicleFinancial', { vehicleId: 1 }).cacheKey,
    describeReport('vehicleFinancial', { vehicleId: 2 }).cacheKey);
  assert.throws(() => describeReport('vehicleFinancial', { vehicleId: 'bad' }), /Invalid vehicle/);
  assert.throws(() => describeReport('unknown'), /Unknown metrics/);
});

test('client never treats a pending report as zero financial results', async () => {
  const { parseMetricReportResponse } = await import('../../src/utils/metricReportResponse.js');
  assert.throws(() => parseMetricReportResponse({ ok: true, status: 202 },
    JSON.stringify({ pending: true, message: 'Preparing first report' })),
    error => error.reportPending === true && /Preparing/.test(error.message));
  assert.equal(parseMetricReportResponse({ ok: true, status: 200 }, '{"revenue":123}').revenue, 123);
});

test('simultaneous snapshot reads share one query and repeated reads use a short cache', async () => {
  const db = database();
  const cache = service(db, () => assert.fail('read must never calculate'));
  const reports = await Promise.all(Array.from({ length: 10 }, () => cache.getSavedReport('summary', {})));
  assert.equal(db.queries.length, 1);
  assert.ok(reports.every(report => report.meta.pending));
  await cache.getSavedReport('summary', {});
  assert.equal(db.queries.length, 1);
  db.advance(15001);
  await cache.getSavedReport('summary', {});
  assert.equal(db.queries.length, 2);
});

test('a failed snapshot read is retried rather than cached', async () => {
  const db = database();
  let fail = true;
  const query = db.query;
  db.query = async (...args) => {
    if (fail) throw new Error('read failed');
    return query(...args);
  };
  const cache = service(db, () => assert.fail('read must never calculate'));
  await assert.rejects(cache.getSavedReport('summary', {}), /read failed/);
  fail = false;
  assert.equal((await cache.getSavedReport('summary', {})).meta.pending, true);
});

test('saved report endpoints defer before querying an already busy pool', async () => {
  let busy = true;
  const gateContext = vm.createContext({ module: { exports: {} }, process: { env: {} },
    require: () => ({}), setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/metrics/metricReadLimiter.js'), 'utf8'), gateContext);
  const gate = gateContext.module.exports.createMetricReadLimiter({ db: {
    getPoolStats: () => ({ max: 6, checked_out: busy ? 4 : 0, waiting: 0 }),
  } });
  const cacheContext = vm.createContext({ module: { exports: {} }, console: { log() {}, warn() {} },
    require: name => name === './metricReadLimiter' ? gate
      : name === 'node:crypto' ? require(name)
      : name === './metricHelpers' ? require('../services/metrics/metricHelpers') : {},
  });
  vm.runInContext(source, cacheContext);
  const db = database();
  const cache = cacheContext.module.exports.createMetricReportCache({ db, clock: db.clock });
  const handler = cache.savedMetricReport('summary');
  const response = () => ({ code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } });
  const deferred = response();
  await handler({}, deferred);
  assert.equal(deferred.code, 503);
  assert.equal(db.queries.length, 0);
  busy = false;
  const ready = response();
  await handler({}, ready);
  assert.equal(ready.code, 202);
  assert.equal(db.queries.length, 1);
});

test('saved snapshots bypass HTTP admission and survive temporary database read failures', async () => {
  const db = database();
  const cache = service(db, async () => ({ revenue: 123 }));
  await cache.getSavedReport('summary', {});
  await cache.refreshDueReport();
  await cache.getSavedReport('summary', {});
  db.advance(15001);
  const queryCount = db.queries.length;
  db.query = async () => { throw new Error('database read temporarily unavailable'); };
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await cache.savedMetricReport('summary')({ query: {} }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.revenue, 123);
  assert.equal(res.body._report.read_deferred, true);
  assert.ok(res.body._report.calculated_at);
  assert.equal(db.queries.length, queryCount);
});

test('an expired local snapshot is served without a pool checkout during real pressure', async () => {
  let busy = false;
  const gateContext = vm.createContext({ module: { exports: {} }, process: { env: {} }, require: () => ({}), setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/metrics/metricReadLimiter.js'), 'utf8'), gateContext);
  const gate = gateContext.module.exports.createMetricReadLimiter({ db: { getPoolStats: () => ({ max: 6, checked_out: busy ? 6 : 0, idle: busy ? 0 : 3, waiting: busy ? 1 : 0 }) } });
  const ctx = vm.createContext({ module: { exports: {} }, console: { log() {}, warn() {} }, require: name => name === './metricReadLimiter' ? gate
    : name === 'node:crypto' ? require(name) : name === './metricHelpers' ? require('../services/metrics/metricHelpers') : {} });
  vm.runInContext(source, ctx);
  const db = database();
  const cache = ctx.module.exports.createMetricReportCache({ db, clock: db.clock, compute: async () => ({ revenue: 123 }), runRefresh: work => work() });
  await cache.getSavedReport('summary', {}); await cache.refreshDueReport(); await cache.getSavedReport('summary', {});
  const count = db.queries.length;
  db.advance(3600001); busy = true;
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  await cache.savedMetricReport('summary')({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.revenue, 123);
  assert.equal(res.body._report.read_deferred, true);
  assert.equal(res.body._report.stale, true);
  assert.equal(db.queries.length, count);
});
