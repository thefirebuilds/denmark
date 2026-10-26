const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { mapCheckInNotice } = require('../services/trips/checkInNotice');
test('check-in deadline is 24 elapsed hours after trip end with stable notice identity', () => {
  const trip = {id: 10, workflow_stage:'check_in', trip_end:'2026-11-01T00:00:00-05:00'};
  const before = mapCheckInNotice(trip, new Date('2026-11-02T04:59:59Z'));
  const due = mapCheckInNotice(trip, new Date('2026-11-02T05:00:00Z'));
  assert.equal(before.check_in_overdue, false);
  assert.equal(due.check_in_overdue, true);
  assert.equal(before.id, due.id);
  assert.equal(due.check_in_deadline, '2026-11-02T05:00:00.000Z');
  for (const override of [{workflow_stage:'awaiting_expenses'}, {closed_out:true}, {status:'canceled'}, {deleted_at:'2026-11-02'}, {trip_end:null}]) {
    assert.equal(mapCheckInNotice({...trip,...override}), null);
  }
});
test('normal progression requires check-in before awaiting expenses', () => {
  const context = vm.createContext({ module:{exports:{}}, require:()=>({}) });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../services/trips/transitionTripStage.js'),'utf8'),context);
  const {canTransition,getAllowedNextStages}=context.module.exports;
  assert.equal(canTransition('in_progress','check_in'),true);
  assert.equal(canTransition('in_progress','awaiting_expenses'),false);
  assert.equal(canTransition('check_in','awaiting_expenses'),true);
  assert.equal(getAllowedNextStages('check_in')[0],'awaiting_expenses');
  assert.equal(canTransition('check_in','complete'),false);
});
test('telemetry return rule uses the trip launch location and advances directly to check-in', async () => {
  const calls = [];
  const observations = [];
  const trip = {id: 11, pickup_location:'Garlic Creek', workflow_stage:'in_progress'};
  const deps = {
    fs: {readFileSync:()=>JSON.stringify({tripStageAutomations:[{enabled:true,fromStage:'in_progress',toStage:'check_in',conditions:[{type:'launch_location'}]}]})},
    path, './transitionTripStage':{transitionTripStage:async (...args)=>{calls.push(args);return {id:11};}},
    '../locations/locationSettings':{getEnabledLocations:async()=>[]},
    '../alerts/fleetAlerts':{getMatchedTripReturnGeoLocation:(row)=>row.address===row.return_location ? {location:{label:row.return_location}} : null,
      recordTripReturnObservation: async (...args) => { observations.push(args); return { returned_at: new Date().toISOString() }; }},
  };
  const context=vm.createContext({module:{exports:{}},__dirname:__dirname,console,require:name=>deps[name]});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../services/trips/autoAdvanceTurnaroundTrip.js'),'utf8'),context);
  let bookingWindowTimestamp;
  const client={query:async (sql, values)=>{
    if (!sql.includes('FROM vehicles')) bookingWindowTimestamp = values[2];
    return {rows:sql.includes('FROM vehicles')?[{turo_vehicle_id:'1'}]:[trip]};
  }};
  const run=context.module.exports.maybeAutoAdvanceTurnaroundTripFromTelemetry;
  assert.equal(await run(client,{vin:'VIN',address:'Other lot'}),null);
  await run(client,{vin:'VIN',address:'Garlic Creek',eventTimestamp:'2020-01-01T00:00:00Z', locationLastUpdated: '2026-10-26T16:12:00Z'});
  assert.ok(Math.abs(Date.now() - Date.parse(bookingWindowTimestamp)) < 5000, 'booking window uses poll time, not the stale movement timestamp');
  assert.equal(calls.length,1);
  assert.equal(calls[0][1],'check_in');
  assert.equal(observations.length, 1);
  assert.equal(observations[0][0].id, trip.id);
  assert.equal(observations[0][0].location_last_updated, '2026-10-26T16:12:00Z');
  assert.equal(observations[0][2], client);
});
test('early return does not start the clock; official end edits recompute the deadline', () => {
  const trip = { id: 12, workflow_stage: 'check_in', trip_end: '2026-10-14T18:00:00Z',
    returned_at: '2026-10-12T10:00:00Z', stage_updated_at: '2026-10-12T10:00:00Z' };
  const now = new Date('2026-10-15T19:00:00Z');
  const early = mapCheckInNotice(trip, new Date('2026-10-13T12:00:00Z'));
  assert.equal(early.check_in_deadline, '2026-10-15T18:00:00.000Z');
  assert.equal(early.check_in_overdue, false);
  assert.equal(mapCheckInNotice(trip, now).check_in_overdue, true);
  const extended = mapCheckInNotice({...trip, trip_end:'2026-10-16T18:00:00Z'}, now);
  assert.equal(extended.check_in_deadline, '2026-10-17T18:00:00.000Z');
  assert.equal(extended.check_in_overdue, false);
  const shortened = mapCheckInNotice({...trip, trip_end:'2026-10-13T18:00:00Z'}, now);
  assert.equal(shortened.check_in_deadline, '2026-10-14T18:00:00.000Z');
  assert.equal(shortened.check_in_overdue, true);
  assert.equal(extended.id, early.id);
});
test('check-in notice identifies fleet nickname and distinguishes observed from scheduled locations', () => {
  const trip={id:20,workflow_stage:'check_in',trip_end:'2026-10-12T20:00:00Z',vehicle_name:'Hyundai Accent',vehicle_nickname:'Delavan',pickup_location:'Launch lot'};
  const scheduled=mapCheckInNotice(trip);
  assert.equal(scheduled.vehicle_nickname,'Delavan');
  assert.equal(scheduled.check_in_location,'Launch lot');
  assert.equal(scheduled.check_in_location_label,'Scheduled location');
  const actual=mapCheckInNotice({...trip,last_location_address:'Garlic Creek',last_location_at:'2026-10-12T19:00:00Z'});
  assert.equal(actual.check_in_location,'Garlic Creek');
  assert.equal(actual.check_in_location_label,'Last reported location');
  assert.equal(actual.check_in_location_at,'2026-10-12T19:00:00Z');
});
test('check-in uses configured geofence names instead of street addresses', () => {
  const trip={id:21,workflow_stage:'check_in',trip_end:'2026-10-12T20:00:00Z',latitude:30,longitude:-97};
  const locations=[{id:'lot',label:'Launch Lot',latitude:30,longitude:-97,radiusMiles:.15,enabled:true}];
  assert.equal(mapCheckInNotice(trip,new Date(),locations).check_in_geofence,'Launch Lot');
  assert.equal(mapCheckInNotice({...trip,latitude:31},new Date(),locations).check_in_geofence,null);
});
test('return telemetry refuses ambiguous vehicle identity and gates tracker fallback on missing VIN', async () => {
  const context=vm.createContext({module:{exports:{}},__dirname,console,require:name=>name==='path'?path:{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../services/trips/autoAdvanceTurnaroundTrip.js'),'utf8'),context);
  const resolve=vm.runInContext('getVehicleForTelemetry',context);
  let query;
  const result=await resolve({query:async(sql)=>{query=sql;return {rows:[{id:1},{id:2}]};}}, {vin:'JUNEAUVIN',dimoTokenId:123});
  assert.equal(result,null);
  assert.match(query,/\$1 = '' AND \$2::text IS NOT NULL/);
  assert.match(query,/\$1 = '' AND \$3::text IS NOT NULL/);
});
