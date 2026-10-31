const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(env, files = {}) {
  const context = vm.createContext({ module: { exports: {} }, process: { env },
    require: () => ({ readFileSync: file => {
      if (!(file in files)) throw new Error('secret file unavailable');
      return files[file];
    } }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../config/runtimeSecrets.js'), 'utf8'), context);
  return context.module.exports;
}

test('missing, empty, whitespace and invalid numeric settings preserve database defaults', () => {
  for (const value of [undefined, '', '  ', 'invalid', 'Infinity']) {
    const env = value === undefined ? {} : { PGQUERY_TIMEOUT_MS: value };
    assert.equal(load(env).getRuntimeNumber('PGQUERY_TIMEOUT_MS', 45000), 45000);
  }
  const defaults = load({});
  assert.equal(defaults.getRuntimeNumber('PGSTATEMENT_TIMEOUT_MS', 45000), 45000);
  assert.equal(defaults.getRuntimeNumber('PGCONNECT_TIMEOUT_MS', 5000), 5000);
  assert.equal(defaults.getRuntimeNumber('PGPORT', 5432), 5432);
});

test('explicit zero remains supported and numeric settings can come from mounted files', () => {
  assert.equal(load({ TIMEOUT: '0' }).getRuntimeNumber('TIMEOUT', 45000), 0);
  assert.equal(load({ TIMEOUT: ' 9000 ' }).getRuntimeNumber('TIMEOUT', 45000), 9000);
  assert.equal(load({ TIMEOUT_FILE: '/timeout' }, { '/timeout': ' 12000\n' })
    .getRuntimeNumber('TIMEOUT', 45000), 12000);
  assert.equal(load({ TIMEOUT_FILE: '/timeout' }, { '/timeout': '\n' })
    .getRuntimeNumber('TIMEOUT', 45000), 45000);
  assert.throws(() => load({ TIMEOUT_FILE: '/missing' }).getRuntimeNumber('TIMEOUT', 45000),
    /secret file unavailable/);
});
