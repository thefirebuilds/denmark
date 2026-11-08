const { createHash } = require('node:crypto');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, safeIncidentError: true });
const tripId = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw fail('Invalid trip ID'); return id; };

async function ensureTripIncidentSchema(db = require('../../db')) {
  await db.query(`CREATE TABLE IF NOT EXISTS trip_telemetry_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    dimo_token_id text NOT NULL, event_key text NOT NULL,
    event_name text NOT NULL, observed_at timestamptz NOT NULL,
    source text NOT NULL, raw_event jsonb NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE(trip_id, dimo_token_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_trip_telemetry_events_trip_id ON trip_telemetry_events(trip_id, id DESC);
  CREATE TABLE IF NOT EXISTS trip_telemetry_event_imports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    dimo_token_id text NOT NULL, window_from timestamptz NOT NULL, window_to timestamptz NOT NULL,
    status text NOT NULL, received_count integer, inserted_count integer,
    error_message text, requested_at timestamptz NOT NULL DEFAULT NOW(), finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS idx_trip_telemetry_event_imports_trip_id ON trip_telemetry_event_imports(trip_id, id DESC);`);
}

async function incidentPage(db, id, before = null, eventName = null) {
  const trip = tripId(id);
  if (eventName !== null && (typeof eventName !== 'string' || !eventName || eventName.length > 250)) throw fail('Invalid event category');
  if (before != null && (!/^\d+$/.test(String(before)) || BigInt(before) <= 0n)) throw fail('Invalid incident cursor');
  const exists = await db.query('SELECT id FROM trips WHERE id=$1 AND deleted_at IS NULL', [trip]);
  if (!exists.rows[0]) throw fail('Trip not found', 404);
  const { rows } = await db.query(`SELECT * FROM trip_telemetry_events
    WHERE trip_id = $1 AND ($2::bigint IS NULL OR id < $2)
      AND ($3::text IS NULL OR event_name = $3) ORDER BY id DESC LIMIT 51`, [trip, before, eventName]);
  const categories = await db.query(`SELECT event_name, COUNT(*)::int AS count FROM trip_telemetry_events
    WHERE trip_id = $1 GROUP BY event_name ORDER BY event_name`, [trip]);
  const imports = await db.query(`SELECT id, window_from, window_to, status, received_count, inserted_count,
    error_message, requested_at, finished_at FROM trip_telemetry_event_imports
    WHERE trip_id = $1 ORDER BY id DESC LIMIT 20`, [trip]);
  const data = rows.slice(0, 50).map(require('./tripTelemetryReview').redact);
  return { trip_id: trip, data, has_more: rows.length > 50, next_cursor: rows.length > 50 ? String(data.at(-1).id) : null,
    categories: categories.rows, imports: imports.rows,
    note: 'Provider-reported events, not independently verified accidents or proof of driver fault. Empty results do not prove no incident. Import history covers only the requested windows; older attempts may not be shown.' };
}

