const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateCardBalanceActivity } = require('../services/plaid/cardBalanceActivity');
const account = 'plaid:citi4483';
const transaction = (amount, extra = {}) => ({ provider_account_id: account, amount, ...extra });

test('all card spending increases debt regardless of expense or review classification', () => {
  const rows = [
    transaction(-100, { review_status: 'matched', matched_expense_id: 1 }),
    transaction(-50, { review_status: 'ignored', ignored: true }),
    transaction(-25, { review_status: 'pending', matched_expense_id: null }),
    transaction(-10, { status: 'pending', description: 'Personal purchase' }),
  ];
  const result = calculateCardBalanceActivity(rows, account);
  assert.equal(1000 - result.normalizedDelta, 1185);
});

test('a payment appearing on the bank and card reduces debt only once', () => {
  const result = calculateCardBalanceActivity([
    transaction(-200, { provider_account_id: 'mercury:checking', description: 'Citi online card payment' }),
    transaction(200, { description: 'AUTOPAY', transaction_date: '2026-09-18' }),
  ], account);
  assert.equal(1000 - result.normalizedDelta, 800);
  assert.equal(result.recognizedPaymentCount, 1);
});

test('other-account activity cannot change this card balance', () => {
  const result = calculateCardBalanceActivity([
    transaction(-400, { provider_account_id: 'plaid:other-card', description: 'Citi online card payment' }),
  ], account);
  assert.equal(result.normalizedDelta, 0);
});

test('refunds reduce debt and payment reversals increase it', () => {
  const result = calculateCardBalanceActivity([
    transaction(50, { description: 'Store refund' }),
    transaction(-200, { description: 'Citi online card payment reversal' }),
  ], account);
  assert.equal(1000 - result.normalizedDelta, 1150);
});

test('distinct equal payments on the same date are both counted', () => {
  const result = calculateCardBalanceActivity([
    transaction(100, { id: 1, description: 'Payment', transaction_date: '2026-09-18' }),
    transaction(100, { id: 2, description: 'Payment', transaction_date: '2026-09-18' }),
  ], account);
  assert.equal(result.normalizedDelta, 200);
  assert.equal(result.recognizedPaymentCount, 2);
});

test('payment naming affects breakdown only, never the total', () => {
  assert.equal(calculateCardBalanceActivity([transaction(123, { description: 'Unknown credit' })], account).normalizedDelta,
    calculateCardBalanceActivity([transaction(123, { description: 'Citi card payment' })], account).normalizedDelta);
});
