const test = require('node:test');
const assert = require('node:assert/strict');
const { filters, redact, matchingFields, reviewPage, reviewDetail, reviewSummary } = require('../services/telemetry/tripTelemetryReview');
const { reviewExport } = require('../services/telemetry/tripTelemetryReview');
const trip = { id: 7, trip_start: '2026-11-01T12:00:00Z', trip_end: '2026-11-04T12:00:00Z', max_speed_mph: 91 };

function exportFixture() {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT id,')) return { rows: [trip] };
    if (sql.includes('AS snapshot_max')) return { rows: [{ snapshot_max: 55, signal_max: 105, incident_max: 3 }] };
    if (sql.includes('FROM trip_telemetry_event_imports')) return { rows: [{ status: 'complete' }] };
    if (sql.includes('FROM trip_telemetry_events')) {
      assert.deepEqual(values, [7, 3, null]);
      return { rows: [{ id: 3, event_name: 'safety.collision', raw_event: { metadata: { access_token: 'SECRET' } } }] };
    }
    if (sql.includes('COUNT(*)::int')) return { rows: [{ snapshots: 55, providers: ['dimo'] }] };
    const snapshot = sql.includes('to_jsonb(s)');
    assert.match(sql, /s.trip_id = \$1/);
    assert.equal(values[0], 7);
    assert.equal(values[1], snapshot ? 55 : 105);
    const ids = Array.from({ length: snapshot ? 55 : 105 }, (_, i) => (snapshot ? 55 : 105) - i)
      .filter(id => values[2] == null || id < values[2]).slice(0, snapshot ? 50 : 100);
    return { rows: ids.map(id => snapshot ? { id, snapshot: { id }, raw_payload: { impact: false, access_token: 'SECRET' } }
      : { id, signal_name: 'impact', value_boolean: false }) };
  } };
  return { db, calls };
}

test('full export streams every snapshot, raw payload and signal across bounded pages', async () => {
  const f = exportFixture();
  let text = '';
  for await (const chunk of reviewExport(f.db, 7)) text += chunk;
  const result = JSON.parse(text);
  assert.equal(result.snapshots.length, 55);
  assert.equal(result.signals.length, 105);
  assert.equal(result.snapshots.at(-1).id, 1);
  assert.equal(result.signals.at(-1).id, 1);
  assert.deepEqual(result.exported_counts, { snapshots: 55, signals: 105, incidents: 1 });
  assert.equal(result.incidents[0].event_name, 'safety.collision');
  assert.equal(result.incident_import_history[0].status, 'complete');
  assert.equal(result.complete, true);
  assert.equal(result.snapshots[0].raw_payload.impact, false);
  assert.equal(result.snapshots[0].raw_payload.access_token, '[redacted]');
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(f.calls.filter(c => c.sql.includes('LIMIT 50')).length, 2);
  assert.equal(f.calls.filter(c => c.sql.includes('LIMIT 100')).length, 3);
});

test('full export stops fetching on disconnect and does not mark failed downloads complete', async () => {
  const f = exportFixture();
  const controller = new AbortController();
  const stream = reviewExport(f.db, 7, { signal: controller.signal });
  await stream.next(); // metadata
  await stream.next(); // snapshots array
  await stream.next(); // first snapshot batch
  const count = f.calls.length;
  controller.abort();
  const rest = [];
  for await (const chunk of stream) rest.push(chunk);
  assert.equal(f.calls.length, count);
  assert.doesNotMatch(rest.join(''), /"complete":true/);
  const broken = exportFixture();
  const original = broken.db.query;
  broken.db.query = async (sql, values) => {
    if (sql.includes('LIMIT 50')) throw Error('read failed');
    return original(sql, values);
  };
  await assert.rejects(async () => { for await (const _ of reviewExport(broken.db, 7)) { /* consume */ } }, /read failed/);
});

test('telemetry filters validate IDs, dates, providers and speed with bounded pages', () => {
  assert.equal(filters({ limit: 5000 }).limit, 100);
  assert.equal(filters({ minSpeed: '80', before: '300' }).minSpeed, 80);
  for (const input of [{ minSpeed: 'bad' }, { minSpeed: -1 }, { before: '1 OR 1=1' }, { from: 'invalid' }, { provider: 'unknown' }, { from: '2026-11-05', to: '2026-11-01' }]) assert.throws(() => filters(input), error => error.statusCode === 400);
});

