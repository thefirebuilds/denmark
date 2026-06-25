export const APP_EVENTS = {
  authRequired: "denmark:auth-required",
  backendUnavailable: "denmark:backend-unavailable",
  openExpenseLedger: "denmark:open-expense-ledger",
  openTripLedger: "denmark:open-trip-ledger",
  messageStatsUpdated: "messages:stats-updated",
} as const;

export const TRIP_LEDGER_FOCUS_STORAGE_KEY = "denmark.tripLedgerFocus";
export const EXPENSE_LEDGER_FOCUS_STORAGE_KEY = "denmark.expenseLedgerFocus";
