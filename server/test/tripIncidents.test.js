const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncidentImporter, normalizeEvents, incidentPage } = require('../services/telemetry/tripIncidents');
const { fetchDimoEvents, QUERY } = require('../services/dimo/eventHistory');
const trip = { id: 7, trip_start: '2026-11-01T00:00:00Z', trip_end: '2026-11-03T00:00:00Z', dimo_token_id: '42' };
const event = { name: 'safety.collision', source: 'device', timestamp: '2026-11-01T12:00:00Z', durationNs: 0,
  metadata: JSON.stringify({ impact: false, access_token: 'SECRET', nested: { password: 'SECRET' } }) };
const range = { from: trip.trip_start, to: '2026-11-02T00:00:00.000Z' };

function fixture({ rows = [trip], writeError = false } = {}) {
  const calls = [], keys = new Set(); let checkedOut = false;
  const query = async (sql, values) => {
    calls.push({ sql, values, checkedOut });
    if (sql.includes('FROM trips t')) return { rows };
    if (sql.includes('RETURNING id')) return { rows: [{ id: 1 }] };
    if (sql.includes('INSERT INTO trip_telemetry_events')) {
      if (writeError) throw Error('secret connection string');
      assert.match(sql, /ON CONFLICT .* DO NOTHING/);
      let rowCount = 0;
      for (const record of JSON.parse(values[2])) { if (!keys.has(record.key)) { keys.add(record.key); rowCount++; } }
      return { rows: [], rowCount };
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => { checkedOut = true; return { query, release() { checkedOut = false; } }; } };
  return { pool, calls, isCheckedOut: () => checkedOut };
}

test('DIMO event query uses official event fields, trip window and vehicle token', async () => {
  assert.match(QUERY, /events\(tokenId: \$tokenId, from: \$from, to: \$to\)/);
  const events = await fetchDimoEvents(42, { ...range, auth: async id => { assert.equal(id, 42); return 'Bearer SECRET'; },
    fetchImpl: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).variables, { tokenId: 42, ...range });
      assert.equal(options.headers.Authorization, 'Bearer SECRET');
      assert.ok(options.signal);
      return new Response(JSON.stringify({ data: { events: [event] } }));
    } });
  assert.equal(events[0].name, 'safety.collision');
});

test('DIMO failures, partial GraphQL results, null events and oversize bodies are not empty success', async () => {
  for (const response of [new Response('SECRET', { status: 403 }),
    new Response(JSON.stringify({ errors: [{ message: 'GetLocationHistory privilege SECRET' }], data: { events: [] } })),
    new Response(JSON.stringify({ data: { events: null } })),
    new Response(JSON.stringify({ data: { events: [] }, errors: [{ message: 'internal SECRET' }] })),
    new Response('x'.repeat(2 * 1024 * 1024 + 1))]) {
    await assert.rejects(fetchDimoEvents(42, { ...range, auth: async () => 'test', fetchImpl: async () => response }), error => {
      assert.doesNotMatch(error.message, /SECRET/); return error.safeIncidentError === true;
    });
  }
  assert.deepEqual(await fetchDimoEvents(42, { ...range, auth: async () => 'test', fetchImpl: async () => new Response('{"data":{"events":[]}}') }), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchDimoEvents(42, { ...range, signal: controller.signal, auth: () => new Promise(() => {}) }), e => e.statusCode === 504);
});

test('normalization preserves false flags, redacts parsed metadata, and rejects outside-trip data', () => {
  const normalized = normalizeEvents([event], range.from, range.to)[0];
  assert.equal(normalized.raw.metadata.impact, false);
  assert.equal(normalized.raw.metadata.access_token, '[redacted]');
  assert.doesNotMatch(JSON.stringify(normalized), /SECRET/);
  assert.equal(normalized.key, normalizeEvents([event], range.from, range.to)[0].key);
  const text = normalizeEvents([{ ...event, metadata: 'Possible impact. access_token=SECRET Bearer SECRET' }], range.from, range.to)[0].raw.metadata;
  assert.match(text, /Possible impact/);
  assert.doesNotMatch(text, /SECRET/);
  for (const invalid of [{ ...event, timestamp: 'bad' }, { ...event, timestamp: '2026-11-04T00:00:00Z' }, { ...event, name: '' }]) {
    assert.throws(() => normalizeEvents([invalid], range.from, range.to));
  }
});

