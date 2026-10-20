const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const builder = require('../services/googleCalendar/googleTripEventBuilder');

const trip = { id: 7, reservation_id: '123', guest_name: 'Guest', vehicle_name: 'Corolla',
  trip_start: '2026-10-10T12:00:00Z', trip_end: '2026-10-15T12:00:00Z',
  workflow_stage: 'awaiting_expenses' };

test('awaiting expenses clears calendar reminders while confirmed trips retain handoff notices', () => {
  for (const workflow_stage of ['awaiting_expenses', 'waiting expenses', 'complete']) {
    assert.equal(builder.getDesiredGoogleEventsForTrip({ ...trip, workflow_stage }).length, 0);
  }
  assert.equal(builder.getDesiredGoogleEventsForTrip({ ...trip, workflow_stage: 'confirmed' }).length, 2);
});

test('pickup stays on the calendar through preparation and clears once the trip starts', () => {
  for (const workflow_stage of ['booked', 'confirmed', 'ready_for_handoff', 'ready_for_guest']) {
    const events = builder.getDesiredGoogleEventsForTrip({ ...trip, workflow_stage });
    assert.deepEqual(events.map(event => event.eventType), ['pickup', 'return']);
    assert.equal(events[0].payload.start.dateTime, trip.trip_start.replace('Z', '.000Z'));
  }
  assert.deepEqual(builder.getDesiredGoogleEventsForTrip({ ...trip, workflow_stage: 'in_progress' })
    .map(event => event.eventType), ['return']);
});

test('calendar reconciliation deletes an existing closeout event instead of recreating it', async () => {
  const deleted = [];
  const marked = [];
  const context = vm.createContext({ module: { exports: {} }, require: name => {
    if (name === 'googleapis') return { google: { calendar: () => ({ events: {
      delete: async args => deleted.push(args),
      insert: () => assert.fail('must not create another reminder'),
      patch: () => assert.fail('must not refresh the closeout reminder'),
    } }) } };
    if (name === './googleCalendarAuth') return { getOAuthClient: () => ({ setCredentials: () => {} }) };
    if (name === './googleCalendarStore') return {
      getGoogleCalendarConnection: async () => ({ id: 2, calendar_id: 'calendar' }),
      markGoogleCalendarConnectionHealth: async () => {},
    };
    if (name === './tripStore') return { getTripById: async () => trip };
    if (name === './tripGoogleSyncStore') return {
      getAllTripGoogleSync: async () => [{ event_type: 'expense_closeout', google_event_id: 'old-closeout', sync_status: 'synced' }],
      markTripGoogleSyncDeleted: async (...args) => marked.push(args),
    };
    if (name === './googleTripEventBuilder') return builder;
    if (name === './googleCalendarSyncSettings') return { isGoogleCalendarSyncEnabled: async () => true };
    throw new Error(name);
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/googleCalendar/googleTripSync.js'), 'utf8'), context);
  await context.module.exports.syncTripToGoogle(7);
  assert.equal(deleted[0].eventId, 'old-closeout');
  assert.deepEqual(marked[0], [7, 2, 'expense_closeout']);
});
