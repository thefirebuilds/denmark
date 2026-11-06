const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function service() {
  const queries = [];
  const db = { query: async (sql, values) => { queries.push({ sql, values }); return { rows: [] }; } };
  const context = vm.createContext({ module: { exports: {} }, require: name => name === '../../db' ? db : {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/expenses/expenseService.js'), 'utf8'), context);
  return { list: context.module.exports.listExpenses, queries };
}

test('amount filters accept trailing decimals, cents and formatted currency using bound numbers', async () => {
  for (const [amount, expected] of [['37.', 37], ['245.', 245], ['91.', 91], ['464.', 464], ['311.', 311], ['.50', 0.5], ['-37.', -37], ['$1,234.50', 1234.5]]) {
    const s = service();
    await s.list({ amount, q: 'rock' });
    assert.equal(s.queries.length, 3);
    for (const { sql, values } of s.queries) {
      assert.ok(values.includes(expected));
      assert.ok(values.includes('%rock%'));
      assert.doesNotMatch(sql, /rock|\$1,234/);
    }
  }
});

test('invalid amount filters still return validation failures before any database work', async () => {
  for (const amount of ['.', '-', '37..', 'NaN', '1 OR 1=1']) {
    const s = service();
    await assert.rejects(s.list({ amount }), error => error.status === 400);
    assert.equal(s.queries.length, 0);
  }
});

test('summary drill-downs bind vendor, category, vehicle, date and unassigned-vehicle filters', async () => {
  const s = service();
  await s.list({ vendor: 'Rock Auto', category: 'Tools', vehicle_id: 7, date_from: '2026-11-01', date_to: '2026-11-05' });
  for (const { sql, values } of s.queries) {
    assert.match(sql, /e.vehicle_id = \$/);
    for (const value of ['Rock Auto', 'Tools', 7, '2026-11-01', '2026-11-05']) assert.ok(values.includes(value));
  }
  const none = service();
  await none.list({ vehicle_unassigned: 'true', category: 'Uncategorized' });
  assert.match(none.queries[0].sql, /e.vehicle_id IS NULL/);
  assert.match(none.queries[0].sql, /COALESCE\(NULLIF\(TRIM\(e.category\), ''\), 'Uncategorized'\)/);
});

test('drill-down filters replace stale searches and reset pagination; partial invalid typing stays local', async () => {
  const { expenseReviewFilters, validExpenseAmount } = await import('../../src/utils/expenseFilters.js');
  for (const filters of [{ vendor: 'Rock Auto' }, { category: 'Tools' }, { vehicle_unassigned: true }, {}]) {
    const next = expenseReviewFilters({ ...filters, page: 8 });
    assert.equal(next.q, '');
    assert.equal(next.amount, '');
    assert.equal(next.page, 1);
    for (const [key, value] of Object.entries(filters)) assert.equal(next[key], value);
  }
  for (const value of ['', '37.', '245.', '.50', '-37.', '$1,234.50']) assert.equal(validExpenseAmount(value), true);
  for (const value of ['-', '.', '37..', '$', 'invalid']) assert.equal(validExpenseAmount(value), false);
});
