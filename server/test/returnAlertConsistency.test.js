const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parking = { id: 'park-my-share', label: 'Park My Share', kind: 'parking', enabled: true,
  latitude: 30.22, longitude: -97.67, lat: 30.22, lon: -97.67, radiusMiles: 0.15 };
function fixture({ failStageOnce = false, returnLocation = '1600 E Hwy 71, Austin, TX', returnedAt = null } = {}) {
  const now = Date.now();
  const state = { id: 7, vehicle_nickname: 'Neenah', vehicle_name: 'Neenah', guest_name: 'Guest',
    workflow_stage: 'in_progress', return_location: returnLocation, pickup_location: 'Fletcher Bend',
    trip_start: new Date(now - 86400000).toISOString(), trip_end: new Date(now - 3600000).toISOString(),
    service_name: 'dimo', latitude: parking.latitude, longitude: parking.longitude,
    location_last_updated: new Date(now - 3900000).toISOString(), captured_at: new Date(now).toISOString(), returned_at: returnedAt };
  const queries = [], transitions = [];
  const pool = { query: async (sql, values) => {
    queries.push({ sql, values });
    if (sql.includes('UPDATE trips SET')) {
      state.returned_at ||= values[1];
      return { rows: [{ returned_at: state.returned_at, return_late_minutes: values[2] }] };
    }
    if (sql.includes('WHERE t.trip_end < NOW()')) return { rows: !state.returned_at && state.workflow_stage === 'in_progress' ? [{ ...state }] : [] };
    if (sql.includes('COALESCE(NULLIF(t.return_location')) {
      assert.match(sql, /COALESCE\(NULLIF\(t.return_location,''\),NULLIF\(t.pickup_location,''\)\)/);
      return { rows: [{ ...state }] };
    }
    if (sql.startsWith('SELECT returned_at')) return { rows: [{ returned_at: state.returned_at }] };
    return { rows: [], rowCount: 1 };
  } };
  const context = vm.createContext({ module: { exports: {} }, process, console,
    require(name) {
      if (name === '../../db') return pool;
      if (name === 'luxon') return require('luxon');
      if (name === '../locations/locationSettings') return { getEnabledLocations: async () => [parking], getPrimaryParkingLocation: async () => parking };
      if (name === '../trips/transitionTripStage') return { transitionTripStage: async (id, stage, options) => {
        transitions.push({ id, stage, options });
        if (failStageOnce) { failStageOnce = false; throw Error('temporary stage failure'); }
        state.workflow_stage = stage;
      } };
      return {};
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/alerts/fleetAlerts.js'), 'utf8'), context);
  return { context, state, queries, transitions };
}

test('Neenah at the booked parking site advances to Check In and cannot produce an overdue alert', async () => {
  const { context, state, transitions } = fixture();
  const result = await context.autoAdvanceReturnedTripsAtExpectedGeoLocations();
  assert.equal(result.advanced, 1);
  assert.equal(state.workflow_stage, 'check_in');
  assert.ok(state.returned_at);
  assert.equal(transitions[0].options.changedAt, state.location_last_updated);
  assert.equal((await context.collectOverdueReturnAlerts()).length, 0);
  assert.equal((await context.collectReturnedToParkingSpotAlerts()).length, 1);
});

test('parking SMS collector records the return before announcing it', async () => {
  const { context, state } = fixture({ returnLocation: 'Park My Share' });
  const messages = await context.collectReturnedToParkingSpotAlerts();
  assert.equal(messages.length, 1);
  assert.equal(state.workflow_stage, 'check_in');
  assert.ok(state.returned_at);
  assert.equal((await context.collectOverdueReturnAlerts()).length, 0);
});

test('a saved arrival retries a failed Check In transition on the next alert pass', async () => {
  const { context, state, transitions } = fixture({ failStageOnce: true });
  await context.autoAdvanceReturnedTripsAtExpectedGeoLocations();
  assert.ok(state.returned_at);
  assert.equal(state.workflow_stage, 'in_progress');
  await context.autoAdvanceReturnedTripsAtExpectedGeoLocations();
  assert.equal(state.workflow_stage, 'check_in');
  assert.equal(transitions.length, 2);
});

test('parking proximity cannot confirm a car booked to return to Fletcher Bend', async () => {
  const { context, state } = fixture({ returnLocation: '135 Fletcher Bend, Buda, TX' });
  assert.equal((await context.collectReturnedToParkingSpotAlerts()).length, 0);
  assert.equal(state.returned_at, null);
  assert.equal(state.workflow_stage, 'in_progress');
});
