const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { createResourceCollector, unavailable, round } = require('./resources');
const { createDatabaseDiagnostics } = require('./databaseDiagnostics');

function config(env = process.env) {
  const num = (key, fallback, min, max) => {
    const value = Number(env[key]);
    return env[key] != null && env[key] !== '' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  return { enabled: env.INFRA_ENABLED !== 'false', intervalMs: num('INFRA_SAMPLE_INTERVAL_MS', 30000, 1000, 3600000),
    sustain: Math.floor(num('INFRA_PRESSURE_SAMPLES', 3, 1, 100)), cooldownMs: num('INFRA_PRESSURE_LOG_INTERVAL_MS', 300000, 1000, 86400000),
    cpuPct: num('INFRA_CPU_PRESSURE_PCT', 90, 1, 100), memoryPct: num('INFRA_MEMORY_AVAILABLE_PCT', 10, 0, 100),
    diskPct: num('INFRA_DISK_USED_PCT', 90, 1, 100), loopMs: num('INFRA_EVENT_LOOP_P95_MS', 100, 1, 60000),
    swapRate: num('INFRA_SWAP_PAGES_PER_SECOND', 5, 0, 1000000),
    slowMs: num('INFRA_METRICS_SLOW_MS', 2000, 1, 3600000),
    dbEnabled: env.INFRA_DB_ACTIVITY_ENABLED !== 'false',
    dbTimeoutMs: num('INFRA_DB_TIMEOUT_MS', 750, 50, 2000), dbIntervalMs: num('INFRA_DB_INTERVAL_MS', 60000, 1000, 3600000) };
}
function pressureValues(snapshot, cfg) {
  const values = {};
  function above(key, value, threshold) { if (Number.isFinite(value)) values[key] = { pressure: value >= threshold, value, threshold }; }
  above('host.cpu.utilization_pct', snapshot.host?.cpu?.utilization_pct, cfg.cpuPct);
  const cgroupScope = snapshot.container?.scope || 'container';
  above(`${cgroupScope}.cgroup.cpu.utilization_capacity_pct`, snapshot.container?.cpu?.utilization_capacity_pct, cfg.cpuPct);
  above('process.cpu.utilization_capacity_pct', snapshot.process?.cpu?.utilization_capacity_pct, cfg.cpuPct);
  const host = snapshot.host?.memory;
  if (host?.total_bytes > 0 && host.available_bytes != null) above('host.memory.used_pct', 100 * (1 - host.available_bytes / host.total_bytes), 100 - cfg.memoryPct);
  const container = snapshot.container?.memory;
  if (container?.limit_bytes > 0 && container.headroom_bytes != null) above(`${cgroupScope}.cgroup.memory.charged_pct`, 100 * (1 - container.headroom_bytes / container.limit_bytes), 100 - cfg.memoryPct);
  above('process.event_loop.p95_ms', snapshot.process?.event_loop?.p95_ms, cfg.loopMs);
  above('host.swap.in_pages_per_second', snapshot.host?.swap?.swap_in_pages_per_second, cfg.swapRate);
  above('host.swap.out_pages_per_second', snapshot.host?.swap?.swap_out_pages_per_second, cfg.swapRate);
  for (const disk of snapshot.disks || []) above(`${disk.scope}.disk.${disk.path}.used_pct`, disk.used_pct, cfg.diskPct);
  return values;
}
function createPressureTracker(cfg, emit) {
  const states = new Map();
  return (snapshot, now) => {
    const values = pressureValues(snapshot, cfg);
    for (const [key, value] of Object.entries(values)) {
      const state = states.get(key) || { high: 0, low: 0, active: false, lastLog: null };
      if (value.pressure) {
        state.low = 0;
        state.high++;
        if (state.high >= cfg.sustain && (!state.active || now - state.lastLog >= cfg.cooldownMs)) {
          state.active = true;
          state.lastLog = now;
          emit('warn', 'resource pressure', { resource: key, value: round(value.value), threshold: value.threshold,
            consecutive_samples: state.high, snapshot_timestamp: snapshot.timestamp });
        }
      } else {
        state.high = 0;
        state.low++;
        if (state.active && state.low >= cfg.sustain) {
          emit('info', 'resource recovery', { resource: key, value: round(value.value), threshold: value.threshold,
            consecutive_samples: state.low, snapshot_timestamp: snapshot.timestamp });
          state.active = false;
        }
      }
      states.set(key, state);
    }
    // Missing samples break sustained streaks without inventing a recovery.
    for (const [key, state] of states) if (!Object.hasOwn(values, key)) { state.high = 0; state.low = 0; }
  };
}
function createInfraDiagnostics({ env = process.env, now = Date.now, monotonic = () => performance.now(),
  collect = createResourceCollector({ env }), logger = console,
  setTimer = setInterval, clearTimer = clearInterval, createMonitor = monitorEventLoopDelay,
  identity = { instance: os.hostname(), pid: process.pid, process_start_id: randomUUID() } } = {}) {
  const cfg = config(env);
  let timer = null;
  let started = false;
  let collecting = false;
  let generation = 0;
  let latest = null;
  let poolStats;
  let dbActivity;
  let monitor;
  let loopStart;
  let lastErrorAt = null;
  const emit = (level, event, fields) => {
    try { logger[level](`[infra] ${event} ${JSON.stringify({ identity, ...fields })}`); }
    catch { /* Diagnostics must not fail business requests or recursively log. */ }
  };
  const getPool = () => {
    try { return poolStats ? poolStats() : unavailable('database pool not attached'); }
    catch { return unavailable('database pool statistics inaccessible'); }
  };
  const trackPressure = createPressureTracker(cfg, emit);
  function context() {
    return { identity, resources: latest ? { timestamp: latest.timestamp, age_ms: Math.max(0, now() - Date.parse(latest.timestamp)), snapshot: latest }
      : { available: false, reason: cfg.enabled ? 'first resource snapshot not ready' : 'resource sampler disabled' },
      pool: { scope: 'process', ...getPool() },
      postgres: dbActivity ? dbActivity.context() : { scope: 'database', ...unavailable(cfg.dbEnabled ? 'diagnostics not started' : 'Postgres activity diagnostics disabled') } };
  }
  function triggerDatabase(reason) { if (dbActivity) void dbActivity.request(reason).catch(() => {}); }
  async function sample() {
    if (!started || collecting) return;
    collecting = true;
    const currentGeneration = generation;
    try {
      const end = monotonic();
      const eventLoop = monitor ? { available: Number.isFinite(monitor.mean), window_ms: round(end - loopStart), units: 'milliseconds',
        mean_ms: round(monitor.mean / 1e6), p95_ms: Number.isFinite(monitor.mean) ? round(monitor.percentile(95) / 1e6) : null,
        max_ms: Number.isFinite(monitor.mean) ? round(monitor.max / 1e6) : null,
        resolution_ms: 20, reason: Number.isFinite(monitor.mean) ? null : 'baseline window' } : unavailable('event-loop monitoring unsupported');
      if (monitor) monitor.reset();
      loopStart = end;
      const snapshot = await collect(eventLoop);
      if (!started || currentGeneration !== generation) return;
      latest = { ...snapshot, pool: { scope: 'process', ...getPool() } };
      emit('info', 'resource snapshot', { snapshot: latest, postgres: dbActivity?.context() || unavailable('Postgres diagnostics disabled or not attached') });
      trackPressure(latest, now());
      triggerDatabase('resource_sample');
    } catch {
      if (started && currentGeneration === generation && (lastErrorAt == null || now() - lastErrorAt >= cfg.cooldownMs)) {
        lastErrorAt = now();
        emit('warn', 'collection unavailable', { reason: 'resource collector failed; previous snapshot retained' });
      }
    } finally { collecting = false; }
  }
  function start({ db, getPoolStats } = {}) {
    if (started || !cfg.enabled) return;
    started = true;
    generation++;
    poolStats = getPoolStats;
    if (cfg.dbEnabled && db && getPoolStats) {
      if (dbActivity) dbActivity.resume();
      else dbActivity = createDatabaseDiagnostics({ db, stats: getPool,
        now, timeoutMs: cfg.dbTimeoutMs, intervalMs: cfg.dbIntervalMs });
    }
    try { monitor = createMonitor({ resolution: 20 }); monitor.enable(); } catch { monitor = null; }
    loopStart = monotonic();
    timer = setTimer(() => void sample(), cfg.intervalMs);
    timer.unref?.();
    void sample();
  }
  function stop() {
    started = false;
    generation++;
    if (timer != null) clearTimer(timer);
    timer = null;
    monitor?.disable();
    monitor = null;
    dbActivity?.stop();
  }
  return { start, stop, sample, context, triggerDatabase, cfg, emit };
}
const diagnostics = createInfraDiagnostics();
module.exports = { ...diagnostics, createInfraDiagnostics, createPressureTracker, pressureValues, config };
