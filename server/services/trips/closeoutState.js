function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim().toLowerCase();
}

function hasPendingExpenseStatus(expenseStatus) {
  return ["", "pending", "needs_review"].includes(
    normalizeText(expenseStatus)
  );
}

function hasPendingTollReview(hasTolls, tollReviewStatus) {
  if (!hasTolls) return false;

  return ["", "pending", "needs_review", "none"].includes(
    normalizeText(tollReviewStatus)
  );
}

function evaluateCloseoutCompleteness(trip) {
  const missingStartingOdometer = trip?.starting_odometer == null;
  const missingEndingOdometer = trip?.ending_odometer == null;
  const expensesPending = hasPendingExpenseStatus(trip?.expense_status);
  const tollsPending = hasPendingTollReview(
    Boolean(trip?.has_tolls),
    trip?.toll_review_status
  );

  const reasons = [];

  if (missingStartingOdometer) reasons.push("starting odometer");
  if (missingEndingOdometer) reasons.push("ending odometer");
  if (expensesPending) reasons.push("expense review");
  if (tollsPending) reasons.push("toll review");

  return {
    missingStartingOdometer,
    missingEndingOdometer,
    expensesPending,
    tollsPending,
    reasons,
    isIncomplete: reasons.length > 0,
  };
}

module.exports = {
  evaluateCloseoutCompleteness,
};
