const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollisionMonitor, pollWindow } = require('../services/telemetry/collisionMonitor');
const { fetchDimoEvents } = require('../services/dimo/eventHistory');
const event = { timestamp: '2026-11-07T12:00:00Z', name: 'safety.collision', source: 'device', durationNs: 0, metadata: '{"severity":"unknown","access_token":"SECRET"}' };
const vehicle = { id: 1, nickname: 'Belle', turo_vehicle_id: 123, dimo_token_id: '42' };
const trip = { id: 7, reservation_id: '62331575', trip_start: '2026-11-07T10:00:00Z', trip_end: '2026-11-08T10:00:00Z' };
function fixture({ failQueue = false } = {}) {
  const state = { vehicles: [vehicle], trips: [trip], collisions: new Map(), messages: new Map(), tripEvents: new Map(), cursors: new Map(), deliveries: [], clock: new Date('2026-11-07T13:00:00Z').getTime() };
  const calls = []; let checkedOut = 0, backup;
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    const rows = data => ({ rows: data, rowCount: data.length });
    if (sql === 'BEGIN') { backup = structuredClone(state); return rows([]); }
    if (sql === 'ROLLBACK') { Object.assign(state, backup); return rows([]); }
    if (sql.includes('FROM vehicles v')) return rows(state.vehicles.map(v => ({ ...v, checked_through: state.cursors.get(v.id) })));
    if (sql.includes('FROM trips')) { assert.deepEqual(values, [123, event.timestamp.replace('Z', '.000Z')]); return rows(state.trips); }
    if (sql.includes('INSERT INTO vehicle_collision_events')) {
      const existing = [...state.collisions.values()].find(c => c.event_key === values[2]);
      if (existing) return rows([]);
      const row = { id: state.collisions.size + 1, vehicle_id: values[0], dimo_token_id: values[1], event_key: values[2], observed_at: values[3], source: values[4], raw_event: JSON.parse(values[5]), trip_id: values[6], body: values[7], trip_event_key: values[8], sms_status: 'pending' };
      state.collisions.set(row.id, row); return rows([{ ...row }]);
    }
    if (sql.includes('SELECT * FROM vehicle_collision_events')) return rows([...state.collisions.values()].filter(c => c.event_key === values[1]).map(c => ({ ...c })));
    if (sql.includes('UPDATE vehicle_collision_events SET trip_id')) { const row = state.collisions.get(values[0]); if (!row.trip_id) Object.assign(row, { trip_id: values[1], body: values[2] }); }
    if (sql.includes('INSERT INTO trip_telemetry_events')) state.tripEvents.set(`${values[0]}:${values[2]}`, values);
    if (sql.includes('INSERT INTO messages')) {
      if (failQueue) throw Error('queue write failed');
      if (!state.messages.has(values[0])) state.messages.set(values[0], { status: 'unread', trip_id: values[5], body: values[2] });
    }
    if (sql.includes('UPDATE messages SET trip_id')) { const row = state.messages.get(values[0]); if (!row.trip_id) row.trip_id = values[1]; }
    if (sql.includes('INSERT INTO vehicle_collision_poll_state')) state.cursors.set(values[0], values[2]);
    const ready = c => ['pending','failed','skipped'].includes(c.sms_status) && (!c.retry || c.retry <= state.clock);
    if (sql.includes("SET sms_status='uncertain'")) for (const row of state.collisions.values()) {
      if (row.sms_status === 'sending' && row.attempt < state.clock - 600000) row.sms_status = 'uncertain';
    }
    if (sql.includes('SELECT id FROM vehicle_collision_events')) return rows([...state.collisions.values()].filter(ready).slice(0, 10).map(c => ({ id: c.id })));
    if (sql.includes("SET sms_status='sending'")) {
      const row = state.collisions.get(values[0]); if (!ready(row)) return rows([]);
      row.sms_status = 'sending'; row.attempt = state.clock; return rows([{ ...row }]);
    }
    if (sql.includes('SET sms_status=$2')) Object.assign(state.collisions.get(values[0]), { sms_status: values[1], sid: values[2], retry: state.clock + 900000 });
    if (sql.includes('INSERT INTO fleet_alert_deliveries')) state.deliveries.push(values);
    return rows([]);
  };
  return { state, calls, pool: { query, connect: async () => { checkedOut++; return { query, release() { checkedOut--; } }; } }, held: () => checkedOut,
    now: () => new Date(state.clock), logger: { log() {}, warn() {} } };
}

