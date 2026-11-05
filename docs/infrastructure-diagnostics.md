# Infrastructure diagnostics

Denmark samples resource counters in the backend and emits JSON through its existing console buffer. Open **Settings -> Advanced / Logs**, filter for `[infra]`, `resource pressure`, `[db] pool pressure`, `metrics request`, or a correlation ID. Filter by level to isolate warnings. The log API and its `settings.read` permission are unchanged. The backend retains 1,000 entries; the viewer retains 500, with filters applied to that retained tail. Restarting clears the tail. Docker stdout contains the same events and can retain a longer history according to the deployment's existing log settings. Samples are never written to Postgres.

## Configuration and deployment

No package, privileged container, Docker socket, host filesystem mount, database extension, schema migration, pool resize, or database tuning change is required. Node 22 in the existing image supplies all dependencies. Compose already passes `.env` into the app. Rebuild/publish the image using the existing workflow, then on the droplet:

```sh
docker compose pull app
docker compose up -d app
```

For a locally built deployment, use its existing image build procedure first. Optional variables below belong in the droplet's `.env`; recreate the app container after changing them. Backend startup owns one idempotent sampler, separate from business scheduler jobs. Timers are unreferenced; SIGINT, SIGTERM and process exit stop sampling and disable the event-loop monitor. Existing application shutdown behavior is unchanged.

| Variable | Default | Meaning |
| --- | --- | --- |
| `INFRA_ENABLED` | `true` | `false` disables resource sampling and Postgres activity collection. Metrics request timing still logs. |
| `INFRA_SAMPLE_INTERVAL_MS` | `30000` | Resource interval; bounded to 1,000–3,600,000 ms. First sample establishes a CPU/swap baseline. |
| `INFRA_PRESSURE_SAMPLES` | `3` | Consecutive high samples before pressure; consecutive healthy samples before recovery. Default is about 90 seconds, not a precise elapsed-duration alarm. Missing values break streaks without inventing recovery. |
| `INFRA_PRESSURE_LOG_INTERVAL_MS` | `300000` | Minimum repeat interval per resource while pressure continues; first sustained warning and recovery are immediate. |
| `INFRA_CPU_PRESSURE_PCT` | `90` | Host utilization, effective cgroup utilization, or process utilization threshold. |
| `INFRA_MEMORY_AVAILABLE_PCT` | `10` | Warn when host MemAvailable or finite cgroup charged-memory headroom is at/below this percentage of capacity. |
| `INFRA_DISK_USED_PCT` | `90` | Filesystem used-space threshold. |
| `INFRA_EVENT_LOOP_P95_MS` | `100` | Node event-loop p95 delay threshold in milliseconds. |
| `INFRA_SWAP_PAGES_PER_SECOND` | `5` | Host swap-in or swap-out threshold, pages/second (not bytes/second). |
| `INFRA_METRICS_SLOW_MS` | `2000` | Slow request threshold; all `/api/metrics` outcomes are logged, including auth/database-gate failures, pending reports, and disconnects. |
| `INFRA_DISK_PATHS` | backend working directory | Comma-separated locally visible paths; first four distinct paths only. Optional `/app/server,/app/imports` for Compose. |
| `INFRA_DB_DISK_PATH` | unset | Optional verified local path of database storage; do not point at an unrelated app directory to fill the missing measurement. |
| `INFRA_DB_ACTIVITY_ENABLED` | `true` | `false` disables the optional Postgres activity summary. |
| `INFRA_DB_TIMEOUT_MS` | `750` | Total diagnostic acquisition/query budget; bounded to 50–2,000 ms. Client deadlines and transaction-local server statement/lock timeouts; no global settings change. |
| `INFRA_DB_INTERVAL_MS` | `60000` | Minimum interval between activity attempts, including skipped attempts. |

Existing `PGPOOL_PRESSURE_LOG_INTERVAL_MS` still rate limits `[db] pool pressure` (15 seconds by default). Ordinary resource snapshots log once per sample. Pressure warnings and recoveries have their own sustained thresholds and cooldown. Request logs produce one entry per completed or aborted Metrics request. No logs are emitted for log-viewer requests, preventing feedback loops.

## Scopes and normalization

Every resource group has `scope: host`, `container`, or `process`. Identity contains the container/host hostname, PID and a random process-start ID so reused PIDs and multiple backend instances can be distinguished. Container detection uses Docker/Podman markers and recognizable cgroup memberships; custom runtimes without those indicators cannot be identified reliably. Cgroup mounts and memberships resolve v1/v2 paths, including private namespaces, and visible ancestors are checked for tighter CPU/memory limits. The `container` group can have `scope: process` on a non-container host with systemd cgroup constraints; trust the explicit scope.

