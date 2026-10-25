export function transactionFlowLabel(transaction) {
  const amount = Number(transaction?.amount);
  if (!Number.isFinite(amount) || amount === 0) return 'No money movement';
  if (amount < 0) return 'Money out';
  const text = `${transaction.description || ''} ${transaction.counterparty_name || ''}`;
  if (/\b(refund|refunded|return|returned|credit|reimbursement|reimbursed)\b/i.test(text)) return 'Money in · possible refund';
  return transaction.matched_income_id ? 'Income' : 'Money in · income or refund';
}

export function expenseEffect(draft) {
  const price = Number(draft?.price || 0);
  const tax = Number(draft?.tax || 0);
  const refund = draft?.record_type === 'refund';
  const total = Math.abs(price) + Math.abs(tax);
  return { refund, total: total === 0 ? 0 : total * (refund ? -1 : 1) };
}
