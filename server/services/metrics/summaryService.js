// ------------------------------------------------------------
// /server/services/metrics/summaryService.js
// Summary metrics for the top KPI cards.
// ------------------------------------------------------------

const pool = require("../../db");
const {
  getCalendarDaysInRange,
  getDateRange,
  getExpenseTotal,
  getOverlapDays,
  getTripFuelReimbursementValue,
  getTripProratedAmount,
  getTripProratedCount,
  getTripProratedValue,
  getTripRecognizedTollRevenueValue,
  isCleaningExpense,
  isTollExpense,
  roundMoney,
  roundNumber,
  safeDivide,
  tripOverlapsRange,
} = require("./metricHelpers");
const {
  getLatestVehicleFmvEstimates,
} = require("../vehicles/fmvEstimateService");

async function fetchTripsInRange(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        reservation_id,
        turo_vehicle_id,
        trip_start,
        trip_end,
        amount,
        fuel_reimbursement_total,
        starting_odometer,
        ending_odometer,
        toll_total,
        toll_review_status,
        workflow_stage,
        expense_status,
        completed_at,
        canceled_at
      FROM trips
      WHERE trip_start <= $2
        AND trip_end >= COALESCE($1, trip_start)
        AND (
          canceled_at IS NULL
          OR COALESCE(amount, 0) > 0
        )
    `,
    [startDate, endDate]
  );

  return rows.filter((trip) => tripOverlapsRange(trip, startDate, endDate));
}

async function fetchExpensesInRange(client, startDate, endDate) {
  if (!startDate) {
    const { rows } = await client.query(
      `
        SELECT
          id,
          vehicle_id,
          vendor,
          price,
          tax,
          category,
          expense_scope,
          trip_id,
          date
        FROM expenses
        WHERE date <= $1::date
      `,
      [endDate]
    );

    return rows;
  }

  const { rows } = await client.query(
    `
      SELECT
        id,
        vehicle_id,
        vendor,
        price,
        tax,
        category,
        expense_scope,
        trip_id,
        date
      FROM expenses
      WHERE date >= $1::date
        AND date <= $2::date
    `,
    [startDate, endDate]
  );

  return rows;
}

function getNormalizedTollStatus(trip) {
  return String(trip?.toll_review_status || "")
    .trim()
    .toLowerCase();
}

async function getSummaryMetrics(rangeKey = "30d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const client = await pool.connect();

  try {
    const [trips, expenses, latestFmvEstimates] = await Promise.all([
      fetchTripsInRange(client, startDate, endDate),
      fetchExpensesInRange(client, startDate, endDate),
      getLatestVehicleFmvEstimates(client),
    ]);

    const tripIncome = trips.reduce(
      (sum, trip) => sum + getTripProratedAmount(trip, startDate, endDate),
      0
    );
    const fuelReimbursements = trips.reduce(
      (sum, trip) =>
        sum + getTripFuelReimbursementValue(trip, startDate, endDate),
      0
    );
    const tollRevenue = trips.reduce(
      (sum, trip) =>
        sum + getTripRecognizedTollRevenueValue(trip, startDate, endDate),
      0
    );

    const tripCountOverlapping = trips.length;

    const tripCountProrated = trips.reduce(
      (sum, trip) => sum + getTripProratedCount(trip, startDate, endDate),
      0
    );

    const bookedVehicleDays = trips.reduce(
      (sum, trip) =>
        sum + getOverlapDays(trip.trip_start, trip.trip_end, startDate, endDate),
      0
    );

    const calendarDays =
      key === "all" ? 0 : getCalendarDaysInRange(startDate, endDate);

    const expensesTotal = expenses.reduce(
      (sum, expense) => sum + getExpenseTotal(expense),
      0
    );

    const cleaningTotal = expenses
      .filter(isCleaningExpense)
      .reduce((sum, expense) => sum + getExpenseTotal(expense), 0);

    const tollsPaid = expenses
  .filter(isTollExpense)
  .reduce((sum, expense) => sum + getExpenseTotal(expense), 0);

function isTripComplete(trip) {
  const workflowStage = String(trip?.workflow_stage || "").trim().toLowerCase();
  return workflowStage === "complete" || trip?.completed_at != null;
}

function isTollBillingComplete(trip) {
  const tollStatus = String(trip?.toll_review_status || "").trim().toLowerCase();
  return tollStatus === "billed";
}

function getTollValueForRange(trip) {
  const tollTotal = Number(trip?.toll_total ?? 0);
  if (!(tollTotal > 0)) return 0;

  if (key === "all") return tollTotal;

  return getTripProratedValue(
    tollTotal,
    trip.trip_start,
    trip.trip_end,
    startDate,
    endDate
  );
}

const tollsRecovered = trips.reduce((sum, trip) => {
  if (!isTripComplete(trip)) return sum;
  if (!isTollBillingComplete(trip)) return sum;

  return sum + getTollValueForRange(trip);
}, 0);

const tollsAttributedOutstanding = trips.reduce((sum, trip) => {
  if (isTripComplete(trip)) return sum;
  if (isTollBillingComplete(trip)) return sum;

  return sum + getTollValueForRange(trip);
}, 0);

const tollsUnattributed = Math.max(
  0,
  tollsPaid - tollsRecovered - tollsAttributedOutstanding
);

    const otherIncome = fuelReimbursements + tollRevenue;
    const revenue = tripIncome + otherIncome;
    const netProfit = revenue - expensesTotal;
    const fleetValue = latestFmvEstimates.reduce(
      (sum, estimate) => sum + Number(estimate?.estimate_mid ?? 0),
      0
    );
    const previousFleetValue = latestFmvEstimates.reduce(
      (sum, estimate) => sum + Number(estimate?.previous_estimate_mid ?? estimate?.estimate_mid ?? 0),
      0
    );
    const fleetValueChange = fleetValue - previousFleetValue;
    const fleetValueUpdatedAt =
      latestFmvEstimates.reduce((latest, estimate) => {
        const candidate = estimate?.estimated_at || null;
        if (!candidate) return latest;
        if (!latest) return candidate;
        return new Date(candidate).getTime() > new Date(latest).getTime()
          ? candidate
          : latest;
      }, null) || null;

    return {
      range: key,
      revenue: roundMoney(revenue),
      trip_income: roundMoney(tripIncome),
      other_income: roundMoney(otherIncome),
      fuel_reimbursements: roundMoney(fuelReimbursements),
      toll_revenue: roundMoney(tollRevenue),
      expenses: roundMoney(expensesTotal),
      net_profit: roundMoney(netProfit),
      fleet_value: roundMoney(fleetValue),
      fleet_value_previous: roundMoney(previousFleetValue),
      fleet_value_change: roundMoney(fleetValueChange),
      fleet_value_updated_at: fleetValueUpdatedAt,

      trip_count_overlapping: tripCountOverlapping,
      trip_count_prorated: roundNumber(tripCountProrated, 2),

      booked_vehicle_days: bookedVehicleDays,
      calendar_days: calendarDays,

      revenue_per_overlapping_trip: roundMoney(
        safeDivide(revenue, tripCountOverlapping)
      ),
      revenue_per_prorated_trip: roundMoney(
        safeDivide(revenue, tripCountProrated)
      ),
      revenue_per_booked_day: roundMoney(
        safeDivide(revenue, bookedVehicleDays)
      ),
      revenue_per_calendar_day: roundMoney(
        safeDivide(revenue, calendarDays)
      ),

      cleaning_cost_per_overlapping_trip: roundMoney(
        safeDivide(cleaningTotal, tripCountOverlapping)
      ),
      cleaning_cost_per_prorated_trip: roundMoney(
        safeDivide(cleaningTotal, tripCountProrated)
      ),

      tolls_paid: roundMoney(tollsPaid),
      tolls_recovered: roundMoney(tollsRecovered),
      tolls_attributed_outstanding: roundMoney(tollsAttributedOutstanding),
      tolls_unattributed: roundMoney(tollsUnattributed),
      toll_recovery_rate: roundNumber(safeDivide(tollsRecovered, tollsPaid)),
      toll_effective_recovery_rate: roundNumber(
        safeDivide(tollsRecovered + tollsAttributedOutstanding, tollsPaid)
      ),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getSummaryMetrics,
};
