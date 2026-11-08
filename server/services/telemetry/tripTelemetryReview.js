const { telemetryEventAtExpression } = require('./tripAttribution');
const { getRawPayloadRetentionDays, getArchiveRetentionDays } = require('./retention');
const bad = message => Object.assign(new Error(message), { statusCode: 400 });
const integer = (value, label) => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw bad(`Invalid ${label}`); return n; };
const time = (value, label) => { if (!value) return null; const date = new Date(value); if (!Number.isFinite(date.getTime())) throw bad(`Invalid ${label}`); return date.toISOString(); };
function filters(input = {}) {
  const kind = input.kind || 'snapshots';
  if (!['snapshots', 'signals'].includes(kind)) throw bad('Invalid telemetry view');
  const provider = input.provider || '';
  if (provider && !['bouncie', 'dimo'].includes(provider)) throw bad('Invalid provider');
  const from = time(input.from, 'start time'), to = time(input.to, 'end time');
  if (from && to && from > to) throw bad('Start time must precede end time');
  const minSpeed = input.minSpeed == null || input.minSpeed === '' ? null : Number(input.minSpeed);
  if (minSpeed != null && (!Number.isFinite(minSpeed) || minSpeed < 0 || minSpeed > 400)) throw bad('Invalid minimum speed');
  return { kind, provider, from, to, minSpeed, signal: String(input.signal || '').slice(0, 100),
    before: input.before ? integer(input.before, 'cursor') : null, limit: Math.min(100, integer(input.limit || 50, 'page size')) };
}
// Retain telemetry values while keeping authentication material out of exports.
function redact(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|password|secret|access.?token|refresh.?token|api.?key|private.?key|cookie|^token$|jwt/i.test(key) ? '[redacted]' : redact(item)]));
  return value;
}
function matchingFields(value, path = '', result = []) {
  if (result.length >= 100) return result;
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (result.length >= 100) break;
    const next = path ? `${path}.${key}` : key;
    if (/impact|collision|hard.?brak|hard.?accel|aggressive|harsh|rapid.?accel|over.?speed|speeding/i.test(key)) result.push({ field: next, value: item });
    else matchingFields(item, next, result);
  }
  return result;
}
async function tripContext(db, id) {
  const { rows } = await db.query('SELECT id, trip_start, trip_end, returned_at, max_speed_mph, speed_over_80_count FROM trips WHERE id = $1 AND deleted_at IS NULL', [integer(id, 'trip ID')]);
  if (!rows[0]) throw Object.assign(new Error('Trip not found'), { statusCode: 404 });
  return rows[0];
}
function observedAt(alias, field) {
  return `CASE WHEN ${alias}.service_name = 'dimo' THEN ${alias}.${field} AT TIME ZONE 'America/Chicago' ELSE ${alias}.${field} AT TIME ZONE 'UTC' END`;
}
async function reviewSummary(db, id) {
  const trip = await tripContext(db, id);
  const speedTime = `COALESCE(${observedAt('s', 'speed_last_updated')}, ${observedAt('s', 'vehicle_last_updated')})`;
  const { rows } = await db.query(`SELECT COUNT(*)::int AS snapshots,
    MIN(s.captured_at AT TIME ZONE 'UTC') AS first_received_at, MAX(s.captured_at AT TIME ZONE 'UTC') AS last_received_at,
    (MAX(s.speed) FILTER (WHERE ${speedTime} BETWEEN t.trip_start AND t.trip_end))::float AS max_sampled_speed_mph,
    COUNT(*) FILTER (WHERE s.speed >= 80 AND ${speedTime} BETWEEN t.trip_start AND t.trip_end)::int AS samples_at_or_above_80,
    ARRAY_AGG(DISTINCT s.service_name) AS providers
    FROM vehicle_telemetry_snapshots s JOIN trips t ON t.id = s.trip_id WHERE s.trip_id = $1`, [trip.id]);
  return { trip, ...rows[0], providers: (rows[0]?.providers || []).filter(Boolean),
    collection: 'Periodic vehicle snapshots and stored signal values. Active DIMO vehicles are polled every 15 minutes for provider-reported collisions; other event history can be imported on request. Check the incidents view and import history for available records and coverage.',
    association: 'Stored trip attribution only; unassigned telemetry is not included. A provider reading can predate its snapshot or this trip.',
    raw_retention: { legacy_days: getRawPayloadRetentionDays(), archive_days: getArchiveRetentionDays() },
    cautions: ['No recorded impact flag does not establish that no incident occurred.', 'Samples can repeat stale readings. Speed thresholds are not posted-road-limit determinations.'] };
}
async function reviewPage(db, id, input) {
  const f = filters(input);
  const trip = await tripContext(db, id);
  const values = [trip.id];
  const clauses = ['s.trip_id = $1'];
  const alias = f.kind === 'signals' ? 'v' : 's';
  const at = f.kind === 'signals' ? `COALESCE(${observedAt('v', 'signal_timestamp')}, v.captured_at AT TIME ZONE 'UTC')`
    : `COALESCE(${observedAt('s', 'speed_last_updated')}, ${observedAt('s', 'vehicle_last_updated')}, ${telemetryEventAtExpression('s')})`;
  const add = (sql, value) => { values.push(value); clauses.push(sql.replace('?', `$${values.length}`)); };
  if (f.before) add(`${alias}.id < ?`, f.before);
  if (f.provider) add('s.service_name = ?', f.provider);
  if (f.from) add(`${at} >= ?::timestamptz`, f.from);
  if (f.to) add(`${at} <= ?::timestamptz`, f.to);
  if (f.kind === 'snapshots' && f.minSpeed != null) add('s.speed >= ?::numeric', f.minSpeed);
  if (f.kind === 'signals' && f.signal) add('v.signal_name ILIKE ?', `%${f.signal}%`);
  values.push(f.limit + 1);
  const selection = f.kind === 'signals' ? `v.id, v.snapshot_id, v.service_name, v.signal_name, v.value_json,
      v.value_numeric, v.value_text, v.value_boolean, ${at} AS observed_at, v.captured_at AT TIME ZONE 'UTC' AS received_at,
      CASE WHEN v.signal_timestamp IS NULL THEN 'received_fallback' ELSE 'signal_timestamp' END AS observation_time_source,
      (${at} BETWEEN t.trip_start AND t.trip_end) AS reading_within_trip`
    : `s.id, s.service_name, s.speed::float AS speed_mph, s.engine_rpm::float AS engine_rpm,
      s.latitude::float AS latitude, s.longitude::float AS longitude, s.is_running,
      ${at} AS observed_at, s.captured_at AT TIME ZONE 'UTC' AS received_at,
      CASE WHEN COALESCE(s.speed_last_updated, s.vehicle_last_updated) IS NULL THEN 'location_or_receipt_fallback' ELSE 'speed_or_vehicle_timestamp' END AS observation_time_source,
      COALESCE(${observedAt('s', 'speed_last_updated')}, ${observedAt('s', 'vehicle_last_updated')}) AS speed_observed_at,
      (COALESCE(${observedAt('s', 'speed_last_updated')}, ${observedAt('s', 'vehicle_last_updated')}) BETWEEN t.trip_start AND t.trip_end) AS reading_within_trip`;
  const { rows } = await db.query(`SELECT ${selection}
    FROM vehicle_telemetry_snapshots s JOIN trips t ON t.id = s.trip_id
    ${f.kind === 'signals' ? 'JOIN vehicle_telemetry_signal_values v ON v.snapshot_id = s.id' : ''}
    WHERE ${clauses.join(' AND ')} ORDER BY ${alias}.id DESC LIMIT $${values.length}`, values);
  const hasMore = rows.length > f.limit;
  const data = rows.slice(0, f.limit).map(redact);
  return { trip_id: trip.id, kind: f.kind, data, has_more: hasMore, next_cursor: hasMore ? String(data[data.length - 1].id) : null,
    ordering: 'Newest stored record first (record ID). Observed time and receipt time are shown separately.',
    units: f.kind === 'signals' ? 'Signal values retain their stored/provider units; speed_mph on snapshot rows is normalized to mph.' : 'mph' };
}
async function reviewDetail(db, id, snapshotId) {
  const trip = await tripContext(db, id);
  const { rows } = await db.query(`SELECT to_jsonb(s) - 'raw_payload' AS snapshot,
    COALESCE(raw.raw_payload, s.raw_payload) AS raw_payload,
    s.captured_at AT TIME ZONE 'UTC' AS received_at
    FROM vehicle_telemetry_snapshots s LEFT JOIN vehicle_telemetry_raw_payloads raw ON raw.snapshot_id = s.id
    WHERE s.trip_id = $1 AND s.id = $2`, [trip.id, integer(snapshotId, 'snapshot ID')]);
  if (!rows[0]) throw Object.assign(new Error('Snapshot not found on this trip'), { statusCode: 404 });
  const row = rows[0];
  const raw = redact(row.raw_payload);
  return { ...row, snapshot: redact(row.snapshot), raw_payload: raw, matching_fields: matchingFields(raw),
    snapshot_timestamps_note: 'Snapshot JSON is as stored: captured_at is UTC; DIMO signal wall times are America/Chicago, Bouncie signal wall times are UTC. Use the offset-bearing normalized times in the timeline for comparison.',
    raw_available: raw != null, raw_unavailable_reason: raw == null ? 'Raw payload was not retained or has been pruned. Normalized snapshot fields remain available.' : null,
    matching_fields_note: 'Keyword-matched provider fields, not verified incidents. False, zero, and historical values are preserved; inspect their timestamps.' };
}
// Stream bounded keyset batches, including retained raw payloads, without a
// long-lived transaction or holding a pool client while the download is slow.
async function* reviewExport(db, id, { signal, now = () => new Date() } = {}) {
  const summary = await reviewSummary(db, id);
  const { rows: [bounds] } = await db.query(`SELECT
    (SELECT MAX(id) FROM vehicle_telemetry_snapshots WHERE trip_id = $1) AS snapshot_max,
    (SELECT MAX(v.id) FROM vehicle_telemetry_signal_values v
      JOIN vehicle_telemetry_snapshots s ON s.id = v.snapshot_id WHERE s.trip_id = $1) AS signal_max,
    (SELECT MAX(id) FROM trip_telemetry_events WHERE trip_id = $1) AS incident_max`, [summary.trip.id]);
  const incidentHistory = await db.query(`SELECT window_from, window_to, status, received_count, inserted_count,
    error_message, requested_at, finished_at FROM trip_telemetry_event_imports
    WHERE trip_id = $1 ORDER BY id DESC LIMIT 20`, [summary.trip.id]);
  const counts = { snapshots: 0, signals: 0, incidents: 0 };
  yield JSON.stringify({ exported_at: now().toISOString(), scope: 'All stored telemetry attributed to this trip; screen filters are not applied.',
    consistency: 'Record IDs are capped at export start. This is not a transactional snapshot; concurrent edits or retention may affect records during export.',
    summary, incident_import_history: incidentHistory.rows, incident_note: 'Provider-reported events are not independently verified accidents. Recent import history may not cover all trip windows.',
    record_bounds: bounds, units: 'Normalized snapshot speed is mph. Signal values retain stored/provider units.',
    timestamps: 'Raw snapshot and signal fields use stored conventions: captured_at is UTC; DIMO signal wall times are America/Chicago, Bouncie signal wall times are UTC.',
    raw_payloads: 'Retained archive payload preferred, legacy inline payload fallback. Null means not retained or pruned. Authentication fields are redacted.' }).slice(0, -1);
  for (const kind of ['snapshots', 'signals', 'incidents']) {
    yield `,"${kind}":[`;
    let before = null, first = true;
    const max = kind === 'snapshots' ? bounds.snapshot_max : kind === 'signals' ? bounds.signal_max : bounds.incident_max;
    while (max != null && !signal?.aborted) {
      const snapshots = kind === 'snapshots';
      const { rows } = await db.query(snapshots ? `SELECT s.id,
        to_jsonb(s) - 'raw_payload' AS snapshot,
        COALESCE(raw.raw_payload, s.raw_payload) AS raw_payload
        FROM vehicle_telemetry_snapshots s
        LEFT JOIN vehicle_telemetry_raw_payloads raw ON raw.snapshot_id = s.id
        WHERE s.trip_id = $1 AND s.id <= $2 AND ($3::bigint IS NULL OR s.id < $3)
        ORDER BY s.id DESC LIMIT 50` : kind === 'incidents' ? `SELECT * FROM trip_telemetry_events
        WHERE trip_id = $1 AND id <= $2 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT 100` : `SELECT v.* FROM vehicle_telemetry_signal_values v
        JOIN vehicle_telemetry_snapshots s ON s.id = v.snapshot_id
        WHERE s.trip_id = $1 AND v.id <= $2 AND ($3::bigint IS NULL OR v.id < $3)
        ORDER BY v.id DESC LIMIT 100`, [summary.trip.id, max, before]);
      if (signal?.aborted) return;
      for (const row of rows) {
        if (signal?.aborted) return;
        yield `${first ? '' : ','}${JSON.stringify(redact(row))}`;
        first = false; counts[kind]++;
      }
      if (rows.length < (snapshots ? 50 : 100)) break;
      before = rows[rows.length - 1].id;
    }
    if (signal?.aborted) return;
    yield ']';
  }
  yield `,"exported_counts":${JSON.stringify(counts)},"complete":true}`;
}
module.exports = { filters, redact, matchingFields, reviewSummary, reviewPage, reviewDetail, reviewExport };
