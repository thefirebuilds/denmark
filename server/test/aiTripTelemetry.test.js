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
  assert.match(result.collection, /No dedicated impact/);
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
