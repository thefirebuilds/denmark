function isDisputedReimbursement(subject = "", body = "") {
  const title = String(subject || "").trim();
  // The invoice template also describes the option to dispute. Only an
  // affirmative notification is evidence that a dispute actually happened.
  if (!/\b(?:not|never|hasn't|haven't|if|can|may|could|would|should)\b/i.test(title) &&
      /^.+?\s+(?:has\s+)?disputed your reimbursement invoice[.!]?$/i.test(title)) {
    return true;
  }

  return String(body || "").split(/[\r\n]+|[.!?]\s+/).some((sentence) => {
    const text = sentence.trim();
    return /^your guest(?:,\s*[^,\r\n]+,)?\s+(?:has disputed|is disputing|disputed)\s+(?:the|your|this)\s+(?:reimbursement\s+)?invoice\b/i.test(text) ||
      /^(?:your|the|this) reimbursement invoice (?:has been|was) disputed\b/i.test(text);
  });
}

function getReimbursementPaymentStatus(subject = '', body = '') {
  // A no-response subject accompanies Turo's automatic charge email. The
  // affirmative account-credit statement in the body is the payment evidence.
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (/\bTuro has credited your account for (?:the )?invoice balance\b/i.test(text)) return 'credited';
  if (isDisputedReimbursement(subject, body)) return 'disputed';
  if (/^.+? has been charged for your reimbursement invoice[.!]?$/i.test(String(subject).trim()) ||
    /^.+? has been charged for your reimbursement invoice[.!]?$/im.test(String(body))) return 'charged';
  return 'unconfirmed';
}

module.exports = { isDisputedReimbursement, getReimbursementPaymentStatus };