test('collision lookback overlaps 24 hours and catches up bounded windows after downtime', () => {
  assert.deepEqual(pollWindow(null, '2026-11-07T13:00:00Z'), { from: '2026-11-06T13:00:00.000Z', to: '2026-11-07T13:00:00.000Z' });
  const range = pollWindow('2026-11-01T13:00:00Z', '2026-11-07T13:00:00Z');
  assert.equal(range.to, '2026-11-02T13:00:00.000Z');
  assert.equal(new Date(range.to) - new Date(range.from), 48 * 3600000);
});

test('collision-only DIMO request sends the canonical name filter', async () => {
  await fetchDimoEvents(42, { from: '2026-11-06T13:00:00Z', to: '2026-11-07T13:00:00Z', collisionOnly: true,
    auth: async () => 'test', fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).query, /filter: \{ name: \{ eq: "safety.collision" \} \}/);
      return new Response('{"data":{"events":[]}}');
    } });
});

test('collision creates one unread message, trip event/flag evidence and SMS; repeats/restarts/metadata changes do not resend', async () => {
  const f = fixture(); let sends = 0, current = event;
  const options = { ...f, fetchEvents: async (token, request) => {
    assert.equal(f.held(), 0); assert.equal(token, 42); assert.equal(request.collisionOnly, true); return [current];
  }, sendSms: async (body, options) => {
    assert.equal(f.held(), 0); assert.match(body, /Belle/); assert.match(body, /62331575/);
    assert.doesNotMatch(body, /SECRET/); assert.equal(options.timeoutMs, 15000); sends++; return { ok: true, sid: 'SM1' };
  } };
  const poll = createCollisionMonitor(options);
  assert.equal((await poll()).detected, 1);
  f.state.messages.get('system:collision:1').status = 'read';
  assert.equal((await poll()).detected, 0);
  current = { ...event, metadata: '{"severity":"updated"}' };
  await createCollisionMonitor(options)();
  assert.equal(sends, 1); assert.equal(f.state.collisions.size, 1); assert.equal(f.state.messages.size, 1); assert.equal(f.state.tripEvents.size, 1);
  assert.equal(f.state.messages.get('system:collision:1').status, 'read');
  assert.equal(f.state.messages.get('system:collision:1').trip_id, 7);
  assert.equal(f.state.collisions.get(1).sms_status, 'sent');
  assert.equal(f.state.deliveries.length, 1);
  assert.doesNotMatch(JSON.stringify([...f.state.collisions.values()]), /SECRET/);
});

test('unassigned or overlapping trips still alert without guessing a trip; later exact match attaches safely', async () => {
  for (const matches of [[], [trip, { ...trip, id: 8 }]]) {
    const f = fixture(); f.state.trips = matches;
    const poll = createCollisionMonitor({ ...f, fetchEvents: async () => [event], sendSms: async body => {
      assert.match(body, /No unique matching trip/); return { ok: true, sid: 'SM' };
    } });
    await poll();
    assert.equal(f.state.messages.get('system:collision:1').trip_id, null);
    assert.equal(f.state.tripEvents.size, 0);
    f.state.trips = [trip]; await poll();
    assert.equal(f.state.collisions.get(1).trip_id, 7);
    assert.equal(f.state.tripEvents.size, 1);
  }
});

test('provider failure retains checkpoint; another vehicle still polls; no SMS or empty success is fabricated', async () => {
  const f = fixture(); f.state.vehicles.push({ ...vehicle, id: 2, dimo_token_id: '43' });
  const poll = createCollisionMonitor({ ...f, fetchEvents: async token => { if (token === 42) throw Error('SECRET'); return []; }, sendSms: async () => assert.fail('no event') });
  const result = await poll();
  assert.equal(result.failed, 1); assert.equal(result.vehicles, 1); assert.equal(f.state.cursors.has(1), false); assert.equal(f.state.cursors.has(2), true);
  assert.equal(f.state.messages.size, 0);
});

test('disabled SMS is retried later, definitive failures retry, ambiguous acceptance is never auto-resent', async () => {
  for (const type of ['disabled', 'rejected', 'timeout']) {
    const f = fixture(); let sends = 0;
    const poll = createCollisionMonitor({ ...f, fetchEvents: async () => [event], sendSms: async () => {
      sends++;
      if (sends > 1) return { ok: true, sid: 'SM' };
      if (type === 'disabled') return { skipped: true, reason: 'sms_alerts_disabled' };
      throw Object.assign(Error('SECRET'), type === 'rejected' ? { statusCode: 429 } : {});
    } });
    await poll();
    assert.equal(f.state.collisions.get(1).sms_status, type === 'disabled' ? 'skipped' : type === 'rejected' ? 'failed' : 'uncertain');
    f.state.clock += 900001; await poll();
    assert.equal(sends, type === 'timeout' ? 1 : 2);
    assert.equal(f.state.messages.size, 1);
  }
});

