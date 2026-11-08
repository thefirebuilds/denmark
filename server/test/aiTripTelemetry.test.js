const test = require('node:test');
const assert = require('node:assert/strict');
const { definitions, validateArgs, createDataTools } = require('../services/businessQuestions/dataTools');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');
const args = { trip_id: 7, view: 'summary', before: null, provider: null, signal: null, snapshot_id: null };

function fixture(result, fail = false) {
  const calls = [];
  let released = false;
  const execute = createDataTools({ pool: { connect: async () => ({
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id,')) return { rows: [{ id: 7 }] };
      if (/^(BEGIN|SET|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (fail) throw Error('query failure');
      return { rows: result };
    }, release() { released = true; },
  }) } });
  return { execute, calls, released: () => released };
}

test('AI telemetry arguments reject invalid identifiers and ignored filters', () => {
  validateArgs('trip_telemetry', args);
  for (const input of [{ trip_id: '62331575' }, { trip_id: -1 }, { view: 'unknown' },
    { view: 'snapshot' }, { before: 0 }, { provider: 'unknown' }, { signal: 'ignored' },
    { snapshot_id: 99 }, { view: 'signals', signal: 123 }]) {
    assert.throws(() => validateArgs('trip_telemetry', { ...args, ...input }));
  }
  const definition = definitions.find(d => d.name === 'trip_telemetry');
  assert.deepEqual(definition.parameters.required, Object.keys(args));
});

test('AI telemetry summary reuses the read-only client and returns coverage caveats', async () => {
  const f = fixture([{ snapshots: 3, providers: ['dimo'], max_sampled_speed_mph: 90 }]);
  const result = await f.execute('trip_telemetry', args);
  assert.equal(result.snapshots, 3);
  assert.match(result.collection, /polled every 15 minutes/);
  assert.match(result.association, /unassigned telemetry is not included/);
  assert.equal(f.calls[0].sql, 'BEGIN READ ONLY');
  assert.match(f.calls[1].sql, /statement_timeout/);
  assert.deepEqual(f.calls[3].values, [7]);
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
  assert.equal(f.released(), true);
});

test('AI incidents view reads imported provider events and history without triggering provider work', async () => {
  const calls = [];
  const execute = createDataTools({ pool: { connect: async () => ({
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM trips')) return { rows: [{ id: 7 }] };
      if (sql.includes('FROM trip_telemetry_events')) return { rows: [{ id: 9, event_name: 'safety.collision', raw_event: { metadata: { impact: false } } }] };
      if (sql.includes('FROM trip_telemetry_event_imports')) return { rows: [{ status: 'complete', received_count: 1 }] };
      return { rows: [] };
    }, release() {},
  }) } });
  const result = await execute('trip_telemetry', { ...args, view: 'incidents' });
  assert.equal(result.data[0].event_name, 'safety.collision');
  assert.equal(result.imports[0].status, 'complete');
  assert.match(result.note, /not independently verified/);
  assert.equal(calls[0].sql, 'BEGIN READ ONLY');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(calls.every(c => !/INSERT|UPDATE/.test(c.sql)));
});

test('AI can inspect an imported category without paging through unrelated driving events', async () => {
  let selection;
  const execute = createDataTools({ pool: { connect: async () => ({
    query: async (sql, values) => {
      if (sql.startsWith('SELECT id FROM trips')) return { rows: [{ id: 7 }] };
      if (sql.includes('SELECT * FROM trip_telemetry_events')) { selection = { sql, values }; return { rows: [{ id: 3, event_name: 'safety.collision' }] }; }
      if (sql.includes('GROUP BY event_name')) return { rows: [{ event_name: 'behavior.harshBraking', count: 1788 }, { event_name: 'safety.collision', count: 1 }] };
      return { rows: [] };
    }, release() {},
  }) } });
  const result = await execute('trip_telemetry', { ...args, view: 'incidents', signal: 'safety.collision' });
  assert.deepEqual(selection.values, [7, null, 'safety.collision']);
  assert.match(selection.sql, /event_name = \$3/);
  assert.equal(result.data[0].event_name, 'safety.collision');
  assert.equal(result.categories[0].count, 1788);
});

