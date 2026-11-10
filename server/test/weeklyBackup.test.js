const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createWeeklyBackupService, backupDue, lastWeeklySlot, requiredSpace, dumpToFile } = require('../services/database/weeklyBackup');
const GiB = 1024 ** 3;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'denmark-weekly-backup-test-'));
  t.after(async () => {
    // Only remove the individual files created in this exact test directory.
    assert.equal(path.dirname(directory), os.tmpdir());
    for (const name of await fs.readdir(directory)) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
  });
  const calls = [], messages = new Map(), logs = [];
  const clock = { value: new Date('2026-11-10T12:00:00Z') };
  let generation = 0;
  const pool = { query: async (sql, args) => {
    calls.push({ sql, args });
    if (sql.includes('pg_database_size')) return { rows: [{ bytes: String(100 * 1024 ** 2) }] };
    if (sql.includes('INSERT INTO messages')) {
      const previous = messages.get('weekly');
      if (!previous || previous.body !== args[2]) messages.set('weekly', { subject: args[0], body: args[2], type: args[3], status: 'unread' });
      assert.match(sql, /WHERE messages.guest_message IS DISTINCT FROM EXCLUDED.guest_message/);
      return { rows: [] };
    }
    throw Error('Unexpected SQL');
  } };
  const dump = async ({ file }) => {
    const data = Buffer.from(`PGDMP-test-generation-${++generation}`);
    await fs.writeFile(file, data);
    return { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  };
  const config = { pool, directory, now: () => clock.value, disk: async () => 10 * GiB, dump, validate: async () => {},
    logger: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args) }, ...options };
  return { config, service: createWeeklyBackupService(config), directory, clock, calls, messages, logs };
}

test('weekly schedule stays at Sunday 3 AM Chicago through DST and survives restarts', () => {
  assert.equal(lastWeeklySlot('2026-11-01T08:59:59Z'), '2026-10-25T08:00:00.000Z');
  assert.equal(lastWeeklySlot('2026-11-01T09:00:00Z'), '2026-11-01T09:00:00.000Z');
  assert.equal(lastWeeklySlot('2027-03-14T08:00:00Z'), '2027-03-14T08:00:00.000Z');
  assert.equal(backupDue(null, '2026-11-10T12:00:00Z'), true);
  assert.equal(backupDue({ created_at: '2026-11-10T12:00:00Z' }, '2026-11-14T12:00:00Z'), false);
  assert.equal(backupDue({ created_at: '2026-11-10T12:00:00Z' }, '2026-11-15T09:00:00Z'), true);
  assert.ok(requiredSpace(GiB, 0) >= 1.2 * GiB);
});

test('first backup queues a download notice, stays read after dismissal, and only one successful copy survives rotation', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.tick()).created, true);
  const old = await f.service.latest();
  assert.equal(f.messages.get('weekly').type, 'database_backup_ready');
  assert.match(f.messages.get('weekly').body, /SHA-256/);
  f.messages.get('weekly').status = 'read';
  assert.equal((await createWeeklyBackupService(f.config).tick()).reason, 'not_due');
  assert.equal(f.messages.get('weekly').status, 'read');
  f.clock.value = new Date('2026-11-15T09:00:00Z');
  assert.equal((await f.service.tick()).created, true);
  const latest = await f.service.latest();
  assert.notEqual(latest.id, old.id);
  assert.equal(f.messages.get('weekly').status, 'unread');
  assert.deepEqual((await fs.readdir(f.directory)).filter(n => n.endsWith('.dump')), [latest.filename]);
  await assert.rejects(fs.stat(old.file), e => e.code === 'ENOENT');
});

test('low disk skips generation, keeps the last copy and queues the failure without secrets', async t => {
  const f = await fixture(t); await f.service.tick();
  const old = await f.service.latest();
  f.clock.value = new Date('2026-11-15T09:00:00Z');
  const limited = createWeeklyBackupService({ ...f.config, disk: async () => GiB + 1024,
    dump: async () => assert.fail('must not run without headroom') });
  assert.equal((await limited.tick()).reason, 'low_disk');
  assert.equal((await limited.latest()).id, old.id);
  assert.match(f.messages.get('weekly').body, /Not enough free disk/);
  assert.equal((await limited.tick()).reason, 'retry_later');
});

