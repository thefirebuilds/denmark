const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { isDisputedReimbursement } = require("../services/reimbursementStatus");

test("dispute in subject or body is detected", () => {
  assert.equal(isDisputedReimbursement("Debra disputed your reimbursement invoice", "Refueling - $9.96"), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Your guest is disputing the invoice"), true);
  assert.equal(isDisputedReimbursement("Reimbursement invoice", "Total charge $19.96"), false);
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
