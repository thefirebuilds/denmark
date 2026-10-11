const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('battery norm alerts only below the floor, with critical lows preserved', async () => {
  const context = vm.createContext({ module: { exports: {} }, require: () => ({}) });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../services/maintenance/getVehicleMaintenanceSummary.js'), 'utf8'), context);
  const evaluate = vm.runInContext('getBatteryVoltageHealth', context);
  async function health(voltage) {
    return evaluate({ query: async () => ({ rows: [{
      current_voltage: voltage, low_voltage: 12.12, high_voltage: 14.31,
      average_voltage: 13, stddev_voltage: 0.3, sample_count: 100,
    }] }) }, 'VIN');
  }
  assert.equal((await health(14.31)).needsInspection, false);
  assert.equal((await health(12.45)).needsInspection, false);
  assert.equal((await health(12.4)).needsInspection, false);
  const low = await health(12.39);
  assert.equal(low.inspectionReason, 'below_30_day_norm');
  assert.match(low.status, /12\.40v/);
  assert.equal((await health(11.8)).inspectionReason, 'critical_low_voltage');
});
