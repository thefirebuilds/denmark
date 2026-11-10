const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = { module: { exports: {} }, require: () => ({}) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/tolls/syncTolls.js'), 'utf8'), context);
const { matchTrip, clearInvalidAutomaticTripMatches, automaticTollEligibilitySql } = context.module.exports;

test('automatic toll matching uses occurrence time strictly within the reservation, without early or late grace', async () => {
  // Oct 27 is CDT: 6:57 PM is 23:57Z, while the 8 PM start is Oct 28 01:00Z.
  for (const [at, matches] of [['2026-10-27T23:57:00Z', false], ['2026-10-28T00:59:59Z', false],
    ['2026-10-28T01:00:00Z', true], ['2026-10-28T12:00:00Z', true],
    ['2026-10-29T01:00:00Z', true], ['2026-10-29T01:00:01Z', false]]) {
    let calls = 0;
    const trip = { id: 442, trip_start: '2026-10-28T01:00:00Z', trip_end: '2026-10-29T01:00:00Z' };
    const result = await matchTrip({ query: async (sql, args) => {
      if (++calls === 1) return { rows: [{ trxn_at: at, turo_vehicle_id: 'vehicle-1', posted_at: '2026-11-08T12:00:00Z' }] };
      assert.deepEqual(Array.from(args), ['vehicle-1', at]);
      assert.match(sql, /\$2::timestamptz >= t.trip_start/);
      assert.match(sql, /ELSE \$2::timestamptz <= t.trip_end END/);
      assert.match(sql, /ready.next_stage='ready_for_handoff'/);
      assert.match(sql, /ready.changed_at <= \$2::timestamptz/);
      assert.match(sql, /t.deleted_at IS NULL/);
      assert.match(sql, /LOWER\(t.status\)/);
      assert.doesNotMatch(sql, /INTERVAL|posted_at/);
      return { rows: new Date(at) >= new Date(trip.trip_start) && new Date(at) <= new Date(trip.trip_end) ? [trip] : [] };
    } }, 5);
    assert.equal(Boolean(result), matches);
  }
});

test('tolls without an exact vehicle or occurrence time stay unmatched', async () => {
  for (const row of [undefined, { trxn_at: null, turo_vehicle_id: 1 }, { trxn_at: '2026-10-27T23:57:00Z', turo_vehicle_id: null }]) {
    let calls = 0;
    const result = await matchTrip({ query: async () => { calls++; return { rows: row ? [row] : [] }; } }, 5);
    assert.equal(result, null); assert.equal(calls, 1);
  }
});

test('repair excludes manual, reviewed, billed and snapshotted tolls and preserves their vehicle match', async () => {
  const count = await clearInvalidAutomaticTripMatches({ query: async sql => {
    assert.match(sql, /tc.attributed_by='automatic_sync'/);
    assert.match(sql, /tc.review_status,''\) IN \('','pending','matched'\)/);
    assert.match(sql, /NOT IN \('billed','waived'\)/);
    assert.match(sql, /t.toll_charged_total,0\)=0/);
    assert.ok(sql.includes(`AND NOT (${automaticTollEligibilitySql('tc.trxn_at')})`));
    assert.match(sql, /trip_toll_billing_snapshot_items/);
    assert.match(sql, /SET matched_trip_id=NULL, match_status='vehicle_matched'/);
    assert.doesNotMatch(sql, /matched_vehicle_id\s*=/);
    return { rowCount: 1 };
  } });
  assert.equal(count, 1);
});

