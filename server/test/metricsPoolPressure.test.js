const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('financial detail obtains fleet metrics before checking out its own connection', async () => {
  let checkedOut = false;
  let fleetMetricsLoaded = false;
  let releases = 0;
  const ensure = async (...args) => {
    assert.equal(checkedOut, false, 'schema setup must precede checkout');
    assert.equal(args.length, 0, 'use the shared pool schema initializer');
  };
  const pool = { connect: async () => {
    assert.equal(fleetMetricsLoaded, true);
    checkedOut = true;
    return { release: () => { checkedOut = false; releases++; } };
  } };
  const context = vm.createContext({ module: { exports: {} }, require: name => {
    if (name === '../../db') return pool;
    if (name === '../vehicles/vehicleRuntimeSchema') return { ensureVehicleRuntimeSchema: ensure };
    if (name === '../vehicles/vehicleAliases') return { ensureVehicleAliasesTable: ensure };
    if (name === './metricHelpers') return { getDateRange: () => ({ key: '30d' }) };
    return {};
  }, assert, metricsLoaded: () => { assert.equal(checkedOut, false); fleetMetricsLoaded = true; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/metrics/vehicleMetricsService.js'), 'utf8'), context);
  vm.runInContext(`
    getVehicleMetrics = async () => { metricsLoaded(); return { vehicles: [] }; };
    fetchActiveVehicles = async () => { throw new Error('read failed'); };
    fetchTripsForVehicles = async () => [];
    fetchExpensesForVehicles = async () => [];
  `, context);
  await assert.rejects(context.module.exports.getVehicleFinancialDetail('1'), /read failed/);
  assert.equal(releases, 1);
});
