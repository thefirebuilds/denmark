const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { DateTime } = require('luxon');
const { getRuntimeSecret } = require('../../config/runtimeSecrets');
const MiB = 1024 ** 2, GiB = 1024 ** 3;
const failure = code => Object.assign(new Error(code), { backupCode: code });
const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const MESSAGES = {
  low_disk: 'Not enough free disk space to safely create a replacement backup.',
  size_limit: 'The backup exceeded its disk-space or configured size limit.',
  disk_unavailable: 'Available backup disk space could not be measured safely.',
  dump_failed: 'PostgreSQL backup generation failed. Check database connectivity and installed PostgreSQL client tools.',
  archive_invalid: 'The new backup failed its archive catalog check.',
  timed_out: 'Backup generation or validation exceeded its time limit.',
  canceled: 'Backup stopped during application shutdown.',
  storage_failed: 'Backup storage or metadata could not be read or written.',
  database_unavailable: 'The database connection was unavailable for this backup job.',
};

function lastWeeklySlot(now) {
  const local = DateTime.fromJSDate(new Date(now), { zone: 'America/Chicago' });
  let slot = local.startOf('week').plus({ days: 6 }).set({ hour: 3 });
  if (slot > local) slot = slot.minus({ weeks: 1 });
  return slot.toUTC().toISO();
}
function backupDue(manifest, now) {
  return !manifest || !Number.isFinite(new Date(manifest.created_at).getTime()) || new Date(manifest.created_at) < new Date(lastWeeklySlot(now));
}
function requiredSpace(databaseBytes, previousBytes = 0) {
  return Math.ceil(Math.max(128 * MiB, Number(databaseBytes) * 1.2, Number(previousBytes) * 1.5));
}
async function freeSpace(dir) {
  try {
    const stat = await fs.promises.statfs(dir), bytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(bytes) || bytes < 0) throw Error('invalid space');
    return bytes;
  }
  catch { throw failure('disk_unavailable'); }
}
function pgEnvironment() {
  return { ...process.env,
    PGHOST: getRuntimeSecret('PGHOST', 'localhost'), PGPORT: getRuntimeSecret('PGPORT', '5432'),
    PGDATABASE: getRuntimeSecret('PGDATABASE', 'denmark'), PGUSER: getRuntimeSecret('PGUSER', 'postgres'),
    PGPASSWORD: getRuntimeSecret('PGPASSWORD'), PGCONNECT_TIMEOUT: '10',
  };
}

function launch(command, args, signal, spawnImpl = spawn) {
  const child = spawnImpl(command, args, { env: pgEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Provider/tool stderr can contain connection details. Drain but never log it.
  child.stderr.resume();
  let killTimer, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); killTimer.unref?.();
  };
  signal.addEventListener('abort', stop, { once: true });
  const done = new Promise((resolve, reject) => {
    child.once('error', () => reject(failure('dump_failed')));
    child.once('close', code => code === 0 && !signal.aborted ? resolve() : reject(failure(signal.aborted ? 'canceled' : 'dump_failed')));
  }).finally(() => { signal.removeEventListener('abort', stop); clearTimeout(killTimer); });
  if (signal.aborted) stop();
  return { child, done, stop };
}

