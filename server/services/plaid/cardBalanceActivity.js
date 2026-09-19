function calculateCardBalanceActivity(rows, providerAccountId) {
  let cardActivityDelta = 0;
  let recognizedPaymentDelta = 0;
  let recognizedPaymentCount = 0;
  for (const row of rows) {
    if (row.provider_account_id !== providerAccountId) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    // Review/expense classifications do not change money owed to the card.
    // Preserve the imported sign, including payment reversals and refunds.
    const raw = row.raw_json || {};
    const description = [row.description, row.counterparty_name, raw.name]
      .filter(Boolean).join(' ');
    const isPayment = amount > 0 && (
      raw.personal_finance_category?.detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' ||
      /\bpayment\b|\bautopay\b/i.test(description)
    );
    if (isPayment) {
      recognizedPaymentDelta += amount;
      recognizedPaymentCount += 1;
    } else {
      cardActivityDelta += amount;
    }
  }
  return { cardActivityDelta, recognizedPaymentDelta, recognizedPaymentCount,
    normalizedDelta: cardActivityDelta + recognizedPaymentDelta };
}

module.exports = { calculateCardBalanceActivity };
