// ------------------------------------------------------------
// /server/services/metrics/summaryService.js
// Summary metrics for the top KPI cards.
// ------------------------------------------------------------

const pool = require("../../db");
const {
  getCalendarDaysInRange,
  getDateRange,
  getExpenseTotal,
  getTripFuelReimbursementValue,
  getTripProratedAmount,
  getTripProratedCount,
  getTripProratedValue,
  getTripRecognizedTollRevenueValue,
  getTripMiles,
  getTripTotalDays,
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
const { getTollAccountBalance } = require("./tollAccountBalanceService");

async function fetchTripsInRange(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        t.id,
        t.reservation_id,
        t.guest_name,
        t.turo_vehicle_id,
        t.vehicle_name,
        v.id AS fleet_vehicle_id,
        v.nickname AS vehicle_nickname,
        v.license_plate AS vehicle_plate,
        v.is_active AS vehicle_is_active,
        v.in_service AS vehicle_in_service,
        v.trip_eligible AS vehicle_trip_eligible,
        t.trip_start,
        t.trip_end,
        t.amount,
        t.fuel_reimbursement_total,
        t.starting_odometer,
        t.ending_odometer,
        t.toll_total,
        t.toll_charged_total,
        t.toll_review_status,
        t.workflow_stage,
        t.expense_status,
        t.completed_at,
        t.closed_out,
        t.closed_out_at,
        t.canceled_at,
        tf.cleaning_reimbursed,
        tf.ticket_reimbursed
      FROM trips t
      LEFT JOIN LATERAL (
        SELECT matched_vehicle.*
        FROM vehicles matched_vehicle
        WHERE (
            t.turo_vehicle_id IS NOT NULL
            AND matched_vehicle.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(COALESCE(matched_vehicle.nickname, '')) = LOWER(t.vehicle_name)
          )
        ORDER BY
          (t.turo_vehicle_id IS NOT NULL AND matched_vehicle.turo_vehicle_id = t.turo_vehicle_id) DESC,
          matched_vehicle.id ASC
        LIMIT 1
      ) v ON true
      LEFT JOIN trip_financial_facts tf
        ON tf.trip_id = t.id
      WHERE t.trip_start <= $2
        AND t.trip_end >= COALESCE($1, t.trip_start)
        AND (
          t.canceled_at IS NULL
          OR COALESCE(t.amount, 0) > 0
        )
    `,
    [startDate, endDate]
  );

  return rows.filter((trip) => tripOverlapsRange(trip, startDate, endDate));
}

function getOccupancyVehicleKey(trip) {
  if (trip?.fleet_vehicle_id != null) return `vehicle:${trip.fleet_vehicle_id}`;
  if (trip?.turo_vehicle_id != null) return `turo:${trip.turo_vehicle_id}`;
  const name = String(trip?.vehicle_name || trip?.vehicle_nickname || "")
    .trim()
    .toLowerCase();
  return name ? `name:${name}` : null;
}

function isRentableOccupancyTrip(trip) {
  return (
    trip?.fleet_vehicle_id != null &&
    trip?.vehicle_is_active !== false &&
    trip?.vehicle_in_service !== false &&
    trip?.vehicle_trip_eligible !== false
  );
}

function getBookedVehicleDays(trips, rangeStart, rangeEnd) {
  const bookedDays = new Set();

  for (const trip of trips) {
    if (!isRentableOccupancyTrip(trip)) continue;
    const vehicleKey = getOccupancyVehicleKey(trip);
    if (!vehicleKey || !trip?.trip_start || !trip?.trip_end) continue;

    const tripStart = new Date(trip.trip_start);
    const tripEnd = new Date(trip.trip_end);
    if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) continue;

    const start = new Date(
      Math.max(tripStart.getTime(), rangeStart?.getTime?.() ?? tripStart.getTime())
    );
    const end = new Date(
      Math.min(tripEnd.getTime(), rangeEnd?.getTime?.() ?? tripEnd.getTime())
    );
    if (end < start) continue;

    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    const lastDay = new Date(end);
    lastDay.setHours(0, 0, 0, 0);
    while (day <= lastDay) {
      bookedDays.add(`${vehicleKey}:${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`);
      day.setDate(day.getDate() + 1);
    }
  }

  return bookedDays.size;
}

async function fetchFleetCalendarDaysAvailable(client, rangeStart, rangeEnd) {
  if (!rangeStart || !rangeEnd) return 0;

  const { rows } = await client.query(`
    SELECT COALESCE(v.onboarding_date, first_trip.first_trip_start::date) AS onboarding_date
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT MIN(t.trip_start)::date AS first_trip_start
      FROM trips t
      WHERE t.trip_start IS NOT NULL
        AND (
          (
            v.turo_vehicle_id IS NOT NULL
            AND t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id = t.turo_vehicle_id
          )
          OR (
            COALESCE(v.nickname, '') <> ''
            AND COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(v.nickname) = LOWER(t.vehicle_name)
          )
        )
        AND (
          t.canceled_at IS NULL
          OR COALESCE(t.amount, 0) > 0
        )
    ) first_trip ON true
    WHERE COALESCE(v.is_active, true) = true
      AND COALESCE(v.in_service, true) = true
      AND COALESCE(v.trip_eligible, true) = true
  `);

  return rows.reduce((sum, vehicle) => {
    const onboardedAt = vehicle.onboarding_date
      ? new Date(vehicle.onboarding_date)
      : null;
    const effectiveStart =
      onboardedAt && onboardedAt > rangeStart ? onboardedAt : rangeStart;

    return sum + getCalendarDaysInRange(effectiveStart, rangeEnd);
  }, 0);
}

async function fetchIncomeTransactionsInRange(client, startDate, endDate) {
  const params = [endDate];
  const dateClause = startDate
    ? `income_date >= $2::date AND income_date <= $1::date`
    : `income_date <= $1::date`;

  if (startDate) params.push(startDate);

  const { rows } = await client.query(
    `
      SELECT
        id,
        trip_id,
        amount,
        income_date,
        income_type
      FROM income_transactions
      WHERE ${dateClause}
    `,
    params
  );

  return rows;
}

async function fetchPaymentNoticesInRange(client, startDate, endDate) {
  const params = [endDate];
  const dateClause = startDate
    ? `COALESCE(message_timestamp, ingested_at) >= $2::timestamptz
        AND COALESCE(message_timestamp, ingested_at) <= $1::timestamptz`
    : `COALESCE(message_timestamp, ingested_at) <= $1::timestamptz`;

  if (startDate) params.push(startDate);

  const { rows } = await client.query(
    `
      SELECT
        id,
        reservation_id,
        amount,
        message_timestamp,
        ingested_at
      FROM messages
      WHERE message_type = 'payment_notice'
        AND amount IS NOT NULL
        AND ${dateClause}
      ORDER BY COALESCE(message_timestamp, ingested_at) ASC, id ASC
    `,
    params
  );

  return rows;
}

async function fetchExpensesInRange(client, startDate, endDate) {
  if (!startDate) {
    const { rows } = await client.query(
      `
        SELECT
          e.id,
          e.vehicle_id,
          e.vendor,
          e.price,
          e.tax,
          e.category,
          e.expense_scope,
          e.trip_id,
          e.date,
          v.nickname AS vehicle_nickname,
          t.reservation_id,
          t.guest_name
        FROM expenses e
        LEFT JOIN vehicles v ON v.id = e.vehicle_id
        LEFT JOIN trips t ON t.id = e.trip_id
        WHERE e.date <= $1::date
      `,
      [endDate]
    );

    return rows;
  }

  const { rows } = await client.query(
    `
      SELECT
        e.id,
        e.vehicle_id,
        e.vendor,
        e.price,
        e.tax,
        e.category,
        e.expense_scope,
        e.trip_id,
        e.date,
        v.nickname AS vehicle_nickname,
        t.reservation_id,
        t.guest_name
      FROM expenses e
      LEFT JOIN vehicles v ON v.id = e.vehicle_id
      LEFT JOIN trips t ON t.id = e.trip_id
      WHERE e.date >= $1::date
        AND e.date <= $2::date
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

function getTripTuroOutputValue(trip) {
  const tollRevenue =
    trip?.toll_charged_total != null ? trip.toll_charged_total : trip?.toll_total;

  return (
    Number(trip?.amount ?? 0) +
    Number(trip?.fuel_reimbursement_total ?? 0) +
    Number(tollRevenue ?? 0) +
    Number(trip?.cleaning_reimbursed ?? 0) +
    Number(trip?.ticket_reimbursed ?? 0)
  );
}

function getPreviousDateRange(startDate, endDate) {
  if (!startDate || !endDate) {
    return { startDate: null, endDate: null };
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = getCalendarDaysInRange(start, end);
  const previousEnd = new Date(start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  previousEnd.setHours(23, 59, 59, 999);

  const previousStart = new Date(previousEnd);
  previousStart.setDate(previousStart.getDate() - days + 1);
  previousStart.setHours(0, 0, 0, 0);

  return { startDate: previousStart, endDate: previousEnd };
}

function getYearOverYearDateRange(startDate, endDate) {
  if (!startDate || !endDate) {
    return { startDate: null, endDate: null };
  }

  const previousStart = new Date(startDate);
  previousStart.setFullYear(previousStart.getFullYear() - 1);
  previousStart.setHours(0, 0, 0, 0);

  const previousEnd = new Date(endDate);
  previousEnd.setFullYear(previousEnd.getFullYear() - 1);
  previousEnd.setHours(23, 59, 59, 999);

  return { startDate: previousStart, endDate: previousEnd };
}

function addDaysToDate(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function toDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isDateInsideRange(value, startDate, endDate) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  if (startDate && date < startDate) return false;
  if (endDate && date > endDate) return false;
  return true;
}

function buildTripScheduledTuroOutputEntries(trip, startDate, endDate) {
  const totalValue = getTripTuroOutputValue(trip);
  if (!totalValue) return [];

  const totalDays = getTripTotalDays(trip?.trip_start, trip?.trip_end);
  if (!totalDays) return [];

  const entries = [];

  function pushEntry(date, amount, label) {
    if (!isDateInsideRange(date, startDate, endDate)) return;
    entries.push({
      date: toDateKey(date),
      amount,
      trip_id: trip.id,
      reservation_id: trip.reservation_id,
      guest_name: trip.guest_name,
      vehicle_name: trip.vehicle_name || trip.vehicle_nickname,
      label,
    });
  }

  // Turo payouts are cash-timed: short trips pay after completion, while
  // longer trips can pay in weekly portions before the final closeout.
  if (totalDays <= 7) {
    pushEntry(trip?.trip_end, totalValue, "trip_end");
    return entries;
  }

  let paidDays = 0;

  while (totalDays - paidDays > 7) {
    paidDays += 7;
    const trancheDate = addDaysToDate(trip.trip_start, paidDays);
    pushEntry(trancheDate, totalValue * (7 / totalDays), `week_${paidDays / 7}`);
  }

  const remainingDays = totalDays - paidDays;
  if (remainingDays > 0) {
    pushEntry(trip?.trip_end, totalValue * (remainingDays / totalDays), "final");
  }

  return entries;
}

function getTripScheduledTuroOutputValue(trip, startDate, endDate) {
  return buildTripScheduledTuroOutputEntries(trip, startDate, endDate).reduce(
    (sum, entry) => sum + Number(entry?.amount ?? 0),
    0
  );
}

const TRIP_LENGTH_BUCKETS = [
  { key: "1_day", label: "1 day", minDays: 1, maxDays: 1 },
  { key: "2_day", label: "2 day", minDays: 2, maxDays: 2 },
  { key: "3_day", label: "3 day", minDays: 3, maxDays: 3 },
  { key: "4_day", label: "4 day", minDays: 4, maxDays: 4 },
  { key: "5_7_day", label: "5-7 days", minDays: 5, maxDays: 7 },
  { key: "7_10_day", label: "7-10 days", minDays: 8, maxDays: 10 },
  { key: "11_20_day", label: "11-20 days", minDays: 11, maxDays: 20 },
  { key: "20_plus_day", label: "20+ days", minDays: 21, maxDays: null },
];

function getTripLengthBucket(totalDays) {
  return TRIP_LENGTH_BUCKETS.find(
    (bucket) =>
      totalDays >= bucket.minDays &&
      (bucket.maxDays == null || totalDays <= bucket.maxDays)
  );
}

function buildTripLengthDistribution(trips) {
  const buckets = TRIP_LENGTH_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    min_days: bucket.minDays,
    max_days: bucket.maxDays,
    trip_count: 0,
    trip_days: 0,
    trip_income: 0,
    trip_miles: 0,
    average_trip_income: 0,
    income_per_day: 0,
    income_per_mile: 0,
    percentage: 0,
  }));
  const bucketByKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  let totalTrips = 0;
  let totalDays = 0;
  let totalIncome = 0;

  for (const trip of trips || []) {
    const tripDays = getTripTotalDays(trip?.trip_start, trip?.trip_end);
    if (!tripDays) continue;

    const bucket = getTripLengthBucket(tripDays);
    if (!bucket) continue;

    totalTrips += 1;
    totalDays += tripDays;
    const tripIncome = getTripTuroOutputValue(trip);
    const tripMiles = getTripMiles(trip);
    totalIncome += tripIncome;
    const targetBucket = bucketByKey.get(bucket.key);
    targetBucket.trip_count += 1;
    targetBucket.trip_days += tripDays;
    targetBucket.trip_income += tripIncome;
    targetBucket.trip_miles += tripMiles;
  }

  const hydratedBuckets = buckets.map((bucket) => {
    return {
      ...bucket,
      trip_days: roundNumber(bucket.trip_days, 1),
      trip_miles: roundNumber(bucket.trip_miles, 1),
      trip_income: roundMoney(bucket.trip_income),
      average_trip_income: roundMoney(
        safeDivide(bucket.trip_income, bucket.trip_count)
      ),
      income_per_day: roundMoney(safeDivide(bucket.trip_income, bucket.trip_days)),
      income_per_mile: roundMoney(safeDivide(bucket.trip_income, bucket.trip_miles)),
      percentage: roundNumber(safeDivide(bucket.trip_count, totalTrips), 4),
    };
  });

  return {
    total_trips: totalTrips,
    trip_income: roundMoney(totalIncome),
    average_days: roundNumber(safeDivide(totalDays, totalTrips), 1),
    average_trip_income: roundMoney(safeDivide(totalIncome, totalTrips)),
    buckets: hydratedBuckets,
    top_income_buckets: hydratedBuckets
      .filter((bucket) => bucket.trip_count > 0)
      .sort((a, b) => {
        const incomeDiff =
          Number(b.income_per_day || 0) - Number(a.income_per_day || 0);
        if (incomeDiff) return incomeDiff;
        const mileDiff =
          Number(b.income_per_mile || 0) - Number(a.income_per_mile || 0);
        if (mileDiff) return mileDiff;
        return Number(b.average_trip_income || 0) - Number(a.average_trip_income || 0);
      })
      .slice(0, 3),
  };
}

function buildIncomeReconciliationBuckets(trips, incomeTransactions, startDate, endDate) {
  const buckets = new Map();

  function getBucket(dateKey) {
    if (!dateKey) return null;
    if (!buckets.has(dateKey)) {
      buckets.set(dateKey, {
        date: dateKey,
        expected: 0,
        income: 0,
        variance: 0,
        expected_count: 0,
        income_count: 0,
      });
    }
    return buckets.get(dateKey);
  }

  for (const trip of trips) {
    for (const entry of buildTripScheduledTuroOutputEntries(trip, startDate, endDate)) {
      const bucket = getBucket(entry.date);
      if (!bucket) continue;
      bucket.expected += Number(entry.amount ?? 0);
      bucket.expected_count += 1;
    }
  }

  for (const item of incomeTransactions) {
    const bucket = getBucket(toDateKey(item?.income_date));
    if (!bucket) continue;
    bucket.income += Number(item?.amount ?? 0);
    bucket.income_count += 1;
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      expected: roundMoney(bucket.expected),
      income: roundMoney(bucket.income),
      variance: roundMoney(bucket.income - bucket.expected),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildPaymentNoticeReconciliationBuckets(
  paymentNotices,
  incomeTransactions,
  startDate,
  endDate
) {
  const buckets = new Map();

  function getBucket(dateKey) {
    if (!dateKey) return null;
    if (!buckets.has(dateKey)) {
      buckets.set(dateKey, {
        date: dateKey,
        payment_notices: 0,
        income: 0,
        variance: 0,
        payment_notice_count: 0,
        income_count: 0,
      });
    }
    return buckets.get(dateKey);
  }

  for (const notice of paymentNotices || []) {
    const bucket = getBucket(toDateKey(notice?.message_timestamp || notice?.ingested_at));
    if (!bucket) continue;
    bucket.payment_notices += Number(notice?.amount ?? 0);
    bucket.payment_notice_count += 1;
  }

  for (const item of incomeTransactions || []) {
    const bucket = getBucket(toDateKey(item?.income_date));
    if (!bucket) continue;
    bucket.income += Number(item?.amount ?? 0);
    bucket.income_count += 1;
  }

  return Array.from(buckets.values())
    .map((bucket) => ({
      ...bucket,
      payment_notices: roundMoney(bucket.payment_notices),
      income: roundMoney(bucket.income),
      variance: roundMoney(bucket.income - bucket.payment_notices),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function getLargestIncomeReconciliationGap(buckets) {
  return (buckets || []).reduce((largest, bucket) => {
    if (!largest) return bucket;
    return Math.abs(Number(bucket.variance ?? 0)) >
      Math.abs(Number(largest.variance ?? 0))
      ? bucket
      : largest;
  }, null);
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
        tc.created_at,
        tc.updated_at,
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

async function fetchTollChargesForTripIds(client, tripIds) {
  const validTripIds = Array.from(
    new Set(
      (tripIds || [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (!validTripIds.length) return [];

  const { rows } = await client.query(
    `
      SELECT
        tc.id,
        tc.trxn_at,
        tc.posted_at,
        tc.created_at,
        tc.updated_at,
        tc.amount,
        tc.review_status,
        tc.match_status,
        tc.matched_trip_id
      FROM toll_charges tc
      WHERE tc.matched_trip_id = ANY($1::bigint[])
      ORDER BY tc.trxn_at DESC, tc.id DESC
    `,
    [validTripIds]
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

    const allMatchedTripCharges = await fetchTollChargesForTripIds(
      client,
      trips.map((trip) => trip.id)
    );

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
    const tollTimingByTripId = new Map();
    for (const charge of allMatchedTripCharges) {
      if (!charge?.matched_trip_id) continue;
      const tripId = Number(charge.matched_trip_id);
      const current = Number(attributedTollTotalsByTripId.get(tripId) || 0);
      attributedTollTotalsByTripId.set(
        tripId,
        current + Number(charge.amount || 0)
      );
      const timing = tollTimingByTripId.get(tripId) || {
        last_toll_received_at: null,
        charges: [],
      };
      const receivedAt = charge.created_at || charge.posted_at || charge.trxn_at;
      if (
        receivedAt &&
        (!timing.last_toll_received_at ||
          new Date(receivedAt).getTime() > new Date(timing.last_toll_received_at).getTime())
      ) {
        timing.last_toll_received_at = receivedAt;
      }
      timing.charges.push(charge);
      tollTimingByTripId.set(tripId, timing);
    }

    function getTollAuditTiming(trip, invoice) {
      const timing = tollTimingByTripId.get(Number(trip.id)) || {};
      const billedAt = invoice?.charged_at || null;
      const billedMs = billedAt ? new Date(billedAt).getTime() : NaN;
      const postBillingCharges = Number.isFinite(billedMs)
        ? (timing.charges || []).filter((charge) => {
            const receivedMs = new Date(
              charge.created_at || charge.posted_at || charge.trxn_at || 0
            ).getTime();
            return Number.isFinite(receivedMs) && receivedMs > billedMs;
          })
        : [];
      return {
        billed_at: billedAt,
        last_toll_received_at: timing.last_toll_received_at || null,
        post_billing_toll_count: postBillingCharges.length,
        post_billing_toll_amount: roundMoney(
          postBillingCharges.reduce((sum, charge) => sum + Number(charge.amount || 0), 0)
        ),
      };
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
        const settlementBasis =
          attributedTollAmount > 0
            ? attributedTollAmount
            : roundMoney(trip.toll_total);
        const recovered =
          isTripTollRecovered(trip) ||
          (chargedTollAmount != null &&
            settlementBasis > 0 &&
            chargedTollAmount + 0.01 >= settlementBasis);
        const auditTiming = getTollAuditTiming(trip, invoice);
        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          turo_vehicle_id: trip.turo_vehicle_id || null,
          vehicle_name: trip.vehicle_name || null,
          vehicle_nickname: trip.vehicle_nickname || null,
          vehicle_plate: trip.vehicle_plate || null,
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
          ...auditTiming,
          toll_review_status: getNormalizedTollStatus(trip),
          workflow_stage: trip.workflow_stage || null,
          expense_status: trip.expense_status || null,
          recovered,
        };
      })
      .filter((trip) => !trip.recovered)
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
        if (tollDelta >= -0.01) return null;
        const auditTiming = getTollAuditTiming(trip, invoice);

        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          turo_vehicle_id: trip.turo_vehicle_id || null,
          vehicle_name: trip.vehicle_name || null,
          vehicle_nickname: trip.vehicle_nickname || null,
          vehicle_plate: trip.vehicle_plate || null,
          trip_start: trip.trip_start || null,
          trip_end: trip.trip_end || null,
          charged_toll_amount: chargedTollAmount,
          attributed_toll_amount: attributedTollAmount,
          toll_delta: tollDelta,
          toll_review_status: getNormalizedTollStatus(trip),
          workflow_stage: trip.workflow_stage || null,
          expense_status: trip.expense_status || null,
          charged_at: invoice?.charged_at || null,
          ...auditTiming,
          loss_amount: roundMoney(attributedTollAmount - (chargedTollAmount || 0)),
          recovered,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.loss_amount || 0) - Number(a.loss_amount || 0));

    const postBillingTrips = trips
      .map((trip) => {
        const invoice =
          latestTollInvoiceByTripKey.get(`trip:${trip.id}`) ||
          latestTollInvoiceByTripKey.get(`reservation:${trip.reservation_id}`) ||
          null;
        if (!invoice?.charged_at) return null;
        const timing = getTollAuditTiming(trip, invoice);
        if (!timing.post_billing_toll_count) return null;
        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          vehicle_name: trip.vehicle_name || null,
          vehicle_nickname: trip.vehicle_nickname || null,
          vehicle_plate: trip.vehicle_plate || null,
          trip_start: trip.trip_start || null,
          trip_end: trip.trip_end || null,
          charged_toll_amount:
            trip.toll_charged_total == null
              ? invoice.charged_toll_amount
              : roundMoney(trip.toll_charged_total),
          attributed_toll_amount: roundMoney(
            attributedTollTotalsByTripId.get(Number(trip.id)) || 0
          ),
          ...timing,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.last_toll_received_at || 0).getTime() -
          new Date(a.last_toll_received_at || 0).getTime()
      );

    const tripEndById = new Map(
      trips.map((trip) => [Number(trip.id), trip.trip_end || null])
    );
    const receiptLagsHours = allMatchedTripCharges
      .map((charge) => {
        const tripEnd = tripEndById.get(Number(charge.matched_trip_id));
        const receivedAt = charge.created_at || charge.posted_at || charge.trxn_at;
        const lag =
          (new Date(receivedAt || 0).getTime() - new Date(tripEnd || 0).getTime()) /
          3600000;
        return Number.isFinite(lag) && lag >= 0 && lag <= 24 * 14 ? lag : null;
      })
      .filter((value) => value != null)
      .sort((a, b) => a - b);
    const maxReceiptLagHours = receiptLagsHours.length
      ? receiptLagsHours[receiptLagsHours.length - 1]
      : 24;
    const p95ReceiptLagHours = receiptLagsHours.length
      ? receiptLagsHours[
          Math.min(
            receiptLagsHours.length - 1,
            Math.floor(receiptLagsHours.length * 0.95)
          )
        ]
      : 24;

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
        total_loss: roundMoney(
          discrepancyTrips.reduce((sum, item) => sum + Number(item.loss_amount || 0), 0)
        ),
        count: discrepancyTrips.length,
        trips: discrepancyTrips,
      },
      post_billing: {
        total_amount: roundMoney(
          postBillingTrips.reduce(
            (sum, item) => sum + Number(item.post_billing_toll_amount || 0),
            0
          )
        ),
        count: postBillingTrips.length,
        trips: postBillingTrips,
      },
      arrival_timing: {
        observed_count: receiptLagsHours.length,
        max_hours_after_trip_end: Math.ceil(maxReceiptLagHours),
        p95_hours_after_trip_end: Math.ceil(p95ReceiptLagHours),
        closeout_delay_hours: Math.max(
          24,
          Math.min(168, Math.ceil(maxReceiptLagHours))
        ),
      },
    };
  } finally {
    client.release();
  }
}

async function getSummaryMetrics(rangeKey = "30d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const previousRange = getPreviousDateRange(startDate, endDate);
  const yearOverYearRange =
    key === "all"
      ? { startDate: null, endDate: null }
      : getYearOverYearDateRange(startDate, endDate);
  const client = await pool.connect();

  try {
    const trips = await fetchTripsInRange(client, startDate, endDate);
    const previousTrips = previousRange.startDate
      ? await fetchTripsInRange(client, previousRange.startDate, previousRange.endDate)
      : [];
    const yearOverYearTrips = yearOverYearRange.startDate
      ? await fetchTripsInRange(
          client,
          yearOverYearRange.startDate,
          yearOverYearRange.endDate
        )
      : [];
    const incomeTransactions = await fetchIncomeTransactionsInRange(
      client,
      startDate,
      endDate
    );
    const paymentNotices = await fetchPaymentNoticesInRange(
      client,
      startDate,
      endDate
    );
    const expenses = await fetchExpensesInRange(client, startDate, endDate);
    const previousExpenses = previousRange.startDate
      ? await fetchExpensesInRange(
          client,
          previousRange.startDate,
          previousRange.endDate
        )
      : [];
    const yearOverYearExpenses = yearOverYearRange.startDate
      ? await fetchExpensesInRange(
          client,
          yearOverYearRange.startDate,
          yearOverYearRange.endDate
        )
      : [];
    const latestFmvEstimates = await getLatestVehicleFmvEstimates(client);
    const tollCharges = await fetchTollChargesInRange(client, startDate, endDate);
    const matchedTollCharges = await fetchTollChargesForTripIds(
      client,
      trips.map((trip) => trip.id)
    );
    const tollAccountBalance = await getTollAccountBalance(client);

    const tripIncome = trips.reduce(
      (sum, trip) => sum + getTripProratedAmount(trip, startDate, endDate),
      0
    );
    const previousTripIncome = previousTrips.reduce(
      (sum, trip) =>
        sum +
        getTripProratedAmount(
          trip,
          previousRange.startDate,
          previousRange.endDate
        ),
      0
    );
    const yearOverYearTripIncome = yearOverYearTrips.reduce(
      (sum, trip) =>
        sum +
        getTripProratedAmount(
          trip,
          yearOverYearRange.startDate,
          yearOverYearRange.endDate
        ),
      0
    );
    const fuelReimbursements = trips.reduce(
      (sum, trip) =>
        sum + getTripFuelReimbursementValue(trip, startDate, endDate),
      0
    );
    const previousFuelReimbursements = previousTrips.reduce(
      (sum, trip) =>
        sum +
        getTripFuelReimbursementValue(
          trip,
          previousRange.startDate,
          previousRange.endDate
        ),
      0
    );
    const yearOverYearFuelReimbursements = yearOverYearTrips.reduce(
      (sum, trip) =>
        sum +
        getTripFuelReimbursementValue(
          trip,
          yearOverYearRange.startDate,
          yearOverYearRange.endDate
        ),
      0
    );
    const tollRevenue = trips.reduce(
      (sum, trip) =>
        sum + getTripRecognizedTollRevenueValue(trip, startDate, endDate),
      0
    );
    const previousTollRevenue = previousTrips.reduce(
      (sum, trip) =>
        sum +
        getTripRecognizedTollRevenueValue(
          trip,
          previousRange.startDate,
          previousRange.endDate
        ),
      0
    );
    const yearOverYearTollRevenue = yearOverYearTrips.reduce(
      (sum, trip) =>
        sum +
        getTripRecognizedTollRevenueValue(
          trip,
          yearOverYearRange.startDate,
          yearOverYearRange.endDate
        ),
      0
    );
    const incomeReconciliationBuckets = buildIncomeReconciliationBuckets(
      trips,
      incomeTransactions,
      startDate,
      endDate
    );
    const largestIncomeReconciliationGap = getLargestIncomeReconciliationGap(
      incomeReconciliationBuckets
    );
    const paymentNoticeTotal = paymentNotices.reduce(
      (sum, item) => sum + Number(item?.amount ?? 0),
      0
    );
    const paymentNoticeReconciliationBuckets =
      buildPaymentNoticeReconciliationBuckets(
        paymentNotices,
        incomeTransactions,
        startDate,
        endDate
      );
    const largestPaymentNoticeGap = getLargestIncomeReconciliationGap(
      paymentNoticeReconciliationBuckets
    );
    const turoOutputTripIncome = trips.reduce(
      (sum, trip) => sum + Number(trip?.amount ?? 0),
      0
    );
    const turoOutputFuelReimbursements = trips.reduce(
      (sum, trip) => sum + Number(trip?.fuel_reimbursement_total ?? 0),
      0
    );
    const turoOutputTollReimbursements = trips.reduce((sum, trip) => {
      const tollRevenueValue =
        trip?.toll_charged_total != null ? trip.toll_charged_total : trip?.toll_total;
      return sum + Number(tollRevenueValue ?? 0);
    }, 0);
    const turoOutputCleaningReimbursements = trips.reduce(
      (sum, trip) => sum + Number(trip?.cleaning_reimbursed ?? 0),
      0
    );
    const turoOutputTicketReimbursements = trips.reduce(
      (sum, trip) => sum + Number(trip?.ticket_reimbursed ?? 0),
      0
    );
    const turoOutputTotal = trips.reduce(
      (sum, trip) => sum + getTripTuroOutputValue(trip),
      0
    );
    const scheduledTuroOutputTotal = trips.reduce(
      (sum, trip) =>
        sum + getTripScheduledTuroOutputValue(trip, startDate, endDate),
      0
    );
    const turoOutputDeferredTotal = turoOutputTotal - scheduledTuroOutputTotal;
    const incomeCategoryTotal = incomeTransactions.reduce(
      (sum, item) => sum + Number(item?.amount ?? 0),
      0
    );
    const incomeCategoryVariance = incomeCategoryTotal - scheduledTuroOutputTotal;
    const tripLengthDistribution = buildTripLengthDistribution(trips);

    const tripCountOverlapping = trips.length;
    const yearOverYearTripCountOverlapping = yearOverYearTrips.length;
    const tripMiles = trips.reduce((sum, trip) => sum + getTripMiles(trip), 0);
    const yearOverYearTripMiles = yearOverYearTrips.reduce(
      (sum, trip) => sum + getTripMiles(trip),
      0
    );
    const previousTripMiles = previousTrips.reduce(
      (sum, trip) => sum + getTripMiles(trip),
      0
    );

    const tripCountProrated = trips.reduce(
      (sum, trip) => sum + getTripProratedCount(trip, startDate, endDate),
      0
    );

    const bookedVehicleDays = getBookedVehicleDays(trips, startDate, endDate);
    const previousBookedVehicleDays = getBookedVehicleDays(
      previousTrips,
      previousRange.startDate,
      previousRange.endDate
    );
    const yearOverYearBookedVehicleDays = getBookedVehicleDays(
      yearOverYearTrips,
      yearOverYearRange.startDate,
      yearOverYearRange.endDate
    );

    const earliestTripStartForAll =
      key === "all"
        ? trips.reduce((earliest, trip) => {
            if (!trip?.trip_start) return earliest;
            const tripStart = new Date(trip.trip_start);
            if (Number.isNaN(tripStart.getTime())) return earliest;
            if (!earliest) return tripStart;
            return tripStart.getTime() < earliest.getTime() ? tripStart : earliest;
          }, null)
        : null;

    const calendarDays =
      key === "all"
        ? earliestTripStartForAll
          ? getCalendarDaysInRange(earliestTripStartForAll, endDate)
          : 0
        : getCalendarDaysInRange(startDate, endDate);
    const fleetCalendarDaysAvailable = await fetchFleetCalendarDaysAvailable(
      client,
      key === "all" ? earliestTripStartForAll : startDate,
      endDate
    );
    const previousFleetCalendarDaysAvailable = previousRange.startDate
      ? await fetchFleetCalendarDaysAvailable(
          client,
          previousRange.startDate,
          previousRange.endDate
        )
      : 0;
    const previousCalendarDays = previousRange.startDate
      ? getCalendarDaysInRange(previousRange.startDate, previousRange.endDate)
      : 0;
    const occupancyRate = safeDivide(bookedVehicleDays, fleetCalendarDaysAvailable);
    const previousOccupancyRate = safeDivide(
      previousBookedVehicleDays,
      previousFleetCalendarDaysAvailable
    );
    const occupancyRateDelta = occupancyRate - previousOccupancyRate;

    const expensesTotal = expenses.reduce(
      (sum, expense) => sum + getExpenseTotal(expense),
      0
    );
    const expenseLineItems = expenses
      .map((expense) => ({
        expense_id: expense.id,
        date: expense.date || null,
        vendor: expense.vendor || null,
        category: expense.category || null,
        expense_scope: expense.expense_scope || "direct",
        vehicle_id: expense.vehicle_id || null,
        vehicle_nickname: expense.vehicle_nickname || null,
        trip_id: expense.trip_id || null,
        reservation_id: expense.reservation_id || null,
        guest_name: expense.guest_name || null,
        price: roundMoney(expense.price),
        tax: roundMoney(expense.tax),
        total_amount: roundMoney(getExpenseTotal(expense)),
      }))
      .sort((a, b) => Number(b.total_amount ?? 0) - Number(a.total_amount ?? 0))
      .slice(0, 100);
    const previousExpensesTotal = previousExpenses.reduce(
      (sum, expense) => sum + getExpenseTotal(expense),
      0
    );
    const yearOverYearExpensesTotal = yearOverYearExpenses.reduce(
      (sum, expense) => sum + getExpenseTotal(expense),
      0
    );

    const cleaningTotal = expenses
      .filter(isCleaningExpense)
      .reduce((sum, expense) => sum + getExpenseTotal(expense), 0);

    const tollsPaid = expenses
  .filter(isTollExpense)
  .reduce((sum, expense) => sum + getExpenseTotal(expense), 0);

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
  if (!isTripTollRecovered(trip)) return sum;

  return sum + getTollValueForRange(trip);
}, 0);

const tollsAttributedOutstanding = trips.reduce((sum, trip) => {
  if (!isTripTollAttributedOutstanding(trip)) return sum;

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

const attributedByTripId = new Map();
for (const charge of matchedTollCharges) {
  const tripId = Number(charge.matched_trip_id);
  attributedByTripId.set(
    tripId,
    Number(attributedByTripId.get(tripId) || 0) + Number(charge.amount || 0)
  );
}
const tollsUnderbilledLoss = trips.reduce((sum, trip) => {
  if (String(trip.toll_review_status || "").toLowerCase() !== "billed") return sum;
  const attributed = Number(attributedByTripId.get(Number(trip.id)) || 0);
  const charged = Number(trip.toll_charged_total || 0);
  return sum + Math.max(0, attributed - charged);
}, 0);

    const otherIncome = fuelReimbursements + tollRevenue;
    const revenue = tripIncome + otherIncome;
    const previousOtherIncome = previousFuelReimbursements + previousTollRevenue;
    const previousRevenue = previousTripIncome + previousOtherIncome;
    const yearOverYearOtherIncome =
      yearOverYearFuelReimbursements + yearOverYearTollRevenue;
    const yearOverYearRevenue =
      yearOverYearTripIncome + yearOverYearOtherIncome;
    const revenuePerOverlappingTrip = safeDivide(revenue, tripCountOverlapping);
    const averageTripPrice = safeDivide(tripIncome, tripCountOverlapping);
    const lastYearAverageTripPrice = safeDivide(
      yearOverYearTripIncome,
      yearOverYearTripCountOverlapping
    );
    const averageTripDayPrice = safeDivide(tripIncome, bookedVehicleDays);
    const lastYearAverageTripDayPrice = safeDivide(
      yearOverYearTripIncome,
      yearOverYearBookedVehicleDays
    );
    const yearOverYearRevenuePerOverlappingTrip = safeDivide(
      yearOverYearRevenue,
      yearOverYearTripCountOverlapping
    );
    const avgRevenuePerTripYoyDelta =
      yearOverYearTripCountOverlapping > 0
        ? revenuePerOverlappingTrip - yearOverYearRevenuePerOverlappingTrip
        : null;
    const revenuePerCalendarDay = safeDivide(revenue, calendarDays);
    const previousRevenuePerCalendarDay = safeDivide(
      previousRevenue,
      previousCalendarDays
    );
    const revenuePerCalendarDayDelta =
      revenuePerCalendarDay - previousRevenuePerCalendarDay;
    const revenuePerBookedDay = safeDivide(revenue, bookedVehicleDays);
    const previousRevenuePerBookedDay = safeDivide(
      previousRevenue,
      previousBookedVehicleDays
    );
    const revenuePerBookedDayDelta =
      revenuePerBookedDay - previousRevenuePerBookedDay;
    const netProfit = revenue - expensesTotal;
    const previousNetProfit = previousRevenue - previousExpensesTotal;
    const yearOverYearNetProfit = yearOverYearRevenue - yearOverYearExpensesTotal;
    const revenuePerTripMile = safeDivide(revenue, tripMiles);
    const profitPerTripMile = safeDivide(netProfit, tripMiles);
    const expensePerTripMile = safeDivide(expensesTotal, tripMiles);
    const previousRevenuePerTripMile = safeDivide(previousRevenue, previousTripMiles);
    const previousProfitPerTripMile = safeDivide(previousNetProfit, previousTripMiles);
    const previousExpensePerTripMile = safeDivide(
      previousExpensesTotal,
      previousTripMiles
    );
    const yearOverYearRevenuePerTripMile = safeDivide(
      yearOverYearRevenue,
      yearOverYearTripMiles
    );
    const yearOverYearProfitPerTripMile = safeDivide(
      yearOverYearNetProfit,
      yearOverYearTripMiles
    );
    const yearOverYearExpensePerTripMile = safeDivide(
      yearOverYearExpensesTotal,
      yearOverYearTripMiles
    );
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
      previous_revenue: roundMoney(previousRevenue),
      revenue_delta: roundMoney(revenue - previousRevenue),
      trip_income: roundMoney(tripIncome),
      other_income: roundMoney(otherIncome),
      fuel_reimbursements: roundMoney(fuelReimbursements),
      toll_revenue: roundMoney(tollRevenue),
      turo_output_total: roundMoney(turoOutputTotal),
      turo_output_trip_income: roundMoney(turoOutputTripIncome),
      turo_output_fuel_reimbursements: roundMoney(turoOutputFuelReimbursements),
      turo_output_toll_reimbursements: roundMoney(turoOutputTollReimbursements),
      turo_output_cleaning_reimbursements: roundMoney(
        turoOutputCleaningReimbursements
      ),
      turo_output_ticket_reimbursements: roundMoney(
        turoOutputTicketReimbursements
      ),
      scheduled_turo_output_total: roundMoney(scheduledTuroOutputTotal),
      turo_output_deferred_total: roundMoney(turoOutputDeferredTotal),
      income_category_total: roundMoney(incomeCategoryTotal),
      income_category_variance: roundMoney(incomeCategoryVariance),
      income_category_coverage_rate: roundNumber(
        safeDivide(incomeCategoryTotal, scheduledTuroOutputTotal)
      ),
      income_transaction_count: incomeTransactions.length,
      income_reconciliation_buckets: incomeReconciliationBuckets,
      income_reconciliation_largest_gap: largestIncomeReconciliationGap,
      payment_notice_total: roundMoney(paymentNoticeTotal),
      payment_notice_count: paymentNotices.length,
      payment_notice_vs_income_variance: roundMoney(
        incomeCategoryTotal - paymentNoticeTotal
      ),
      payment_notice_vs_expected_variance: roundMoney(
        paymentNoticeTotal - scheduledTuroOutputTotal
      ),
      payment_notice_reconciliation_buckets: paymentNoticeReconciliationBuckets,
      payment_notice_reconciliation_largest_gap: largestPaymentNoticeGap,
      expenses: roundMoney(expensesTotal),
      previous_expenses: roundMoney(previousExpensesTotal),
      expenses_delta: roundMoney(expensesTotal - previousExpensesTotal),
      expense_line_items: expenseLineItems,
      net_profit: roundMoney(netProfit),
      previous_net_profit: roundMoney(previousNetProfit),
      net_profit_delta: roundMoney(netProfit - previousNetProfit),
      fleet_value: roundMoney(fleetValue),
      fleet_value_previous: roundMoney(previousFleetValue),
      fleet_value_change: roundMoney(fleetValueChange),
      fleet_value_updated_at: fleetValueUpdatedAt,

      trip_count_overlapping: tripCountOverlapping,
      trip_count_prorated: roundNumber(tripCountProrated, 2),
      trip_miles: roundNumber(tripMiles, 1),
      trip_length_distribution: tripLengthDistribution,

      booked_vehicle_days: bookedVehicleDays,
      calendar_days: calendarDays,
      fleet_calendar_days_available: fleetCalendarDaysAvailable,
      occupancy_rate: roundNumber(occupancyRate, 4),
      previous_occupancy_rate: roundNumber(previousOccupancyRate, 4),
      occupancy_rate_delta: roundNumber(occupancyRateDelta, 4),
      occupancy_previous_period: previousRange.startDate
        ? {
            start_date: previousRange.startDate.toISOString(),
            end_date: previousRange.endDate.toISOString(),
            booked_vehicle_days: roundNumber(previousBookedVehicleDays, 2),
            calendar_days: previousCalendarDays,
            fleet_calendar_days_available: previousFleetCalendarDaysAvailable,
          }
        : null,

      revenue_per_overlapping_trip: roundMoney(revenuePerOverlappingTrip),
      average_trip_price: roundMoney(averageTripPrice),
      last_year_average_trip_price:
        yearOverYearTripCountOverlapping > 0
          ? roundMoney(lastYearAverageTripPrice)
          : null,
      average_trip_price_yoy_delta:
        yearOverYearTripCountOverlapping > 0
          ? roundMoney(averageTripPrice - lastYearAverageTripPrice)
          : null,
      average_trip_day_price: roundMoney(averageTripDayPrice),
      last_year_average_trip_day_price:
        yearOverYearBookedVehicleDays > 0
          ? roundMoney(lastYearAverageTripDayPrice)
          : null,
      average_trip_day_price_yoy_delta:
        yearOverYearBookedVehicleDays > 0
          ? roundMoney(averageTripDayPrice - lastYearAverageTripDayPrice)
          : null,
      last_year_revenue_per_overlapping_trip:
        yearOverYearTripCountOverlapping > 0
          ? roundMoney(yearOverYearRevenuePerOverlappingTrip)
          : null,
      avg_revenue_per_trip_yoy_delta:
        avgRevenuePerTripYoyDelta == null
          ? null
          : roundMoney(avgRevenuePerTripYoyDelta),
      avg_revenue_per_trip_yoy_delta_pct:
        avgRevenuePerTripYoyDelta == null ||
        !yearOverYearRevenuePerOverlappingTrip
          ? null
          : roundNumber(
              avgRevenuePerTripYoyDelta / yearOverYearRevenuePerOverlappingTrip,
              4
            ),
      avg_revenue_per_trip_last_year_period: yearOverYearRange.startDate
        ? {
            start_date: yearOverYearRange.startDate.toISOString(),
            end_date: yearOverYearRange.endDate.toISOString(),
            revenue: roundMoney(yearOverYearRevenue),
            trip_count_overlapping: yearOverYearTripCountOverlapping,
            revenue_per_overlapping_trip:
              yearOverYearTripCountOverlapping > 0
                ? roundMoney(yearOverYearRevenuePerOverlappingTrip)
                : null,
          }
        : null,
      revenue_per_prorated_trip: roundMoney(
        safeDivide(revenue, tripCountProrated)
      ),
      revenue_per_trip_mile: roundMoney(revenuePerTripMile),
      previous_revenue_per_trip_mile:
        previousTripMiles > 0 ? roundMoney(previousRevenuePerTripMile) : null,
      revenue_per_trip_mile_delta:
        previousTripMiles > 0
          ? roundMoney(revenuePerTripMile - previousRevenuePerTripMile)
          : null,
      last_year_revenue_per_trip_mile:
        yearOverYearTripMiles > 0 ? roundMoney(yearOverYearRevenuePerTripMile) : null,
      revenue_per_trip_mile_yoy_delta:
        yearOverYearTripMiles > 0
          ? roundMoney(revenuePerTripMile - yearOverYearRevenuePerTripMile)
          : null,
      profit_per_trip_mile: roundMoney(profitPerTripMile),
      previous_profit_per_trip_mile:
        previousTripMiles > 0 ? roundMoney(previousProfitPerTripMile) : null,
      profit_per_trip_mile_delta:
        previousTripMiles > 0
          ? roundMoney(profitPerTripMile - previousProfitPerTripMile)
          : null,
      last_year_profit_per_trip_mile:
        yearOverYearTripMiles > 0 ? roundMoney(yearOverYearProfitPerTripMile) : null,
      profit_per_trip_mile_yoy_delta:
        yearOverYearTripMiles > 0
          ? roundMoney(profitPerTripMile - yearOverYearProfitPerTripMile)
          : null,
      expense_per_trip_mile: roundMoney(expensePerTripMile),
      previous_expense_per_trip_mile:
        previousTripMiles > 0 ? roundMoney(previousExpensePerTripMile) : null,
      expense_per_trip_mile_delta:
        previousTripMiles > 0
          ? roundMoney(expensePerTripMile - previousExpensePerTripMile)
          : null,
      last_year_expense_per_trip_mile:
        yearOverYearTripMiles > 0 ? roundMoney(yearOverYearExpensePerTripMile) : null,
      expense_per_trip_mile_yoy_delta:
        yearOverYearTripMiles > 0
          ? roundMoney(expensePerTripMile - yearOverYearExpensePerTripMile)
          : null,
      revenue_per_booked_day: roundMoney(
        revenuePerBookedDay
      ),
      previous_revenue_per_booked_day: roundMoney(previousRevenuePerBookedDay),
      revenue_per_booked_day_delta: roundMoney(revenuePerBookedDayDelta),
      revenue_per_calendar_day: roundMoney(
        revenuePerCalendarDay
      ),
      previous_revenue_per_calendar_day: roundMoney(
        previousRevenuePerCalendarDay
      ),
      revenue_per_calendar_day_delta: roundMoney(
        revenuePerCalendarDayDelta
      ),
      revenue_previous_period: previousRange.startDate
        ? {
            start_date: previousRange.startDate.toISOString(),
            end_date: previousRange.endDate.toISOString(),
            revenue: roundMoney(previousRevenue),
            revenue_per_calendar_day: roundMoney(previousRevenuePerCalendarDay),
            revenue_per_booked_day: roundMoney(previousRevenuePerBookedDay),
            calendar_days: previousCalendarDays,
            booked_vehicle_days: roundNumber(previousBookedVehicleDays, 2),
          }
        : null,

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
      tolls_underbilled_loss: roundMoney(tollsUnderbilledLoss),
      toll_account_balance: {
        ...tollAccountBalance,
        anchorBalance:
          tollAccountBalance.anchorBalance == null
            ? null
            : roundMoney(tollAccountBalance.anchorBalance),
        fundingAdded: roundMoney(tollAccountBalance.fundingAdded),
        tollsDeducted: roundMoney(tollAccountBalance.tollsDeducted),
        currentBalance:
          tollAccountBalance.currentBalance == null
            ? null
            : roundMoney(tollAccountBalance.currentBalance),
      },
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
