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
const { getVehicleMetrics } = require("./vehicleMetricsService");

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
        toll_charged_total,
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

function parseMoney(value) {
  if (!value) return null;
  const n = Number(String(value).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function extractTollAmountFromText(normalizedTextBody) {
  const text = String(normalizedTextBody || "");
  const match = text.match(/tolls?\s*-\s*\$([0-9,]+(?:\.\d{2})?)/i);
  return match ? parseMoney(match[1]) : null;
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
        candidate.top_trip_id AS candidate_trip_id,
        candidate.top_reservation_id AS candidate_reservation_id,
        candidate.top_guest_name AS candidate_guest_name,
        candidate.top_trip_start AS candidate_trip_start,
        candidate.top_trip_end AS candidate_trip_end,
        candidate.candidates_json AS candidate_trips_json
      FROM toll_charges tc
      LEFT JOIN vehicles mv
        ON mv.id = tc.matched_vehicle_id
      LEFT JOIN trips mt
        ON mt.id = tc.matched_trip_id
      LEFT JOIN LATERAL (
        SELECT
          candidates.candidates_json,
          candidates.candidates_json->0->>'trip_id' AS top_trip_id,
          candidates.candidates_json->0->>'reservation_id' AS top_reservation_id,
          candidates.candidates_json->0->>'guest_name' AS top_guest_name,
          candidates.candidates_json->0->>'trip_start' AS top_trip_start,
          candidates.candidates_json->0->>'trip_end' AS top_trip_end
        FROM (
          SELECT jsonb_agg(
            jsonb_build_object(
              'trip_id', ranked.id,
              'reservation_id', ranked.reservation_id,
              'guest_name', ranked.guest_name,
              'trip_start', ranked.trip_start,
              'trip_end', ranked.trip_end,
              'workflow_stage', ranked.workflow_stage,
              'hours_from_start', ranked.hours_from_start
            )
            ORDER BY ranked.hours_from_start ASC, ranked.trip_start DESC
          ) AS candidates_json
          FROM (
            SELECT
              t.id,
              t.reservation_id,
              t.guest_name,
              t.trip_start,
              t.trip_end,
              t.workflow_stage,
              ABS(EXTRACT(EPOCH FROM (tc.trxn_at - t.trip_start))) / 3600.0 AS hours_from_start
            FROM trips t
            WHERE tc.matched_trip_id IS NULL
              AND mv.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id = mv.turo_vehicle_id
              AND COALESCE(lower(t.workflow_stage), '') <> 'canceled'
              AND t.trip_start IS NOT NULL
              AND t.trip_end IS NOT NULL
              AND tc.trxn_at >= (t.trip_start - INTERVAL '24 hours')
              AND tc.trxn_at <= (t.trip_end + INTERVAL '72 hours')
            ORDER BY
              ABS(EXTRACT(EPOCH FROM (tc.trxn_at - t.trip_start))) ASC,
              t.trip_start DESC
            LIMIT 5
          ) ranked
        ) candidates
      ) candidate ON TRUE
      ${dateClause}
      ORDER BY tc.trxn_at DESC, tc.id DESC
    `,
    params
  );

  return rows;
}

async function fetchTollInvoiceMessages(client, tripIds, reservationIds) {
  const validTripIds = Array.from(
    new Set((tripIds || []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))
  );
  const validReservationIds = Array.from(
    new Set(
      (reservationIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (!validTripIds.length && !validReservationIds.length) return [];

  const params = [];
  const targetConditions = [];

  if (validTripIds.length) {
    params.push(validTripIds);
    targetConditions.push(`trip_id = ANY($${params.length}::int[])`);
  }

  if (validReservationIds.length) {
    params.push(validReservationIds);
    targetConditions.push(`reservation_id = ANY($${params.length}::bigint[])`);
  }

  const { rows } = await client.query(
    `
      SELECT
        id,
        trip_id,
        reservation_id,
        subject,
        normalized_text_body,
        message_timestamp,
        created_at
      FROM messages
      WHERE message_type = 'reimbursement_invoice'
        AND (${targetConditions.join(" OR ")})
      ORDER BY COALESCE(message_timestamp, created_at) DESC, id DESC
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
          trip_id: Number(row.candidate_trip_id),
          reservation_id: row.candidate_reservation_id || null,
          guest_name: row.candidate_guest_name || null,
          trip_start: row.candidate_trip_start || null,
          trip_end: row.candidate_trip_end || null,
        }
      : null,
    candidate_trips: Array.isArray(row.candidate_trips_json)
      ? row.candidate_trips_json.map((trip) => ({
          trip_id: Number(trip?.trip_id),
          reservation_id: trip?.reservation_id ?? null,
          guest_name: trip?.guest_name ?? null,
          trip_start: trip?.trip_start ?? null,
          trip_end: trip?.trip_end ?? null,
          workflow_stage: trip?.workflow_stage ?? null,
          hours_from_start:
            trip?.hours_from_start == null ? null : Number(trip.hours_from_start),
        }))
      : [],
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

    const tollInvoiceMessages = await fetchTollInvoiceMessages(
      client,
      trips.map((trip) => trip.id),
      trips.map((trip) => trip.reservation_id)
    );

    const latestTollInvoiceByTripKey = new Map();
    for (const message of tollInvoiceMessages) {
      const tollAmount = extractTollAmountFromText(message.normalized_text_body);
      if (!(tollAmount >= 0)) continue;

      const keys = [];
      if (message.trip_id) keys.push(`trip:${message.trip_id}`);
      if (message.reservation_id) keys.push(`reservation:${message.reservation_id}`);

      for (const key of keys) {
        if (!latestTollInvoiceByTripKey.has(key)) {
          latestTollInvoiceByTripKey.set(key, {
            message_id: message.id,
            charged_toll_amount: roundMoney(tollAmount),
            charged_at: message.message_timestamp || message.created_at || null,
            subject: message.subject || null,
          });
        }
      }
    }

    const attributedTollTotalsByTripId = new Map();
    for (const charge of tollCharges) {
      if (!charge?.matched_trip_id) continue;
      const tripId = Number(charge.matched_trip_id);
      const current = Number(attributedTollTotalsByTripId.get(tripId) || 0);
      attributedTollTotalsByTripId.set(
        tripId,
        current + Number(charge.amount || 0)
      );
    }

    const outstandingTrips = trips
      .filter((trip) => isTripTollAttributedOutstanding(trip))
      .map((trip) => {
        const invoice =
          latestTollInvoiceByTripKey.get(`trip:${trip.id}`) ||
          latestTollInvoiceByTripKey.get(`reservation:${trip.reservation_id}`) ||
          null;
        const attributedTollAmount = roundMoney(
          attributedTollTotalsByTripId.get(Number(trip.id)) || 0
        );
        const chargedTollAmount =
          trip?.toll_charged_total != null
            ? roundMoney(trip.toll_charged_total)
            : invoice?.charged_toll_amount != null
            ? roundMoney(invoice.charged_toll_amount)
            : null;
        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          turo_vehicle_id: trip.turo_vehicle_id || null,
          trip_start: trip.trip_start || null,
          trip_end: trip.trip_end || null,
          toll_total: roundMoney(trip.toll_total),
          attributed_toll_amount: attributedTollAmount,
          charged_toll_amount: chargedTollAmount,
          toll_delta:
            chargedTollAmount == null
              ? null
              : roundMoney(chargedTollAmount - attributedTollAmount),
          charged_at: invoice?.charged_at || null,
          toll_review_status: getNormalizedTollStatus(trip),
          workflow_stage: trip.workflow_stage || null,
          expense_status: trip.expense_status || null,
          recovered: isTripTollRecovered(trip),
        };
      })
      .sort((a, b) => new Date(a.trip_end || 0).getTime() - new Date(b.trip_end || 0).getTime());

    const discrepancyTrips = trips
      .map((trip) => {
        const invoice =
          latestTollInvoiceByTripKey.get(`trip:${trip.id}`) ||
          latestTollInvoiceByTripKey.get(`reservation:${trip.reservation_id}`) ||
          null;
        const recovered = isTripTollRecovered(trip);
        const attributedTollAmount = roundMoney(
          attributedTollTotalsByTripId.get(Number(trip.id)) || 0
        );
        const chargedTollAmount =
          trip?.toll_charged_total != null
            ? roundMoney(trip.toll_charged_total)
            : invoice?.charged_toll_amount != null
            ? roundMoney(invoice.charged_toll_amount)
            : null;

        if (chargedTollAmount == null) {
          if (!recovered) return null;
          if (!(attributedTollAmount > 0)) return null;
        }

        const tollDelta = roundMoney((chargedTollAmount || 0) - attributedTollAmount);
        if (Math.abs(tollDelta) < 0.01) return null;

        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          turo_vehicle_id: trip.turo_vehicle_id || null,
          trip_start: trip.trip_start || null,
          trip_end: trip.trip_end || null,
          charged_toll_amount: chargedTollAmount,
          attributed_toll_amount: attributedTollAmount,
          toll_delta: tollDelta,
          toll_review_status: getNormalizedTollStatus(trip),
          workflow_stage: trip.workflow_stage || null,
          expense_status: trip.expense_status || null,
          charged_at: invoice?.charged_at || null,
          recovered,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(Number(b.toll_delta || 0)) - Math.abs(Number(a.toll_delta || 0)));

    const unattributedCharges = tollCharges
      .filter(
        (charge) =>
          !charge.matched_trip_id &&
          !["dismissed", "ignored"].includes(
            String(charge.review_status || "").trim().toLowerCase()
          )
      )
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
      discrepancies: {
        total_delta: roundMoney(
          discrepancyTrips.reduce((sum, item) => sum + Math.abs(Number(item.toll_delta || 0)), 0)
        ),
        count: discrepancyTrips.length,
        trips: discrepancyTrips,
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
    const [trips, expenses, latestFmvEstimates, tollCharges, vehicleMetricsPayload] = await Promise.all([
      fetchTripsInRange(client, startDate, endDate),
      fetchExpensesInRange(client, startDate, endDate),
      getLatestVehicleFmvEstimates(client),
      fetchTollChargesInRange(client, startDate, endDate),
      getVehicleMetrics(key),
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

    const fleetCalendarDaysAvailable = Array.isArray(vehicleMetricsPayload?.vehicles)
      ? vehicleMetricsPayload.vehicles.reduce(
          (sum, vehicle) => sum + Number(vehicle?.calendar_days_available ?? 0),
          0
        )
      : 0;

    const calendarDays =
      key === "all"
        ? (() => {
            const earliestTripStart = trips.reduce((earliest, trip) => {
              if (!trip?.trip_start) return earliest;
              const tripStart = new Date(trip.trip_start);
              if (Number.isNaN(tripStart.getTime())) return earliest;
              if (!earliest) return tripStart;
              return tripStart.getTime() < earliest.getTime() ? tripStart : earliest;
            }, null);

            return earliestTripStart
              ? getCalendarDaysInRange(earliestTripStart, endDate)
              : 0;
          })()
        : getCalendarDaysInRange(startDate, endDate);

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

function getOutstandingTollValue(trip) {
  const tollTotal = Number(trip?.toll_total ?? 0);
  return tollTotal > 0 ? tollTotal : 0;
}

const tollsRecovered = trips.reduce((sum, trip) => {
  if (!isTripComplete(trip)) return sum;
  if (!isTollBillingComplete(trip)) return sum;

  return sum + getTollValueForRange(trip);
}, 0);

const tollsAttributedOutstanding = trips.reduce((sum, trip) => {
  if (isTripComplete(trip)) return sum;
  if (isTollBillingComplete(trip)) return sum;

  return sum + getOutstandingTollValue(trip);
}, 0);

const tollsUnattributed = tollCharges.reduce((sum, charge) => {
  if (charge?.matched_trip_id) return sum;
  if (
    ["dismissed", "ignored"].includes(
      String(charge?.review_status || "").trim().toLowerCase()
    )
  ) {
    return sum;
  }
  return sum + Number(charge?.amount ?? 0);
}, 0);

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
      fleet_calendar_days_available: fleetCalendarDaysAvailable,

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
