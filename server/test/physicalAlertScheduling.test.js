const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { reconcileBookingAlerts } = require('../services/physicalAlerts/bookingAlertReconciler');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Bat Signal heartbeat does not check trips; changes and five-minute fallback do', async () => {
  const timers = new Map();
  const listeners = new Set();
  const checks = [];
  let starts = 0;
  const context = vm.createContext({ module: { exports: {} }, console,
    setInterval: (fn, ms) => { const handle = { fn, ms, unref() {} }; timers.set(handle, handle); return handle; },
    clearInterval: handle => timers.delete(handle),
    require: name => name === './bookingAlertReconciler' ? { reconcileBookingAlerts: async (_, options) => { checks.push(options.reason); } }
      : name === '../trips/tripUpdateEvents' ? { onTripUpdated: listener => { listeners.add(listener); return () => listeners.delete(listener); } } : {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/physicalAlerts/runtime.js'), 'utf8'), context);
  const runtime = context.module.exports;
  const current = {
    config: { defaultDeviceId: 'bedroom', heartbeatIntervalMs: 30000, mqtt: { enabled: true } },
    repository: { ensureSchema: async () => {}, registerDevice: async () => {}, listDevices: async () => [] },
    transport: { start: () => { starts++; } },
    healthService: { computeHealth: async () => ({ health: 'ready' }) },
  };
  await Promise.all([runtime.startPhysicalAlertRuntime(current), runtime.startPhysicalAlertRuntime(current)]);
  assert.equal(starts, 1);
  assert.equal(timers.size, 2);
  assert.equal(listeners.size, 1);
  assert.deepEqual(checks, ['startup']);
  const heartbeat = [...timers.values()].find(t => t.ms === 30000);
  const fallback = [...timers.values()].find(t => t.ms === 300000);
  assert.ok(heartbeat); assert.ok(fallback);
  heartbeat.fn(); await flush();
  assert.deepEqual(checks, ['startup']);
  fallback.fn(); await flush();
  for (const listener of listeners) listener();
  await flush();
  assert.deepEqual(checks, ['startup', 'fallback', 'trip_changed']);
  runtime.stopPhysicalAlertRuntime(current);
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('trip checks serialize work and recheck changes arriving while a read is pending', async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  let release;
  const current = {
    config: { defaultDeviceId: 'bedroom', businessTimeZone: 'America/Chicago' },
    repository: {
      listUnconfirmedTrips: async () => {
        calls++; peak = Math.max(peak, ++active);
        if (calls === 1) await new Promise(resolve => { release = resolve; });
        active--; return [];
      },
      getBookingAlertSettings: async () => ({}), listAlerts: async () => [],
    },
    alertService: { publishDeviceState: async () => {} },
  };
  const first = reconcileBookingAlerts(current);
  const second = reconcileBookingAlerts(current);
  const third = reconcileBookingAlerts(current);
  assert.equal(first, second);
  assert.equal(second, third);
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2, 'coalesces pending events into one follow-up pass');
  assert.equal(peak, 1);
});

test('trip check failures release their guard and allow retry', async () => {
  let fail = true;
  const current = { config: {}, repository: {
    listUnconfirmedTrips: async () => { if (fail) throw new Error('database unavailable'); return []; },
    getBookingAlertSettings: async () => ({}), listAlerts: async () => [],
  }, alertService: { publishDeviceState: async () => {} } };
  await assert.rejects(reconcileBookingAlerts(current), /database unavailable/);
  fail = false;
  assert.equal((await reconcileBookingAlerts(current)).unconfirmedTrips, 0);
});

test('unchanged trip checks are quiet, including replacing one booking with another at the same count', async () => {
  const lines = [];
  const context = vm.createContext({ module: { exports: {} }, console: { log: line => lines.push(line) },
    require: name => name === './bookingRule' ? { createCriticalBookingRule: () => async () => null }
      : { isBookingAlertEligible: () => false },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/physicalAlerts/bookingAlertReconciler.js'), 'utf8'), context);
  const check = context.module.exports.reconcileBookingAlerts;
  let trips = [];
  const current = { config: {}, repository: {
    listUnconfirmedTrips: async () => trips, getBookingAlertSettings: async () => ({}), listAlerts: async () => [],
  }, alertService: { publishDeviceState: async () => {} } };
  await check(current); await check(current);
  assert.equal(lines.length, 1, 'initial state is logged once');
  trips = [{ id: 1 }]; await check(current); await check(current);
  assert.equal(lines.length, 2);
  trips = [{ id: 2 }]; await check(current);
  assert.equal(lines.length, 3, 'a different trip is a change even if the count matches');
  assert.ok(lines.every(line => line.includes('Bat Signal checked for new trips')));
});