test('snapshot review is scoped to its trip, includes missing-GPS samples, and paginates without truncating history', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (calls.length === 1) return { rows: [trip] };
    return { rows: [{ id: 9, speed_mph: 90, observed_at: new Date('2026-11-03T15:00:00Z') }, { id: 8, speed_mph: 80 }, { id: 6 }] };
  } };
  const result = await reviewPage(db, 7, { minSpeed: 80, provider: 'dimo', before: 12, limit: 2 });
  assert.equal(result.data.length, 2);
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, '8');
  assert.equal(result.data[0].observed_at, '2026-11-03T15:00:00.000Z');
  assert.match(calls[1].sql, /s.trip_id = \$1/);
  assert.match(calls[1].sql, /s.speed >= \$/);
  assert.match(calls[1].sql, /America\/Chicago/);
  assert.match(calls[1].sql, /ORDER BY s.id DESC LIMIT/);
  assert.doesNotMatch(calls[1].sql, /latitude IS NOT NULL|raw_payload/);
  assert.deepEqual(calls[1].values, [7, 12, 'dimo', 80, 3]);
});

test('signals review preserves raw/provider values and keeps signal-name searches bound', async () => {
  let last;
  const db = { query: async (sql, values) => {
    if (sql.startsWith('SELECT id,')) return { rows: [trip] };
    last = { sql, values }; return { rows: [{ id: 12, snapshot_id: 5, signal_name: 'impactDetected', value_boolean: false }] };
  } };
  const result = await reviewPage(db, 7, { kind: 'signals', signal: "speed' OR 1=1--" });
  assert.equal(result.data[0].value_boolean, false);
  assert.match(last.sql, /JOIN vehicle_telemetry_signal_values v ON v.snapshot_id = s.id/);
  assert.doesNotMatch(last.sql, /OR 1=1/);
  assert.ok(last.values.includes("%speed' OR 1=1--%"));
  assert.match(result.units, /provider units/);
});

test('raw review retains false flags and all provider values while redacting credentials', () => {
  const raw = { stats: { impact: false, hardBraking: 0, speed: 90 }, access_token: 'SECRET', nested: [{ password: 'SECRET', engine_rpm: 4000 }] };
  const safe = redact(raw);
  assert.equal(safe.access_token, '[redacted]');
  assert.equal(safe.nested[0].password, '[redacted]');
  assert.equal(safe.nested[0].engine_rpm, 4000);
  assert.deepEqual(matchingFields(safe).map(f => f.value), [false, 0]);
  assert.doesNotMatch(JSON.stringify(safe), /SECRET/);
  assert.equal(raw.access_token, 'SECRET');
});

test('snapshot details require trip ownership and expose missing raw payloads explicitly', async () => {
  let calls = 0;
  const db = { query: async (sql, values) => {
    if (++calls === 1) return { rows: [trip] };
    assert.match(sql, /s.trip_id = \$1 AND s.id = \$2/);
    assert.deepEqual(values, [7, 99]);
    return { rows: [{ snapshot: { id: 99, speed: 91 }, raw_payload: null }] };
  } };
  const result = await reviewDetail(db, 7, 99);
  assert.equal(result.raw_available, false);
  assert.match(result.raw_unavailable_reason, /not retained or has been pruned/);
  assert.deepEqual(result.matching_fields, []);
  await assert.rejects(reviewDetail({ query: async sql => ({ rows: sql.startsWith('SELECT id,') ? [trip] : [] }) }, 7, 99), error => error.statusCode === 404);
});

test('missing trips fail before telemetry is read and summaries disclose collection limitations', async () => {
  await assert.rejects(reviewPage({ query: async () => ({ rows: [] }) }, 123, {}), error => error.statusCode === 404);
  const result = await reviewSummary({ query: async sql => ({ rows: sql.startsWith('SELECT id,') ? [trip] : [{ snapshots: 0, providers: [null], max_sampled_speed_mph: null }] }) }, 7);
  assert.equal(result.max_sampled_speed_mph, null);
  assert.deepEqual(result.providers, []);
  assert.match(result.collection, /polled every 15 minutes/);
  assert.match(result.association, /unassigned telemetry is not included/);
});