async function dumpToFile({ file, maxBytes, reserveBytes, signal, disk = freeSpace, spawnImpl = spawn }) {
  const proc = launch('pg_dump', ['--format=custom', '--compress=gzip:1', '--no-owner', '--no-privileges', '--no-password', '--lock-wait-timeout=5s'], signal, spawnImpl);
  const hash = createHash('sha256'); let bytes = 0, checked = 0;
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(failure('size_limit'));
    hash.update(chunk);
    if (bytes - checked < 16 * MiB) return callback(null, chunk);
    checked = bytes;
    disk(path.dirname(file)).then(free => callback(!Number.isFinite(free) ? failure('disk_unavailable') : free < reserveBytes ? failure('low_disk') : null, chunk), callback);
  } });
  let active = true, checking = false;
  const watcher = setInterval(() => {
    if (checking || !active) return;
    checking = true;
    disk(path.dirname(file)).then(free => {
      if (active && (!Number.isFinite(free) || free < reserveBytes)) {
        guard.destroy(failure(Number.isFinite(free) ? 'low_disk' : 'disk_unavailable')); proc.stop();
      }
    }, () => { if (active) { guard.destroy(failure('disk_unavailable')); proc.stop(); } }).finally(() => { checking = false; });
  }, 5000);
  watcher.unref?.();
  const copy = pipeline(proc.child.stdout, guard, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal })
    .catch(error => { proc.stop(); throw error; });
  const results = await Promise.allSettled([copy, proc.done]);
  active = false; clearInterval(watcher);
  const rejected = results.find(r => r.status === 'rejected');
  if (rejected) throw rejected.reason;
  return { bytes, sha256: hash.digest('hex') };
}
async function checkArchive(file, signal) {
  const proc = launch('pg_restore', ['--list', file], signal);
  proc.child.stdout.resume();
  try { await proc.done; } catch { throw failure(signal.aborted ? 'canceled' : 'archive_invalid'); }
}

