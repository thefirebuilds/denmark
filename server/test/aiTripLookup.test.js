const test = require('node:test');
const assert = require('node:assert/strict');
const { createDataTools, validateArgs } = require('../services/businessQuestions/dataTools');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');

const filters = { trip_reference: '62331575', guest_name: null, vehicle_name: null, offset: 0 };
const toolResponse = (name, args) => ({ ok: true, json: async () => ({ output: [
  { type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'lookup' },
] }) });
const answerResponse = text => ({ ok: true, json: async () => ({ output: [
  { type: 'message', content: [{ type: 'output_text', text }] },
] }) });

test('trip search checks internal and reservation IDs, returns actual and scheduled times separately', async () => {
  let released = false;
  const queries = [];
  const execute = createDataTools({ pool: { connect: async () => ({
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('WITH matching')) {
        assert.deepEqual(values, ['62331575', null, null, 0]);
        assert.match(sql, /t.id::text = \$1 OR t.reservation_id::text = \$1/);
        assert.match(sql, /t.deleted_at IS NULL/);
        assert.doesNotMatch(sql, /t.is_active|NOW\(\)|INTERVAL/);
        return { rows: [{ matched_count: 1, records: [{ trip_id: 7, reservation_id: '62331575', guest_name: 'Olive',
          returned_at: '2026-10-23T16:12:00Z', scheduled_return_at: '2026-10-23T15:00:00Z', return_detection_source: 'dimo' }] }] };
      }
      return { rows: [] };
    }, release() { released = true; },
  }) } });
  const result = await execute('search_trips', filters);
  assert.equal(result.records[0].returned_at_local, '2026-10-23T11:12:00.000-05:00');
  assert.equal(result.records[0].scheduled_return_at_local, '2026-10-23T10:00:00.000-05:00');
  assert.equal(result.matched_count, 1);
  assert.equal(result.next_offset, null);
  assert.equal(queries[0].sql, 'BEGIN READ ONLY');
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released, true);
});

test('guest lookup uses bound partial names and never substitutes scheduled time for missing actual return', async () => {
  const execute = createDataTools({ pool: { connect: async () => ({
    query: async (sql, values) => {
      if (sql.includes('WITH matching')) {
        assert.equal(values[1], "Olive's");
        assert.match(sql, /strpos\(LOWER\(COALESCE\(t.guest_name/);
        return { rows: [{ matched_count: 1, records: [{ trip_id: 7, returned_at: null, scheduled_return_at: '2026-10-23T15:00:00Z' }] }] };
      }
      return { rows: [] };
    }, release() {},
  }) } });
  const result = await execute('search_trips', { ...filters, trip_reference: null, guest_name: "Olive's" });
  assert.equal(result.records[0].returned_at_local, null);
  assert.match(result.basis, /not that the trip was not found/);
  for (const invalid of [{ ...filters, trip_reference: '7 OR 1=1' }, { ...filters, trip_reference: null }, { ...filters, offset: -1 }]) {
    assert.throws(() => validateArgs('search_trips', invalid));
  }
});

test('return questions and reservation follow-ups start with the individual trip search', async () => {
  for (const question of ['what time of day did Olive return my vehicle?', 'trip 62331575', '62331575']) {
    let requests = 0;
    const answer = createQuestionAnswerer({ apiKey: () => 'test',
      execute: async name => { assert.equal(name, 'search_trips'); return { matched_count: 1, records: [{ returned_at_local: '2026-10-23T11:12:00-05:00' }] }; },
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        if (++requests === 1) {
          assert.deepEqual(payload.tool_choice, { type: 'function', name: 'search_trips' });
          assert.match(payload.instructions, /Never substitute scheduled_return_at/);
          return toolResponse('search_trips', filters);
        }
        return answerResponse('Recorded return: 11:12 AM CDT. [S1]');
      } });
    const result = await answer({ question, history: [{ role: 'user', content: 'Olive' }] });
    assert.equal(result.sources[0].tool, 'search_trips');
  }
});

test('failed queries are surfaced as failed lookups rather than missing records, without leaking database details', async () => {
  let requests = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: async () => { throw Object.assign(Error('secret database URI'), { code: '42703' }); },
    fetchImpl: async (_url, options) => {
      if (++requests === 1) return toolResponse('database_query', { sql: 'SELECT wrong_column FROM trips', offset: 0 });
      const payload = JSON.parse(options.body);
      const output = payload.input.find(item => item.type === 'function_call_output');
      assert.match(output.output, /unknown table, column or function/);
      assert.doesNotMatch(options.body, /secret database URI/);
      return answerResponse('The lookup failed.');
    } });
  const result = await answer({ question: 'trip 62331575' });
  assert.match(result.answer, /failed lookups do not establish that records are missing/);
});

test('lookup limit reserves a final answer using evidence already retrieved', async () => {
  let executions = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: async () => { executions++; return { matched_count: 1 }; },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.tool_choice === 'none') return answerResponse('I found the trip but could not verify the return time. [S1]');
      return toolResponse('search_trips', filters);
    } });
  const result = await answer({ question: 'trip 62331575' });
  assert.equal(executions, 6);
  assert.equal(result.sources.length, 6);
  assert.match(result.answer, /found the trip/);
});
