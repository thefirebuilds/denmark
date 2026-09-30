const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fleet = [
  { id: '2', turo_vehicle_id: '3284235', nickname: 'Juneau', turo_vehicle_name: 'Hyundai Accent 2017', aliases: ['Old Juneau'] },
  { id: '3', turo_vehicle_id: '999', nickname: 'Other', turo_vehicle_name: 'Hyundai Accent 2017', aliases: [] },
];
const currentTrip = { id: 1, turo_vehicle_id: '999', vehicle_name: 'Hyundai Accent 2017',
  status: 'booked', trip_start: '2026-09-29T15:00:00Z', trip_end: '2026-10-04T15:00:00Z' };

async function availability(trips, vehicles = fleet) {
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-09-30T14:19:01.542Z'])); }
    },
    require(name) {
      if (name === '../db') return { query: async (sql) => {
        if (sql.includes('FROM trips t')) return { rows: trips };
        assert.match(sql, /va.active = true/);
        return { rows: vehicles };
      } };
      return { ensureVehicleAliasesTable: async () => {}, ensureVehicleRuntimeSchema: async () => {} };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/publicAvailability.js'), 'utf8'), context);
  return context.module.exports.getPublicAvailability();
}

test('another Accent cannot block Juneau or contribute to its typical rate', async () => {
  const rows = await availability([currentTrip, { ...currentTrip, id: 2,
    trip_start: '2026-09-01', trip_end: '2026-09-04', amount: 200, status: 'completed' }]);
  assert.equal(rows[0].status, 'available_now');
  assert.equal(rows[0].unavailableDates.length, 0);
  assert.equal(rows[0].typicalDailyRate, null);
  assert.equal(rows[1].status, 'unavailable_until_current_trip_ends');
  assert.equal(rows[1].nextAvailableDate, '2026-10-05');
  assert.equal(rows[1].typicalDailyRate.sampleSize, 1);
});

test('unknown Turo IDs never fall back to names or collide with local vehicle IDs', async () => {
  for (const id of ['unowned', '2']) {
    const rows = await availability([{ ...currentTrip, turo_vehicle_id: id, vehicle_name: 'Juneau' }]);
    assert.ok(rows.every(row => row.status === 'available_now'));
  }
});

test('missing IDs allow unique nicknames and active aliases, but not shared model names', async () => {
  for (const name of [' Juneau ', 'OLD   JUNEAU']) {
    const rows = await availability([{ ...currentTrip, turo_vehicle_id: null, vehicle_name: name }]);
    assert.equal(rows[0].status, 'unavailable_until_current_trip_ends');
    assert.equal(rows[1].status, 'available_now');
  }
  const rows = await availability([{ ...currentTrip, turo_vehicle_id: null }]);
  assert.ok(rows.every(row => row.status === 'available_now'));
});

test('non-public vehicles still prevent ambiguous name attribution', async () => {
  const rows = await availability([{ ...currentTrip, turo_vehicle_id: null }],
    [fleet[0], { ...fleet[1], trip_eligible: false }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'available_now');
});

test('canceled, closed and deleted trips do not block the correct vehicle', async () => {
  for (const flags of [{ status: 'canceled' }, { canceled_at: '2026-09-29' },
    { closed_out: true }, { deleted_at: '2026-09-29' }]) {
    const rows = await availability([{ ...currentTrip, turo_vehicle_id: '3284235', ...flags }]);
    assert.equal(rows[0].status, 'available_now');
    assert.equal(rows[0].unavailableDates.length, 0);
  }
});