* Host CPU utilization uses deltas in the first eight `/proc/stat` counters: `(total - idle - iowait) / total * 100`. Guest counters are not added again. This is normalized across all proc-visible host cores, includes steal as non-idle time, and reports iowait and steal separately. Load averages are host runnable/uninterruptible-task counts, not percentages and not container load. `cpu_count` is the proc-visible OS logical CPU count.
* Process and cgroup CPU usage use elapsed monotonic interval time. `utilization_one_core_pct` is CPU time / wall time: 100% is one fully occupied logical core, 200% is two. `utilization_capacity_pct` divides that by the minimum of visible quota cores, cpuset count, process affinity and host logical cores. A 0.5-core quota running at 50% of one core is at 100% of its visible capacity. These values are not clamped: bursts or a changing quota can exceed 100%. When a container's CPU quota files cannot be read, capacity utilization is null rather than inferred from host capacity. Hidden ancestor limits cannot be discovered; this limitation is explicit. Cgroup CPU usage includes all processes in that cgroup, unlike Node process CPU. `throttled_ms` is a counter delta across the sample window, not disk latency or a normalized CPU percentage.
* Host memory uses `MemTotal` and `MemAvailable`; swap totals/used use `SwapTotal`/`SwapFree`. Host swap rates are deltas of `/proc/vmstat` pswpin/pswpout per second. In an ordinary Docker deployment these can be host-visible counters, so they are labeled host and are **not container availability**. Masked/inaccessible proc files yield unavailable/null values. A measured zero swap total means no swap; inaccessible swap never becomes zero.
* Cgroup memory is charged usage, the tightest visible finite limit, and the minimum `limit - usage` headroom across visible ancestors. This headroom is conservative charged-memory accounting, includes page cache, and is **not Linux MemAvailable**; it can include ancestor sibling usage. Unlimited limits stay null. Swap is cgroup swap-only usage in v2, or memsw minus memory in v1. Swap limit visibility is local, not a claim about host swap capacity. Node reports RSS, heap used and V8 heap limit independently.
* Event-loop delay uses Node `monitorEventLoopDelay` with 20 ms resolution. Each histogram is reset per measurement window; `window_ms` gives that actual window and mean/p95/max are converted from nanoseconds to **milliseconds**. It measures timer scheduling delay, not total request time. First/unavailable windows have nulls rather than misleading zeros.
* Disk space comes from `statfs` at each configured path: available bytes use `bavail`; used percent is `(blocks - bfree) / blocks`. App overlay space may reflect a shared host backing filesystem, **not a container quota**. Database-storage identity must be supplied by the operator; the collector never assumes the app overlay is the Postgres volume. Disk throughput is not collected or equated with latency. Disk latency is explicitly unavailable because there is no reliable device/volume attribution in the application namespace.

On the supplied Compose deployment, Postgres storage is in a named volume attached only to `db`; its free space is **unavailable to the app by default**. Host/sibling container CPU and memory breakdowns, hidden cgroup ancestors, and per-device/database disk latency are also unavailable. Linux host swap counters and CPU iowait/steal are collected only when proc permits them. The implementation has not been run on the live droplet, so logs provide the authoritative accessibility/permission results. No new host mounts or permissions are needed or requested.

## Database context and privacy

Snapshots and slow-request context include the existing pool total, idle, waiting, maximum, checked-out count, active-query count and explicit checked-out-client count. Counters describe **this Node process**, not all Postgres sessions; active tracked queries can include callers waiting for a connection. `[db] pool pressure` keeps its existing name and fields, adding `diagnostics.identity`, `diagnostics.resources` (snapshot timestamp and age), and cached Postgres activity. Pool instrumentation calls the sampler only through cached context; sampler reads use the non-logging stats option to avoid recursion.

Activity is attempted periodically and on pressure/slow-request events, at most once per minute and at most one in flight. It skips unless an existing idle connection is available, no callers are waiting, and at least three pool slots are free before checkout (leaving two for real work). Diagnostic work uses a read-only transaction with local timeouts. Failed/expired work destroys its diagnostic connection instead of queuing cleanup behind a timeout. A late acquisition is discarded and prevents a second diagnostic from starting until it settles. Existing pool settings are untouched. Thus during an actual exhausted-pool incident it is normal to see **a skipped attempt and an older cached activity sample**; check both timestamps/ages. These diagnostics cannot supply a fresh DB view when doing so would consume scarce connections.

Postgres activity covers the current database, excludes the diagnostic backend and non-client backends, counts visible active/idle-in-transaction/lock-wait sessions and records oldest active query/transaction ages. Details are bounded to 10 sessions and 5 blocker PIDs per session. Permission-limited visibility is explicit; hidden session states must not be interpreted as zero activity. PostgreSQL query IDs can be null when `compute_query_id` is disabled, a query has no identifier or permissions hide it. No roles are granted automatically. The existing `postgres` Compose role normally has full visibility, but deployments using a restricted role may not.

Neither the diagnostic SQL nor request timing collects SQL text, bind parameters, guest identity, raw URLs/query strings, usernames, addresses, credentials or connection strings. Local tracked queries now expose an opaque SHA-256-derived `query_id` and statement operation instead of SQL snippets. This local fingerprint and Postgres's native `query_id` are different identifiers and are not joinable. Metrics requests receive a server-generated `X-Request-ID`; AsyncLocalStorage adds that ID to tracked queries started by the request. Background scheduler queries have no request correlation ID.

## Reading an incident