test('overlapping checks and shutdown cancellation do not run extra provider calls or advance checkpoints', async () => {
  const f = fixture(); let release;
  const controller = new AbortController();
  const poll = createCollisionMonitor({ ...f, fetchEvents: () => new Promise(resolve => { release = resolve; }), sendSms: async () => assert.fail('canceled') });
  const first = poll({ signal: controller.signal });
  while (!release) await Promise.resolve();
  assert.equal((await poll()).skipped, true);
  controller.abort(); release([event]); await first;
  assert.equal(f.state.messages.size, 0); assert.equal(f.state.cursors.size, 0);
});

test('a failed queue write rolls back the collision and trip event and retains the checkpoint for retry', async () => {
  const f = fixture({ failQueue: true });
  const result = await createCollisionMonitor({ ...f, fetchEvents: async () => [event], sendSms: async () => assert.fail('uncommitted alert') })();
  assert.equal(result.failed, 1);
  assert.equal(f.state.collisions.size, 0); assert.equal(f.state.tripEvents.size, 0);
  assert.equal(f.state.messages.size, 0); assert.equal(f.state.cursors.size, 0);
  assert.equal(f.held(), 0);
  assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
});

test('concurrent processes share a durable SMS claim and do not send the collision twice', async () => {
  const f = fixture(); let sends = 0;
  const options = { ...f, fetchEvents: async () => [event], sendSms: async () => { sends++; return { ok: true, sid: 'SM1' }; } };
  await Promise.all([createCollisionMonitor(options)(), createCollisionMonitor(options)()]);
  assert.equal(sends, 1); assert.equal(f.state.collisions.size, 1); assert.equal(f.state.messages.size, 1);
});

test('scheduler registers a single 15-minute collision job, respects pressure/settings, and aborts it on stop', async () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const timeouts = [], intervals = [], logs = [], observed = [];
  let enabled = false, pressure = false;
  const timer = (list, fn, ms) => { const t = { fn, ms, unreferenced: false, cleared: false, unref() { this.unreferenced = true; } }; list.push(t); return t; };
  const noop = new Proxy(async () => ({}), { get: () => async () => ({}) });
  const environment = { ...process.env };
  delete environment.DIMO_COLLISION_POLL_ENABLED;
  const context = vm.createContext({ module: { exports: {} }, AbortController, Date, Intl,
    process: { env: environment }, console: { log: value => logs.push(value), warn() {}, error() {} },
    setTimeout: (fn, ms) => timer(timeouts, fn, ms), clearTimeout: t => { t.cleared = true; },
    setInterval: (fn, ms) => timer(intervals, fn, ms), clearInterval: t => { t.cleared = true; },
    require: name => {
      if (name === '../db') return { query: async () => ({ rows: [{ value: { last_run_at: new Date().toISOString() } }] }),
        getPoolStats: () => ({ max: 6, idle: 6, checked_out: 0, waiting: pressure ? 1 : 0 }) };
      if (name === './integrations/integrationSettings') return { isIntegrationEnabled: async () => enabled };
      if (name === './telemetry/collisionMonitor') return { createCollisionMonitor: () => async ({ signal }) => { observed.push(signal); return {}; } };
      return noop;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8') + '\nmodule.exports.checkCollisions = runCollisionCheck;', context);
  const scheduler = context.module.exports;
  scheduler(); scheduler();
  assert.equal(logs.filter(l => l.includes('dimoCollisions interval scheduled')).length, 1);
  await scheduler.checkCollisions(); assert.equal(observed.length, 0);
  enabled = true; pressure = true;
  await scheduler.checkCollisions(); assert.equal(observed.length, 0);
  pressure = false; environment.DIMO_COLLISION_POLL_ENABLED = 'false';
  await scheduler.checkCollisions(); assert.equal(observed.length, 0);
  delete environment.DIMO_COLLISION_POLL_ENABLED;
  await scheduler.checkCollisions(); assert.equal(observed.length, 1);
  const collisionTimer = timeouts.find(t => t.ms === 180000);
  assert.ok(collisionTimer.unreferenced);
  collisionTimer.fn();
  const interval = intervals.find(t => t.ms === 900000);
  assert.ok(interval.unreferenced);
  scheduler.stopScheduler();
  assert.equal(collisionTimer.cleared, true); assert.equal(interval.cleared, true);
  assert.equal(observed[0].aborted, true);
  await new Promise(setImmediate);
});
