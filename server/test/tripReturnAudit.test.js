const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('runtime migration atomically audits all return writes and backfills only real recorded returns', async () => {
  const statements = [];
  const client = { query: async sql => { statements.push(sql); return { rows: [], rowCount: 1 }; } };
  const context = vm.createContext({ module: { exports: {} }, require: () => client });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/trips/tripRuntimeSchema.js'), 'utf8'), context);
  await context.module.exports.ensureTripRuntimeSchema(client);
  const audit = statements.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS public.trip_return_audit'));
  assert.ok(audit);
  assert.match(audit, /AFTER INSERT OR UPDATE OF returned_at ON public.trips/);
  assert.match(audit, /IF NEW.returned_at IS NOT NULL/);
  assert.match(audit, /VALUES \(NEW.id, NEW.returned_at, NEW.return_detected_location/);
  assert.match(audit, /ON CONFLICT \(trip_id\) DO NOTHING/);
  assert.doesNotMatch(audit, /DO UPDATE|UPDATE public.trip_return_audit|trip_end|stage_updated_at/);
  assert.match(audit, /FROM public.trips WHERE returned_at IS NOT NULL/);
  assert.match(audit, /is_backfilled boolean NOT NULL DEFAULT false/);
  const initialSchema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  assert.ok(initialSchema.includes(audit.trim().split('\n').map(line => line.replace(/^        /, '')).join('\n')));
});

test('GPS return observation uses actual GPS time, matched location and source instead of scheduled end', async () => {
  let captured;
  const client = { query: async (sql, values) => {
    captured = { sql, values };
    return { rows: [{ returned_at: values[1], return_late_minutes: values[2] }] };
  } };
  const context = vm.createContext({ module: { exports: {} }, console, process,
    require: name => name === 'luxon' ? require('luxon') : {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/alerts/fleetAlerts.js'), 'utf8'), context);
  const result = await context.module.exports.recordTripReturnObservation({
    id: 7, trip_start: '2026-10-23T15:00:00Z', trip_end: '2026-10-26T15:00:00Z',
    location_last_updated: '2026-10-26T10:12:00', service_name: 'dimo', captured_at: '2026-10-26T15:14:00Z',
  }, { location: { label: 'Fletcher Bend' }, milesAway: 0.03 }, client);
  assert.equal(captured.values[1], '2026-10-26T15:12:00.000Z');
  assert.equal(captured.values[2], 12);
  assert.equal(captured.values[3], 'telemetry:dimo');
  assert.equal(captured.values[4], 'Fletcher Bend');
  assert.equal(captured.values[5], 0.03);
  assert.equal(result.returned_at, captured.values[1]);
  assert.match(captured.sql, /returned_at=COALESCE\(returned_at,\$2/);
});
