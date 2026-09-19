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

module.exports = { isDisputedReimbursement };
