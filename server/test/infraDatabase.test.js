const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabaseDiagnostics, ACTIVITY_SQL } = require('../services/infra/databaseDiagnostics');
const spare = () => ({ total: 4, idle: 3, checked_out: 1, waiting: 0, max: 6 });
test('activity diagnostics skip exhausted pools without acquiring and rate limit attempts', async () => {
  let now = 0;
  let stats = { ...spare(), idle: 0, checked_out: 5 };
  let calls = 0;
  const diag = createDatabaseDiagnostics({ db: { connect: async () => { calls++; throw new Error(); } }, stats: () => stats, now: () => now });
  await diag.request('pressure');
  assert.equal(calls, 0);
  assert.equal(diag.context().last_attempt.status, 'skipped');
  stats = spare();
  await diag.request('pressure');
  assert.equal(calls, 0);
  now += 60000;
  await diag.request('pressure');
  assert.equal(calls, 1);
  assert.equal(diag.context().available, false);
});
test('activity runs once in flight with deadlines, bounded sanitized output, and session-local timeouts', async () => {
  let finish;
  let calls = 0;
  let released = false;
  const statements = [];
  const client = { query: async query => {
    statements.push(query);
    assert.ok(query.query_timeout <= 750 && query.query_timeout > 0);
    if (query.text === ACTIVITY_SQL) return new Promise(resolve => { finish = () => resolve({ rows: [{
      sessions: 20, active_sessions: 12, idle_in_transaction_sessions: 1, lock_wait_sessions: 2,
      full_visibility: false, visibility_limited_sessions: 3,
      activity: Array.from({ length: 20 }, () => ({ pid: 1, state: 'active', wait_event_type: 'Lock', query_id: '123', query: 'SECRET',
        blockers: [2, 3, 4, 5, 6, 7, 8] })),
    }] }); });
    return { rows: [] };
  }, release: error => { assert.equal(error, undefined); released = true; } };
  const diag = createDatabaseDiagnostics({ db: { connect: async () => { calls++; return client; } }, stats: spare });
  const pending = diag.request('slow_metrics_request');
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await diag.request('pool_pressure');
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(released, true);
  assert.equal(statements[0].text, 'BEGIN READ ONLY');
  assert.ok(statements.some(q => q.text.includes('SET LOCAL statement_timeout')));
  const snapshot = diag.context();
  assert.equal(snapshot.activity.length, 10);
  assert.equal(snapshot.activity[0].blocking_pids.length, 5);
  assert.match(snapshot.visibility, /partial/);
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
  assert.doesNotMatch(ACTIVITY_SQL, /\bquery\s*[,\n]/i);
  diag.stop();
  await diag.request('pressure');
  assert.equal(calls, 1);
});
test('diagnostic timeout destroys its connection without logging error details or leaking a transaction', async () => {
  let destroyed;
  const diag = createDatabaseDiagnostics({ stats: spare, db: { connect: async () => ({
    query: async ({ text }) => {
      if (text === ACTIVITY_SQL) throw Object.assign(new Error('SECRET connection string'), { code: '57014' });
      return { rows: [] };
    }, release: error => { destroyed = error; },
  }) } });
  await diag.request('pressure');
  assert.ok(destroyed);
  assert.equal(diag.context().code, '57014');
  assert.match(diag.context().reason, /timed out/);
  assert.doesNotMatch(JSON.stringify(diag.context()), /SECRET/);
});

test('a late diagnostic acquisition is discarded and cannot overlap another attempt', async () => {
  let time = 0;
  let connectCalls = 0;
  let resolveAcquire;
  let released = false;
  const diag = createDatabaseDiagnostics({ db: { connect: () => {
    connectCalls++;
    return new Promise(resolve => { resolveAcquire = resolve; });
  } }, stats: spare, timeoutMs: 10, intervalMs: 20, now: () => time });
  const pending = diag.request('pressure');
  await new Promise(resolve => setTimeout(resolve, 25));
  await pending;
  assert.equal(diag.context().available, false);
  time += 100;
  await diag.request('pressure');
  assert.equal(connectCalls, 1, 'late pending checkout must retain the in-flight guard');
  resolveAcquire({ release: error => { assert.ok(error); released = true; }, query: () => assert.fail('must not query a late connection') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, true);
  diag.stop();
});

test('permission failures are explicit and never exposed as zero sessions', async () => {
  const diag = createDatabaseDiagnostics({ stats: spare, db: { connect: async () => ({
    query: async () => { throw Object.assign(new Error('SECRET'), { code: '42501' }); }, release() {},
  }) } });
  await diag.request('pressure');
  assert.equal(diag.context().available, false);
  assert.match(diag.context().reason, /permission/);
  assert.equal(diag.context().active_sessions, undefined);
});

test('unknown pool capacity never starts database diagnostics', async () => {
  const diag = createDatabaseDiagnostics({ stats: () => ({ available: false }), db: { connect: () => assert.fail() } });
  await diag.request('pressure');
  assert.equal(diag.context().last_attempt.status, 'skipped');
});
