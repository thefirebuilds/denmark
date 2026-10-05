const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { getReimbursementPaymentStatus } = require('../services/reimbursementStatus');

test('Marleen automatic-charge emails confirm account credit regardless of no-response subject', () => {
  const body = `Marleen has been charged for your reimbursement invoice
Turo has credited your account for the invoice balance from Marleen’s trip with your Hyundai Veloster 2016.
Tolls\n$102.29\nTotal charge\n$102.29`;
  for (const subject of ['Marleen has been charged for your reimbursement invoice',
    'Marleen has not responded to your reimbursement invoice']) {
    assert.equal(getReimbursementPaymentStatus(subject, body), 'credited');
  }
  assert.equal(getReimbursementPaymentStatus('Marleen has been charged for your reimbursement invoice', ''), 'charged');
  assert.equal(getReimbursementPaymentStatus('Marleen has not responded to your reimbursement invoice', 'Please wait for payment.'), 'unconfirmed');
  assert.equal(getReimbursementPaymentStatus('Reimbursement invoice', 'Turo will credit your account after payment.'), 'unconfirmed');
  assert.equal(getReimbursementPaymentStatus('Reimbursement invoice', 'Turo has not credited your account.'), 'unconfirmed');
});

test('no-response duplicate suppression requires a charged sibling, matching trip and matching total', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/messages.js'), 'utf8');
  const start = source.indexOf("LOWER(COALESCE(m.subject, '')) LIKE '%has not responded");
  const block = source.slice(start, start + 2300);
  assert.match(block, /has been charged for your reimbursement invoice/);
  assert.match(block, /substring\(COALESCE\(sibling.normalized_text_body/);
  assert.match(block, /= substring\(COALESCE\(m.normalized_text_body/);
  assert.match(block, /sibling.reservation_id = m.reservation_id/);
  assert.match(block, /INTERVAL '24 hours'/);
});
const path = require("node:path");
const { isDisputedReimbursement } = require("../services/reimbursementStatus");

test("dispute in subject or body is detected", () => {
  assert.equal(isDisputedReimbursement("Debra disputed your reimbursement invoice", "Refueling - $9.96"), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Your guest is disputing the invoice"), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Total charge $19.96"), false);
});

test("pending John Christian invoice is not disputed by instructional boilerplate", () => {
  assert.equal(isDisputedReimbursement("Reimbursement invoice", [
    "Your reimbursement invoice was sent to John Christian.",
    "Refueling - $8.64",
    "Refueling convenience fee - $10.00",
    "Total charge - $18.64",
    "Your guest can pay or dispute this invoice.",
    "If your guest has disputed the invoice, Turo will review it.",
  ].join("\n")), false);
});

test("optional, conditional and negated dispute language stays unconfirmed", () => {
  for (const text of [
    "Dispute invoice", "How to dispute your reimbursement invoice",
    "Your guest has not disputed the invoice.",
    "Your guest may dispute the invoice.",
    "Your guest has 48 hours to pay or dispute the invoice.",
    "If your guest is disputing the invoice, contact support.",
    "John has not disputed your reimbursement invoice",
  ]) {
    assert.equal(isDisputedReimbursement(text, text), false, text);
  }
});

test("explicit notifications still identify actual disputes", () => {
  assert.equal(isDisputedReimbursement("John Christian has disputed your reimbursement invoice", ""), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Your guest, John Christian, has disputed the reimbursement invoice."), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Your reimbursement invoice has been disputed."), true);
});

test("disputed invoice cannot update trip finances or closeout", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../services/saveMessage.js"), "utf8");
  const start = source.indexOf("async function applyTripCloseoutSignalsFromMessage(");
  const end = source.indexOf("function extractTripChangedFields", start);
  const context = { isDisputedReimbursement, pool: { query: () => assert.fail("must not write disputed charges") } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.applyTripCloseoutSignalsFromMessage({
    tripId: 1, messageType: "reimbursement_invoice",
    subject: "Debra disputed your reimbursement invoice",
    normalizedTextBody: "Refueling - $9.96\nRefueling convenience fee - $10.00\nTotal charge - $19.96",
  });
});
