// --------------------------------------------------------------
// server/services/trips/legacyTripNormalizer.js
// Normalize Denmark 1.0 and Denmark 2.0 trip rows into a common
// comparison shape so we can reconcile by reservation_id.
// --------------------------------------------------------------

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function cleanReservationId(value) {
  const str = cleanString(value);
  return str ? str : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toInteger(value) {
  const num = toNumber(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function toBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(v)) return true;
    if (["false", "f", "0", "no", "n"].includes(v)) return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeLegacyStatus(rawStatus, expenseReportDone) {
  const status = cleanString(rawStatus)?.toLowerCase();
  const done = toBoolean(expenseReportDone) === true;

  if (status === "canceled" || status === "cancelled") return "canceled";

  if (
    status === "completed" ||
    status === "complete" ||
    status === "closed" ||
    status === "closed_out"
  ) {
    return "complete";
  }

  // legacy often leaves status as "booked" even after closeout
  if (done) return "complete";

  if (status === "active" || status === "in_progress") return "in_progress";
  if (status === "confirmed") return "confirmed";
  if (status === "ready_for_handoff") return "ready_for_handoff";
  if (status === "turnaround") return "turnaround";
  if (status === "awaiting_expenses") return "awaiting_expenses";
  if (status === "booked") return "booked";

  return status || "unknown";
}

function normalizeLegacyExpenseStatus(expenseReportDone) {
  return toBoolean(expenseReportDone) ? "resolved" : "none";
}

function normalizeD2Stage(rawWorkflowStage, rawStatus) {
  const stage = cleanString(rawWorkflowStage)?.toLowerCase();
  const status = cleanString(rawStatus)?.toLowerCase();

  if (stage) return stage;

  if (status === "canceled" || status === "cancelled") return "canceled";
  if (
    status === "completed" ||
    status === "complete" ||
    status === "closed" ||
    status === "closed_out"
  ) {
    return "complete";
  }
  if (status === "active" || status === "in_progress") return "in_progress";
  if (status === "confirmed") return "confirmed";
  if (status === "booked") return "booked";

  return status || "unknown";
}

function normalizeExpenseStatus(rawExpenseStatus) {
  const status = cleanString(rawExpenseStatus)?.toLowerCase();
  if (!status) return "none";
  return status;
}

function getLegacyTripStart(row) {
  return toIsoString(row.start_at || row.start_date);
}

function getLegacyTripEnd(row) {
  return toIsoString(row.end_at || row.end_date);
}

function normalizeLegacyTrip(row) {
  const reservationId = cleanReservationId(row.reservation_id);
  const normalizedStage = normalizeLegacyStatus(row.status, row.expense_report_done);
  const expenseDone = toBoolean(row.expense_report_done) === true;

  const completedAt =
    normalizedStage === "complete"
      ? toIsoString(row.updated_on || row.end_at || row.end_date)
      : null;

  const canceledAt =
    normalizedStage === "canceled"
      ? toIsoString(row.updated_on || row.start_at || row.start_date)
      : null;

  return {
    source: "legacy",
    id: row.id ?? null,
    reservation_id: reservationId,

    guest_name: cleanString(row.renter_name),
    status_raw: cleanString(row.status),
    normalized_stage: normalizedStage,

    trip_start: getLegacyTripStart(row),
    trip_end: getLegacyTripEnd(row),

    amount: toNumber(row.gross_income),

    starting_odometer: toInteger(row.mileage_start),
    ending_odometer: toInteger(row.mileage_end),

    expense_status: normalizeLegacyExpenseStatus(row.expense_report_done),

    notes: cleanString(row.notes),
    repair_notes: cleanString(row.repair_notes),

    toll_total: toNumber(row.toll_charges_guest),
    toll_reimbursement: toNumber(row.toll_reimbursement),

    expense_report_done: expenseDone,

    completed_at: completedAt,
    canceled_at: canceledAt,

    closed_out: normalizedStage === "complete" || normalizedStage === "canceled",

    raw: row,
  };
}

function normalizeD2Trip(row) {
  const normalizedStage = normalizeD2Stage(row.workflow_stage, row.status);

  return {
    source: "d2",
    id: row.id ?? null,
    reservation_id: cleanReservationId(row.reservation_id),

    guest_name: cleanString(row.guest_name),
    status_raw: cleanString(row.status),
    normalized_stage: normalizedStage,

    trip_start: toIsoString(row.trip_start),
    trip_end: toIsoString(row.trip_end),

    amount: toNumber(row.amount),

    starting_odometer: toInteger(row.starting_odometer),
    ending_odometer: toInteger(row.ending_odometer),

    expense_status: normalizeExpenseStatus(row.expense_status),

    notes: cleanString(row.notes),
    repair_notes: null,

    toll_total: toNumber(row.toll_total),
    toll_reimbursement: null,

    expense_report_done: null,

    completed_at: toIsoString(row.completed_at),
    canceled_at: toIsoString(row.canceled_at),
    closed_out: toBoolean(row.closed_out),

    workflow_stage: cleanString(row.workflow_stage),

    raw: row,
  };
}

module.exports = {
  cleanString,
  cleanReservationId,
  toNumber,
  toInteger,
  toBoolean,
  toIsoString,
  normalizeLegacyStatus,
  normalizeD2Stage,
  normalizeLegacyTrip,
  normalizeD2Trip,
};