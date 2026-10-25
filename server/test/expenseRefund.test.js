const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadService(transaction) {
  let saved;
  const context = vm.createContext({ module: { exports: {} }, console,
    require(name) {
      if (name === '../../db') return { query: async sql => ({ rows: sql.includes('FROM banking_transactions tt') ? [transaction] : [{ id: transaction.id }] }) };
      if (name === '../expenses/expenseService') return { createExpense: async payload => { saved = payload; return { id: 42, ...payload }; } };
      throw new Error(name);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/banking/bankingMatchService.js'), 'utf8'), context);
  return { service: context.module.exports, get saved() { return saved; } };
}

test('a tool refund without refund keywords saves negative expense and reduces the original cost', async () => {
  const loaded = loadService({ id: 1, amount: 75, description: 'Tool rental counter', transaction_date: '2026-10-25' });
  const result = await loaded.service.createExpenseFromBanking(1, { price: 75, category: 'Tools' });
  assert.equal(result.expense.price, -75);
  assert.equal(loaded.saved.tax, 0);
  assert.equal(loaded.saved.category, 'Tools');
  assert.equal(75 + result.expense.price, 0);
});

test('refund selection makes price and tax negative exactly once, while expense selection keeps costs positive', () => {
  const { service } = loadService({ id: 1 });
  for (const sign of [1, -1]) {
    const result = service.resolveExpenseTreatment({ amount: 81.19 }, { record_type: 'refund', price: sign * 75, tax: sign * 6.19 });
    assert.equal(result.price, -75);
    assert.equal(result.tax, -6.19);
  }
  assert.equal(service.resolveExpenseTreatment({ amount: -75, description: 'Return shipping' }).price, 75);
  assert.equal(service.resolveExpenseTreatment({ amount: 75 }, { record_type: 'expense', price: -75 }).price, 75);
  assert.throws(() => service.resolveExpenseTreatment({ amount: 75 }, { record_type: 'income' }), /Choose expense or refund/);
});

test('form preview agrees with saved refund signs and import labels distinguish money direction', async () => {
  const { expenseEffect, transactionFlowLabel } = await import('../../shared/expenseRefund.mjs');
  const { service } = loadService({ id: 1 });
  const draft = { record_type: 'refund', price: 75, tax: 6.19 };
  const saved = service.resolveExpenseTreatment({ amount: 81.19 }, draft);
  assert.equal(expenseEffect(draft).total, saved.price + saved.tax);
  assert.equal(transactionFlowLabel({ amount: -75, description: 'Tool rental' }), 'Money out');
  assert.equal(transactionFlowLabel({ amount: 75, description: 'Tool rental refund' }), 'Money in · possible refund');
  assert.equal(transactionFlowLabel({ amount: 75, description: 'Deposit' }), 'Money in · income or refund');
  assert.equal(transactionFlowLabel({ amount: 75, matched_income_id: 4 }), 'Income');
});
