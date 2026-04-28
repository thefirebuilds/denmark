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
  isTripTollAttributedOutstanding,
  isTripTollRecovered,
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
        guest_name,
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

async function fetchTollChargesInRange(client, startDate, endDate) {
  const params = [endDate];
  const dateClause = startDate
    ? `WHERE tc.trxn_at >= $2::timestamptz
        AND tc.trxn_at <= $1::timestamptz`
    : `WHERE tc.trxn_at <= $1::timestamptz`;

  if (startDate) params.push(startDate);

  const { rows } = await client.query(
    `
      SELECT
        tc.id,
        tc.trxn_at,
        tc.posted_at,
        tc.amount,
        tc.license_plate,
        tc.license_state,
        tc.vehicle_nickname,
        tc.agency_name,
        tc.facility_name,
        tc.plaza_name,
        tc.lane_name,
        tc.direction,
        tc.trans_type,
        tc.match_status,
        tc.review_status,
        tc.matched_vehicle_id,
        tc.matched_trip_id,
        mv.nickname AS matched_vehicle_nickname,
        mv.license_plate AS matched_vehicle_plate,
        mv.turo_vehicle_id AS matched_vehicle_turo_id,
        mt.reservation_id AS matched_reservation_id,
        mt.guest_name AS matched_guest_name,
        mt.trip_start AS matched_trip_start,
        mt.trip_end AS matched_trip_end,
        candidate.id AS candidate_trip_id,
        candidate.reservation_id AS candidate_reservation_id,
        candidate.guest_name AS candidate_guest_name,
        candidate.trip_start AS candidate_trip_start,
        candidate.trip_end AS candidate_trip_end
      FROM toll_charges tc
      LEFT JOIN vehicles mv
        ON mv.id = tc.matched_vehicle_id
      LEFT JOIN trips mt
        ON mt.id = tc.matched_trip_id
      LEFT JOIN LATERAL (
        SELECT
          t.id,
          t.reservation_id,
          t.guest_name,
          t.trip_start,
          t.trip_end
        FROM trips t
        WHERE tc.matched_trip_id IS NULL
          AND mv.turo_vehicle_id IS NOT NULL
          AND t.turo_vehicle_id = mv.turo_vehicle_id
          AND COALESCE(lower(t.workflow_stage), '') <> 'canceled'
          AND t.trip_start IS NOT NULL
          AND t.trip_end IS NOT NULL
          AND tc.trxn_at >= (t.trip_start - INTERVAL '2 hours')
          AND tc.trxn_at <= (t.trip_end + INTERVAL '12 hours')
        ORDER BY
          ABS(EXTRACT(EPOCH FROM (tc.trxn_at - t.trip_start))) ASC,
          t.trip_start DESC
        LIMIT 1
      ) candidate ON TRUE
      ${dateClause}
      ORDER BY tc.trxn_at DESC, tc.id DESC
    `,
    params
  );

  return rows;
}

function mapUnattributedTollCharge(row) {
  return {
    toll_charge_id: row.id,
    trxn_at: row.trxn_at,
    posted_at: row.posted_at,
    amount: roundMoney(row.amount),
    license_plate: row.license_plate || null,
    license_state: row.license_state || null,
    vehicle_nickname: row.vehicle_nickname || row.matched_vehicle_nickname || null,
    matched_vehicle_nickname: row.matched_vehicle_nickname || null,
    matched_vehicle_plate: row.matched_vehicle_plate || null,
    agency_name: row.agency_name || null,
    facility_name: row.facility_name || null,
    plaza_name: row.plaza_name || null,
    lane_name: row.lane_name || null,
    direction: row.direction || null,
    trans_type: row.trans_type || null,
    match_status: row.match_status || null,
    review_status: row.review_status || null,
    matched_trip: row.matched_trip_id
      ? {
          trip_id: row.matched_trip_id,
          reservation_id: row.matched_reservation_id || null,
          guest_name: row.matched_guest_name || null,
          trip_start: row.matched_trip_start || null,
          trip_end: row.matched_trip_end || null,
        }
      : null,
    candidate_trip: row.candidate_trip_id
      ? {
          trip_id: row.candidate_trip_id,
          reservation_id: row.candidate_reservation_id || null,
          guest_name: row.candidate_guest_name || null,
          trip_start: row.candidate_trip_start || null,
          trip_end: row.candidate_trip_end || null,
        }
      : null,
  };
}

async function getTollMetricsDetail(rangeKey = "30d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const client = await pool.connect();

  try {
    const [trips, tollCharges] = await Promise.all([
      fetchTripsInRange(client, startDate, endDate),
      fetchTollChargesInRange(client, startDate, endDate),
    ]);

    const outstandingTrips = trips
      .filter((trip) => isTripTollAttributedOutstanding(trip))
      .map((trip) => ({
        trip_id: trip.id,
        reservation_id: trip.reservation_id || null,
        guest_name: trip.guest_name || null,
        turo_vehicle_id: trip.turo_vehicle_id || null,
        trip_start: trip.trip_start || null,
        trip_end: trip.trip_end || null,
        toll_total: roundMoney(trip.toll_total),
        toll_review_status: getNormalizedTollStatus(trip),
        workflow_stage: trip.workflow_stage || null,
        expense_status: trip.expense_status || null,
        recovered: isTripTollRecovered(trip),
      }))
      .sort((a, b) => new Date(a.trip_end || 0).getTime() - new Date(b.trip_end || 0).getTime());

    const unattributedCharges = tollCharges
      .filter((charge) => !charge.matched_trip_id)
      .map(mapUnattributedTollCharge);

    return {
      range: key,
      unattributed: {
        total_amount: roundMoney(
          unattributedCharges.reduce((sum, item) => sum + Number(item.amount || 0), 0)
        ),
        count: unattributedCharges.length,
        charges: unattributedCharges,
      },
      outstanding: {
        total_amount: roundMoney(
          outstandingTrips.reduce((sum, item) => sum + Number(item.toll_total || 0), 0)
        ),
        count: outstandingTrips.length,
        trips: outstandingTrips,
      },
    };
  } finally {
    client.release();
  }
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
  getTollMetricsDetail,
};
