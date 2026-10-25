const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('trip and map resolve the same primary return site regardless of location order', async () => {
  const { getConfiguredReturnLocation } = await import('../../shared/returnLocation.mjs');
  const locations = [
    { label: 'Park My Share', kind: 'parking', lat: 30.2, lon: -97.7 },
    { label: 'Garlic Creek', kind: 'parking', lat: 30.08, lon: -97.85 },
  ];
  const trip = getConfiguredReturnLocation({ return_location: '135 Fletcher Bend, Buda, TX' }, locations);
  const map = getConfiguredReturnLocation({ returnLocation: '135 Fletcher Bend, Buda, TX' }, locations);
  assert.equal(trip.label, 'Garlic Creek');
  assert.equal(map, trip);
  assert.equal(getConfiguredReturnLocation({ returnLocation: 'Airport terminal' }, locations), null);
  assert.equal(getConfiguredReturnLocation({ returnLocation: 'Park My Share' }, locations).label, 'Park My Share');
  assert.equal(getConfiguredReturnLocation({}, [{ ...locations[1], enabled: false }]), null);
});

test('trip location and motion use the map observation for the same VIN and preserve mileage', async () => {
  const { withMapTelemetry, describeVehicleBehavior } = await import('../../shared/tripLocationTelemetry.mjs');
  const original = { vin: 'BELLE', telemetry: { odometer: 120000, speed: 34, engine_running: true,
    last_comm: '2026-10-23T15:51:00Z', location: { lat: 30.011, lon: -97.868 } } };
  const location = { vin: ' belle ', lat: 30.3, lon: -97.9, speed: 0, isRunning: true,
    telemetryDiagnostics: { locationSignalAt: '2026-10-23T15:55:00Z' } };
  const vehicle = withMapTelemetry(original, [location]);
  assert.equal(vehicle.telemetry.speed, 0);
  assert.equal(vehicle.telemetry.location.lat, location.lat);
  assert.equal(vehicle.telemetry.odometer, 120000);
  assert.equal(vehicle.telemetry.timestamps.location_last_updated, '2026-10-23T15:55:00Z');
  assert.equal(describeVehicleBehavior(vehicle.telemetry), 'Engine running, currently stopped');
  assert.equal(original.telemetry.speed, 34);
  assert.equal(withMapTelemetry(original, [{ ...location, vin: 'OTHER' }]), original);
  assert.equal(describeVehicleBehavior({ engine_running: null, speed: null }), 'Current movement unavailable');
  assert.equal(describeVehicleBehavior({ engine_running: true, speed: null }), 'Engine running; speed unavailable');
});

test('stored locations distinguish GPS time from a general check-in and suppress stale motion', async () => {
  const rows = [
    { id: 1, vin: 'BELLE', latitude: 30, longitude: -97, speed: 34, is_running: true,
      last_seen: new Date().toISOString(), running_last_seen: new Date(Date.now() - 3600000).toISOString(),
      speed_last_seen: new Date(Date.now() - 3600000).toISOString(), location_signal_at: null },
    { id: 2, vin: 'SECOND', latitude: 30, longitude: -97, speed: 0,
      last_seen: new Date().toISOString(), speed_last_seen: new Date().toISOString() },
  ];
  const context = vm.createContext({ module: { exports: {} }, process, console,
    require(name) { assert.equal(name, '../../db'); return {}; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/vehicles/locationFeed.js'), 'utf8'), context);
  const result = await context.module.exports.getStoredVehicleLocations({ query: async () => ({ rows }) });
  assert.equal(result[0].telemetryDiagnostics.locationSignalAt, null);
  assert.equal(result[0].speed, null);
  assert.equal(result[0].isRunning, null);
  assert.equal(result[1].speed, 0);
});
