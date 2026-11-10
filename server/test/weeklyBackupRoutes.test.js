const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');

test('weekly backup metadata/download require database admin access and stream the saved file', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'denmark-backup-route-test-'));
  const file = path.join(directory, 'saved.dump'), content = Buffer.from('PGDMP-test-backup-file');
  await fs.promises.writeFile(file, content);
  const sourcePath = path.join(__dirname, '../routes/database.js'), nativeRequire = createRequire(sourcePath);
  let latestCalls = 0, manualCalls = 0, saved = { file, id: 'test', bytes: content.length, sha256: 'a'.repeat(64), created_at: '2026-11-10T12:00:00.000Z' };
  const service = {
    latest: async () => { latestCalls++; return saved; },
    state: async () => { const { file: _file, ...metadata } = saved || {}; return { backup: saved ? metadata : null, running: false }; },
    startManual: () => ({ accepted: ++manualCalls === 1, job: { id: 'manual-test', status: 'queued' } }),
  };
  const context = { module: { exports: {} }, __dirname: path.dirname(sourcePath), Buffer, process, console,
    require: name => {
      if (name === '../services/database/weeklyBackup') return { weeklyBackupService: () => service };
      if (name === '../db') return {};
      if (name.startsWith('../services/') || name === '../dbHealth') return {};
      return nativeRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  const authFile = path.join(__dirname, '../auth/middleware.js'), authRequire = createRequire(authFile);
  const authContext = { module: { exports: {} }, process, console, Buffer,
    require: name => name === './config' ? { isAuthEnforced: () => true }
      : name === './store' ? { createAuthAuditLog: async () => {}, getAuditRequestMeta: () => ({}) } : authRequire(name) };
  vm.runInNewContext(fs.readFileSync(authFile, 'utf8'), authContext);
  const app = express();
  app.use((req, _res, next) => { const role = req.headers['x-test-role']; req.auth = role ? { role, isActive: true } : null; next(); });
  app.use('/api/database', authContext.module.exports.requirePermission('database.admin'), context.module.exports);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.promises.unlink(file); await fs.promises.rmdir(directory); });
  const url = `http://127.0.0.1:${server.address().port}/api/database/backup/weekly`;
  assert.equal((await fetch(`${url}/download`)).status, 401);
  assert.equal((await fetch(`${url}/download`, { headers: { 'x-test-role': 'operator' } })).status, 403);
  assert.equal(latestCalls, 0);
  assert.equal((await fetch(`${url}/run`, { method: 'POST', headers: { 'x-test-role': 'operator' } })).status, 403);
  assert.equal(manualCalls, 0);
  const accepted = await fetch(`${url}/run`, { method: 'POST', headers: { 'x-test-role': 'owner' } });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).job.id, 'manual-test');
  assert.equal((await fetch(`${url}/run`, { method: 'POST', headers: { 'x-test-role': 'owner' } })).status, 409);
  const response = await fetch(`${url}/download`, { headers: { 'x-test-role': 'owner' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-backup-sha256'), 'a'.repeat(64));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
  const metadata = await (await fetch(url, { headers: { 'x-test-role': 'owner' } })).json();
  assert.equal(metadata.backup.bytes, content.length);
  assert.equal('file' in metadata.backup, false);
  saved = null;
  assert.equal((await fetch(`${url}/download`, { headers: { 'x-test-role': 'owner' } })).status, 404);
});

test('scheduler registers one weekly-check timer and cancels it on shutdown while honoring DB pressure', async () => {
  const timers = [], logs = [], seen = []; let pressure = false;
  const noop = new Proxy(async () => ({}), { get: () => async () => ({}) });
  const context = vm.createContext({ module: { exports: {} }, AbortController, Date, Intl, process: { env: { ...process.env } },
    console: { log: value => logs.push(value), warn() {}, error() {} },
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { timer.cleared = true; }, setInterval: () => ({ unref() {} }), clearInterval() {},
    require: name => {
      if (name === '../db') return { query: async () => ({ rows: [{ value: { last_run_at: new Date().toISOString() } }] }),
        getPoolStats: () => ({ max: 6, idle: 6, checked_out: 0, waiting: pressure ? 1 : 0 }) };
      if (name === './database/weeklyBackup') return { weeklyBackupService: () => ({ tick: async ({ signal }) => { seen.push(signal); } }) };
      if (name === './telemetry/collisionMonitor') return { createCollisionMonitor: () => async () => ({}) };
      return noop;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8') + '\nmodule.exports.checkWeekly = runWeeklyBackupCheck;', context);
  const scheduler = context.module.exports;
  scheduler(); scheduler();
  assert.equal(logs.filter(l => l.includes('weeklyDatabaseBackup interval scheduled')).length, 1);
  pressure = true; await scheduler.checkWeekly(); assert.equal(seen.length, 0);
  pressure = false; await scheduler.checkWeekly(); assert.equal(seen.length, 1);
  const timer = timers.find(t => t.ms === 7 * 45000);
  assert.ok(timer);
  scheduler.stopScheduler();
  assert.equal(timer.cleared, true); assert.equal(seen[0].aborted, true);
  await scheduler.checkWeekly(); assert.equal(seen.length, 1);
  await new Promise(setImmediate);
});
