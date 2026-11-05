const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBookingMessage, getBookingMessageReminders, reminderKey, acknowledgeBookingMessage } = require('../services/trips/bookingMessageReminder');
const trip = { trip_id: 7, trip_start: '2026-12-01T12:00:00Z', guest_name: 'Marquette Smith', vehicle_nickname: 'Belle' };
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
