const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInfraDiagnostics, createPressureTracker, config } = require('../services/infra/diagnostics');
const { createMetricsRequestDiagnostics } = require('../app/metricsRequestDiagnostics');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('pressure requires sustained samples, rate limits repeats and reports sustained recovery', () => {
  const events = [];
  const cfg = { ...config({}), sustain: 2, cooldownMs: 1000 };
  const track = createPressureTracker(cfg, (...args) => events.push(args));
  const sample = value => ({ timestamp: '2026-11-05T12:00:00Z', host: { cpu: { utilization_pct: value } } });
  track(sample(95), 0);
  assert.equal(events.length, 0);
  track(sample(95), 30);
  assert.equal(events.length, 1);
  track(sample(95), 60);
  assert.equal(events.length, 1);
  track(sample(95), 1100);
  assert.equal(events.length, 2);
  track(sample(null), 1200);
  assert.equal(events.length, 2, 'unavailable is not recovery');
  track(sample(20), 1300);
  track(sample(20), 1400);
  assert.equal(events[2][1], 'resource recovery');
  track(sample(95), 1500);
  track(sample(null), 1600);
  track(sample(95), 1700);
  assert.equal(events.length, 3, 'unavailable breaks the sustained streak');
});

test('sampler is idempotent, unreferenced, nonoverlapping and suppresses late results on shutdown', async () => {
  let collects = 0;
  let finish;
  let timers = 0;
  let clears = 0;
  let unrefs = 0;
  let disabled = 0;
  let resets = 0;
  const lines = [];
  const infra = createInfraDiagnostics({ env: {}, now: () => 30000, monotonic: () => 30000,
    collect: () => { collects++; return new Promise(resolve => { finish = resolve; }); },
    logger: { info: line => lines.push(line), warn: line => lines.push(line) },
    setTimer: (callback, interval) => { timers++; assert.equal(interval, 30000); return { unref() { unrefs++; } }; },
    clearTimer: () => { clears++; },
    createMonitor: () => ({ enable() {}, disable() { disabled++; }, reset() { resets++; }, mean: 1e6, max: 2e6, percentile: () => 1.5e6 }),
  });
  infra.start(); infra.start();
  assert.equal(timers, 1);
  assert.equal(unrefs, 1);
  await infra.sample();
  assert.equal(collects, 1);
  infra.stop();
  finish({ timestamp: new Date(0).toISOString() });
  await flush();
  assert.equal(lines.length, 0);
  assert.equal(disabled, 1);
  assert.equal(clears, 1);
  assert.equal(resets, 1);
  infra.start();
  finish({ timestamp: new Date(0).toISOString() });
  await flush();
  assert.equal(lines.length, 1);
  assert.equal(infra.context().resources.age_ms, 30000);
  infra.stop();
});

test('event-loop window and units are reported; collector and logger failures stay contained', async () => {
  let time = 1000;
  let fail = false;
  const seen = [];
  const lines = [];
  const infra = createInfraDiagnostics({ env: {}, monotonic: () => time, now: () => time,
    collect: async loop => { if (fail) throw new Error('SECRET'); seen.push(loop); return { timestamp: new Date(time).toISOString() }; },
    logger: { info: line => lines.push(line), warn: line => lines.push(line) },
    setTimer: () => ({ unref() {} }), clearTimer() {},
    createMonitor: () => ({ enable() {}, disable() {}, reset() {}, mean: 2000000, max: 4000000, percentile: () => 3000000 }),
  });
  infra.start(); await flush();
  time += 30000;
  await infra.sample();
  assert.equal(seen[1].window_ms, 30000);
  assert.equal(seen[1].units, 'milliseconds');
  assert.equal(seen[1].p95_ms, 3);
  fail = true;
  await infra.sample(); await infra.sample();
  assert.equal(lines.filter(line => line.includes('collection unavailable')).length, 1);
  assert.doesNotMatch(lines.join(''), /SECRET/);
  assert.equal(infra.context().resources.age_ms, 0);
  infra.stop();
  const brokenLogger = createInfraDiagnostics({ logger: { info() { throw new Error('broken'); } } });
  assert.doesNotThrow(() => brokenLogger.emit('info', 'test', {}));
});

test('disabled sampler never starts timers or monitors', () => {
  const infra = createInfraDiagnostics({ env: { INFRA_ENABLED: 'false' },
    collect: () => assert.fail(), setTimer: () => assert.fail(), createMonitor: () => assert.fail() });
  infra.start();
  assert.equal(infra.context().resources.available, false);
});

test('Metrics instrumentation logs failures and aborts once, correlates IDs and strips sensitive URLs', () => {
  let time = 0;
  const logs = [];
  const triggers = [];
  const infra = { cfg: { slowMs: 2000 }, emit: (...args) => logs.push(args), triggerDatabase: reason => triggers.push(reason),
    context: () => ({ resources: { timestamp: '2026-11-05T12:00:00Z', age_ms: 500 } }) };
  const middleware = createMetricsRequestDiagnostics({ infra, now: () => time });
  const req = { method: 'GET', originalUrl: '/api/metrics/vehicles/private-guest/financial-detail?password=SECRET' };
  const res = new EventEmitter();
  res.statusCode = 503; res.writableFinished = true;
  res.setHeader = (name, value) => { assert.equal(name, 'X-Request-ID'); res.requestId = value; };
  middleware(req, res, () => {});
  time = 2500;
  res.emit('finish'); res.emit('close');
  assert.equal(logs.length, 1);
  const event = logs[0][2];
  assert.equal(event.outcome, 'failure');
  assert.equal(event.duration_ms, 2500);
  assert.equal(event.correlation_id, res.requestId);
  assert.equal(event.diagnostics.resources.age_ms, 500);
  assert.equal(triggers.length, 1);
  assert.doesNotMatch(JSON.stringify(event), /private-guest|SECRET|password/);
  const aborted = new EventEmitter();
  aborted.setHeader = () => {};
  middleware({ method: 'GET', url: '/api/metrics/summary' }, aborted, () => {});
  aborted.emit('close');
  assert.equal(logs[1][2].outcome, 'aborted');
  middleware({ url: '/api/server/logs' }, {}, () => {});
  assert.equal(logs.length, 2, 'log viewer requests must not feed themselves');
});

test('structured diagnostics use the existing bounded console buffer and log transport fields', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const sink = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const context = vm.createContext({ module: { exports: {} }, console: sink, require });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/serverLogBuffer.js'), 'utf8'), context);
  context.module.exports.installConsoleLogBuffer();
  context.module.exports.installConsoleLogBuffer();
  for (let i = 0; i < 1100; i++) sink.info(`[infra] resource snapshot ${JSON.stringify({ snapshot: { sample: i } })}`);
  const logs = context.module.exports.getLogEntries({ limit: 2000 });
  assert.equal(logs.length, 1000);
  assert.equal(logs.at(-1).level, 'info');
  assert.ok(logs.at(-1).at);
  assert.match(logs.at(-1).message, /\[infra\] resource snapshot/);
  assert.equal(context.module.exports.getLogEntries({ afterId: logs.at(-2).id }).length, 1);
});

test('real sampler and event-loop monitor do not prevent a child process from exiting', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const modulePath = path.join(__dirname, '../services/infra/diagnostics.js');
  const code = `const { createInfraDiagnostics } = require(${JSON.stringify(modulePath)}); createInfraDiagnostics({ logger: { info() {}, warn() {} } }).start();`;
  const child = spawnSync(process.execPath, ['-e', code], { timeout: 5000, encoding: 'utf8' });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});
