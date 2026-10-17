const { EventEmitter } = require('node:events');

const events = new EventEmitter();

module.exports = {
  notifyTripUpdated: () => events.emit('updated'),
  onTripUpdated: (listener) => events.on('updated', listener),
};