test('invalid archive or failed dump never replaces the previous copy and removes partial output', async t => {
  for (const kind of ['dump', 'archive']) {
    const f = await fixture(t); await f.service.tick();
    const old = await f.service.latest(); f.clock.value = new Date('2026-11-15T09:00:00Z');
    const broken = createWeeklyBackupService({ ...f.config,
      dump: kind === 'dump' ? async ({ file }) => { await fs.writeFile(file, 'partial'); throw Error('postgres://SECRET'); } : f.config.dump,
      validate: kind === 'archive' ? async () => { throw Object.assign(Error('SECRET'), { backupCode: 'archive_invalid' }); } : f.config.validate,
    });
    assert.equal((await broken.tick()).failed, true);
    assert.equal((await broken.latest()).id, old.id);
    assert.deepEqual((await fs.readdir(f.directory)).filter(n => n.endsWith('.dump')), [old.filename]);
    assert.equal((await fs.readdir(f.directory)).some(n => n.endsWith('.dump.partial')), false);
    assert.doesNotMatch(JSON.stringify({ messages: [...f.messages.values()], logs: f.logs }), /SECRET/);
  }
});

test('single-process guard, cross-instance file lock and shutdown prevent overlapping backups', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { dump: async ({ signal }) => {
    started(); await new Promise(resolve => { release = resolve; });
    assert.equal(signal.aborted, true);
    throw Object.assign(Error('aborted'), { backupCode: 'canceled' });
  } });
  const controller = new AbortController();
  const pending = f.service.tick({ signal: controller.signal });
  await ready;
  assert.equal((await f.service.tick()).skipped, true);
  assert.equal((await createWeeklyBackupService(f.config).tick()).reason, 'locked');
  controller.abort(); release(); await pending;
  assert.equal(await f.service.latest(), null);
  assert.equal((await fs.readdir(f.directory)).includes('weekly.lock'), false);
});

test('failed first attempt creates an attention message and retries after six hours', async t => {
  const f = await fixture(t, { disk: async () => 0 });
  assert.equal((await f.service.tick()).reason, 'low_disk');
  assert.equal(f.messages.get('weekly').type, 'database_backup_failed');
  const recovered = createWeeklyBackupService({ ...f.config, disk: async () => 10 * GiB });
  assert.equal((await recovered.tick()).reason, 'retry_later');
  f.clock.value = new Date(f.clock.value.getTime() + 6 * 3600000 + 1);
  assert.equal((await recovered.tick()).created, true);
  assert.equal(f.messages.get('weekly').type, 'database_backup_ready');
});

test('an expired crashed-job lock and abandoned partial are cleaned without deleting user files', async t => {
  const f = await fixture(t);
  const lock = path.join(f.directory, 'weekly.lock');
  await fs.writeFile(lock, 'crashed-job');
  const stale = new Date(f.clock.value.getTime() - 3600000);
  await fs.utimes(lock, stale, stale);
  const partial = path.join(f.directory, 'denmark-weekly-11111111-1111-1111-1111-111111111111.dump.partial');
  await fs.writeFile(partial, 'unfinished');
  await fs.writeFile(path.join(f.directory, 'personal-notes.txt'), 'keep');
  assert.equal((await f.service.tick()).created, true);
  assert.equal(await fs.readFile(path.join(f.directory, 'personal-notes.txt'), 'utf8'), 'keep');
  await assert.rejects(fs.stat(partial), e => e.code === 'ENOENT');
});

test('missing queue notification is recreated after restart without generating a new backup', async t => {
  const f = await fixture(t); await f.service.tick();
  const old = await f.service.latest(); f.messages.clear();
  const restarted = createWeeklyBackupService({ ...f.config, dump: async () => assert.fail('already current') });
  await restarted.tick();
  assert.equal((await restarted.latest()).id, old.id);
  assert.equal(f.messages.get('weekly').type, 'database_backup_ready');
});

test('a post-publication queue failure preserves the new backup and repairs the notice without dumping again', async t => {
  const f = await fixture(t), query = f.config.pool.query;
  let fail = true;
  f.config.pool.query = async (...args) => {
    if (fail && args[0].includes('INSERT INTO messages')) { fail = false; throw Error('connection lost'); }
    return query(...args);
  };
  const result = await f.service.tick();
  assert.equal(result.created, true); assert.equal(result.repair_pending, true);
  const old = await f.service.latest();
  const restarted = createWeeklyBackupService({ ...f.config, dump: async () => assert.fail('already published') });
  assert.equal((await restarted.tick()).reason, 'not_due');
  assert.equal((await restarted.latest()).id, old.id);
  assert.equal(f.messages.get('weekly').type, 'database_backup_ready');
  assert.doesNotMatch(f.messages.get('weekly').body, /needs attention|failed/);
});

