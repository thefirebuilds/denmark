const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../routes/messages.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function cacheHarness() {
  let now = 1000000;
  class Clock extends Date { static now() { return now; } }
  let stats = { max: 6, checked_out: 0, waiting: 0 };
  const context = vm.createContext({ Date: Clock, process: { env: {} },
    db: { getPoolStats: () => stats }, console: { log() {}, warn() {} },
  });
  vm.runInContext(source.slice(source.indexOf('const EMPTY_QUERY_RESULT'),
    source.indexOf('function getCachedPayload')), context);
  vm.runInContext(source.slice(source.indexOf('function invalidateMessageCaches()'),
    source.indexOf('onBankingReconciliationNoticeChanged(()')), context);
  return { context, advance: ms => { now += ms; }, pressure: value => { stats = value; } };
}

test('diagnostics return cached rows immediately and coalesce pending refreshes', async () => {
  const { context, advance } = cacheHarness();
  let finish;
  let calls = 0;
  const load = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  for (let i = 0; i < 5; i++) {
    assert.equal(context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent').rows.length, 0);
  }
  await flush();
  assert.equal(calls, 1);
  context.invalidateMessageCaches();
  context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent');
  await flush();
  assert.equal(calls, 1, 'message actions retain the pending diagnostic refresh');
  assert.equal(context.getDiagnosticCacheStatus().checkedAt, null);
  const first = { rows: [{ id: 1 }] };
  finish(first);
  await flush();
  const checkedAt = context.getDiagnosticCacheStatus().checkedAt;
  assert.equal(context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent'), first);
  advance(61000);
  assert.equal(context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent'), first);
  await flush();
  assert.equal(calls, 2);
  assert.equal(context.getDiagnosticCacheStatus().checkedAt, checkedAt);
  assert.equal(context.getDiagnosticCacheStatus().refreshing, true);
  finish({ rows: [] });
  await flush();
  assert.equal(context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent').rows.length, 0);
});

test('background refresh defers under pool pressure and retries without pretending stale data is fresh', async () => {
  const harness = cacheHarness();
  const { context, advance, pressure } = harness;
  let calls = 0;
  const load = async () => { calls++; return { rows: [] }; };
  pressure({ max: 6, checked_out: 4, waiting: 0 });
  context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent');
  await flush();
  assert.equal(calls, 0);
  assert.equal(context.getDiagnosticCacheStatus().deferred, true);
  assert.equal(context.getDiagnosticCacheStatus().checkedAt, null);
  pressure({ max: 6, checked_out: 0, waiting: 0 });
  advance(15001);
  context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent');
  await flush();
  assert.equal(calls, 1);
  const checkedAt = context.getDiagnosticCacheStatus().checkedAt;
  advance(61000);
  const failed = async () => { calls++; throw new Error('database unavailable'); };
  context.getCachedFleetAlertQuery('diagnostics', failed, 60000, 'urgent');
  await flush();
  assert.equal(context.getDiagnosticCacheStatus().checkedAt, checkedAt);
  assert.equal(context.getDiagnosticCacheStatus().refreshFailed, true);
  context.getCachedFleetAlertQuery('diagnostics', failed, 60000, 'urgent');
  await flush();
  assert.equal(calls, 2, 'failed refresh backs off instead of retrying each poll');
  advance(61000);
  context.getCachedFleetAlertQuery('diagnostics', load, 60000, 'urgent');
  await flush();
  assert.equal(context.getDiagnosticCacheStatus().refreshFailed, false);
});

test('fast queue returns a guest message while its diagnostic query is still pending', async () => {
  const routes = new Map();
  const router = {};
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (url, handler) => routes.set(`${method}:${url}`, handler);
  }
  let finishDiagnostic;
  let diagnosticCalls = 0;
  const db = { query: async sql => {
    if (sql.includes('SELECT DISTINCT ON (s.service_name)') && sql.includes('first_seen')) {
      diagnosticCalls++;
      return new Promise(resolve => { finishDiagnostic = resolve; });
    }
    if (sql.includes('FROM messages') && sql.includes('LIMIT $1')) return { rows: [{
      id: 1, message_type: 'guest_message', status: 'unread',
      subject: 'Olive has sent you a message about your Geneva', guest_message: 'Hello',
    }] };
    return { rows: [] };
  } };
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} },
    console: { log() {}, warn() {}, error: (...args) => assert.fail(args.join(' ')) },
    require: name => {
      if (name === 'express') return { Router: () => router };
      if (name === '../db') return db;
      if (name.endsWith('/bankingReconciliationNotice')) return { onBankingReconciliationNoticeChanged() {} };
      if (name.endsWith('/tripUpdateEvents')) return { onTripUpdated() {} };
      if (name.endsWith('/bridgeAlertSettings')) return { getBridgeAlertSettings: async () => ({ enabled: false }) };
      if (name.endsWith('/returnMessageReminder')) return { getReturnMessageReminders: async () => [] };
      if (name.endsWith('/bookingMessageReminder')) return { getBookingMessageReminders: async () => [] };
      if (name.endsWith('/reimbursementStatus')) return require('../services/reimbursementStatus');
      return {};
    },
  });
  vm.runInContext(source, context);
  let payload;
  const response = { locals: {}, setHeader() {}, json: value => { payload = value; },
    status: () => response };
  await routes.get('get:/')({ query: { fast: '1', debug: '1', limit: '25' } }, response);
  assert.ok(payload.items.some(item => item.id === 1));
  await flush();
  assert.equal(diagnosticCalls, 1);
  assert.equal(payload.diagnostics.checkedAt, null);
  assert.equal(payload.diagnostics.refreshing, true);
  finishDiagnostic({ rows: [] });
  await flush();
});