function createWeeklyBackupService({ pool, directory = process.env.DATABASE_BACKUP_DIR || path.resolve(__dirname, '../../../backups'),
  now = () => new Date(), disk = freeSpace, dump = dumpToFile, validate = checkArchive, logger = console,
  reserveBytes = positive(process.env.DATABASE_BACKUP_RESERVE_BYTES, GiB),
  maxBytes = positive(process.env.DATABASE_BACKUP_MAX_BYTES, 2 * GiB),
  timeoutMs = positive(process.env.DATABASE_BACKUP_TIMEOUT_MS, 30 * 60000) } = {}) {
  const root = path.resolve(directory), pointer = path.join(root, 'weekly-current.json'), statusPath = path.join(root, 'weekly-status.json');
  const lockPath = path.join(root, 'weekly.lock');
  const owned = /^denmark-weekly-[0-9a-f-]{36}\.dump(?:\.partial)?$/;
  let running = false, manualJob = null, manualController = null;
  async function readJson(file) {
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw failure('storage_failed'); }
  }
  async function atomicJson(file, value) {
    const temp = `${file}.partial`;
    await fs.promises.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await fs.promises.rename(temp, file);
  }
  async function latest() {
    const manifest = await readJson(pointer);
    if (!manifest) return null;
    if (!owned.test(manifest.filename) || manifest.filename !== `denmark-weekly-${manifest.id}.dump` || !/^[0-9a-f-]{36}$/.test(manifest.id) ||
        !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 5 || !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
        !Number.isFinite(new Date(manifest.created_at).getTime())) throw failure('storage_failed');
    const file = path.join(root, manifest.filename);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.bytes) throw failure('storage_failed');
    return { ...manifest, file };
  }
  async function clean(keep) {
    for (const name of await fs.promises.readdir(root)) {
      if (owned.test(name) && name !== keep) {
        const file = path.join(root, name), stat = await fs.promises.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink()) await fs.promises.unlink(file);
      }
    }
  }
  async function notify(manifest, status) {
    let problem = status?.error_code ? MESSAGES[status.error_code] || MESSAGES.storage_failed : '';
    if (problem && Number.isFinite(status.free_bytes)) problem += ` Free space: ${(status.free_bytes / MiB).toFixed(0)} MiB; reserved: ${(reserveBytes / MiB).toFixed(0)} MiB.`;
    const subject = manifest ? `Database backup ready (${(manifest.bytes / MiB).toFixed(1)} MiB)` : 'Database backup needs attention';
    const body = manifest ? `Database backup created ${DateTime.fromISO(manifest.created_at).setZone('America/Chicago').toFormat('MMM d, yyyy h:mm a ZZZZ')}. Size ${(manifest.bytes / MiB).toFixed(1)} MiB. SHA-256: ${manifest.sha256}. Download and move it to your personal storage. Only the latest successful copy is retained.${problem ? ` Latest backup job needs attention: ${problem} The saved backup is still available.` : ''}`
      : `Database backup could not be created. ${problem} The weekly job will retry later, or you can retry from Settings.`;
    await pool.query(`INSERT INTO messages(message_id,subject,status,mailbox,from_header,message_timestamp,text_body,normalized_text_body,guest_message,message_type)
      VALUES ('system:weekly-database-backup',$1,'unread','system','Denmark automation',$2,$3,$3,$3,$4)
      ON CONFLICT (message_id) DO UPDATE SET subject=EXCLUDED.subject,status='unread',message_timestamp=EXCLUDED.message_timestamp,
        text_body=EXCLUDED.text_body,normalized_text_body=EXCLUDED.normalized_text_body,guest_message=EXCLUDED.guest_message,message_type=EXCLUDED.message_type
      WHERE messages.guest_message IS DISTINCT FROM EXCLUDED.guest_message
        OR messages.message_timestamp IS DISTINCT FROM EXCLUDED.message_timestamp`,
    [subject, status?.last_attempt_at || manifest?.created_at || now().toISOString(), body, manifest ? 'database_backup_ready' : 'database_backup_failed']);
  }

  async function tick({ signal, force = false } = {}) {
    if (running || signal?.aborted || (!force && process.env.DATABASE_WEEKLY_BACKUP_ENABLED === 'false')) return { skipped: true };
    running = true;
    let lock, heartbeat, partial, finalFile, published = false, manifest, status, space, databaseBytes;
    const lockToken = randomUUID();
    try {
      await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.promises.chmod(root, 0o700);
      try { lock = await fs.promises.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = await fs.promises.lstat(lockPath);
        if (!stat.isFile() || now().getTime() - stat.mtimeMs <= timeoutMs + 5 * 60000) return { skipped: true, reason: 'locked' };
        await fs.promises.unlink(lockPath);
        lock = await fs.promises.open(lockPath, 'wx', 0o600);
      }
      await lock.writeFile(lockToken);
      heartbeat = setInterval(() => { const at = new Date(); void lock.utimes(at, at).catch(() => {}); }, 60000);
      heartbeat.unref?.();
      manifest = await latest(); status = await readJson(statusPath);
      // Also repairs a missed queue notification after a prior DB outage.
      if (manifest || status?.error_code) await notify(manifest, status);
      await clean(manifest?.filename);
      if (!force && !backupDue(manifest, now())) return { skipped: true, reason: 'not_due' };
      if (!force && status?.next_retry_at && now() < new Date(status.next_retry_at)) return { skipped: true, reason: 'retry_later' };
      space = await disk(root);
      if (!Number.isFinite(space) || space < 0) throw failure('disk_unavailable');
      const size = await pool.query('SELECT pg_database_size(current_database())::text AS bytes');
      databaseBytes = Number(size.rows[0]?.bytes);
      if (!Number.isFinite(databaseBytes) || databaseBytes <= 0) throw failure('storage_failed');
      if (space - reserveBytes < requiredSpace(databaseBytes, manifest?.bytes)) throw failure('low_disk');
      const id = randomUUID(), filename = `denmark-weekly-${id}.dump`;
      finalFile = path.join(root, filename); partial = `${finalFile}.partial`;
      const started = now();
      const deadline = AbortSignal.timeout(timeoutMs);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let result;
      try {
        result = await dump({ file: partial, maxBytes: Math.min(maxBytes, space - reserveBytes), reserveBytes, signal: bounded, disk });
        const stat = await fs.promises.stat(partial);
        if (stat.size <= 5 || stat.size !== result.bytes) throw failure('archive_invalid');
        await validate(partial, bounded);
        if (bounded.aborted) throw failure('canceled');
      } catch (error) {
        if (signal?.aborted) throw failure('canceled');
        if (deadline.aborted) throw failure('timed_out');
        throw error;
      }
      await fs.promises.rename(partial, finalFile); partial = null;
      const next = { version: 1, id, filename, created_at: now().toISOString(), bytes: result.bytes, sha256: result.sha256,
        database_size_bytes: databaseBytes, free_bytes_before: space, duration_ms: now() - started, trigger: force ? 'manual' : 'weekly' };
      await atomicJson(pointer, next); published = true; manifest = { ...next, file: finalFile };
      await atomicJson(statusPath, { last_attempt_at: next.created_at });
      await clean(filename);
      await notify(manifest, null);
      logger.log('[backup] weekly backup ready', { bytes: next.bytes, database_bytes: databaseBytes, free_bytes_before: space, duration_ms: next.duration_ms });
      return { created: true, bytes: next.bytes };
    } catch (error) {
      if (published) {
        // The archive is already safely published. Retry queue/retention work
        // on the next tick rather than mislabeling it as a failed backup.
        logger.warn('[backup] weekly backup saved; queue or cleanup pending');
        await atomicJson(statusPath, { last_attempt_at: manifest.created_at, repair_pending: true }).catch(() => {});
        return { created: true, repair_pending: true, bytes: manifest.bytes };
      }
      const code = Object.hasOwn(MESSAGES, error?.backupCode) ? error.backupCode
        : ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','53300','57P01'].includes(error?.code) ? 'database_unavailable' : 'storage_failed';
      logger.warn('[backup] weekly backup failed', { reason: code, saved_copy_available: Boolean(manifest),
        free_bytes: Number.isFinite(space) ? space : null, database_bytes: Number.isFinite(databaseBytes) ? databaseBytes : null,
        reserve_bytes: reserveBytes, max_backup_bytes: maxBytes });
      if (!signal?.aborted) {
        status = { last_attempt_at: now().toISOString(), error_code: code, next_retry_at: new Date(now().getTime() + 6 * 3600000).toISOString(),
          free_bytes: Number.isFinite(space) ? space : null };
        await atomicJson(statusPath, status).catch(() => {});
        await notify(manifest, status).catch(() => {});
      }
      return { failed: true, reason: code };
    } finally {
      if (partial) await fs.promises.unlink(partial).catch(() => {});
      if (finalFile && !published) await fs.promises.unlink(finalFile).catch(() => {});
      clearInterval(heartbeat);
      if (lock) {
        await lock.close().catch(() => {});
        if (await fs.promises.readFile(lockPath, 'utf8').catch(() => '') === lockToken) await fs.promises.unlink(lockPath).catch(() => {});
      }
      running = false;
    }
  }
  async function state() {
    const saved = await latest(), status = await readJson(statusPath);
    let locked = false;
    try { const stat = await fs.promises.lstat(lockPath); locked = now().getTime() - stat.mtimeMs <= timeoutMs + 5 * 60000; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { file, ...metadata } = saved || {};
    return { backup: saved ? metadata : null, running: running || locked || ['queued','running'].includes(manualJob?.status),
      manual_job: manualJob ? { ...manualJob } : null,
      last_attempt: status ? { ...status, message: status.error_code ? MESSAGES[status.error_code] || MESSAGES.storage_failed : null } : null };
  }
  function startManual() {
    if (running || ['queued','running'].includes(manualJob?.status)) return { accepted: false };
    const job = { id: randomUUID(), status: 'queued', requested_at: now().toISOString() };
    manualJob = job; manualController = new AbortController();
    const controller = manualController;
    void Promise.resolve().then(async () => {
      job.status = 'running';
      const result = await tick({ force: true, signal: controller.signal });
      job.status = result.created ? 'complete' : result.skipped ? 'busy' : 'failed';
      job.message = result.created ? 'Saved backup ready. Download it here or from Messages.'
        : result.skipped ? 'Another backup job is already running. Wait for it to finish.' : MESSAGES[result.reason] || MESSAGES.storage_failed;
      job.finished_at = now().toISOString();
    }).catch(() => {
      job.status = 'failed'; job.message = MESSAGES.storage_failed; job.finished_at = now().toISOString();
    }).finally(() => { if (manualController === controller) manualController = null; });
    return { accepted: true, job: { ...job } };
  }
  return { tick, latest, state, startManual, stop: () => manualController?.abort() };
}
let instance;
function weeklyBackupService() { return instance ||= createWeeklyBackupService({ pool: require('../../db') }); }
module.exports = { createWeeklyBackupService, weeklyBackupService, backupDue, lastWeeklySlot, requiredSpace, dumpToFile };
