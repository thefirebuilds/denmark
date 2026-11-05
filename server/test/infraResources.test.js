const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCpu, cpuDelta, delta, discoverCgroups, collectCgroup, createResourceCollector } = require('../services/infra/resources');

test('CPU interval deltas exclude idle and iowait, expose steal, and reject absent/reset windows', () => {
  const before = parseCpu('cpu 1000 0 0 1000 0 0 0 0 9999 9999');
  const after = parseCpu('cpu 1100 0 0 1100 50 0 0 50 9999 9999');
  assert.deepEqual(cpuDelta(after, before), { available: true, utilization_pct: 50, iowait_pct: 16.67, steal_pct: 16.67 });
  assert.equal(cpuDelta(before, after).available, false);
  assert.equal(cpuDelta(null, before).available, false);
  assert.equal(delta(15000000, 0, 30000, 0.1), 50);
  assert.equal(delta(1, 10, 1000), null);
  assert.equal(delta(null, 0, 1000), null);
  assert.equal(delta(0, 0, null), null);
});

test('cgroup mounts resolve namespace roots and reject escaping membership', () => {
  const mounts = '1 0 0:1 /docker/abc /sys/fs/cgroup rw - cgroup2 cgroup rw';
  assert.deepEqual(discoverCgroups('0::/', mounts).v2, { dir: '/sys/fs/cgroup', mount: '/sys/fs/cgroup' });
  assert.equal(discoverCgroups('0::/other', mounts).v2, undefined);
  assert.equal(discoverCgroups('0::/../../etc', mounts.replace('/docker/abc', '/')).v2, undefined);
});

test('v2 applies most restrictive visible ancestor quotas, cpusets and memory headroom', async () => {
  const files = {
    '/cg/team/app/cpu.max': '200000 100000', '/cg/team/cpu.max': '50000 100000', '/cg/cpu.max': 'max 100000',
    '/cg/team/app/cpuset.cpus.effective': '0-3', '/cg/team/cpuset.cpus.effective': '0-1',
    '/cg/team/app/cpu.stat': 'usage_usec 900000\nthrottled_usec 1000',
    '/cg/team/app/memory.max': '1000', '/cg/team/memory.max': '800', '/cg/memory.max': 'max',
    '/cg/team/app/memory.current': '300', '/cg/team/memory.current': '700',
    '/cg/team/app/memory.swap.current': '30', '/cg/team/app/memory.swap.max': '100',
  };
  const group = await collectCgroup({ v2: { dir: '/cg/team/app', mount: '/cg' } }, async file => files[file] ?? null);
  assert.equal(group.cpu.quota_cores, 0.5);
  assert.equal(group.cpu.cpuset_cores, 2);
  assert.equal(group.memory.limit_bytes, 800);
  assert.equal(group.memory.headroom_bytes, 100);
  assert.equal(group.swap.used_bytes, 30);
});

test('v1 normalizes nanosecond CPU usage and separates memory from memsw', async () => {
  const locations = discoverCgroups('2:cpu,cpuacct:/docker/a\n3:memory:/docker/a',
    '1 0 0:1 / /cg/cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 / /cg/memory rw - cgroup cgroup rw,memory');
  const files = {
    '/cg/cpu/docker/a/cpu.cfs_quota_us': '100000', '/cg/cpu/docker/a/cpu.cfs_period_us': '100000',
    '/cg/cpu/docker/a/cpuacct.usage': '2000000000', '/cg/cpu/docker/a/cpu.stat': 'throttled_time 1000000',
    '/cg/memory/docker/a/memory.limit_in_bytes': '1000', '/cg/memory/docker/a/memory.usage_in_bytes': '400',
    '/cg/memory/docker/a/memory.memsw.usage_in_bytes': '500', '/cg/memory/docker/a/memory.memsw.limit_in_bytes': '2000',
  };
  const group = await collectCgroup(locations, async file => files[file] ?? null);
  assert.equal(group.version, 1);
  assert.equal(group.cpu.quota_cores, 1);
  assert.equal(group.cpu.usage_usec, 2000000);
  assert.equal(group.cpu.throttled_usec, 1000);
  assert.equal(group.swap.used_bytes, 100);
  assert.equal(group.swap.limit_bytes, 1000);
});

