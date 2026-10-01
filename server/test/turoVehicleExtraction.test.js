const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTuroVehicle } = require('../services/vehicles/extractTuroVehicle');
test('stored-email repair skips conflicting identities and updates only missing managed-vehicle links', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: values ? [] : [
      { reservation_id: 'louis', html_body: '<img data-vehicle-id="1234567">' },
      { reservation_id: 'ambiguous', vehicle_listing_id: '111' },
      { reservation_id: 'ambiguous', vehicle_listing_id: '222' },
    ] };
  } };
  const context = vm.createContext({ module: { exports: {} },
    require: name => name === '../../db' ? pool : { extractTuroVehicle } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/vehicles/backfillTripVehicleIds.js'), 'utf8'), context);
  await context.module.exports.backfillTripVehicleIds();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].values[0], 'louis');
  assert.equal(calls[1].values[1], '1234567');
  assert.match(calls[1].sql, /NULLIF\(TRIM\(turo_vehicle_id\), ''\) IS NULL/);
  assert.match(calls[1].sql, /EXISTS \(SELECT 1 FROM vehicles/);
});
test('Tucson listing image links resolve independently of the model name and rental category', () => {
  for (const category of ['car', 'suv', 'truck']) {
    const url = `https://turo.com/us/en/${category}-rental/united-states/austin-tx/hyundai/tucson/1234567?source=email`;
    assert.equal(extractTuroVehicle(`<a href='${url}'><img src='https://images.turo.com/photo.jpg'></a>`).id, '1234567');
    assert.equal(extractTuroVehicle(`<a href="${encodeURIComponent(url)}"><img src="photo"></a>`).id, '1234567');
  }
});
test('explicit image vehicle identifiers work without listing links', () => {
  for (const html of ['<img data-vehicle-id="1234567" src="photo">',
    '<img src="https://images.turo.com/vehicle/1234567/photo.jpg">',
    '<img src="https://images.turo.com/photo?size=400&amp;vehicleId=1234567">']) {
    assert.equal(extractTuroVehicle(html).id, '1234567');
  }
});
test('reservation IDs, arbitrary photo IDs and ambiguous vehicles are not guessed', () => {
  for (const html of ['https://turo.com/reservation/1234567',
    '<img src="https://images.turo.com/media/vehicle/images/1234567.jpg">',
    '<img src="https://other.com/vehicle/1234567/photo.jpg">',
    '<img data-vehicle-id="123"><img data-vehicle-id="456">']) {
    assert.equal(extractTuroVehicle(html).id, null);
  }
});
