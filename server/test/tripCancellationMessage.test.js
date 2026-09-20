const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parser = vm.createContext({
  require: (name) => name === 'luxon' ? require('luxon') : {},
  module: { exports: {} },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/saveMessage.js'), 'utf8'), parser);

const body = `Alexis has canceled this trip with your Hyundai Accent
We’re sorry things didn’t work out. Because Alexis canceled with sufficient notice, Alexis won’t be charged, and you won’t receive any payment.
I need the vehicle delivered to my hotel.
Reply https://turo.com/us/en/reservation/61519776/messages
Canceled trip
Hyundai Accent 2017
Trip start: 9/20/26 10:00 AM
Trip end: 9/24/26 10:00 AM
Reservation ID #61519776
Location
1600 East Highway 71
Austin, TX`;

test('Alexis cancellation is classified and extracted with zero payout', () => {
  const subject = 'Alexis has canceled their trip';
  const type = parser.classifyMessageType(subject, body);
  assert.equal(type, 'trip_canceled');
  const fields = parser.extractStructuredFieldsByType(type, body, subject, '');
  assert.equal(String(fields.reservationId), '61519776');
  assert.equal(fields.guestName, 'Alexis');
  assert.equal(fields.cancellationPayoutAmount, 0);
});

test('both cancellation spellings support short and vehicle-specific subjects', () => {
  for (const spelling of ['canceled', 'cancelled']) {
    for (const suffix of ['', ' with your Hyundai Accent']) {
      assert.equal(parser.classifyMessageType(`Alexis has ${spelling} their trip${suffix}`, body), 'trip_canceled');
    }
    assert.equal(parser.classifyMessageType(`Turo has ${spelling} Alexis’s trip with your Hyundai Accent`, body), 'trip_canceled');
  }
});

test('discussion of cancellation does not cancel a reservation', () => {
  assert.equal(parser.classifyMessageType('Alexis has sent you a message about your Hyundai Accent',
    'I might need to cancel my trip.'), 'guest_message');
  assert.notEqual(parser.classifyMessageType('Alexis may cancel their trip', ''), 'trip_canceled');
});