function normalizeEvents(events, from, to) {
  if (!Array.isArray(events)) throw fail('DIMO event response is invalid.', 502);
  if (events.length > 2000) throw Object.assign(fail('DIMO returned too many events for one import window. No events from this window were saved.', 502), { code: 'DIMO_EVENT_WINDOW_TOO_LARGE' });
  const { redact } = require('./tripTelemetryReview');
  return events.map(event => {
    const at = new Date(event?.timestamp);
    if (!event || typeof event.timestamp !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(event.timestamp) ||
        typeof event.name !== 'string' || !event.name || event.name.length > 250 ||
        !Number.isSafeInteger(event.durationNs) || event.durationNs < 0 ||
        typeof event.source !== 'string' || !event.source || event.source.length > 500 || !Number.isFinite(at.getTime()) ||
        at < new Date(from) || at > new Date(to)) throw fail('DIMO returned an invalid or outside-window event. No events from this window were saved.', 502);
    // Metadata is a JSON string in DIMO's schema. Parse it for credential redaction.
    let metadata = event.metadata;
    if (typeof metadata === 'string') {
      try { metadata = redact(JSON.parse(metadata)); }
      catch {
        metadata = metadata.replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]')
          .replace(/\b(authorization|password|secret|token|cookie|jwt|access[_-]?token|refresh[_-]?token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
      }
    }
    const raw = redact({ ...event, metadata });
    const key = createHash('sha256').update(JSON.stringify([
      event.name, event.source, at.toISOString(), event.durationNs ?? null, event.metadata ?? null,
    ])).digest('hex');
    return { key, name: event.name, source: event.source, at: at.toISOString(), raw };
  });
}

function createIncidentImporter({ pool, fetchEvents = (...args) => require('../dimo/eventHistory').fetchDimoEvents(...args), now = () => new Date() }) {
  let busy = false;
  return async function importWindow(id, { from = null, signal } = {}) {
    if (busy) throw fail('Another DIMO incident import is running. Try again shortly.', 429);
    busy = true;
    let attempt;
    try {
      if (signal?.aborted) throw fail('Incident import canceled. Retry to continue.', 499);
      const { rows } = await pool.query(`SELECT t.id, t.trip_start, t.trip_end, v.dimo_token_id
        FROM trips t LEFT JOIN vehicles v ON v.turo_vehicle_id = t.turo_vehicle_id
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [tripId(id)]);
      if (!rows[0]) throw fail('Trip not found', 404);
      if (rows.length !== 1) throw fail('The trip has an ambiguous vehicle link. Fix its vehicle assignment before importing.');
      const trip = rows[0], token = Number(trip.dimo_token_id);
      if (!trip.dimo_token_id || !Number.isSafeInteger(token) || token <= 0) throw fail('This trip needs an exact vehicle link with a DIMO token ID before importing.');
      const start = new Date(trip.trip_start), end = new Date(Math.min(new Date(trip.trip_end).getTime(), now().getTime()));
      const lower = from == null ? start : new Date(from);
      if (!trip.trip_start || !trip.trip_end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) ||
          !Number.isFinite(lower.getTime()) || lower < start || lower >= end) throw fail('Import requires a valid elapsed trip window.');
      let upper = new Date(Math.min(lower.getTime() + 24 * 3600000, end.getTime()));
      const window = { from: lower.toISOString(), to: upper.toISOString() };
      const run = await pool.query(`INSERT INTO trip_telemetry_event_imports
        (trip_id, dimo_token_id, window_from, window_to, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
      [trip.id, String(token), window.from, window.to]);
      attempt = run.rows[0].id;
      // No checked-out DB client or transaction while waiting for DIMO/auth.
      const deadline = AbortSignal.timeout(60000);
      const lookupSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let events, splits = 0;
      while (true) {
        if (signal?.aborted) throw fail('Incident import canceled. Retry to continue.', 499);
        if (deadline.aborted) throw fail('DIMO import window timed out. Retry to continue.', 504);
        try {
          events = normalizeEvents(await fetchEvents(token, { ...window, signal: lookupSignal }), window.from, window.to);
          break;
        } catch (error) {
          if (error.code !== 'DIMO_EVENT_WINDOW_TOO_LARGE' || !error.safeIncidentError) throw error;
          const duration = upper.getTime() - lower.getTime();
          if (duration <= 60000 || splits >= 11) throw fail('DIMO returned too many events or too much data even for a one-minute window. No records from this window were saved; contact support to review this provider response.', 502);
          upper = new Date(lower.getTime() + Math.max(60000, Math.floor(duration / 2)));
          window.to = upper.toISOString(); splits++;
          // History must show the interval actually saved, not the rejected day.
          await pool.query('UPDATE trip_telemetry_event_imports SET window_to=$2 WHERE id=$1', [attempt, window.to]);
        }
      }
      if (signal?.aborted) throw fail('Incident import canceled. Retry to continue.', 499);
      if (deadline.aborted) throw fail('DIMO import window timed out. Retry to continue.', 504);
      const client = await pool.connect();
      let inserted = 0;
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        for (let offset = 0; offset < events.length; offset += 100) {
          if (signal?.aborted) throw fail('Incident import canceled. Retry to continue.', 499);
          const batch = events.slice(offset, offset + 100);
          const result = await client.query(`INSERT INTO trip_telemetry_events
            (trip_id, dimo_token_id, event_key, event_name, observed_at, source, raw_event)
            SELECT $1, $2, e.key, e.name, e.at::timestamptz, e.source, e.raw
            FROM jsonb_to_recordset($3::jsonb) AS e(key text, name text, at text, source text, raw jsonb)
            ON CONFLICT (trip_id, dimo_token_id, event_key) DO NOTHING`, [trip.id, String(token), JSON.stringify(batch)]);
          inserted += result.rowCount;
        }
        await client.query(`UPDATE trip_telemetry_event_imports SET status='complete', received_count=$2,
          inserted_count=$3, finished_at=NOW() WHERE id=$1`, [attempt, events.length, inserted]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
      return { ...window, received: events.length, inserted, window_splits: splits, complete: upper >= end,
        next_from: upper < end ? upper.toISOString() : null,
        note: 'Imported provider-reported events only. No events returned does not establish no incident.' };
    } catch (error) {
      const safe = error.safeIncidentError ? error : fail('DIMO incident import failed. No successful empty lookup was recorded. Retry the import.', 502);
      if (attempt) await pool.query(`UPDATE trip_telemetry_event_imports SET status='failed', error_message=$2, finished_at=NOW() WHERE id=$1`, [attempt, safe.message]).catch(() => {});
      throw safe;
    } finally { busy = false; }
  };
}
module.exports = { ensureTripIncidentSchema, incidentPage, normalizeEvents, createIncidentImporter };