function fixture(overrides = {}) {
  let time = 0;
  const files = {
    '/.dockerenv': '', '/proc/self/cgroup': '0::/', '/proc/self/mountinfo': '1 0 0:1 / /cg rw - cgroup2 cgroup rw',
    '/proc/stat': 'cpu 1000 0 0 1000 0 0 0 0',
    '/proc/meminfo': 'MemTotal: 524288 kB\nMemAvailable: 102400 kB\nSwapTotal: 1048576 kB\nSwapFree: 921600 kB',
    '/proc/vmstat': 'pswpin 10\npswpout 20',
    '/cg/cpu.max': '50000 100000', '/cg/cpu.stat': 'usage_usec 0\nthrottled_usec 0',
    '/cg/memory.max': '67108864', '/cg/memory.current': '33554432',
  };
  const collect = createResourceCollector({ read: async file => files[file] ?? null,
    statfs: async () => ({ blocks: 100, bfree: 30, bavail: 20, bsize: 1024 }),
    system: { cpus: () => [{}], loadavg: () => [1, 2, 3], availableParallelism: () => 1 },
    proc: { platform: 'linux', cwd: () => '/app', cpuUsage: () => ({ user: time * 500, system: 0 }), memoryUsage: () => ({ rss: 10, heapUsed: 5 }) },
    heap: () => ({ heap_size_limit: 20 }), now: () => time, monotonic: () => time, env: {}, ...overrides });
  return { collect, files, advance: ms => { time += ms; } };
}

test('resource snapshots keep host totals separate from fractional container capacity and process CPU', async () => {
  const f = fixture();
  const first = await f.collect();
  assert.equal(first.process.cpu.utilization_one_core_pct, null);
  assert.equal(first.host.memory.total_bytes, 512 * 1024 * 1024);
  assert.equal(first.container.memory.limit_bytes, 64 * 1024 * 1024);
  f.advance(30000);
  f.files['/cg/cpu.stat'] = 'usage_usec 15000000\nthrottled_usec 2000000';
  f.files['/proc/stat'] = 'cpu 1100 0 0 1100 50 0 0 50';
  f.files['/proc/vmstat'] = 'pswpin 70\npswpout 110';
  const next = await f.collect();
  assert.equal(next.window_ms, 30000);
  assert.equal(next.process.cpu.utilization_one_core_pct, 50);
  assert.equal(next.process.cpu.utilization_capacity_pct, 100);
  assert.equal(next.container.cpu.utilization_capacity_pct, 100);
  assert.equal(next.container.cpu.throttled_ms, 2000);
  assert.equal(next.host.swap.swap_in_pages_per_second, 2);
  assert.equal(next.host.swap.swap_out_pages_per_second, 3);
  assert.equal(next.disks[0].available_bytes, 20480);
  assert.equal(next.disks[0].used_pct, 70);
  assert.equal(next.disks[0].scope, 'container');
  assert.equal(next.database_storage.available, false);
  assert.equal(next.disk_latency.available, false);
});

test('inaccessible counters and filesystems remain unavailable, never zero capacity', async () => {
  const f = fixture({ read: async file => file === '/.dockerenv' ? '' : null,
    statfs: async () => { throw new Error('permission denied with sensitive detail'); } });
  const snapshot = await f.collect();
  assert.equal(snapshot.execution.container_detected, true);
  assert.equal(snapshot.host.cpu.available, false);
  assert.equal(snapshot.host.memory.available, false);
  assert.equal(snapshot.host.swap.available, false);
  assert.equal(snapshot.container.cpu.effective_capacity_cores, null);
  assert.equal(snapshot.container.memory.available, false);
  assert.equal(snapshot.disks[0].available, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive detail/);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});