test('handoff and return policy executes against actual histories, including delayed imports and revoked readiness', () => {
  // Execute the production predicate in Node's built-in in-memory SQL engine.
  // Integer instants preserve timestamp ordering; no PostgreSQL casts are used
  // in this shared predicate, and no new test dependency/server is needed.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE trips(id INTEGER,trip_start INTEGER,trip_end INTEGER,returned_at INTEGER,
      return_detected_location TEXT,workflow_stage TEXT,status TEXT,deleted_at INTEGER,stage_updated_at INTEGER);
      CREATE TABLE trip_stage_history(id INTEGER,trip_id INTEGER,next_stage TEXT,changed_at INTEGER);`);
    const at = hour => new Date('2026-10-28T01:00:00Z').getTime() + hour * 3600000;
    const eligible = db.prepare(`SELECT ${automaticTollEligibilitySql(':at')} AS eligible FROM trips t`);
    const scenarios = [
      { name: 'not made ready', history: [], toll: 1, expected: false },
      { name: 'ready early does not allow pre-booking tolls', history: [['ready_for_handoff', -2]], toll: -1.05, expected: false },
      { name: 'not ready until after the toll', history: [['ready_for_handoff', 2]], toll: 1, expected: false },
      { name: 'ready boundary inclusive', history: [['ready_for_handoff', 1]], toll: 1, expected: true },
      { name: 'import after completion retains historical eligibility', history: [['ready_for_handoff', -1], ['in_progress', 0], ['complete', 25]], toll: 1, expected: true },
      { name: 'just before early return', history: [['ready_for_handoff', -1]], returned: 2, location: 'Return lot', toll: 1.99, expected: true },
      { name: 'stop exactly at return', history: [['ready_for_handoff', -1]], returned: 2, location: 'Return lot', toll: 2, expected: false },
      { name: 'owner transfer after early return', history: [['ready_for_handoff', -1]], returned: 2, location: 'Return lot', toll: 3, expected: false },
      { name: 'known late return uses actual location return time', history: [['ready_for_handoff', -1]], returned: 26, location: 'Return lot', toll: 25, expected: true },
      { name: 'no location return retains scheduled-end cap', history: [['ready_for_handoff', -1]], returned: 26, location: '', toll: 25, expected: false },
      { name: 'readiness revoked before toll', history: [['ready_for_handoff', 0], ['confirmed', 1]], toll: 2, expected: false },
      { name: 'made ready again', history: [['ready_for_handoff', 0], ['confirmed', 1], ['ready_for_handoff', 2]], toll: 3, expected: true },
      { name: 'revocation after occurrence does not erase prior eligibility', history: [['ready_for_handoff', 0], ['confirmed', 3]], toll: 2, expected: true },
      { name: 'same-time revocation uses history ID order', history: [['ready_for_handoff', 0], ['confirmed', 0]], toll: 1, expected: false },
      { name: 'same-time new readiness uses history ID order', history: [['confirmed', 0], ['ready_for_handoff', 0]], toll: 1, expected: true },
      { name: 'current ready timestamp fallback with no history', history: [], stage: 'ready_for_handoff', updated: 0, toll: 1, expected: true },
      { name: 'fallback cannot override recorded revocation', history: [['ready_for_handoff', 0], ['confirmed', 1]], stage: 'ready_for_handoff', updated: 0, toll: 2, expected: false },
    ];
    for (const s of scenarios) {
      db.exec('DELETE FROM trips; DELETE FROM trip_stage_history;');
      db.prepare('INSERT INTO trips VALUES (1,?,?,?,?,?,?,NULL,?)').run(at(0), at(24), s.returned == null ? null : at(s.returned), s.location || null, s.stage || 'complete', 'booked', at(s.updated ?? 25));
      s.history.forEach(([stage, hour], index) => db.prepare('INSERT INTO trip_stage_history VALUES (?,1,?,?)').run(index + 1, stage, at(hour)));
      assert.equal(Boolean(eligible.get({ at: at(s.toll) }).eligible), s.expected, s.name);
    }
  } finally { db.close(); }
});

test('overlapping eligible trips are held for review rather than assigned arbitrarily', async () => {
  let calls = 0;
  const result = await matchTrip({ query: async sql => {
    if (++calls === 1) return { rows: [{ trxn_at: '2026-10-28T02:00:00Z', turo_vehicle_id: 1 }] };
    assert.match(sql, /LIMIT 2/);
    return { rows: [{ id: 1 }, { id: 2 }] };
  } }, 5);
  assert.equal(result, null);
});
