const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ module: { exports: {} }, require: () => ({}) });
vm.runInContext(fs.readFileSync(path.join(__dirname,
  '../services/maintenance/homeMaintenanceNotices.js'), 'utf8'), context);
const { buildHomeMaintenanceNotices: build } = context.module.exports;
const now = Date.parse('2026-09-30T18:00:00Z');
const locations = [{ id: 'garlic-creek', label: 'Garlic Creek', latitude: 30,
  longitude: -97, radiusMiles: 0.15 }];
const car = { id: 2, nickname: 'Juneau', vin: 'VIN', latitude: 30, longitude: -97,
  seen_at: new Date(now - 60000).toISOString(), tasks: [{ id: 4, title: 'Check tires', status: 'open' }] };

test('one card per vehicle at home includes all pending tasks and cars without tasks', () => {
  const notices = build([car, { ...car, id: 3, tasks: [] }], locations, now);
  assert.equal(notices.length, 2);
  assert.equal(notices[0].maintenance_tasks[0].title, 'Check tires');
  assert.equal(notices[1].maintenance_task_count, 0);
  assert.notEqual(notices[0].id, notices[1].id);
});

test('cars outside the fence or with old, invalid, or future GPS readings are excluded', () => {
  for (const change of [{ latitude: 31 }, { latitude: null }, { seen_at: null },
    { seen_at: new Date(now - 25 * 3600000).toISOString() },
    { seen_at: new Date(now + 3600000).toISOString() }]) {
    assert.equal(build([{ ...car, ...change }], locations, now).length, 0);
  }
  assert.equal(build([car], [], now).length, 0);
  assert.equal(build([car], [{ ...locations[0], id: 'other', label: 'Other parking' }], now).length, 0);
});
