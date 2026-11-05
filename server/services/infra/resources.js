const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { performance } = require('node:perf_hooks');

const unavailable = reason => ({ available: false, reason });
const round = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
const number = text => text != null && String(text).trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
const pairs = text => Object.fromEntries(String(text || '').trim().split('\n').map(line => line.trim().split(/\s+/)).filter(p => p.length >= 2).map(([key, value]) => [key.replace(/:$/, ''), number(value)]));
function delta(current, previous, windowMs, scale = 1) {
  return current != null && previous != null && windowMs > 0 && current >= previous
    ? round((current - previous) * scale / windowMs) : null;
}
function parseCpu(text) {
  const match = String(text || '').match(/^cpu\s+(.+)$/m);
  if (!match) return null;
  const values = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (values.length < 4 || values.some(n => !Number.isFinite(n))) return null;
  return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3], iowait: values[4] ?? null, steal: values[7] ?? null };
}
function cpuDelta(current, previous) {
  if (!current || !previous || current.total <= previous.total || ['idle', 'iowait', 'steal'].some(key => current[key] != null && previous[key] != null && current[key] < previous[key])) return unavailable('baseline or counters reset');
  const total = current.total - previous.total;
  const wait = current.iowait != null && previous.iowait != null ? current.iowait - previous.iowait : null;
  const steal = current.steal != null && previous.steal != null ? current.steal - previous.steal : null;
  return { available: true, utilization_pct: round(100 * (1 - (current.idle - previous.idle + (wait ?? 0)) / total)),
    iowait_pct: wait == null ? null : round(100 * wait / total), steal_pct: steal == null ? null : round(100 * steal / total),
    ...(wait == null || steal == null ? { counters_reason: 'iowait/steal not exposed by proc counters; utilization excludes only exposed idle counters' } : {}) };
}
function parseCpuSet(text) {
  if (!text?.trim()) return null;
  let count = 0;
  for (const part of text.trim().split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(part)) return null;
    const [start, end = start] = part.split('-').map(Number);
    if (end < start) return null;
    count += end - start + 1;
  }
  return count || null;
}
function minPositive(values) {
  const valid = values.filter(n => Number.isFinite(n) && n > 0);
  return valid.length ? Math.min(...valid) : null;
}
// Resolve membership against the mount's root, including private cgroup namespaces.
function discoverCgroups(membership, mounts) {
  const entries = String(membership || '').trim().split('\n').map(line => {
    const match = line.match(/^(\d+):([^:]*):(.*)$/);
    return match && { controllers: match[2].split(','), member: match[3] };
  }).filter(Boolean);
  const result = {};
  const decode = text => text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  for (const line of String(mounts || '').split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' ');
    const [type, , options = ''] = right.split(' ');
    if (!['cgroup', 'cgroup2'].includes(type)) continue;
    const root = decode(fields[3]);
    const mount = decode(fields[4]);
    for (const entry of entries) {
      const controllers = type === 'cgroup2' ? ['v2'] : options.split(',').filter(c => entry.controllers.includes(c));
      if (type === 'cgroup2' && entry.controllers[0] !== '') continue;
      if (!controllers.length) continue;
      const relative = root === '/' ? entry.member.slice(1) : entry.member === '/' ? ''
        : entry.member === root ? '' : entry.member.startsWith(`${root}/`) ? entry.member.slice(root.length + 1) : null;
      if (relative == null) continue;
      const dir = path.posix.resolve(mount, relative);
      if (dir !== mount && !dir.startsWith(`${mount}/`)) continue;
      for (const controller of controllers) result[controller] = { dir, mount };
    }
  }
  return result;
}
async function readSmall(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) return null;
    return buffer.toString('utf8', 0, bytesRead);
  } catch { return null; }
  finally { if (handle) await handle.close().catch(() => {}); }
}
async function ancestors(location, file, read) {
  if (!location) return [];
  const values = [];
  let dir = location.dir;
  for (let i = 0; i < 32; i++) {
    values.push(await read(path.posix.join(dir, file)));
    if (dir === location.mount) break;
    const parent = path.posix.dirname(dir);
    if (parent === dir || (parent !== location.mount && !parent.startsWith(`${location.mount}/`))) break;
    dir = parent;
  }
  return values;
}
async function collectCgroup(locations, read = readSmall) {
  const v2 = locations.v2;
  const cpu = v2 || locations.cpu;
  const memory = v2 || locations.memory;
  const at = (loc, file) => loc ? read(path.posix.join(loc.dir, file)) : Promise.resolve(null);
  const quotaTexts = await ancestors(cpu, v2 ? 'cpu.max' : 'cpu.cfs_quota_us', read);
  const quotaValues = v2 ? quotaTexts.map(text => {
    const [quota, period] = String(text || '').trim().split(/\s+/);
    return quota !== 'max' && number(quota) > 0 && number(period) > 0 ? number(quota) / number(period) : null;
  }) : await (async () => {
    const periods = await ancestors(cpu, 'cpu.cfs_period_us', read);
    return quotaTexts.map((q, i) => number(q) > 0 && number(periods[i]) > 0 ? number(q) / number(periods[i]) : null);
  })();
  const cpusets = await ancestors(v2 || locations.cpuset, v2 ? 'cpuset.cpus.effective' : 'cpuset.cpus', read);
  const limits = await ancestors(memory, v2 ? 'memory.max' : 'memory.limit_in_bytes', read);
  const cpuStatText = await at(cpu, 'cpu.stat');
  const cpuStat = pairs(cpuStatText);
  const cpuUsageText = v2 ? cpuStatText : await at(locations.cpuacct, 'cpuacct.usage');
  const usage = v2 ? cpuStat.usage_usec ?? null : number(cpuUsageText) == null ? null : number(cpuUsageText) / 1000;
  const memoryText = await at(memory, v2 ? 'memory.current' : 'memory.usage_in_bytes');
  const swapText = await at(memory, v2 ? 'memory.swap.current' : 'memory.memsw.usage_in_bytes');
  const swapLimitText = await at(memory, v2 ? 'memory.swap.max' : 'memory.memsw.limit_in_bytes');
  const memoryLimit = minPositive(limits.map(number).filter(n => n != null && n < 2 ** 60));
  const ancestorUsages = await ancestors(memory, v2 ? 'memory.current' : 'memory.usage_in_bytes', read);
  const headrooms = limits.map((limit, index) => {
    const max = number(limit);
    const used = number(ancestorUsages[index]);
    return max != null && max > 0 && max < 2 ** 60 && used != null ? Math.max(0, max - used) : null;
  }).filter(n => n != null);
  const memoryUsed = number(memoryText);
  const swap = number(swapText);
  const swapLimit = number(swapLimitText) != null && number(swapLimitText) < 2 ** 60 ? number(swapLimitText) : null;
  const memoryEvents = await at(memory, v2 ? 'memory.events' : 'memory.failcnt');
  return { scope: 'container', available: Boolean(v2 || cpu || memory), version: v2 ? 2 : Object.keys(locations).length ? 1 : null,
    visibility: 'visible cgroup hierarchy only; limits of hidden ancestors and sibling containers are unavailable',
    cpu: { available: usage != null, limits_readable: quotaTexts.some(text => text != null), quota_cores: minPositive(quotaValues), cpuset_cores: minPositive(cpusets.map(parseCpuSet)),
      usage_usec: usage, throttled_usec: v2 ? cpuStat.throttled_usec ?? null : cpuStat.throttled_time == null ? null : cpuStat.throttled_time / 1000,
      limits_reason: cpu ? 'null quota means unlimited or unreadable in visible hierarchy' : 'CPU cgroup not accessible' },
    memory: memoryText == null ? unavailable('memory cgroup not accessible') : {
      available: true, used_bytes: memoryUsed, limit_bytes: memoryLimit,
      headroom_bytes: headrooms.length ? Math.min(...headrooms) : null,
      headroom_note: 'minimum limit minus charged usage across visible ancestors; not reclaim-adjusted MemAvailable',
      limit_reason: memoryLimit == null ? 'unlimited or unreadable in visible hierarchy' : null,
      events: memoryEvents == null ? unavailable('cgroup memory event counters inaccessible') : { available: true, counters: v2 ? pairs(memoryEvents) : { fail_count: number(memoryEvents) } },
    },
    swap: swap == null ? unavailable('cgroup swap accounting not accessible') : {
      available: true, used_bytes: v2 ? swap : memoryUsed == null ? null : Math.max(0, swap - memoryUsed),
      limit_bytes: v2 ? swapLimit : swapLimit != null && memoryLimit != null ? Math.max(0, swapLimit - memoryLimit) : null,
      note: v2 ? 'swap-only cgroup accounting; null limit is unlimited or unreadable' : 'memsw minus memory; null limit is unreadable',
    } };
}
function createResourceCollector({ read = readSmall, statfs = fs.statfs, system = os, proc = process, heap = v8.getHeapStatistics,
  monotonic = () => performance.now(), now = () => Date.now(), env = process.env } = {}) {
  let previous = null;
  let discovery;
  async function discover() {
    const [membership, mounts, docker, podman] = await Promise.all([
      read('/proc/self/cgroup'), read('/proc/self/mountinfo'), read('/.dockerenv'), read('/run/.containerenv'),
    ]);
    const locations = discoverCgroups(membership, mounts);
    const container = docker != null || podman != null || /docker|kubepods|containerd|libpod|lxc/.test(membership || '');
    return { container: Boolean(container), locations };
  }
  return async function collect(eventLoop = unavailable('event-loop monitor not running')) {
    discovery ||= await discover();
    const [stat, memText, vmText, cgroup] = await Promise.all([
      read('/proc/stat'), read('/proc/meminfo'), read('/proc/vmstat'), collectCgroup(discovery.locations, read),
    ]);
    const started = monotonic();
    const cpu = parseCpu(stat);
    const mem = pairs(memText);
    const vm = pairs(vmText);
    const processCpu = proc.cpuUsage();
    const rss = proc.memoryUsage();
    const hostCpus = system.cpus().length || null;
    const affinityCores = typeof system.availableParallelism === 'function' ? system.availableParallelism() : hostCpus;
    const effectiveCores = discovery.container && !cgroup.cpu.limits_readable ? null
      : minPositive([hostCpus, affinityCores, cgroup.cpu.quota_cores, cgroup.cpu.cpuset_cores]);
    const cgroupScope = discovery.container ? 'container' : 'process';
    const windowMs = previous ? started - previous.time : null;
    const usageUsec = processCpu.user + processCpu.system;
    const processPct = delta(usageUsec, previous?.processUsec, windowMs, 0.1);
    const containerPct = delta(cgroup.cpu.usage_usec, previous?.cgroupUsec, windowMs, 0.1);
    const diskPaths = [...new Set((env.INFRA_DISK_PATHS || proc.cwd()).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 4);
    if (env.INFRA_DB_DISK_PATH && !diskPaths.includes(env.INFRA_DB_DISK_PATH)) diskPaths.push(env.INFRA_DB_DISK_PATH);
    const disks = [];
    for (const diskPath of diskPaths) {
      const scope = discovery.container ? 'container' : 'host';
      try {
        const disk = await statfs(diskPath);
        const total = Number(disk.blocks) * Number(disk.bsize);
        const free = Number(disk.bfree) * Number(disk.bsize);
        const available = Number(disk.bavail) * Number(disk.bsize);
        disks.push({ scope, path: diskPath, available: total > 0, total_bytes: total || null, available_bytes: Number.isFinite(available) ? available : null,
          used_pct: total > 0 ? round(100 * (total - free) / total) : null,
          note: 'space of filesystem visible at this path; overlay/shared backing store is not a container disk quota' });
      } catch { disks.push({ scope, path: diskPath, ...unavailable('filesystem inaccessible or statfs unsupported') }); }
    }
    const sample = { timestamp: new Date(now()).toISOString(), window_ms: round(windowMs),
      execution: { container_detected: discovery.container, platform: proc.platform },
      host: { scope: 'host', visibility: discovery.container ? 'proc-visible host totals; not container capacity' : 'local host',
        cpu: { scope: 'host', cpu_count: hostCpus, ...(cpu ? cpuDelta(cpu, previous?.cpu) : unavailable('Linux /proc/stat inaccessible')),
          load_average_1_5_15: proc.platform === 'win32' ? unavailable('load averages unsupported') : system.loadavg() },
        memory: { scope: 'host', ...(memText == null ? unavailable('Linux /proc/meminfo inaccessible') : {
          available: mem.MemTotal != null && mem.MemAvailable != null, total_bytes: mem.MemTotal == null ? null : mem.MemTotal * 1024,
          available_bytes: mem.MemAvailable == null ? null : mem.MemAvailable * 1024,
          ...(mem.MemAvailable == null ? { reason: 'MemAvailable not exposed' } : {}),
        }) },
        swap: { scope: 'host', ...(mem.SwapTotal == null || mem.SwapFree == null ? unavailable('host swap counters inaccessible') : {
          available: true, total_bytes: mem.SwapTotal * 1024, used_bytes: (mem.SwapTotal - mem.SwapFree) * 1024 }),
          swap_in_pages_per_second: delta(vm.pswpin, previous?.swapIn, windowMs, 1000),
          swap_out_pages_per_second: delta(vm.pswpout, previous?.swapOut, windowMs, 1000),
          rate_reason: vm.pswpin == null || vm.pswpout == null || !previous || vm.pswpin < previous.swapIn || vm.pswpout < previous.swapOut ? 'counters inaccessible, reset, or baseline window' : null },
      },
      container: { ...cgroup, scope: cgroupScope, container_detected: discovery.container,
        cpu: { ...cgroup.cpu, scope: cgroupScope, effective_capacity_cores: effectiveCores,
        utilization_one_core_pct: containerPct, utilization_capacity_pct: containerPct != null && effectiveCores ? round(containerPct / effectiveCores) : null,
        throttled_ms: delta(cgroup.cpu.throttled_usec, previous?.throttledUsec, 1, 0.001),
        rate_reason: containerPct == null ? 'CPU usage inaccessible or baseline window' : null },
        memory: { scope: cgroupScope, ...cgroup.memory }, swap: { scope: cgroupScope, ...cgroup.swap } },
      process: { scope: 'process', cpu: { scope: 'process', utilization_one_core_pct: processPct,
        utilization_capacity_pct: processPct != null && effectiveCores ? round(processPct / effectiveCores) : null,
        effective_capacity_cores: effectiveCores, reason: processPct == null ? 'baseline window' : null },
        memory: { scope: 'process', rss_bytes: rss.rss, heap_used_bytes: rss.heapUsed, heap_limit_bytes: heap().heap_size_limit },
        event_loop: { scope: 'process', ...eventLoop } },
      disks, database_storage: { scope: discovery.container ? 'container' : 'host', ...(env.INFRA_DB_DISK_PATH
        ? { available: disks.some(d => d.path === env.INFRA_DB_DISK_PATH && d.available), path: env.INFRA_DB_DISK_PATH,
          note: 'operator-specified path; storage identity is not independently verified' }
        : unavailable('Postgres storage is not verified in the application namespace; no local path configured')) },
      disk_latency: { scope: 'host', ...unavailable('no reliable device/volume latency attribution from application namespace; I/O-wait is not disk latency') },
    };
    previous = { time: started, cpu, processUsec: usageUsec, cgroupUsec: cgroup.cpu.usage_usec,
      throttledUsec: cgroup.cpu.throttled_usec, swapIn: vm.pswpin, swapOut: vm.pswpout };
    return sample;
  };
}
module.exports = { createResourceCollector, collectCgroup, discoverCgroups, parseCpu, cpuDelta, parseCpuSet, delta, unavailable, round };
