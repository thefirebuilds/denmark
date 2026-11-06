export const DEFAULT_EXPENSE_FILTERS = {
  q: '', amount: '', category: '', vendor: '', expense_scope: '', is_capitalized: '',
  date_from: '', date_to: '', sort: 'date', direction: 'desc', page: 1, limit: 50,
};

export function expenseReviewFilters(filters = {}) {
  return { ...DEFAULT_EXPENSE_FILTERS, ...filters, page: 1 };
}

export function validExpenseAmount(value) {
  const text = String(value || '').trim().replace(/[$,]/g, '');
  return !String(value || '').trim() || (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number.isFinite(Number(text)));
}