test('requested import fetches outside transactions, persists only one day and deduplicates repeat imports', async () => {
  const f = fixture();
  const importer = createIncidentImporter({ pool: f.pool, now: () => new Date('2026-11-05'), fetchEvents: async (token, options) => {
    assert.equal(f.isCheckedOut(), false);
    assert.equal(token, 42);
    assert.equal(options.to, range.to);
    return [event];
  } });
  const first = await importer(7);
  const second = await importer(7);
  assert.equal(first.received, 1);
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(first.complete, false);
  assert.equal(first.next_from, range.to);
  assert.equal(f.isCheckedOut(), false);
  const write = f.calls.find(c => c.sql.includes('INSERT INTO trip_telemetry_events'));
  assert.equal(write.checkedOut, true);
  assert.doesNotMatch(write.values[2], /SECRET/);
  assert.equal(f.calls.filter(c => c.sql === 'COMMIT').length, 2);
});

test('import rejects missing/ambiguous identity and bad date bounds without calling DIMO', async () => {
  for (const rows of [[], [trip, trip], [{ ...trip, dimo_token_id: null }]]) {
    const f = fixture({ rows });
    const importer = createIncidentImporter({ pool: f.pool, fetchEvents: () => assert.fail('must not contact DIMO') });
    await assert.rejects(importer(7));
    assert.equal(f.calls.some(c => c.sql.includes('RETURNING id')), false);
  }
  const f = fixture();
  const importer = createIncidentImporter({ pool: f.pool, fetchEvents: () => assert.fail('invalid range') });
  for (const from of ['bad', '2026-10-31', '2026-11-04']) await assert.rejects(importer(7, { from }));
});

test('import caps at now and records completed empty windows without claiming no incident', async () => {
  const f = fixture();
  const importer = createIncidentImporter({ pool: f.pool, now: () => new Date('2026-11-01T14:00:00Z'), fetchEvents: async (_token, options) => {
    assert.equal(options.to, '2026-11-01T14:00:00.000Z'); return [];
  } });
  const result = await importer(7);
  assert.equal(result.complete, true);
  assert.equal(result.next_from, null);
  assert.equal(result.received, 0);
  assert.match(result.note, /does not establish no incident/);
  assert.ok(f.calls.some(c => c.sql.includes("status='complete'") && c.values[1] === 0));
});

test('only one import runs at a time, failures record sanitized status and allow retry', async () => {
  const f = fixture(); let release;
  const importer = createIncidentImporter({ pool: f.pool, fetchEvents: () => new Promise(resolve => { release = resolve; }) });
  const first = importer(7);
  // Advance through the two DB reads without timers or provider access.
  while (!release) await Promise.resolve();
  await assert.rejects(importer(7), e => e.statusCode === 429);
  release([]); await first;
  const failing = createIncidentImporter({ pool: f.pool, fetchEvents: async () => { throw Object.assign(Error('SECRET'), { statusCode: 403 }); } });
  for (let i = 0; i < 2; i++) await assert.rejects(failing(7), error => !error.message.includes('SECRET'));
  assert.ok(f.calls.some(c => c.sql.includes("status='failed'")));
  assert.doesNotMatch(JSON.stringify(f.calls), /SECRET/);
});

test('failed writes roll back and release clients; canceled requests do not start writes', async () => {
  const f = fixture({ writeError: true });
  const importer = createIncidentImporter({ pool: f.pool, fetchEvents: async () => [event] });
  await assert.rejects(importer(7));
  assert.ok(f.calls.some(c => c.sql === 'ROLLBACK'));
  assert.equal(f.isCheckedOut(), false);
  const canceled = fixture(), controller = new AbortController();
  const cancelImport = createIncidentImporter({ pool: canceled.pool, fetchEvents: async () => { controller.abort(); return []; } });
  await assert.rejects(cancelImport(7, { signal: controller.signal }), e => e.statusCode === 499);
  assert.equal(canceled.calls.some(c => c.sql === 'BEGIN'), false);
});

test('incident reads paginate within trip, preserve provider labels, and report import windows', async () => {
  const result = await incidentPage({ query: async (sql, values) => {
    assert.equal(values[0], 7);
    if (sql.startsWith('SELECT id FROM trips')) return { rows: [{ id: 7 }] };
    if (sql.includes('FROM trip_telemetry_events')) {
      assert.deepEqual(values, [7, 100]);
      return { rows: Array.from({ length: 51 }, (_, i) => ({ id: 99 - i, event_name: 'behavior.harshBraking' })) };
    }
    return { rows: [{ status: 'failed', error_message: 'DIMO unavailable' }] };
  } }, 7, 100);
  assert.equal(result.data.length, 50);
  assert.equal(result.next_cursor, '50');
  assert.equal(result.imports[0].status, 'failed');
  assert.match(result.note, /not independently verified/);
});
