const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingMessage, getBookingMessageReminders, reminderKey, acknowledgeBookingMessage } = require('../services/trips/bookingMessageReminder');
const trip = { trip_id: 7, trip_start: '2026-12-01T12:00:00Z', guest_name: 'Marquette Smith', vehicle_nickname: 'Belle' };
test('AUS welcome personalizes the supplied airport template using pickup location', () => {
  for (const pickup_location of ['Austin-Bergstrom International Airport (AUS)', 'AUS', 'The Parking Spot - West', '1600 E Highway 71']) {
    const { template, text } = buildBookingMessage({ ...trip, pickup_location });
    assert.equal(template, 'airport');
    assert.match(text, /^Hi Marquette,/);
    assert.match(text, /Fresh Coast Garage! Belle will be ready/);
    assert.match(text, /You'll return Belle at the end/);
    assert.match(text, /1600 E Highway 71,\nAustin, TX 78742/);
    assert.match(text, /\(512\) 385-9343/);
    assert.match(text, /rear pocket of the passenger seat/);
    assert.match(text, /– Blake\nFresh Coast Garage$/);
    assert.doesNotMatch(text, /Jeffrey|Winnie|Fletcher/);
  }
  assert.equal(buildBookingMessage({ ...trip, pickup_location: '135 Fletcher Bend', return_location: 'AUS' }).template, 'fletcher');
});
test('airport reminders only select booked and confirmed pickups and retain airport draft', async () => {
  const reminders = await getBookingMessageReminders({ query: async sql => {
    assert.match(sql, /OR \(t.workflow_stage IN \('booked', 'confirmed'\)/);
    assert.match(sql, /airport\|aus/);
    assert.match(sql, /t.deleted_at IS NULL/);
    assert.match(sql, /t.returned_at IS NULL/);
    return { rows: [{ ...trip, pickup_location: 'AUS', workflow_stage: 'confirmed' }] };
  } });
  assert.equal(reminders[0].booking_message_template, 'airport');
  assert.match(reminders[0].booking_message_draft, /The Parking Spot - West/);
});
test('welcome uses the supplied template and personalizes guest and car', () => {
  const { text } = buildBookingMessage(trip);
  assert.match(text, /^Hi Marquette,/);
  assert.match(text, /Belle ready for you/);
  assert.match(text, /135 Fletcher Bend\nBuda, TX/);
  assert.match(text, /HCTRA toll tag/);
  assert.match(text, /sunshade in the glove box/);
  assert.match(text, /snooze the car/);
  assert.match(text, /-Blake$/);
});
test('booking reminders persist dismissal independently from return reminders', async () => {
  const reminders = await getBookingMessageReminders({ query: async (sql, args) => {
    assert.match(sql, /t.trip_start > NOW\(\)/);
    assert.match(sql, /135\[\[:space:\]\]\+fletcher/);
    assert.match(sql, /'booked', 'confirmed', 'ready_for_handoff'/);
    assert.equal(args.length, 1);
    return { rows: [trip, { ...trip, trip_id: 8, acknowledgements: { [reminderKey(8, trip.trip_start)]: {} } }] };
  } });
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].type, 'booking_message_required');
  await acknowledgeBookingMessage({ query: async (sql, args) => {
    assert.match(sql, /t.trip_start = \$5/);
    assert.equal(args[1], reminderKey(7, trip.trip_start));
    return { rowCount: 1 };
  } }, 7, trip.trip_start);
  await assert.rejects(acknowledgeBookingMessage({ query: async () => ({ rowCount: 0 }) }, 7, trip.trip_start), { statusCode: 409 });
});
