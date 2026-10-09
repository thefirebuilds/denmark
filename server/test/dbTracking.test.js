const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('reused clients count queries once and track every explicit checkout', async () => {
  const pending = [];
  const client = {
    query(...args) {
      const callback = args.find(arg => typeof arg === 'function');
      if (callback) { pending.push(() => callback(null, { rows: [] })); return; }
      return new Promise(resolve => pending.push(() => resolve({ rows: [] })));
    },
  };
  class Pool {
    constructor(options) { this.options = options; }
    on() {}
    connect(callback) {
      client.release = () => {};
      if (callback) return callback(null, client);
      return Promise.resolve(client);
    }
    query(sql) {
      return new Promise((resolve, reject) => this.connect((err, connection) => {
        connection.query(sql, (error, result) => {
          connection.release();
          if (error) reject(error); else resolve(result);
        });
      }));
    }
  }
  const dependencies = {
    dotenv: { config() {} }, pg: { Pool }, './dbHealth': {},
    './config/runtimeSecrets': {
      getRuntimeNumber: (_, fallback) => fallback,
      getRuntimeSecret: (_, fallback) => fallback,
    },
  };
  const context = vm.createContext({ module: { exports: {} }, console,
    require: name => dependencies[name] });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8'), context);
  const pool = context.module.exports;
  for (let cycle = 0; cycle < 2; cycle++) {
    const connection = await pool.connect();
    assert.equal(pool.getPoolActivitySnapshot().checked_out_clients.length, 1);
    const direct = connection.query('SELECT 1');
    assert.equal(pool.getPoolActivitySnapshot().active_queries.length, 1);
    pending.shift()();
    await direct;
    connection.release();
    assert.equal(pool.getPoolActivitySnapshot().checked_out_clients.length, 0);
    const pooled = pool.query('SELECT 2');
    assert.equal(pool.getPoolActivitySnapshot().active_queries.length, 1);
    pending.shift()();
    await pooled;
    assert.equal(pool.getPoolActivitySnapshot().active_queries.length, 0);
  }
});
