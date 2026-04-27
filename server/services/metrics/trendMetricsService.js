// ------------------------------------------------------------
// /server/services/metrics/trendMetricsService.js
// Revenue / expense / profit trend buckets for metrics charts.
// ------------------------------------------------------------

const pool = require("../../db");
const {
  endOfDay,
  getDateRange,
  roundMoney,
  tripOverlapsRange,
  toNumber,
} = require("./metricHelpers");

function getTrendGranularity(rangeKey) {
  return rangeKey === "90d" || rangeKey === "all" ? "week" : "day";
}

function bucketStartForDate(dateInput, granularity) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;

  if (granularity === "week") {
    const day = d.getDay(); // 0 sun
    const diffToMonday = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diffToMonday);
  }

  d.setHours(0, 0, 0, 0);
  return d;
}

function bucketKey(dateInput, granularity) {
  const d = bucketStartForDate(dateInput, granularity);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
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
  const client = await pool.connect();

  try {
    const [trips, expenses] = await Promise.all([
      fetchTripsInRange(client, startDate, endDate),
      fetchExpensesInRange(client, startDate, endDate),
    ]);

    const bucketMap = new Map();

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

    for (const trip of trips) {
      const label = bucketKey(trip.trip_start, granularity);
      if (!label) continue;
      const bucket = ensureBucket(label);
      bucket.revenue += toNumber(trip.amount);
    }

    for (const expense of expenses) {
      const label = bucketKey(expense.date, granularity);
      if (!label) continue;
      const bucket = ensureBucket(label);
      bucket.expenses += toNumber(expense.price) + toNumber(expense.tax);
    }

    const points = Array.from(bucketMap.values())
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
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getTrendMetrics,
};
