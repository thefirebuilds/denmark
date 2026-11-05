const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();
module.exports = { requestContext };
