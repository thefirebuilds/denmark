const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, require: () => ({}), Date, Map, Number };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/tolls/settlementWindow.js'), 'utf8'), context);
const { settlementState, assertTollsSettled, attachTollSettlement, getSettlementDelayHours, POLICY_SQL } = context.module.exports;
const trip = { id: 42, trip_end: '2026-10-01T00:00:00Z' };
const policy = { delay_hours: 150, sample_count: 100, last_success_at: '2026-10-07T07:00:00Z' };

test('longest observed delay controls the hold even with a single late receipt', () => {
  const learned = { max_hours: 135, sample_count: 1, delay_hours: 100,
    last_success_at: '2026-10-07T15:00:00Z' };
  assert.equal(getSettlementDelayHours(learned), 159);
  assert.equal(getSettlementDelayHours({ max_hours: 200, sample_count: 1 }), 224);
  assert.equal(getSettlementDelayHours({ max_hours: 12 }), 100);
  const state = settlementState(trip, learned, null, '2026-10-06T15:00:00Z');
  assert.equal(state.toll_collection_ready, false);
  assert.equal(state.toll_collection_due_at, '2026-10-07T15:00:00.000Z');
  assert.equal(settlementState(trip, learned, null, '2026-10-07T15:00:00Z').toll_collection_ready, true);
  assert.match(POLICY_SQL, /MAX\(hours\) AS max_hours/);
  assert.doesNotMatch(POLICY_SQL, /percentile_cont|sample_count >=/);
});

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

test('toll drawer uses the enforced hold and quiet period instead of a separate 100-hour deadline', async () => {
  const metrics = require('../services/metrics/metricHelpers');
  const source = fs.readFileSync(path.join(__dirname, '../services/metrics/summaryService.js'), 'utf8');
  const client = { release() {} };
  const end = '2026-10-01T00:00:00Z';
  const received = '2026-10-06T15:00:00Z'; // 135 hours after trip end
  const learned = { max_hours: 135, sample_count: 1, delay_hours: 159,
    last_success_at: '2026-10-07T06:00:00Z' };
  const sandbox = vm.createContext({
    pool: { connect: async () => client },
    ensureTollAuditSchema: async () => {},
    getDateRange: () => ({ key: '30d' }),
    getTollSettlementPolicy: async receivedClient => {
      assert.equal(receivedClient, client);
      return learned;
    },
    settlementState: (record, policy, arrival) => settlementState(record, policy, arrival, '2026-10-07T06:00:00Z'),
    QUIET_HOURS: 48, BUFFER_HOURS: 24,
    fetchTripsInRange: async () => [{ id: 42, trip_end: end, toll_total: 20,
      workflow_stage: 'awaiting_expenses', toll_review_status: 'pending' }],
    fetchTollChargesInRange: async () => [],
    fetchTollChargesForTripIds: async () => [{ id: 1, matched_trip_id: 42,
      source: 'hctra_eztag', created_at: received, amount: 20 }],
    fetchTollInvoiceMessages: async () => [], fetchLatestTollBillingSnapshots: async () => [],
    getNormalizedTollStatus: record => record.toll_review_status,
    mapUnattributedTollCharge: record => record,
    roundMoney: metrics.roundMoney,
    isTripTollAttributedOutstanding: metrics.isTripTollAttributedOutstanding,
    isTripTollRecovered: metrics.isTripTollRecovered,
    isTripTollBillingFinalized: metrics.isTripTollBillingFinalized,
  });
  vm.runInContext(source.slice(source.indexOf('async function getTollMetricsDetail('),
    source.indexOf('async function getSummaryMetrics(')), sandbox);
  const detail = await sandbox.getTollMetricsDetail();
  assert.equal(detail.arrival_timing.max_hours_after_trip_end, 135);
  assert.equal(detail.arrival_timing.closeout_delay_hours, 159);
  assert.equal(detail.outstanding.count, 1);
  assert.equal(detail.outstanding.trips[0].collection_due_at, '2026-10-08T15:00:00.000Z');
});
