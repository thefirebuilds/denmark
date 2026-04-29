// ------------------------------------------------------------
// /server/services/metrics/metricHelpers.js
// Shared helpers for metrics date windows, money math, mileage,
// and allocation logic.
// ------------------------------------------------------------

function isTripTollRecovered(trip) {
  const workflowStage = String(trip?.workflow_stage || "").toLowerCase();
  const expenseStatus = String(trip?.expense_status || "").toLowerCase();
  const tollReviewStatus = String(trip?.toll_review_status || "").toLowerCase();

  if (trip?.completed_at) return true;
  if (expenseStatus === "complete" || expenseStatus === "completed") return true;
  if (workflowStage === "complete" || workflowStage === "completed") return true;
  if (workflowStage === "turnaround" && tollReviewStatus !== "pending") return true;

  return false;
}

function isTripTollAttributedOutstanding(trip) {
  const tollTotal = toNumber(trip?.toll_total);
  if (tollTotal <= 0) return false;
  return !isTripTollRecovered(trip);
}

function getTripFuelReimbursementValue(trip, rangeStart, rangeEnd) {
  return getTripProratedValue(
    trip?.fuel_reimbursement_total,
    trip?.trip_start,
    trip?.trip_end,
    rangeStart,
    rangeEnd
  );
}

function getTripRecognizedTollRevenueValue(trip, rangeStart, rangeEnd) {
  if (!isTripTollRecovered(trip)) return 0;

  const chargedTollTotal =
    trip?.toll_charged_total != null ? trip.toll_charged_total : trip?.toll_total;

  return getTripProratedValue(
    chargedTollTotal,
    trip?.trip_start,
    trip?.trip_end,
    rangeStart,
    rangeEnd
  );
}

function getTripTotalDays(tripStartInput, tripEndInput) {
  if (!tripStartInput || !tripEndInput) return 0;

  const tripStart = new Date(tripStartInput);
  const tripEnd = new Date(tripEndInput);

  if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) {
    return 0;
  }

  const millis = endOfDay(tripEnd).getTime() - startOfDay(tripStart).getTime();
  return Math.max(0, Math.floor(millis / 86400000) + 1);
}

function getTripProratedValue(value, tripStartInput, tripEndInput, rangeStart, rangeEnd) {
  const totalValue = toNumber(value);
  const totalDays = getTripTotalDays(tripStartInput, tripEndInput);
  const overlapDays = getOverlapDays(tripStartInput, tripEndInput, rangeStart, rangeEnd);

  if (!totalValue || !totalDays || !overlapDays) return 0;
  return totalValue * (overlapDays / totalDays);
}

function getTripProratedAmount(trip, rangeStart, rangeEnd) {
  return getTripProratedValue(
    trip?.amount,
    trip?.trip_start,
    trip?.trip_end,
    rangeStart,
    rangeEnd
  );
}

function getTripProratedCount(trip, rangeStart, rangeEnd) {
  const totalDays = getTripTotalDays(trip?.trip_start, trip?.trip_end);
  const overlapDays = getOverlapDays(trip?.trip_start, trip?.trip_end, rangeStart, rangeEnd);

  if (!totalDays || !overlapDays) return 0;
  return overlapDays / totalDays;
}

function getCalendarDaysInRange(startDate, endDate) {
  if (!endDate) return 0;
  if (!startDate) return 0;

  const millis = endOfDay(endDate).getTime() - startOfDay(startDate).getTime();
  return Math.max(0, Math.floor(millis / 86400000) + 1);
}

function getTripTotalDays(tripStartInput, tripEndInput) {
  if (!tripStartInput || !tripEndInput) return 0;

  const tripStart = new Date(tripStartInput);
  const tripEnd = new Date(tripEndInput);

  if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) {
    return 0;
  }

  const millis = endOfDay(tripEnd).getTime() - startOfDay(tripStart).getTime();
  return Math.max(0, Math.floor(millis / 86400000) + 1);
}

function getTripProratedValue(value, tripStartInput, tripEndInput, rangeStart, rangeEnd) {
  const totalValue = toNumber(value);
  const totalDays = getTripTotalDays(tripStartInput, tripEndInput);
  const overlapDays = getOverlapDays(tripStartInput, tripEndInput, rangeStart, rangeEnd);

  if (!totalValue || !totalDays || !overlapDays) return 0;
  return totalValue * (overlapDays / totalDays);
}

