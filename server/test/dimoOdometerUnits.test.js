const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, dependencies = {}) {
  const context = vm.createContext({ module: { exports: {} }, process, console,
    require: name => dependencies[name] || {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), context);
  return context;
}

test('default DIMO input converts kilometers while a per-vehicle miles override preserves dashboard miles', () => {
  const { normalizeDimoSnapshot } = load('../services/dimo/collectDimoSnapshot.js').module.exports;
  const raw = { data: { signalsLatest: { powertrainTransmissionTravelledDistance: { value: 135000 }, speed: { value: 100 } } } };
  const standard = normalizeDimoSnapshot(raw, { vin: 'VIN', tokenId: 7 });
  const corrected = normalizeDimoSnapshot(raw, { vin: 'VIN', tokenId: 7, dimo_odometer_unit: 'mi' });
  assert.equal(Math.round(standard.odometer), 83885);
  assert.equal(corrected.odometer, 135000);
  assert.equal(corrected.speed, standard.speed);
  assert.equal(corrected.raw_payload.odometerInputUnit, 'mi');
  assert.equal(corrected.raw_payload.raw, raw);
});

test('fleet status keeps maintenance mileage authoritative while retaining the lower provider reading', async () => {
  const vehicle = { id: 1, vin: 'VIN', nickname: 'Toyota', current_odometer_miles: 135200 };
  const context = load('../services/vehicles/statusFeed.js', {
    '../../db': { query: async () => ({ rows: [vehicle] }) },
    '../bouncie/statusFeed': { getBouncieStatusFeed: async () => [] },
    '../dimo/statusFeed': { getDimoStatusFeed: async () => [{ vin: 'VIN', dimo_token_id: 7, telemetry: { odometer: 83885 } }] },
  });
  const result = await context.module.exports.getCombinedVehicleStatusFeed({ force: true });
  assert.equal(result[0].telemetry.odometer, 135200);
  assert.equal(result[0].telemetry.reported_odometer, 83885);
  assert.equal(result[0].current_odometer_miles, 135200);
  assert.equal(context.getDisplayOdometer(135200, 135300), 135300);
  assert.equal(context.getDisplayOdometer(null, null), null);
  assert.equal(context.getDisplayOdometer(0, null), 0);
});

test('DIMO history insertion rejects readings below the recorded mileage floor', async () => {
  const context = load('../services/dimo/collectDimoSnapshot.js');
  let query;
  await context.insertDimoOdometerHistory({ vin: 'VIN', odometer: 83885 }, { query: async (sql, values) => {
    query = sql;
    assert.equal(values[1], 83885);
    return { rowCount: 0 };
  } });
  assert.match(query, /\$2 >= COALESCE\(v.current_odometer_miles, 0\)/);
});
