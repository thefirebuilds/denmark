const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const policy = require('../services/vehicles/nonOwnedVehicles');

test('operator exclusions match exact names and active supplied aliases, without substring matching other fleet cars', () => {
  for (const nickname of ['Blossom','Cocaina','OJ','Phantom','Tulip','Yogi']) {
    assert.equal(policy.isNonOwnedVehicle({ nickname: ` ${nickname.toUpperCase()} ` }), true);
    assert.equal(policy.isNonOwnedVehicle({ nickname: 'Renamed', aliases: [nickname] }), true);
  }
  for (const nickname of ['Belle','Juneau','Geneva','Delavan','Menasha','Neenah','Verona','Winnie','Monstro III','OJ Simpson']) {
    assert.equal(policy.isNonOwnedVehicle({ nickname }), false);
  }
});

function database() {
  const db = new DatabaseSync(':memory:');
  db.function('NOW', () => Date.now());
  db.exec(`CREATE TABLE vehicles(id INTEGER PRIMARY KEY,vin TEXT UNIQUE,nickname TEXT,turo_vehicle_name TEXT,turo_vehicle_id TEXT,
    is_active INTEGER DEFAULT 1,in_service INTEGER DEFAULT 1,trip_eligible INTEGER DEFAULT 1,updated_at INTEGER,
    imei TEXT,make TEXT,model TEXT,year INTEGER,standard_engine TEXT,bouncie_vehicle_id TEXT,current_odometer_miles INTEGER);
    CREATE TABLE vehicle_aliases(id INTEGER PRIMARY KEY,vehicle_id INTEGER,alias TEXT,active INTEGER,source TEXT,updated_at INTEGER,created_at INTEGER);`);
  return db;
}

test('startup retirement deactivates all six despite listing IDs, preserves history/identity and leaves real cars alone', async () => {
  const db = database();
  try {
    policy.NON_OWNED_NAMES.forEach((name, i) => db.prepare('INSERT INTO vehicles(id,vin,nickname,turo_vehicle_id) VALUES (?,?,?,?)').run(i + 1, `OTHER-VIN-${i}`, name, String(1000 + i)));
    db.prepare('INSERT INTO vehicles(id,vin,nickname) VALUES (20,?,?)').run('OUR-VIN', 'Belle');
    db.prepare('INSERT INTO vehicles(id,vin,nickname) VALUES (21,?,?)').run('RENAMED-VIN', 'Renamed tracker');
    db.exec("INSERT INTO vehicle_aliases VALUES (1,21,'Tulip',1,'canonical',1,1)");
    const client = { query: async (sql, values) => {
      // Execute the production UPDATE with only dialect adaptations for
      // PostgreSQL arrays, UPDATE alias syntax and RETURNING qualification.
      sql = sql.replace('UPDATE vehicles v', 'UPDATE vehicles AS v')
        .replace(/=\s*ANY\(\$1::text\[\]\)/g, 'IN (SELECT value FROM json_each($1))')
        .replace('RETURNING v.id, v.nickname', 'RETURNING id, nickname');
      return { rows: db.prepare(sql).all({ '$1': JSON.stringify(values[0]) }) };
    } };
    const context = { module: { exports: {} }, console: { log() {} }, require: name => name === '../../db' ? client : policy };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/vehicles/retireTransferredTrackerVehicles.js'), 'utf8'), context);
    assert.equal((await context.module.exports.retireTransferredTrackerVehicles(client)).length, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n, 8);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vehicles WHERE is_active=0 AND in_service=0 AND trip_eligible=0').get().n, 7);
    assert.equal(db.prepare('SELECT is_active FROM vehicles WHERE id=20').get().is_active, 1);
    assert.equal(db.prepare('SELECT turo_vehicle_id FROM vehicles WHERE id=1').get().turo_vehicle_id, '1000');
    assert.equal((await context.module.exports.retireTransferredTrackerVehicles(client)).length, 0);
  } finally { db.close(); }
});

test('Bouncie persistence cannot create cars, reactivate inactive rows or update a different VIN', async () => {
  const db = database();
  try {
    db.prepare('INSERT INTO vehicles(id,vin,nickname,current_odometer_miles) VALUES (1,?,?,?)').run('OWNVIN', 'Belle', 100);
    const context = vm.createContext({ module: { exports: {} }, console, require: () => ({}) });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/bouncie/collectBouncieSnapshot.js'), 'utf8'), context);
    const client = { query: async (sql, values) => {
      assert.match(sql, /UPDATE vehicles SET/);
      assert.doesNotMatch(sql, /INSERT INTO vehicles/);
      sql = sql.replace(/\$(\d+)::(integer|text)/g, (_all, id, type) => `CAST($${id} AS ${type === 'integer' ? 'INTEGER' : 'TEXT'})`);
      const bindings = Object.fromEntries(Array.from(values, (value, i) => [`$${i + 1}`, value ?? null]));
      return { rows: db.prepare(sql).all(bindings) };
    } };
    const snapshot = { vin: 'OWNVIN', nickname: 'Provider rename', current_odometer_miles: 120 };
    assert.equal((await context.updateManagedVehicle(client, { ...snapshot, vin: 'FOREIGN-VIN' }, 1)).rows.length, 0);
    assert.equal((await context.updateManagedVehicle(client, snapshot, 999)).rows.length, 0);
    assert.equal((await context.updateManagedVehicle(client, snapshot, 1)).rows.length, 1);
    assert.equal(db.prepare('SELECT nickname FROM vehicles WHERE id=1').get().nickname, 'Belle');
    db.exec('UPDATE vehicles SET is_active=0 WHERE id=1');
    assert.equal((await context.updateManagedVehicle(client, { ...snapshot, current_odometer_miles: 500 }, 1)).rows.length, 0);
    assert.equal(db.prepare('SELECT current_odometer_miles FROM vehicles WHERE id=1').get().current_odometer_miles, 120);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vehicles').get().n, 1);
  } finally { db.close(); }
});

test('a quick restart republishes the website snapshot even when other startup jobs are on cooldown', async () => {
  const pushes = [];
  const noop = new Proxy(async () => ({}), { get: () => async () => ({}) });
  const context = vm.createContext({ module: { exports: {} }, process: { env: { ...process.env } }, AbortController, Date, Intl,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    require: name => {
      if (name === '../db') return { query: async () => ({ rows: [{ value: { last_run_at: new Date().toISOString() } }] }), getPoolStats: () => ({ max: 6, checked_out: 0, idle: 6 }) };
      if (name === './pushPublicAvailability') return { pushPublicAvailabilitySnapshotSafe: async reason => pushes.push(reason) };
      if (name === './integrations/integrationSettings') return { isIntegrationEnabled: async () => true };
      return noop;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8'), context);
  context.module.exports();
  await new Promise(setImmediate);
  assert.deepEqual(pushes, ['startup']);
  context.module.exports.stopScheduler();
});
