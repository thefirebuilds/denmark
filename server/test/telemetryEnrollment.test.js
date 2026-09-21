const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const managed = require('../services/telemetry/managedVehicle');

test('VIN is required; a device ID alone cannot enroll a vehicle', async () => {
  assert.equal(await managed.findManagedTelemetryVehicle({ query: () => assert.fail('no VIN') }, null), null);
});

for (const provider of ['bouncie', 'dimo']) {
  test(`${provider} does not persist unknown or inactive provider vehicles`, async () => {
    const queries = [];
    let released = false;
    const client = {
      async query(sql) {
        queries.push(sql);
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return {};
        assert.match(sql, /SELECT id, vin FROM vehicles/);
        assert.match(sql, /is_active = true/);
        return { rows: [] };
      },
      release() { released = true; },
    };
    const context = vm.createContext({ module: { exports: {} }, console: { log() {}, warn() {} },
      require(name) {
        if (name === '../../db') return { connect: async () => client };
        if (name === '../telemetry/managedVehicle') return managed;
        if (name === './client') return { getVehicles: async () => [{ vin: 'FRIENDVIN', nickName: 'Yogi' }] };
        return {};
      },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../services/${provider}/collect${provider === 'dimo' ? 'Dimo' : 'Bouncie'}Snapshot.js`), 'utf8'), context);
    if (provider === 'bouncie') await context.module.exports();
    else {
      const result = await context.persistDimoTelemetry({ normalized: { vin: 'FRIENDVIN' }, raw: {} });
      assert.equal(result.skipped, true);
    }
    assert.equal(queries.at(-1), 'COMMIT');
    assert.equal(released, true);
  });
}

test('existing active fleet VIN is retained for updates', async () => {
  const result = await managed.findManagedTelemetryVehicle({ query: async (_sql, values) => {
    assert.equal(values[0], 'ownvin');
    return { rows: [{ id: 1, vin: 'OWNVIN' }] };
  } }, ' ownvin ');
  assert.equal(result.vin, 'OWNVIN');
});
