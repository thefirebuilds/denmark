const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadService(file, dependencies) {
  const context = vm.createContext({ module: { exports: {} }, process, console,
    require(name) {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  return context.module.exports;
}

test('combined feed only includes managed cars and rejects transferred trackers', async () => {
  const fleet = [{ id: 1, vin: 'OWNVIN', nickname: 'Own car', imei: 'sold-device' },
    { id: 2, vin: 'MATCHVIN', nickname: 'Second car' }];
  const service = loadService('../services/vehicles/statusFeed.js', {
    '../../db': { query: async () => ({ rows: fleet }) },
    '../bouncie/client': {},
    '../bouncie/statusFeed': { getBouncieStatusFeed: async () => [
      { vin: 'FRIENDVIN', nickname: 'Own car', imei: 'sold-device', telemetry: { odometer: 999999 } },
      { vin: ' matchvin ', nickname: 'Provider name', telemetry: { odometer: 12345 } },
    ] },
    '../dimo/statusFeed': { getDimoStatusFeed: async () => [{ vin: 'UNMANAGEDVIN' }] },
  });
  const result = await service.getCombinedVehicleStatusFeed({ force: true });
  assert.equal(result.length, 2);
  assert.equal(result[0].vin, 'OWNVIN');
  assert.equal(result[0].telemetry, null);
  assert.equal(result[1].telemetry.odometer, 12345);
  assert.equal(result[1].nickname, 'Second Car');
});

test('Bouncie status excludes unknown VINs and devices without a VIN', async () => {
  const service = loadService('../services/bouncie/statusFeed.js', {
    '../../db': { query: async () => ({ rows: [{ vin: 'OWNVIN', nickname: 'Own car' }] }) },
    './client': { getVehicles: async () => [
      { vin: ' ownvin ', stats: {} }, { vin: 'FRIENDVIN' }, { imei: 'sold-device' },
    ] },
  });
  const result = await service.getBouncieStatusFeed();
  assert.equal(result.length, 1);
  assert.equal(result[0].nickname, 'Own car');
});
