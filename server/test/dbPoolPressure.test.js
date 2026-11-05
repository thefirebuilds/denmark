const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const health = require('../dbHealth');
function handlers() {
  let resets = 0;
  let restarts = 0;
  const context = vm.createContext({ module: { exports: {} }, require: name => {
    if (name === '../dbHealth') return health;
    if (name === '../startup/startupState') return {
      markStartupTablesNotReady: () => { resets++; },
      initializeStartupTablesWithRetry: async () => { restarts++; },
    };
    throw new Error(`Unexpected module: ${name}`);
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/errorHandlers.js'), 'utf8'), context);
  return { handle: context.module.exports.appErrorHandler, resets: () => resets, restarts: () => restarts };
}
function response() {
  return { code: 200, headers: {}, set(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
test('a local pool checkout timeout fails only that request without restarting database setup', () => {
  health.markDatabaseReady();
  const app = handlers();
  const res = response();
  app.handle(new Error('timeout exceeded when trying to connect'), {}, res, () => assert.fail());
  assert.equal(res.code, 503);
  assert.equal(res.body.error, 'database busy');
  assert.equal(res.headers['Retry-After'], '10');
  assert.equal(health.getDatabaseHealth().ready, true);
  assert.equal(health.getDatabaseHealth().schema_initialized, true);
  assert.equal(app.resets(), 0);
  assert.equal(app.restarts(), 0);
});
test('an actual connection failure still triggers recovery', () => {
  health.markDatabaseReady();
  const app = handlers();
  const res = response();
  app.handle(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), {}, res, () => assert.fail());
  assert.equal(res.code, 503);
  assert.equal(health.getDatabaseHealth().ready, false);
  assert.equal(app.resets(), 1);
  assert.equal(app.restarts(), 1);
  assert.equal(health.isDatabasePoolTimeout(Object.assign(new Error('timeout exceeded when trying to connect'), { cause: new Error('network failed') })), false);
});
