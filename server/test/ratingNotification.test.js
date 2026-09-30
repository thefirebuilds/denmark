const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyRatingNotification, matchesRatingTrip } = require('../services/trips/applyRatingNotification');

const routeDb = {};
const context = vm.createContext({ module: { exports: {} }, console,
  require(name) {
    if (name === 'express') return { Router: () => ({ post() {} }) };
    if (name === '../db') return routeDb;
    if (name === '../services/trips/applyRatingNotification') return { applyRatingNotification };
    return {};
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../routes/notificationRoutes.js'), 'utf8'), context);
const { extractGuestName, extractVehicleName } = context.module.exports;
const body = 'Leesa just rated their trip with your Honda Fit. It’s time to return the favor.';
const event = { classification: 'trip_rated', guestName: 'Leesa', vehicleName: 'Honda Fit',
  postedAt: '2026-09-25T18:15:00Z' };
const trip = { id: 42, guest_name: 'Leesa Smith', vehicle_name: 'Delavan', nickname: 'Delavan', make: 'Honda', model: 'Fit' };

test('Leesa app notification extracts guest and vehicle without boilerplate', () => {
  assert.equal(extractGuestName(body), 'Leesa');
  assert.equal(extractVehicleName(body), 'Honda Fit');
  assert.equal(extractGuestName('Leesa has just rated their trip'), 'Leesa');
  assert.equal(extractGuestName('Leesa Smith rated their trip'), 'Leesa Smith');
});

test('rating matches model names, aliases and first names without matching another car', () => {
  assert.equal(matchesRatingTrip(event, trip), true);
  assert.equal(matchesRatingTrip(event, { ...trip, make: 'Toyota', model: 'Corolla' }), false);
  assert.equal(matchesRatingTrip(event, { ...trip, guest_name: 'Leesaann Smith' }), false);
  assert.equal(matchesRatingTrip({ ...event, vehicleName: 'Honda Fit 2017' }, trip), true);
  assert.equal(matchesRatingTrip({ ...event, vehicleName: 'Old name' }, { ...trip, aliases: ['Old name'] }), true);
});

test('app rating marks the checkbox and acknowledges the notification without changing trip stage', async () => {
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: calls.length === 1 ? [trip] : [{ id: 9 }] };
  } };
  assert.deepEqual(await applyRatingNotification(client, event, 9), { tripId: 42 });
  assert.deepEqual(calls[1].values, [42, event.postedAt, 9]);
  assert.match(calls[1].sql, /guest_rating_received = true/);
  assert.match(calls[1].sql, /COALESCE\(guest_rating_received_at/);
  assert.doesNotMatch(calls[1].sql, /SET\s+(?:workflow_stage|status|returned_at|amount)/i);
});

test('ambiguous or missing matches leave the checkbox and mismatch warning untouched', async () => {
  for (const rows of [[], [trip, { ...trip, id: 43 }]]) {
    let calls = 0;
    const result = await applyRatingNotification({ query: async () => {
      calls++; assert.equal(calls, 1); return { rows };
    } }, event, 9);
    assert.equal(result, null);
  }
});

test('a reservation ID identifies a trip without requiring matching notification names', async () => {
  let calls = 0;
  const result = await applyRatingNotification({ query: async (_sql, values) => {
    if (++calls === 1) { assert.equal(values[0], 12345); return { rows: [trip] }; }
    return { rows: [{ id: 9 }] };
  } }, { ...event, reservationId: 12345, guestName: null, vehicleName: null }, 9);
  assert.equal(result.tripId, 42);
});

test('non-rating and insufficiently identified notices do not query the database', async () => {
  const client = { query: () => assert.fail('Unexpected database call') };
  assert.equal(await applyRatingNotification(client, { ...event, classification: 'message' }, 9), null);
  assert.equal(await applyRatingNotification(client, { ...event, guestName: null }, 9), null);
});

test('startup reprocesses the stored app notice without a matching email', async () => {
  let calls = 0;
  routeDb.query = async (_sql, values) => {
    calls++;
    if (calls === 1) return { rows: [{ id: 9, title: 'Leesa rated their trip', body,
      posted_at: event.postedAt, received_at: event.postedAt }] };
    if (calls === 2) return { rows: [trip] };
    assert.equal(values[0], trip.id);
    return { rows: [{ id: 9 }] };
  };
  const result = await context.module.exports.backfillRatingNotifications();
  assert.equal(result.scanned, 1);
  assert.equal(result.applied, 1);
});
