const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReturnMessage, reminderKey, getReturnMessageReminders, acknowledgeReturnMessage } = require('../services/trips/returnMessageReminder');

const trip = { trip_id: 7, reservation_id: 123, guest_name: 'Lorenzo Smith', vehicle_nickname: 'Juneau',
  trip_start: '2026-10-22T15:00:00Z', trip_end: '2026-10-25T15:00:00Z', workflow_stage: 'in_progress' };

test('airport returns personalize the supplied directions, key instructions and signature', () => {
  for (const location of ['The Parking Spot West', '1600 E Hwy 71, Austin, TX 78742', '1600 East Highway 71', 'AUS airport']) {
    const draft = buildReturnMessage({ ...trip, return_location: location });
    assert.equal(draft.template, 'airport');
    assert.match(draft.text, /^Hello Again Lorenzo,/);
    assert.match(draft.text, /Juneau served you well/);
    assert.match(draft.text, /signs for car share parking/);
    assert.match(draft.text, /1600 E Hwy 71,\nAustin, TX 78742/);
    assert.match(draft.text, /lock the keys in the car/);
    assert.match(draft.text, /Blake - Fresh Coast Garage$/);
  }
});

test('home returns use street parking instructions without making an unsupported availability promise', () => {
  for (const location of ['135 Fletcher Bend, Buda, TX', 'Fletcher Bnd', 'Garlic Creek']) {
    const draft = buildReturnMessage({ ...trip, guest_name: 'Vanessa', vehicle_nickname: 'Verona', return_location: location });
    assert.equal(draft.template, 'home');
    assert.match(draft.text, /^Hi Vanessa,/);
    assert.match(draft.text, /bring back Verona/);
    assert.match(draft.text, /across the street is fine/);
    assert.match(draft.text, /request an extension in the app/);
    assert.doesNotMatch(draft.text, /currently available|tonight|1600/);
  }
});

test('booked return location wins over pickup and unknown sites get no invented parking instructions', () => {
  assert.equal(buildReturnMessage({ ...trip, pickup_location: 'Fletcher Bend', return_location: 'Airport' }).template, 'airport');
  const draft = buildReturnMessage({ ...trip, return_location: 'Downtown Hotel' });
  assert.equal(draft.template, 'other');
  assert.match(draft.text, /Downtown Hotel/);
  assert.doesNotMatch(draft.text, /spare|Fletcher|Parking Spot/);
});

test('queue selects current unreturned trips twelve hours before end and respects persistent dismissal', async () => {
  const key = reminderKey(trip.trip_id, trip.trip_end);
  let sql;
  const db = { query: async (query, values) => {
    sql = query;
    assert.equal(values[1], 12);
    return { rows: [trip, { ...trip, trip_id: 8, acknowledgements: { [reminderKey(8, trip.trip_end)]: {} } }] };
  } };
  const reminders = await getReturnMessageReminders(db);
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].id, key);
  assert.match(sql, /workflow_stage = 'in_progress'/);
  assert.match(sql, /returned_at IS NULL/);
  assert.match(sql, /deleted_at IS NULL/);
  assert.match(sql, /closed_out, false\) = false/);
  assert.match(sql, /trip_start <= NOW\(\)/);
  assert.match(sql, /trip_end <= NOW\(\) \+ \(\$2/);
  assert.notEqual(key, reminderKey(trip.trip_id, '2026-10-26T15:00:00Z'));
});

test('acknowledgement is persisted for the exact schedule and rejects a changed return time', async () => {
  const db = { query: async (sql, values) => {
    assert.match(sql, /ON CONFLICT \(key\) DO UPDATE/);
    assert.match(sql, /t.trip_end = \$5::timestamptz/);
    assert.equal(values[1], reminderKey(trip.trip_id, trip.trip_end));
    assert.equal(values[2], 'owner@example.com');
    return { rowCount: 1 };
  } };
  await acknowledgeReturnMessage(db, trip.trip_id, trip.trip_end, 'owner@example.com');
  await assert.rejects(acknowledgeReturnMessage({ query: async () => ({ rowCount: 0 }) }, trip.trip_id, trip.trip_end), { statusCode: 409 });
  await assert.rejects(acknowledgeReturnMessage({ query: () => assert.fail() }, -1, trip.trip_end), { statusCode: 400 });
});
