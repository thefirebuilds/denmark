// No query text, parameters, client addresses, usernames or application names.
const ACTIVITY_SQL = `WITH sessions AS MATERIALIZED (
  SELECT pid, state, wait_event_type, query_start, xact_start, query_id,
    ARRAY(SELECT blocker FROM unnest(pg_blocking_pids(pid)) blocker LIMIT 5) AS blockers
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
), summary AS (
  SELECT COUNT(*)::int AS sessions,
    COUNT(*) FILTER (WHERE state = 'active')::int AS active_sessions,
    COUNT(*) FILTER (WHERE state LIKE 'idle in transaction%')::int AS idle_in_transaction_sessions,
    COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::int AS lock_wait_sessions,
    COUNT(*) FILTER (WHERE state IS NULL)::int AS visibility_limited_sessions,
    MAX(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000) FILTER (WHERE state = 'active') AS oldest_active_query_ms,
    MAX(EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000) AS oldest_transaction_ms
  FROM sessions
)
SELECT summary.*,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS full_visibility,
  COALESCE((SELECT json_agg(detail) FROM (
    SELECT pid, state, wait_event_type, query_id::text AS query_id,
      CASE WHEN query_start IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::bigint END AS query_age_ms,
      CASE WHEN xact_start IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000)::bigint END AS transaction_age_ms,
      blockers
    FROM sessions WHERE state = 'active' OR state LIKE 'idle in transaction%'
    ORDER BY (wait_event_type = 'Lock') DESC NULLS LAST, xact_start ASC NULLS LAST, query_start ASC NULLS LAST
    LIMIT 10
  ) detail), '[]'::json) AS activity
FROM summary`;

function createDatabaseDiagnostics({ db, stats, now = Date.now, timeoutMs = 750, intervalMs = 60000 } = {}) {
  let inFlight = false;
  let stopped = false;
  let lastAttempt = null;
  let latest = { scope: 'database', available: false, reason: 'not sampled yet' };
  let lastOutcome = null;
  async function request(reason) {
    if (stopped || inFlight || (lastAttempt != null && now() - lastAttempt < intervalMs)) return;
    lastAttempt = now();
    const pool = stats();
    // Use a genuinely idle connection and preserve two slots for real work.
    if (!pool || !['idle', 'waiting', 'max', 'checked_out'].every(key => Number.isFinite(pool[key])) ||
      pool.idle < 1 || pool.waiting > 0 || pool.max - pool.checked_out < 3) {
      lastOutcome = { timestamp: new Date(now()).toISOString(), status: 'skipped', reason: 'no spare idle pool capacity' };
      return;
    }
    inFlight = true;
    let client;
    let transaction = false;
    let destroy;
    let acquisition;
    let acquisitionExpired = false;
    let acquireTimer;
    const deadline = now() + timeoutMs;
    try {
      acquisition = db.connect();
      client = await Promise.race([acquisition, new Promise((_, reject) => {
        acquireTimer = setTimeout(() => {
          acquisitionExpired = true;
          reject(new Error('diagnostic acquisition timed out'));
        }, timeoutMs);
        acquireTimer.unref?.();
      })]);
      clearTimeout(acquireTimer);
      if (stopped) return;
      const query = text => {
        const remaining = Math.floor(deadline - now());
        if (remaining < 1 || stopped) throw new Error('diagnostic deadline expired or stopped');
        return client.query({ text, query_timeout: remaining });
      };
      await query('BEGIN READ ONLY');
      transaction = true;
      // Server cancellation bounds execution too; client timeouts alone do not.
      await query(`SET LOCAL statement_timeout = '${Math.floor(timeoutMs)}ms'`);
      await query(`SET LOCAL lock_timeout = '${Math.floor(timeoutMs)}ms'`);
      const { rows } = await query(ACTIVITY_SQL);
      await query('COMMIT');
      transaction = false;
      const row = rows[0];
      if (!row) throw new Error('empty diagnostic result');
      const numeric = value => value == null || !Number.isFinite(Number(value)) ? null : Math.max(0, Number(value));
      const count = key => numeric(row[key]);
      latest = { scope: 'database', available: true, timestamp: new Date(now()).toISOString(), trigger: reason,
        visibility: row.full_visibility ? 'all sessions in current database' : 'partial: other roles may hide session state, ages, wait events and query identifiers',
        counts_cover: 'visible session states only; hidden states are counted separately',
        visibility_limited_sessions: count('visibility_limited_sessions'),
        sessions: count('sessions'), active_sessions: count('active_sessions'), idle_in_transaction_sessions: count('idle_in_transaction_sessions'),
        lock_wait_sessions: count('lock_wait_sessions'), oldest_active_query_ms: count('oldest_active_query_ms'), oldest_transaction_ms: count('oldest_transaction_ms'),
        activity: (Array.isArray(row.activity) ? row.activity : []).slice(0, 10).map(session => ({
          pid: numeric(session.pid), state: ['active', 'idle in transaction', 'idle in transaction (aborted)'].includes(session.state) ? session.state : 'unknown',
          wait_event_type: ['Activity', 'BufferPin', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'Timeout'].includes(session.wait_event_type) ? session.wait_event_type : null,
          query_id: /^-?\d+$/.test(String(session.query_id)) ? String(session.query_id) : null,
          query_age_ms: numeric(session.query_age_ms), transaction_age_ms: numeric(session.transaction_age_ms),
          blocking_pids: (Array.isArray(session.blockers) ? session.blockers : []).slice(0, 5).map(numeric).filter(n => n != null),
        })),
        bounds: { sessions: 10, blockers_per_session: 5 },
        query_id_note: 'null when compute_query_id is disabled, no identifier exists, or permissions hide it; SQL text is never selected',
      };
      lastOutcome = { timestamp: latest.timestamp, status: 'sampled' };
    } catch (error) {
      // Error messages can contain SQL or connection details; log only safe codes.
      destroy = error;
      latest = { scope: 'database', available: false, timestamp: new Date(now()).toISOString(),
        reason: error.code === '42501' ? 'insufficient permission to read Postgres activity' : error.code === '57014' ? 'diagnostic statement timed out' : 'diagnostic failed or timed out',
        code: /^[A-Z0-9]{5}$/.test(error.code || '') ? error.code : null };
      lastOutcome = { timestamp: latest.timestamp, status: 'unavailable', reason: latest.reason };
    } finally {
      clearTimeout(acquireTimer);
      // Destroy on failure instead of queuing cleanup behind a timed-out query.
      if (client) client.release(destroy || (transaction ? new Error('diagnostic transaction interrupted') : undefined));
      if (acquisitionExpired) {
        // A late checkout is released, and no second diagnostic may start while
        // that acquisition still exists. Never hold or use a late connection.
        void acquisition.then(late => late.release(new Error('diagnostic acquisition expired')), () => {}).finally(() => { inFlight = false; });
      } else inFlight = false;
    }
  }
  return { request, stop: () => { stopped = true; }, resume: () => { stopped = false; }, context: () => ({ ...latest,
    age_ms: latest.timestamp ? Math.max(0, now() - Date.parse(latest.timestamp)) : null, last_attempt: lastOutcome }) };
}
module.exports = { createDatabaseDiagnostics, ACTIVITY_SQL };
