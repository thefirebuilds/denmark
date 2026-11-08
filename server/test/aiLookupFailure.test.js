const test = require('node:test');
const assert = require('node:assert/strict');
const { describeLookupFailure, explicitTelemetryTripId } = require('../services/businessQuestions/lookupFailure');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');
const { requestContext } = require('../services/infra/requestContext');
const oldPrompt = 'Review the stored telemetry JSON for internal trip ID 442. Does anything indicate a possible accident or inappropriate driving behavior?';
const response = text => ({ ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }) });

test('explicit legacy review wording resolves the internal trip without guessing reservation IDs', () => {
  assert.equal(explicitTelemetryTripId({}, oldPrompt), 442);
  assert.equal(explicitTelemetryTripId({ telemetry_trip_id: 7 }, oldPrompt), 7);
  for (const text of ['Review telemetry for trip 442', 'Review internal trip ID 442 revenue',
    'Compare telemetry for internal trip ID 442 and internal trip ID 443', 'Review telemetry for internal trip ID 9007199254740992']) {
    assert.equal(explicitTelemetryTripId({}, text), undefined);
  }
});

test('safe lookup classification distinguishes actual failures without copying raw database errors', () => {
  for (const [error, expected] of [
    [{ code: 'ECONNREFUSED', message: 'SECRET' }, 'database_unavailable'],
    [{ errors: [{ code: 'ECONNREFUSED', message: 'SECRET' }] }, 'database_unavailable'],
    [Error('timeout exceeded when trying to connect'), 'database_unavailable'],
    [{ code: '57014', message: 'SECRET SQL' }, 'query_timeout'],
    [{ code: '42501', message: 'SECRET' }, 'database_permission_denied'],
    [{ code: '42P01', message: 'SECRET SQL' }, 'schema_error'],
    [{ code: 'AI_INVALID_TOOL_ARGUMENTS' }, 'invalid_arguments'],
    [{ code: 'AI_RESULT_TOO_LARGE' }, 'result_too_large'],
    [{ statusCode: 404, message: 'SECRET' }, 'record_not_found'],
    [new Error('SECRET'), 'lookup_failed'],
  ]) {
    const result = describeLookupFailure(error);
    assert.equal(result.code, expected);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('the exact old prompt for trip 442 loads imported events directly before the model response', async () => {
  const calls = [];
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: async (name, args) => {
    calls.push({ name, args });
    assert.equal(name, 'trip_telemetry'); assert.equal(args.trip_id, 442);
    return { data: [{ id: 9, event_name: 'behavior.harshBraking' }], categories: [{ event_name: 'behavior.harshBraking', count: 1788 }], imports: [], has_more: true, next_cursor: '9' };
  }, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(calls.length, 1);
    assert.notDeepEqual(payload.tool_choice, { type: 'function', name: 'search_trips' });
    assert.match(payload.input.find(i => i.type === 'function_call_output').output, /1788/);
    return response('Imported harsh-braking records are available; this is a partial review. [S1]');
  } });
  const result = await answer({ question: oldPrompt });
  assert.equal(result.sources[0].filters.trip_id, 442);
  assert.equal(result.sources[0].filters.view, 'incidents');
  assert.equal(result.lookupFailures.length, 0);
});

test('a real lookup failure is visible in the answer and UX log with correlation, but no secrets or SQL', async () => {
  const logs = [];
  const answer = createQuestionAnswerer({ apiKey: () => 'test', logger: { warn: (...args) => logs.push(args) },
    execute: async () => { throw Object.assign(Error('postgres://SECRET:password@host/db SELECT guest_name'), { code: '57014' }); },
    fetchImpl: async (_url, options) => {
      assert.match(options.body, /query_timeout/);
      assert.doesNotMatch(options.body, /SECRET|SELECT guest_name/);
      return response('The telemetry lookup timed out.');
    } });
  const result = await requestContext.run({ correlationId: 'request-442' }, () => answer({ question: oldPrompt }));
  assert.equal(result.sources.length, 0);
  assert.equal(result.lookupFailures[0].code, 'query_timeout');
  assert.match(result.answer, /trip_telemetry\/incidents: The database query timed out/);
  assert.equal(logs[0][0], '[ai] data lookup failed');
  assert.equal(logs[0][1].trip_id, 442);
  assert.equal(logs[0][1].correlation_id, 'request-442');
  assert.doesNotMatch(JSON.stringify({ result, logs }), /SECRET|SELECT guest_name/);
});
