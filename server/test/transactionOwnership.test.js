const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { withTransaction } = require('../services/withTransaction');

test('owner commits and releases before effects; rollback discards every effect', async () => {
  const events = [];
  const client = { query: async sql => events.push(sql), release: () => events.push('release') };
  const pool = { connect: async () => client };
  const result = await withTransaction(pool, async (received, effects) => {
    assert.equal(received, client);
    effects.push(() => events.push('effect'));
    await received.query('work');
    assert.deepEqual(events, ['BEGIN', 'work']);
    return 42;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result, 42);
  assert.deepEqual(events, ['BEGIN', 'work', 'COMMIT', 'release', 'effect']);
  events.length = 0;
  await assert.rejects(withTransaction(pool, async (_client, effects) => {
    effects.push(() => events.push('must not run'));
    throw new Error('write failed');
  }), /write failed/);
  assert.deepEqual(events, ['BEGIN', 'ROLLBACK', 'release']);
});

test('failed BEGIN releases a broken client; failed rollback preserves original error and discards client', async () => {
  for (const failedCommand of ['BEGIN', 'ROLLBACK']) {
    let releasedWith;
    const failure = new Error(`${failedCommand} failed`);
    const client = {
      query: async sql => { if (sql === failedCommand) throw failure; },
      release: error => { releasedWith = error; },
    };
    await assert.rejects(withTransaction({ connect: async () => client }, async () => {
      throw new Error('original write failed');
    }), failedCommand === 'BEGIN' ? /BEGIN failed/ : /original write failed/);
    assert.equal(releasedWith, failure);
  }
});

test('failed commit rolls back, releases and suppresses queued effects', async () => {
  const events = [];
  const client = {
    query: async sql => {
      events.push(sql);
      if (sql === 'COMMIT') throw new Error('commit failed');
    },
    release: () => events.push('release'),
  };
  await assert.rejects(withTransaction({ connect: async () => client }, async (_client, effects) => {
    effects.push(() => events.push('effect'));
  }), /commit failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['BEGIN', 'COMMIT', 'ROLLBACK', 'release']);
});

function loadService(file, dependencies) {
  const context = vm.createContext({ module: { exports: {} }, __dirname,
    console: { warn() {}, log() {} },
    require: name => dependencies[name] || {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services', file), 'utf8'), context);
  return context;
}

test('return observation and stage change share the owner connection without nested BEGIN or checkout', async () => {
  const statements = [];
  let checkouts = 0;
  let released = false;
  let effectsRan = 0;
  const trip = { id: 11, workflow_stage: 'in_progress', pickup_location: 'Home',
    trip_start: '2026-10-01', trip_end: '2026-10-02', starting_odometer: 1000 };
  const client = {
    query: async sql => {
      statements.push(sql.trim());
      if (sql.includes('FROM app_settings')) return { rows: [{ value: { locations: [
        { id: 'home', label: 'Home', latitude: 30, longitude: -97, radiusMiles: 0.15 },
      ] } }] };
      if (sql.includes('FROM vehicles')) return { rows: [{ vin: 'VIN', turo_vehicle_id: '1' }] };
      if (sql.includes('information_schema')) return { rows: [] };
      if (sql.includes('SELECT max_engine_rpm')) return { rows: [{}] };
      if (sql.includes('UPDATE trips') && sql.includes('workflow_stage =')) {
        return { rows: [{ ...trip, workflow_stage: 'check_in' }] };
      }
      if (sql.includes('FROM trips')) return { rows: [trip] };
      return { rows: [] };
    },
    release: () => { released = true; },
  };
  const pool = { connect: async () => {
    assert.equal(++checkouts, 1, 'nested checkout would starve a one-connection pool');
    return client;
  }, query: () => assert.fail('helper escaped to the global pool') };
  const transitionContext = loadService('trips/transitionTripStage.js', {
    '../../db': pool, '../withTransaction': { withTransaction },
    '../physicalAlerts/runtime': { buildRuntime: () => ({}) },
    '../physicalAlerts/bookingAlertReconciler': { reconcileBookingAlerts: async () => {
      assert.equal(released, true);
      effectsRan++;
    } },
    '../googleCalendar/googleTripSync': { syncTripToSelectedGoogleCalendars: async () => ({ ok: true }) },
  });
  // The separate maintenance job has its own checkout after this transaction.
  transitionContext.runStageEntryAutomation = () => assert.equal(released, true);
  const transitions = transitionContext.module.exports;
  const locations = loadService('locations/locationSettings.js', { '../../db': pool }).module.exports;
  const automation = loadService('trips/autoAdvanceTurnaroundTrip.js', {
    fs: { readFileSync: () => JSON.stringify({ tripStageAutomations: [{
      enabled: true, fromStage: 'in_progress', toStage: 'check_in',
      conditions: [{ type: 'launch_location' }],
    }] }) }, path,
    './transitionTripStage': transitions,
    '../locations/locationSettings': locations,
    '../alerts/fleetAlerts': {
      getMatchedTripReturnGeoLocation: (_row, sites) => ({ location: sites[0] }),
      recordTripReturnObservation: async (_row, _match, received) => {
        assert.equal(received, client);
        await received.query('UPDATE trips SET returned_at = NOW() WHERE id = 11');
      },
    },
  }).module.exports;
  await withTransaction(pool, async (received, afterCommit) => {
    const result = await automation.maybeAutoAdvanceTurnaroundTripFromTelemetry(received,
      { vin: 'VIN', odometer: 1100 }, { afterCommit });
    assert.equal(result.workflow_stage, 'check_in');
    assert.equal(released, false);
    assert.equal(effectsRan, 0);
    assert.equal(statements.filter(sql => sql === 'BEGIN').length, 1);
    assert.equal(statements.some(sql => sql === 'COMMIT'), false);
    // The helper queues effects but does not own transaction lifecycle.
    assert.equal(afterCommit.length, 1);
  });
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(checkouts, 1);
  assert.equal(released, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(effectsRan, 1);
});

test('DIMO failed BEGIN reaches owner cleanup before persistence runs', async () => {
  const error = new Error('connection lost during BEGIN');
  let releaseError;
  const context = loadService('dimo/collectDimoSnapshot.js', {
    '../../db': { connect: async () => ({ query: async () => { throw error; },
      release: failure => { releaseError = failure; } }) },
    '../withTransaction': { withTransaction },
  });
  await assert.rejects(context.persistDimoTelemetry({ normalized: { vin: 'VIN' }, raw: {} }),
    /connection lost during BEGIN/);
  assert.equal(releaseError, error);
});

test('auto-start uses the supplied client and defers its guest alert', async () => {
  const queries = [];
  let alerts = 0;
  const afterCommit = [];
  const client = { query: async sql => {
    queries.push(sql);
    return { rows: sql.includes('FROM vehicles') ? [{ turo_vehicle_id: '1' }]
      : [{ id: 10, workflow_stage: 'ready_for_handoff' }] };
  } };
  const automation = loadService('trips/autoStartReadyTrip.js', {
    './transitionTripStage': { transitionTripStageInTransaction: async (received, id, stage, options) => {
      assert.equal(received, client);
      assert.equal(options.afterCommit, afterCommit);
      assert.equal(stage, 'in_progress');
      return { id };
    } },
    '../alerts/fleetAlerts': { sendTripUnderwayAlert: async () => { alerts++; } },
  }).module.exports;
  const result = await automation.maybeAutoStartReadyTripFromTelemetry(client,
    { vin: 'VIN', isRunning: true }, { afterCommit });
  assert.equal(result.id, 10);
  assert.equal(alerts, 0);
  assert.equal(afterCommit.length, 1);
  await afterCommit[0]();
  assert.equal(alerts, 1);
  assert.equal(queries.length, 2);
});

test('public transition owns exactly one transaction and rejects invalid input before checkout', async () => {
  const commands = [];
  let acquired = 0;
  let released = false;
  let effects = 0;
  const client = { query: async sql => {
    commands.push(sql.trim());
    if (sql.includes('UPDATE trips')) return { rows: [{ id: 9, workflow_stage: 'awaiting_expenses' }] };
    if (sql.includes('FROM trips')) return { rows: [{ id: 9, workflow_stage: 'check_in' }] };
    return { rows: [] };
  }, release: () => { released = true; } };
  const context = loadService('trips/transitionTripStage.js', {
    '../../db': { connect: async () => { acquired++; return client; } },
    '../withTransaction': { withTransaction },
    '../physicalAlerts/runtime': { buildRuntime: () => ({}) },
    '../physicalAlerts/bookingAlertReconciler': { reconcileBookingAlerts: async () => {
      assert.equal(released, true);
      effects++;
    } },
    '../googleCalendar/googleTripSync': { syncTripToSelectedGoogleCalendars: async () => ({ ok: true }) },
  });
  context.runStageEntryAutomation = () => assert.equal(released, true);
  const transition = context.module.exports.transitionTripStage;
  await assert.rejects(transition('bad', 'check_in'), error => error.statusCode === 400);
  assert.equal(acquired, 0);
  const result = await transition(9, 'awaiting_expenses');
  assert.equal(result.workflow_stage, 'awaiting_expenses');
  assert.equal(acquired, 1);
  assert.equal(commands.filter(sql => sql === 'BEGIN').length, 1);
  assert.equal(commands.at(-1), 'COMMIT');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(effects, 1);
});