test('download metadata rejects path traversal and file corruption instead of serving arbitrary files', async t => {
  const f = await fixture(t); await f.service.tick();
  const latest = await f.service.latest();
  await fs.writeFile(latest.file, 'truncated');
  await assert.rejects(f.service.latest());
  const pointer = path.join(f.directory, 'weekly-current.json');
  await fs.writeFile(pointer, JSON.stringify({ ...latest, filename: '../secret.dump' }));
  await assert.rejects(f.service.latest(), e => e.backupCode === 'storage_failed');
});

function mockSpawn(data, captures) {
  return (command, args, options) => {
    captures.push({ command, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    let finished = false;
    const finish = code => { if (finished) return; finished = true; child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit('close', code); };
    child.kill = () => { child.stdout.destroy(); finish(1); return true; };
    setImmediate(() => { if (!finished) { child.stdout.end(data); setImmediate(() => finish(0)); } });
    return child;
  };
}

test('dump streams to disk with checksum, no parallel jobs and a hard byte limit', async t => {
  const f = await fixture(t), captures = [], data = Buffer.from('PGDMP-streamed-data');
  const file = path.join(f.directory, 'stream-test.partial');
  const result = await dumpToFile({ file, maxBytes: 100, reserveBytes: GiB, signal: new AbortController().signal,
    spawnImpl: mockSpawn(data, captures) });
  assert.equal(result.bytes, data.length);
  assert.equal(result.sha256, createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(await fs.readFile(file), data);
  assert.equal(captures[0].command, 'pg_dump');
  assert.ok(captures[0].args.includes('--compress=gzip:1'));
  assert.ok(!captures[0].args.some(a => a.includes('jobs')));
  assert.ok(!captures[0].args.some(a => a.includes('password=')));
  await assert.rejects(dumpToFile({ file: path.join(f.directory, 'too-large.partial'), maxBytes: 8, reserveBytes: GiB,
    signal: new AbortController().signal, spawnImpl: mockSpawn(data, []) }), e => e.backupCode === 'size_limit');
});

async function waitForManual(service) {
  for (let i = 0; i < 400; i++) {
    const state = await service.state();
    if (!['queued','running'].includes(state.manual_job?.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('manual backup did not finish');
}

test('manual backup runs asynchronously even when the weekly copy is current, rejects duplicate starts and rotates to one copy', async t => {
  const f = await fixture(t); await f.service.tick();
  const old = await f.service.latest();
  const start = f.service.startManual();
  assert.equal(start.accepted, true); assert.equal(start.job.status, 'queued');
  assert.equal(f.service.startManual().accepted, false);
  const state = await waitForManual(f.service);
  assert.equal(state.manual_job.status, 'complete');
  assert.notEqual(state.backup.id, old.id);
  assert.equal(state.backup.trigger, 'manual');
  assert.equal('file' in state.backup, false);
  assert.equal(state.running, false);
  assert.equal((await fs.readdir(f.directory)).filter(n => n.endsWith('.dump')).length, 1);
  assert.equal(f.messages.get('weekly').type, 'database_backup_ready');
});

test('manual backup bypasses automated schedule disablement and retry delay but keeps disk safety', async t => {
  const previous = process.env.DATABASE_WEEKLY_BACKUP_ENABLED;
  process.env.DATABASE_WEEKLY_BACKUP_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_WEEKLY_BACKUP_ENABLED; else process.env.DATABASE_WEEKLY_BACKUP_ENABLED = previous; });
  const f = await fixture(t, { disk: async () => 0 });
  assert.equal((await f.service.tick()).skipped, true);
  assert.equal(f.service.startManual().accepted, true);
  const failed = await waitForManual(f.service);
  assert.equal(failed.manual_job.status, 'failed');
  assert.match(failed.manual_job.message, /Not enough free disk/);
  assert.equal(failed.backup, null);
  const recovered = createWeeklyBackupService({ ...f.config, disk: async () => 10 * GiB });
  assert.equal(recovered.startManual().accepted, true);
  assert.equal((await waitForManual(recovered)).manual_job.status, 'complete');
});

test('shutdown cancels an on-demand generation without publishing partial data', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { dump: async ({ signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(Error('canceled'), { backupCode: 'canceled' });
  } });
  f.service.startManual(); await ready; f.service.stop();
  const state = await waitForManual(f.service);
  assert.equal(state.manual_job.status, 'failed');
  assert.match(state.manual_job.message, /shutdown/);
  assert.equal(state.backup, null);
});
