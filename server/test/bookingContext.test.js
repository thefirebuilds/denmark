const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('picked-up, returned and canceled bookings never show pickup overdue', async () => {
  const { getBookingContext } = await import('../../shared/bookingContext.mjs');
  for (const stage of ['in_progress', 'check_in', 'awaiting_expenses', 'complete', 'canceled']) {
    const context = getBookingContext({ trip_workflow_stage: stage, trip_start: '2026-10-19T18:00:00Z' });
    assert.equal(context.showPickupCountdown, false, stage);
    assert.equal(context.title, 'Booking context');
  }
  assert.equal(getBookingContext({ trip_id: 7, active_trip_id: 7 }).showPickupCountdown, false);
  assert.equal(getBookingContext({ trip_workflow_stage: 'handoff' }).showPickupCountdown, true);
  assert.equal(getBookingContext({ trip_workflow_stage: 'booked' }).title, 'Upcoming booking context');
});

test('initial amount comes from booking evidence, including zero, and never current changed earnings', async () => {
  const { getBookingContext } = await import('../../shared/bookingContext.mjs');
  assert.equal(getBookingContext({ initial_booking_amount: '203.87', trip_record_amount: '300' }).initialAmount, 203.87);
  assert.equal(getBookingContext({ type: 'trip_booked', amount: '203.87' }).initialAmount, 203.87);
  assert.equal(getBookingContext({ initial_booking_amount: 0 }).initialAmount, 0);
  assert.equal(getBookingContext({ type: 'turo_notification', trip_record_amount: '300', amount: '300' }).initialAmount, null);
  assert.equal(getBookingContext({ type: 'trip_booked', amount: null }).initialAmount, null);
});

test('message serialization retains saved pickup and original amount', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/messages.js'), 'utf8');
  const context = vm.createContext({
    isActionableBookingMessage: () => false, buildReimbursementInvoiceSummary: () => null, parseSubject: () => ({}),
  });
  vm.runInContext(source.slice(source.indexOf('function mapMessageRow('), source.indexOf('function cleanPickupLocation(')), context);
  const message = context.mapMessageRow({ pickup_location: '135 Fletcher Bend, Buda, TX',
    initial_booking_amount: '203.87', trip_record_amount: '300', trip_workflow_stage: 'check_in' });
  assert.equal(message.pickup_location, '135 Fletcher Bend, Buda, TX');
  assert.equal(message.initial_booking_amount, '203.87');
  assert.equal(message.trip_workflow_stage, 'check_in');
  // Both fast and full queue queries must project the stored location and
  // original booking amount; fallback parsing must not erase saved data.
  assert.equal((source.match(/AS initial_booking_amount/g) || []).length, 2);
  assert.equal((source.match(/NULLIF\(TRIM\(t.pickup_location\), ''\)/g) || []).length, 2);
  assert.match(source, /row.pickup_location = row.pickup_location \|\| extractPickupLocationFromNoticeText/);
});
