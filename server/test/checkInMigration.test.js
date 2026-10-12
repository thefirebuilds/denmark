const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('runtime Check In migration sends a correctly dollar-quoted PostgreSQL DO block', async () => {
  const statements = [];
  const client = { query: async sql => { statements.push(sql); return { rows: [], rowCount: 1 }; } };
  const context = vm.createContext({ module: { exports: {} }, require: () => client });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/trips/tripRuntimeSchema.js'), 'utf8'), context);
  await context.module.exports.ensureTripRuntimeSchema(client);
  const migration = statements.find(sql => sql.includes('DROP CONSTRAINT trips_workflow_stage_check'));
  assert.ok(migration);
  const opening = migration.match(/DO\s+(\$[a-z_]*\$)\s+BEGIN/i);
  assert.ok(opening, 'DO must open with a valid dollar-quote delimiter, not a single $');
  assert.ok(migration.includes(`END ${opening[1]};`), 'closing delimiter must match');
  assert.match(migration, /UPDATE public\.trips SET workflow_stage = 'check_in' WHERE workflow_stage = 'turnaround'/);
});
