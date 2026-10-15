const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parser = vm.createContext({
  require: name => name === 'luxon' ? require('luxon') : {},
  module: { exports: {} },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/saveMessage.js'), 'utf8'), parser);

const address = '1600 East Highway 71, Austin, TX';
const markdown = `| **Booked trip** |
| **Total distance included** |
| **1,000 miles** |
| Reservation ID #62331575 |
| **Location** |
| ------------ |
| [1600 East Highway 71](http://maps.google.com/maps?q=30.22013,-97.67463)<br>[Austin, TX](http://maps.google.com/maps?q=30.22013,-97.67463) |
| --- |
| **About the guest** |`;

test('host booking summaries remain host bookings with either apostrophe', () => {
  for (const apostrophe of ["'", '\u2019']) {
    assert.equal(parser.classifyMessageType(`Olive${apostrophe}s trip with your Toyota Corolla is booked!`, markdown), 'trip_booked');
  }
  assert.equal(parser.classifyMessageType("You're booked!", 'Booked trip\nTotal paid\n$203.87'), 'renter_activity');
});

test('location in linked Markdown tables supplies pickup and return', () => {
  const locations = parser.extractTripLocations(markdown.split('\n'));
  assert.equal(locations.pickupLocation, address);
  assert.equal(locations.returnLocation, address);
});

test('HTML location links supply both address lines without guest or image data', () => {
  const locations = parser.module.exports.extractTripLocationsFromHtml(`<table>
    <tr><td><strong>Location</strong></td></tr>
    <tr><td><a href="https://maps.google.com/">1600 East Highway 71</a><br>
    <a href="https://maps.google.com/">Austin, TX</a></td></tr>
    <tr><td><img src="map.png"></td></tr>
    <tr><td>About the guest</td></tr><tr><td>Olive</td></tr></table>`);
  assert.equal(locations.pickupLocation, address);
  assert.equal(locations.returnLocation, address);
});

test('separate pickup and return addresses remain distinct', () => {
  const locations = parser.extractTripLocations(['Pickup location:', 'Airport', 'Return location:', 'Home']);
  assert.equal(locations.pickupLocation, 'Airport');
  assert.equal(locations.returnLocation, 'Home');
});

test('booking SMS uses persisted trip locations when email text has no plain location label', async () => {
  const context = vm.createContext({
    require: name => name === '../../db' ? { query: async () => ({ rows: [{
      id: 1, vehicle_name: 'Toyota Corolla', trip_start: '2026-10-14T23:00:00Z',
      pickup_location: address, normalized_text_body: markdown,
    }] }) } : name === 'luxon' ? require('luxon') : {},
    module: { exports: {} }, process: { env: {} }, console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/alerts/fleetAlerts.js'), 'utf8'), context);
  const alerts = await context.collectNewTripBookedAlerts();
  assert.ok(alerts[0].body.includes(`Pickup: ${address}.`));
});

test('stored repair includes HTML-only and previously misclassified host notices', async () => {
  const calls = [];
  const context = vm.createContext({
    require: name => name === '../db' ? { query: async (sql, values) => {
      calls.push({ sql, values });
      return { rowCount: 1, rows: calls.length === 1 ? [{
        id: 10, subject: "Olive's trip with your Toyota Corolla is booked!",
        normalized_text_body: null,
        html_body: '<p>Location</p><p>1600 East Highway 71<br>Austin, TX</p><p>About the guest</p>',
      }] : [] };
    } } : name === './messageRuntimeSchema' ? { ensureMessageRuntimeSchema: async () => {} }
      : name === 'luxon' ? require('luxon')
      : name === './vehicles/extractTuroVehicle' ? require('../services/vehicles/extractTuroVehicle') : {},
    module: { exports: {} }, console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/saveMessage.js'), 'utf8'), context);
  await context.module.exports.backfillTripLocationsFromStoredMessages();
  assert.match(calls[0].sql, /html_body IS NOT NULL/);
  assert.match(calls[0].sql, /renter_activity/);
  assert.equal(calls[1].values[1], address);
  assert.equal(calls[1].values[2], address);
  assert.match(calls[2].sql, /'unknown'/);
});
