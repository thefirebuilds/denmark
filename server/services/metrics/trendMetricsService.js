// ------------------------------------------------------------
// /server/services/metrics/trendMetricsService.js
// Revenue / expense / profit trend buckets for metrics charts.
// ------------------------------------------------------------

const pool = require("../../db");
const {
  endOfDay,
  getDateRange,
  getTripTotalDays,
  roundMoney,
  startOfDay,
  tripOverlapsRange,
  toNumber,
} = require("./metricHelpers");

function getTrendGranularity(rangeKey) {
  return rangeKey === "all" ? "month" : "day";
}

function bucketStartForDate(dateInput, granularity) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;

  if (granularity === "week") {
    const day = d.getDay(); // 0 sun
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diffToMonday);
  }

  if (granularity === "month") {
    d.setDate(1);
  }

  d.setHours(0, 0, 0, 0);
  return d;
}

function bucketKey(dateInput, granularity) {
  const d = bucketStartForDate(dateInput, granularity);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(dateInput, days) {
  const d = new Date(dateInput);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(dateInput, months) {
  const d = new Date(dateInput);
  d.setMonth(d.getMonth() + months);
  return d;
}

function startOfMonth(dateInput) {
  const d = new Date(dateInput);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfMonth(dateInput) {
  const d = startOfMonth(dateInput);
  d.setMonth(d.getMonth() + 1);
  d.setMilliseconds(-1);
  return d;
}

function iterateBucketLabels(startDate, endDate, granularity) {
  if (!startDate || !endDate) return [];

  const labels = [];
  let cursor = bucketStartForDate(startDate, granularity);
  const end = bucketStartForDate(endDate, granularity);

  while (cursor && end && cursor <= end) {
    labels.push(cursor.toISOString().slice(0, 10));
    cursor = granularity === "month" ? addMonths(cursor, 1) : addDays(cursor, 1);
  }

  return labels;
}

function addTripRevenueToBuckets(bucketMap, trip, rangeStart, rangeEnd, granularity) {
  if (!trip?.trip_start || !trip?.trip_end) return;

  if (granularity !== "day") {
    const label = bucketKey(trip.trip_start, granularity);
    if (!label) return;
    const bucket = bucketMap.get(label);
    if (!bucket) return;
    bucket.revenue += toNumber(trip.amount);
    return;
  }

  const totalDays = getTripTotalDays(trip.trip_start, trip.trip_end);
  if (!totalDays) return;

  const dailyRevenue = toNumber(trip.amount) / totalDays;
  const tripStart = startOfDay(trip.trip_start);
  const tripEnd = startOfDay(trip.trip_end);
  const effectiveStart = rangeStart
    ? new Date(Math.max(tripStart.getTime(), startOfDay(rangeStart).getTime()))
    : tripStart;
  const effectiveEnd = new Date(
    Math.min(tripEnd.getTime(), startOfDay(rangeEnd).getTime())
  );

  for (
    let cursor = effectiveStart;
    cursor <= effectiveEnd;
    cursor = addDays(cursor, 1)
  ) {
    const label = bucketKey(cursor, "day");
    const bucket = bucketMap.get(label);
    if (bucket) bucket.revenue += dailyRevenue;
  }
}

function addTripMonthlyRevenueToBuckets(bucketMap, trip) {
  if (!trip?.trip_start || !trip?.trip_end) return;

  const tripStart = startOfDay(trip.trip_start);
  const tripEnd = endOfDay(trip.trip_end);
  if (Number.isNaN(tripStart.getTime()) || Number.isNaN(tripEnd.getTime())) return;

  const totalDays = getTripTotalDays(trip.trip_start, trip.trip_end);
  const totalRevenue = toNumber(trip.amount);
  if (!totalDays || !totalRevenue) return;

  const dailyRevenue = totalRevenue / totalDays;

  for (
    let cursor = startOfMonth(tripStart);
    cursor <= tripEnd;
    cursor = addMonths(cursor, 1)
  ) {
    const label = bucketKey(cursor, "month");
    const bucket = bucketMap.get(label);
    if (!bucket) continue;

    const monthStart = startOfMonth(cursor);
    const monthEnd = endOfMonth(cursor);
    const effectiveStart = new Date(Math.max(tripStart.getTime(), monthStart.getTime()));
    const effectiveEnd = new Date(Math.min(tripEnd.getTime(), monthEnd.getTime()));
    const overlapDays = Math.max(
      0,
      Math.floor(
        (startOfDay(effectiveEnd).getTime() - startOfDay(effectiveStart).getTime()) /
          86400000
      ) + 1
    );

    bucket.revenue += dailyRevenue * overlapDays;
  }
}

async function fetchTripsInRange(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        trip_start,
        trip_end,
        amount,
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
          date,
          price,
          tax
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
        date,
        price,
        tax
      FROM expenses
      WHERE date >= $1::date
        AND date <= $2::date
    `,
    [startDate, endDate]
  );

  return rows;
}

async function getTrendMetrics(rangeKey = "90d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const granularity = getTrendGranularity(key);
  const monthlyEndDate = endOfDay(new Date());
  const monthlyStartDate = startOfMonth(addMonths(monthlyEndDate, -11));
  const client = await pool.connect();

  try {
    const trips = await fetchTripsInRange(client, startDate, endDate);
    const expenses = await fetchExpensesInRange(client, startDate, endDate);
    const monthlyTrips = await fetchTripsInRange(client, monthlyStartDate, monthlyEndDate);
    const monthlyExpenses = await fetchExpensesInRange(
      client,
      monthlyStartDate,
      monthlyEndDate
    );

    const bucketMap = new Map();
    const monthlyBucketMap = new Map();
    const effectiveStartDate =
      startDate ||
      [...trips.map((trip) => trip.trip_start), ...expenses.map((expense) => expense.date)]
        .filter(Boolean)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ||
      endDate;

    function ensureBucket(label) {
      if (!bucketMap.has(label)) {
        bucketMap.set(label, {
          label,
          revenue: 0,
          expenses: 0,
          profit: 0,
        });
      }
      return bucketMap.get(label);
    }

    for (const label of iterateBucketLabels(effectiveStartDate, endDate, granularity)) {
      ensureBucket(label);
    }

    for (const label of iterateBucketLabels(monthlyStartDate, monthlyEndDate, "month")) {
      monthlyBucketMap.set(label, {
        label,
        revenue: 0,
        expenses: 0,
        profit: 0,
      });
    }

    for (const trip of trips) {
      addTripRevenueToBuckets(bucketMap, trip, startDate, endDate, granularity);
    }

    for (const trip of monthlyTrips) {
      addTripMonthlyRevenueToBuckets(monthlyBucketMap, trip);
    }

    for (const expense of expenses) {
      const label = bucketKey(expense.date, granularity);
      if (!label) continue;
      const bucket = ensureBucket(label);
      bucket.expenses += toNumber(expense.price) + toNumber(expense.tax);
    }

    for (const expense of monthlyExpenses) {
      const label = bucketKey(expense.date, "month");
      if (!label) continue;
      const bucket = monthlyBucketMap.get(label);
      if (bucket) bucket.expenses += toNumber(expense.price) + toNumber(expense.tax);
    }

    const points = Array.from(bucketMap.values())
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      .map((bucket) => ({
        label: bucket.label,
        revenue: roundMoney(bucket.revenue),
        expenses: roundMoney(bucket.expenses),
        profit: roundMoney(bucket.revenue - bucket.expenses),
      }));
    const monthlyProfitLoss = Array.from(monthlyBucketMap.values())
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      .map((bucket) => ({
        label: bucket.label,
        revenue: roundMoney(bucket.revenue),
        expenses: roundMoney(bucket.expenses),
        profit: roundMoney(bucket.revenue - bucket.expenses),
      }));

    return {
      range: key,
      granularity,
      points,
      monthly_profit_loss: {
        months: 12,
        granularity: "month",
        points: monthlyProfitLoss,
        summary: {
          revenue: roundMoney(
            monthlyProfitLoss.reduce((sum, point) => sum + toNumber(point.revenue), 0)
          ),
          expenses: roundMoney(
            monthlyProfitLoss.reduce((sum, point) => sum + toNumber(point.expenses), 0)
          ),
          profit: roundMoney(
            monthlyProfitLoss.reduce((sum, point) => sum + toNumber(point.profit), 0)
          ),
        },
      },
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getTrendMetrics,
};
