const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresSessionStore } = require('../auth/sessionStore');
const call = (store, method, ...args) => new Promise((resolve, reject) =>
  store[method](...args, (error, result) => error ? reject(error) : resolve(result)));

test('sessions survive a new store instance and logout deletes the persisted session', async () => {
  const rows = new Map();
  const pool = { query: async (sql, values) => {
    if (sql.startsWith('INSERT')) rows.set(values[0], { data: JSON.parse(values[1]), expires: values[2] });
    if (sql.startsWith('DELETE')) rows.delete(values[0]);
    if (sql.startsWith('SELECT')) {
      assert.match(sql, /expires_at > NOW\(\)/);
      const row = rows.get(values[0]);
      return { rows: row && new Date(row.expires).getTime() > Date.now() ? [row] : [] };
    }
    return { rows: [] };
  } };
  const first = new PostgresSessionStore(pool, 60000);
  const data = { cookie: {}, auth: { userId: 42 } };
  await call(first, 'set', 'session', data);
  const restarted = new PostgresSessionStore(pool, 60000);
  assert.deepEqual(await call(restarted, 'get', 'session'), data);
  await call(restarted, 'destroy', 'session');
  assert.equal(await call(first, 'get', 'session'), null);
  await call(first, 'set', 'expired', { cookie: { expires: '2020-01-01' } });
  assert.equal(await call(restarted, 'get', 'expired'), null);
});

test('session database errors propagate instead of being reported as a missing login', async () => {
  const store = new PostgresSessionStore({ query: async sql => {
    if (sql.startsWith('SELECT')) throw new Error('database temporarily unavailable');
    return { rows: [] };
  } }, 60000);
  await assert.rejects(call(store, 'get', 'session'), /temporarily unavailable/);
});

test('touch only updates expiry, without overwriting concurrent authentication changes', async () => {
  const queries = [];
  const store = new PostgresSessionStore({ query: async (sql, values) => {
    queries.push({ sql, values }); return { rows: [] };
  } }, 60000);
  await call(store, 'touch', 'session', { cookie: { expires: '2030-01-01' }, auth: { userId: 42 } });
  assert.match(queries.at(-1).sql, /SET expires_at = \$2/);
  assert.doesNotMatch(queries.at(-1).sql, /SET data/);
});