test('AI telemetry pages are bounded and trip scoped, with raw redaction and rollback on failure', async () => {
  const page = fixture(Array.from({ length: 51 }, (_, i) => ({ id: 100 - i, value_boolean: false })));
  const result = await page.execute('trip_telemetry', { ...args, view: 'signals', before: 200, provider: 'dimo', signal: 'impact' });
  assert.equal(result.data.length, 50);
  assert.equal(result.next_cursor, '51');
  assert.equal(result.data[0].value_boolean, false);
  assert.match(result.units, /provider units/);
  assert.deepEqual(page.calls[3].values, [7, 200, 'dimo', '%impact%', 51]);
  const raw = fixture([{ snapshot: { id: 99 }, raw_payload: { impact: false, access_token: 'SECRET' } }]);
  const detail = await raw.execute('trip_telemetry', { ...args, view: 'snapshot', snapshot_id: 99 });
  assert.deepEqual(raw.calls[3].values, [7, 99]);
  assert.equal(detail.raw_payload.access_token, '[redacted]');
  assert.doesNotMatch(JSON.stringify(detail), /SECRET/);
  const failing = fixture([], true);
  await assert.rejects(failing.execute('trip_telemetry', args));
  assert.equal(failing.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(failing.released(), true);
});

test('AI resolves reservation first, retrieves telemetry, and cites fresh evidence despite prior denial', async () => {
  let round = 0;
  const executed = [];
  const answer = createQuestionAnswerer({ apiKey: () => 'test',
    execute: async (name, input) => {
      executed.push(name);
      if (name === 'search_trips') return { records: [{ trip_id: 7, reservation_id: '62331575' }] };
      assert.equal(input.trip_id, 7);
      return { snapshots: 3, max_sampled_speed_mph: 90 };
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.ok(payload.tools.some(t => t.name === 'trip_telemetry'));
      assert.match(payload.instructions, /even if earlier replies denied access/);
      assert.match(payload.instructions, /not evidence of exceeding the posted road limit/);
      const call = (name, input) => ({ ok: true, json: async () => ({ output: [
        { type: 'function_call', name, arguments: JSON.stringify(input), call_id: name },
      ] }) });
      if (++round === 1) {
        assert.equal(payload.tool_choice.name, 'search_trips');
        return call('search_trips', { trip_reference: '62331575', guest_name: null, vehicle_name: null, offset: 0 });
      }
      if (round === 2) return call('trip_telemetry', args);
      assert.match(payload.input.find(i => i.call_id === 'trip_telemetry' && i.type === 'function_call_output').output, /max_sampled_speed_mph/);
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [
        { type: 'output_text', text: 'Three snapshots; maximum sampled speed 90 mph. [S2]' },
      ] }] }) };
    } });
  const result = await answer({ question: 'Review telemetry for trip 62331575', history: [{ role: 'assistant', content: 'I do not have telemetry access.' }] });
  assert.deepEqual(executed, ['search_trips', 'trip_telemetry']);
  assert.equal(result.sources[1].tool, 'trip_telemetry');
  assert.match(result.answer, /90 mph/);
});

test('trip review always supplies imported incident evidence before AI can choose only legacy telemetry', async () => {
  const calls = [];
  let round = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: async (name, input) => {
    calls.push({ name, input });
    if (input.view === 'incidents') return {
      categories: [{ event_name: 'behavior.harshBraking', count: 1788 }, { event_name: 'safety.collision', count: 1 }],
      data: [{ id: 99, event_name: 'safety.collision', raw_event: { metadata: { impact: true } } }],
      has_more: true, next_cursor: '50', imports: [{ status: 'failed', window_from: '2026-10-17', window_to: '2026-10-18' }],
    };
    return { snapshots: 500, max_sampled_speed_mph: 80 };
  }, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    const incidents = payload.input.find(i => i.type === 'function_call_output' && i.call_id === 'trip-review-incidents');
    const source = JSON.parse(incidents.output);
    assert.equal(source.filters.trip_id, 7);
    assert.equal(source.filters.view, 'incidents');
    assert.equal(source.data.categories[0].count, 1788);
    assert.equal(source.data.imports[0].status, 'failed');
    assert.match(payload.instructions, /imported category counts/i);
    assert.ok(payload.input.some(i => i.role === 'user' && i.content.includes('report reviewed versus total records')));
    if (++round === 1) {
      assert.equal(calls[0].input.view, 'incidents');
      return { ok: true, json: async () => ({ output: [{ type: 'function_call', name: 'trip_telemetry', arguments: JSON.stringify(args), call_id: 'summary' }] }) };
    }
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Imported events include a provider-reported collision and 1,788 harsh-braking records; review is partial and an import window failed. [S1] Sampled peak speed is 80 mph. [S2]' }] }] }) };
  } });
  const result = await answer({ question: 'Review driving behavior for this trip', telemetry_trip_id: 7 });
  assert.deepEqual(calls.map(c => c.input.view), ['incidents', 'summary']);
  assert.equal(result.sources[0].filters.view, 'incidents');
  assert.equal(result.sources[1].filters.view, 'summary');
  assert.match(result.answer, /partial/);
});

test('failed prefetched incident evidence is disclosed and invalid trip context is rejected', async () => {
  let executions = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: async () => { executions++; throw Error('SECRET database error'); },
    fetchImpl: async (_url, options) => {
      assert.match(options.body, /Imported events have NOT been reviewed/);
      assert.doesNotMatch(options.body, /SECRET/);
      return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'The imported event lookup failed.' }] }] }) };
    } });
  for (const id of [null, '7', -1, 0, 1.5]) await assert.rejects(answer({ question: 'Review driving behavior', telemetry_trip_id: id }), e => e.statusCode === 400);
  assert.equal(executions, 0);
  const result = await answer({ question: 'Review driving behavior', telemetry_trip_id: 7 });
  assert.equal(executions, 1);
  assert.equal(result.sources.length, 0);
  assert.match(result.answer, /1 data lookup\(s\) failed/);
});
