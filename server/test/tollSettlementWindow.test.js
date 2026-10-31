const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, require: () => ({}), Date, Map, Number };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/tolls/settlementWindow.js'), 'utf8'), context);
const { settlementState, assertTollsSettled, attachTollSettlement } = context.module.exports;
const trip = { id: 42, trip_end: '2026-10-01T00:00:00Z' };
const policy = { delay_hours: 150, sample_count: 100, last_success_at: '2026-10-07T07:00:00Z' };

test('learned arrival window holds billing beyond the old fixed wait', () => {
  const state = settlementState(trip, policy, null, '2026-10-06T00:00:00Z');
  assert.equal(state.toll_collection_ready, false);
  assert.equal(state.toll_collection_due_at, '2026-10-07T06:00:00.000Z');
  assert.equal(settlementState(trip, policy, null, '2026-10-07T08:00:00Z').toll_collection_ready, true);
});

test('late toll restarts quiet period and requires a subsequent successful pull', () => {
  const arrival = '2026-10-07T00:00:00Z';
  const waiting = settlementState(trip, policy, arrival, '2026-10-08T00:00:00Z');
  assert.equal(waiting.toll_collection_due_at, '2026-10-09T00:00:00.000Z');
  assert.equal(waiting.toll_collection_ready, false);
  const after = '2026-10-09T01:00:00Z';
  assert.equal(settlementState(trip, policy, arrival, after).toll_collection_ready, false);
  assert.equal(settlementState(trip, { ...policy, last_success_at: after }, arrival, after).toll_collection_ready, true);
});

test('stale or missing successful pulls cannot release a billing hold', () => {
  assert.equal(settlementState(trip, policy, null, '2026-10-10T00:00:00Z').toll_collection_ready, false);
  assert.equal(settlementState(trip, { ...policy, last_success_at: null }, null, '2026-10-10').toll_collection_ready, false);
  assert.equal(settlementState({ id: 1 }, policy, null).toll_collection_ready, false);
});

test('batch enrichment associates arrivals with the correct trips', async () => {
  const client = { query: async (sql, params) => params
    ? { rows: [{ matched_trip_id: 42, last_arrival: new Date().toISOString() }] }
    : { rows: [{ delay_hours: 100, last_success_at: new Date().toISOString() }] } };
  const states = await attachTollSettlement([trip, { ...trip, id: 43 }], client);
  assert.equal(states[0].toll_collection_ready, false);
  assert.equal(states[1].toll_collection_ready, true);
  await assert.rejects(assertTollsSettled(trip, client), error => error.statusCode === 409);
  await assertTollsSettled({ ...trip, status: 'canceled' }, { query: () => { throw new Error('should not query'); } });
});
