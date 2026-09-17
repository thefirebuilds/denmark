function isDisputedReimbursement(subject = "", body = "") {
  return /\bdisput(?:e|ed|es|ing)\b/i.test(`${subject}\n${body}`);
}

module.exports = { isDisputedReimbursement };
