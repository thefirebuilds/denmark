const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskTools } = require('../services/businessQuestions/taskTools');
const { createQuestionAnswerer } = require('../services/businessQuestions/answerQuestion');
const { createManualMaintenanceTask } = require('../services/maintenance/createManualMaintenanceTask');

const args = { vehicle_name: 'Geneva', title: 'Fix the headlights', description: '', priority: 'medium' };
test('shared manual task service persists an open to-do with AI provenance and existing defaults', async () => {
  const queries = [];
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes('INSERT INTO') ? [{ id: 42, title: 'Fix the headlights', status: 'open' }] : [{ vin: 'GENEVA-VIN' }] };
  } };
  const task = await createManualMaintenanceTask(client, 'GENEVA-VIN', {
    title: args.title, source: 'ai_assistant', createdFrom: 'messages_ai', reportedBy: 'owner',
  });
  assert.equal(task.id, 42);
  const insert = queries.find(q => q.sql.includes('INSERT INTO'));
  assert.match(insert.sql, /'manual_todo'/);
  assert.match(insert.sql, /'open'/);
  assert.equal(insert.params[0], 'GENEVA-VIN');
  assert.equal(insert.params[3], 'medium');
  assert.equal(insert.params[4], false);
  assert.equal(insert.params[6], 'ai_assistant');
  assert.equal(JSON.parse(insert.params[8]).createdFrom, 'messages_ai');
});
function fixture(vehicles = [{ id: 7, vin: 'GENEVA-VIN', nickname: 'Geneva' }]) {
  const queries = [];
  let released = false;
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: sql.includes('FROM vehicles') ? vehicles : [] };
  }, release() { released = true; } };
  return { queries, client, pool: { connect: async () => client }, get released() { return released; } };
}

test('AI task uses the resolved VIN, existing manual task workflow, and a committed result', async () => {
  const db = fixture();
  const execute = createTaskTools({ pool: db.pool, canWrite: true, reportedBy: 'owner@example.com',
    createTask: async (client, vin, input) => {
      assert.equal(client, db.client);
      assert.equal(vin, 'GENEVA-VIN');
      assert.equal(input.title, 'Fix the headlights');
      assert.equal(input.reportedBy, 'owner@example.com');
      assert.equal(input.source, 'ai_assistant');
      return { id: 42, title: input.title, status: 'open', priority: input.priority };
    } });
  const result = await execute('create_maintenance_task', args);
  assert.equal(result.created, true);
  assert.equal(result.task.id, 42);
  const lookup = db.queries.find(q => q.sql.includes('FROM vehicles'));
  assert.deepEqual(lookup.params, ['Geneva']);
  assert.match(lookup.sql, /vehicle_aliases/);
  assert.equal(db.queries.at(-1).sql, 'COMMIT');
  assert.equal(db.released, true);
});

test('unknown and ambiguous vehicle names never create a task', async () => {
  for (const vehicles of [[], [{ id: 1, vin: 'a' }, { id: 2, vin: 'b' }]]) {
    const db = fixture(vehicles);
    const execute = createTaskTools({ pool: db.pool, canWrite: true, createTask: () => assert.fail('must not write') });
    const result = await execute('create_maintenance_task', args);
    assert.match(result.error, /ambiguous/);
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(db.released, true);
  }
});

test('write permission and invalid arguments are rejected before database access', async () => {
  const pool = { connect: () => assert.fail('must not connect') };
  await assert.rejects(createTaskTools({ pool, canWrite: false })('create_maintenance_task', args), /permission/);
  const execute = createTaskTools({ pool, canWrite: true });
  for (const invalid of [{ ...args, title: '' }, { ...args, priority: 'critical' }, { ...args, sql: 'DELETE' }]) {
    await assert.rejects(execute('create_maintenance_task', invalid), /Invalid/);
  }
});

test('failed task creation rolls back and releases the connection', async () => {
  const db = fixture();
  const execute = createTaskTools({ pool: db.pool, canWrite: true, createTask: async () => { throw Error('write failed'); } });
  await assert.rejects(execute('create_maintenance_task', args), /write failed/);
  assert.equal(db.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(db.released, true);
});

test('task request resolves fleet then returns saved task without a second write or AI completion', async () => {
  let requests = 0, writes = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test',
    execute: async name => { assert.equal(name, 'list_fleet'); return { vehicles: [{ id: 7, nickname: 'Geneva' }] }; },
    executeTask: async (name, input) => {
      assert.equal(name, 'create_maintenance_task'); assert.deepEqual(input, args); writes++;
      return { created: true, vehicle: { nickname: 'Geneva' }, task: { id: 42, title: args.title } };
    },
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.ok(payload.tools.some(tool => tool.name === 'create_maintenance_task'));
      requests++;
      assert.ok(requests <= 2);
      return { ok: true, json: async () => ({ output: [{ type: 'function_call', call_id: `call-${requests}`,
        name: requests === 1 ? 'list_fleet' : 'create_maintenance_task',
        arguments: JSON.stringify(requests === 1 ? {} : args) }] }) };
    } });
  const result = await answer({ question: 'Add a todo to fix the headlights on Geneva' });
  assert.match(result.answer, /Added to-do #42 for Geneva: Fix the headlights/);
  assert.equal(result.sources.at(-1).data.task.id, 42);
  assert.equal(writes, 1);
});

test('read-only users have no write tool and cannot invoke it through model output', async () => {
  let requests = 0;
  const answer = createQuestionAnswerer({ apiKey: () => 'test', execute: () => assert.fail('must not execute'),
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.ok(!payload.tools.some(tool => tool.name === 'create_maintenance_task'));
      requests++;
      return { ok: true, json: async () => ({ output: requests === 1
        ? [{ type: 'function_call', call_id: 'call-1', name: 'create_maintenance_task', arguments: JSON.stringify(args) }]
        : [{ type: 'message', content: [{ type: 'output_text', text: 'Task creation is unavailable.' }] }] }) };
    } });
  const result = await answer({ question: 'Add a todo to fix the headlights on Geneva' });
  assert.equal(result.sources.length, 0);
});