| Pattern in the same measurement window | Interpretation / next evidence |
| --- | --- |
| High host CPU + high Node CPU + high event-loop delay | Node is CPU-bound; inspect which Metrics request/refresh or scheduler job overlaps. |
| High host CPU, low Node CPU, busy active DB sessions, no lock waits | Postgres or another process may be consuming CPU. Database summaries are not per-process CPU attribution; confirm with droplet process/container tools. |
| High capacity CPU and increasing cgroup throttled time | Container CPU quota pressure, even if host-wide CPU is not saturated. |
| High steal | Hypervisor scheduling contention is a candidate; this is separate from app CPU time. |
| Low host available memory or low cgroup headroom, growing RSS, sustained swap in/out | Memory pressure/page churn is a candidate. Swap merely being allocated/used does not establish current pressure; rates matter. Check OOM/high counters in cgroup memory events when exposed. |
| Lock-wait sessions, blocking PIDs, old transactions, idle-in-transaction | Lock contention is a stronger explanation than infrastructure size; trace blocker lifetime. |
| Pool near max, waiting callers, long tracked-query ages, little CPU/memory pressure | Connection demand, long queries/transactions or held clients are candidates. Pool logs cannot by themselves prove insufficient droplet capacity. |
| High iowait, long queries, no lock waits | Storage waits are a candidate; iowait is host CPU accounting, **not measured disk latency**. Obtain device/database latency separately if needed. |
| Slow request with healthy host/Node, but little DB activity | May involve external services, queues or request gates; correlate request ID and scheduler/metrics-refresh timestamps. |

Intervals can miss brief spikes; always compare request duration with `resources.age_ms`, resource `window_ms`, cached DB age and `last_attempt`. A single pressure warning is not a recommendation to resize the droplet.

## Representative logs (illustrative excerpts)

Actual records include the full scoped snapshot; these examples omit most fields for readability and are not measurements of the droplet:

```text
[infra] resource snapshot {"identity":{"instance":"app-container","pid":1,"process_start_id":"example"},"snapshot":{"timestamp":"2026-11-05T20:15:00.000Z","window_ms":30000,"host":{"scope":"host","cpu":{"utilization_pct":96,"iowait_pct":2,"steal_pct":0}},"process":{"scope":"process","cpu":{"utilization_one_core_pct":82,"utilization_capacity_pct":82},"event_loop":{"window_ms":30000,"units":"milliseconds","p95_ms":140}},"pool":{"scope":"process","total":6,"idle":0,"waiting":2,"max":6,"active_queries":7,"checked_out_clients":2}}}
[infra] resource pressure {"identity":{"instance":"app-container","pid":1,"process_start_id":"example"},"resource":"host.cpu.utilization_pct","value":96,"threshold":90,"consecutive_samples":3,"snapshot_timestamp":"2026-11-05T20:15:00.000Z"}
[db] pool pressure {"total":6,"idle":0,"waiting":2,"max":6,"diagnostics":{"resources":{"timestamp":"2026-11-05T20:15:00.000Z","age_ms":1200},"postgres":{"available":true,"age_ms":45000,"lock_wait_sessions":2,"activity":[{"pid":123,"blocking_pids":[122]}],"last_attempt":{"status":"skipped","reason":"no spare idle pool capacity"}}}}
[infra] metrics request {"identity":{"instance":"app-container","pid":1,"process_start_id":"example"},"correlation_id":"example-request","method":"GET","endpoint":"/api/metrics/summary","duration_ms":3400,"status":503,"outcome":"failure","slow":true,"diagnostics":{"resources":{"timestamp":"2026-11-05T20:15:00.000Z","age_ms":1500}}}
[infra] resource recovery {"identity":{"instance":"app-container","pid":1,"process_start_id":"example"},"resource":"host.cpu.utilization_pct","value":25,"threshold":90,"consecutive_samples":3,"snapshot_timestamp":"2026-11-05T20:17:00.000Z"}
```

UTC ISO timestamps are in structured events. The UX renders each log line's timestamp in the viewer's local timezone. Preserve the structured timestamp when comparing with DigitalOcean graphs.

## Bat Signal trip checking

The physical alert device heartbeat stays at 30 seconds. It publishes device health and current alert state without rerunning the booking scan. New/updated booking ingestion, trip-stage changes, manual trip edits, alert-policy changes, startup, and MQTT reconnects trigger immediate trip checks. A separate five-minute fallback catches bookings entering/leaving the configured time window and missed events; a time-only change can therefore take up to five minutes to appear. Configure this with `ALERT_TRIP_CHECK_INTERVAL_MS` (default `300000`, bounded to 60 seconds–one hour), then recreate the app container. No device firmware change is needed.

Trip checks serialize and coalesce concurrent triggers, with a follow-up pass for changes during an active check. Logs say `[physical-alerts] Bat Signal checked for new trips` and include the trigger and counts. The initial state, changed trip/eligibility state, alert changes, and failures are logged; identical successful fallback checks are quiet. Device heartbeat database health/state reads still run every 30 seconds. This removes the full trip check from that cadence, not all heartbeat database access.