function getTripProratedAmount(trip, rangeStart, rangeEnd) {
  return getTripProratedValue(
    trip?.amount,
    trip?.trip_start,
    trip?.trip_end,
    rangeStart,
    rangeEnd
  );
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getDateRange(rangeKey = "30d") {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  switch (String(rangeKey).toLowerCase()) {
    case "30":
    case "30d":
      return {
        key: "30d",
        startDate: addDays(todayStart, -29),
        endDate: todayEnd,
      };

    case "90":
    case "90d":
      return {
        key: "90d",
        startDate: addDays(todayStart, -89),
        endDate: todayEnd,
      };

    case "ytd": {
      const yearStart = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      return {
        key: "ytd",
        startDate: yearStart,
        endDate: todayEnd,
      };
    }

    case "all":
      return {
        key: "all",
        startDate: null,
        endDate: todayEnd,
      };

    default:
      return {
        key: "30d",
        startDate: addDays(todayStart, -29),
        endDate: todayEnd,
      };
  }
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Number(toNumber(value).toFixed(2));
}

function roundNumber(value, decimals = 2) {
  return Number(toNumber(value).toFixed(decimals));
}

function safeDivide(numerator, denominator, fallback = 0) {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  if (!d) return fallback;
  return n / d;
}

function clampNonNegative(value) {
  return Math.max(0, toNumber(value));
}

function getExpenseTotal(expense) {
  if (!expense) return 0;
  return toNumber(expense.total_cost, toNumber(expense.price) + toNumber(expense.tax));
}

function normalizeCategory(category) {
  return String(category || "").trim().toLowerCase();
}

function isTollExpense(expense) {
  const category = normalizeCategory(expense?.category);
  const vendor = String(expense?.vendor || "").toLowerCase();
  return category === "tolls" || vendor.includes("hctra");
}

function isCleaningExpense(expense) {
  return normalizeCategory(expense?.category) === "cleaning";
}

function isOnboardingExpense(expense) {
  return normalizeCategory(expense?.category) === "onboarding";
}

function tripOverlapsRange(trip, startDate, endDate) {
  if (!trip?.trip_start || !trip?.trip_end) return false;

  const tripStart = new Date(trip.trip_start);
  const tripEnd = new Date(trip.trip_end);

  if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) {
    return false;
  }

  if (!startDate && !endDate) return true;
  if (!startDate) return tripStart <= endDate;
  if (!endDate) return tripEnd >= startDate;

  return tripStart <= endDate && tripEnd >= startDate;
}

function getOverlapDays(tripStartInput, tripEndInput, rangeStart, rangeEnd) {
  if (!tripStartInput || !tripEndInput) return 0;

  const tripStart = new Date(tripStartInput);
  const tripEnd = new Date(tripEndInput);

  if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) {
    return 0;
  }

  const start = rangeStart ? new Date(Math.max(tripStart.getTime(), rangeStart.getTime())) : tripStart;
  const end = rangeEnd ? new Date(Math.min(tripEnd.getTime(), rangeEnd.getTime())) : tripEnd;

  if (end < start) return 0;

  const millis = endOfDay(end).getTime() - startOfDay(start).getTime();
  return Math.max(0, Math.floor(millis / 86400000) + 1);
}

function getTripMiles(trip) {
  const start = toNumber(trip?.starting_odometer, NaN);
  const end = toNumber(trip?.ending_odometer, NaN);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end < start) return 0;

  return end - start;
}

function toMapBy(array, keyFn) {
  const map = new Map();
  for (const item of array || []) {
    map.set(keyFn(item), item);
  }
  return map;
}

function sumBy(array, valueFn) {
  return (array || []).reduce((sum, item) => sum + toNumber(valueFn(item)), 0);
}

module.exports = {
  clampNonNegative,
  getCalendarDaysInRange,
  getDateRange,
  getExpenseTotal,
  getOverlapDays,
  getTripMiles,
  getTripFuelReimbursementValue,
  getTripRecognizedTollRevenueValue,
  getTripProratedAmount,
  getTripProratedCount,
  getTripProratedValue,
  getTripTotalDays,
  isCleaningExpense,
  isOnboardingExpense,
  isTollExpense,
  isTripTollAttributedOutstanding,
  isTripTollRecovered,
  normalizeCategory,
  roundMoney,
  roundNumber,
  safeDivide,
  startOfDay,
  endOfDay,
  sumBy,
  toMapBy,
  toNumber,
  tripOverlapsRange,
};
