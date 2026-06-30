const pool = require("../db");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_DAILY_BRIEF_MODEL ||
  process.env.OPENAI_FMV_MODEL ||
  "gpt-4.1-mini";
const DEFAULT_TIME_ZONE = process.env.DAILY_BRIEF_TIME_ZONE || "America/Chicago";
const DAILY_BRIEF_LATEST_KEY = "ai.dailyBrief.latest";
const DAILY_BRIEF_RUN_HISTORY_KEY = "ai.dailyBrief.runHistory";

function cleanText(value, maxLength = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function getLocalDateString(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeBriefDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return getLocalDateString();
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function mapTrip(row) {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    vehicleNickname: row.vehicle_nickname,
    start: row.trip_start,
    end: row.trip_end,
    pickupLocation: row.pickup_location,
    returnLocation: row.return_location,
    status: row.status,
    workflowStage: row.workflow_stage,
    amount: row.amount == null ? null : Number(row.amount),
    tollTotal: row.toll_total == null ? null : Number(row.toll_total),
    tollReviewStatus: row.toll_review_status,
    expenseStatus: row.expense_status,
    closedOut: row.closed_out === true,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    vehicleName: row.vehicle_name,
    title: row.title,
    priority: row.priority,
    status: row.status,
    blocksRental: row.blocks_rental === true,
    blocksGuestExport: row.blocks_guest_export === true,
    needsReview: row.needs_review === true,
    updatedAt: row.updated_at,
  };
}

function mapTripChange(row) {
  return {
    id: row.id,
    type: row.message_type,
    subject: row.subject,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    reservationId: row.reservation_id,
    tripId: row.trip_id,
    amount: row.amount == null ? null : Number(row.amount),
    timestamp: row.message_timestamp || row.created_at,
  };
}

function mapLatestBookedTrip(row) {
  if (!row) return null;
  return {
    timestamp: row.message_timestamp || row.created_at || row.trip_created_at,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    reservationId: row.reservation_id,
    tripId: row.trip_id,
    start: row.trip_start,
    end: row.trip_end,
    amount: row.amount == null ? null : Number(row.amount),
    subject: row.subject,
  };
}

function mapFleetStatusCandidate(row) {
  const revenue = roundMoney(row.revenue);
  const costs = roundMoney(row.operating_cost);
  const netRevenue = roundMoney(revenue - costs);
  const bookedDays = roundMoney(row.booked_days);
  const activeTripCount = Number(row.active_trip_count || 0);
  const avgDailyRate =
    bookedDays > 0 ? roundMoney(revenue / bookedDays) : roundMoney(row.avg_daily_rate);
  const bookingCount = Number(row.booking_count || 0);
  const blockerTasks = Number(row.blocker_tasks || 0);
  const highPriorityTasks = Number(row.high_priority_tasks || 0);
  const openMaintenanceTasks = Number(row.open_maintenance_tasks || 0);
  const blockerDays = roundMoney(row.blocker_days);
  const issueTrips = Number(row.issue_trips || 0);
  const chadScore = roundMoney(
    netRevenue +
      avgDailyRate * 1.5 +
      bookingCount * 25 +
      bookedDays * 10 -
      blockerDays * 35 -
      blockerTasks * 50 -
      highPriorityTasks * 25 -
      issueTrips * 25
  );
  const princessScore = roundMoney(
    costs +
      blockerDays * 75 +
      blockerTasks * 100 +
      highPriorityTasks * 50 +
      openMaintenanceTasks * 15 +
      issueTrips * 50 -
      revenue * 0.2 -
      bookingCount * 10
  );

  return {
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    revenue,
    costs,
    netRevenue,
    bookedDays,
    bookingCount,
    activeTripCount,
    avgDailyRate,
    openMaintenanceTasks,
    blockerTasks,
    highPriorityTasks,
    blockerDays,
    issueTrips,
    chadScore,
    princessScore,
  };
}

function selectFleetStatus(candidates) {
  const ranked = Array.isArray(candidates) ? candidates : [];
  const activeCandidates = ranked.filter(
    (item) =>
      item.bookingCount > 0 ||
      item.revenue > 0 ||
      item.costs > 0 ||
      item.openMaintenanceTasks > 0
  );
  if (!activeCandidates.length) {
    return {
      lookbackDays: 10,
      chad: null,
      princess: null,
      candidates: [],
    };
  }

  const byChad = [...activeCandidates].sort(
    (a, b) => b.chadScore - a.chadScore || b.netRevenue - a.netRevenue
  );
  const byPrincess = [...activeCandidates].sort(
    (a, b) => b.princessScore - a.princessScore || b.costs - a.costs
  );

  return {
    lookbackDays: 10,
    chad: byChad[0] || null,
    princess: byPrincess[0] || null,
    candidates: activeCandidates
      .sort((a, b) => b.chadScore - a.chadScore)
      .slice(0, 8),
  };
}

function buildMonthlyProjection(finance) {
  const monthToDateRevenue = roundMoney(finance.month_to_date_revenue);
  const bookedRemainingRevenue = roundMoney(finance.booked_remaining_month_revenue);
  const daysElapsed = Math.max(1, Number(finance.month_days_elapsed || 1));
  const daysInMonth = Math.max(daysElapsed, Number(finance.month_days_total || daysElapsed));
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
  const runRateDailyRevenue = roundMoney(monthToDateRevenue / daysElapsed);
  const runRateProjectedRevenue = roundMoney(runRateDailyRevenue * daysInMonth);
  const bookedProjectedRevenue = roundMoney(
    monthToDateRevenue + bookedRemainingRevenue
  );
  const blendedProjectedRevenue = roundMoney(
    Math.max(bookedProjectedRevenue, runRateProjectedRevenue)
  );

  return {
    monthStart: finance.month_start || null,
    monthEnd: finance.month_end || null,
    daysElapsed,
    daysRemaining,
    daysInMonth,
    monthToDateRevenue,
    bookedRemainingRevenue,
    runRateDailyRevenue,
    runRateProjectedRevenue,
    bookedProjectedRevenue,
    blendedProjectedRevenue,
    projectionMethod:
      bookedProjectedRevenue >= runRateProjectedRevenue
        ? "booked_remaining"
        : "run_rate",
  };
}

async function collectDailyBriefContext(options = {}) {
  const date = normalizeBriefDate(options.date);
  const timeZone = cleanText(options.timeZone, 80) || DEFAULT_TIME_ZONE;

  const client = options.client || pool;
  const params = [date];
  const tripsSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    )
    SELECT
      t.id,
      t.reservation_id,
      t.guest_name,
      t.vehicle_name,
      COALESCE(v.nickname, v.turo_vehicle_name, t.vehicle_name) AS vehicle_nickname,
      t.trip_start,
      t.trip_end,
      t.pickup_location,
      t.return_location,
      t.status,
      t.workflow_stage,
      t.amount,
      t.toll_total,
      t.toll_review_status,
      t.expense_status,
      t.closed_out
    FROM trips t
    LEFT JOIN vehicles v
      ON (
        NULLIF(t.turo_vehicle_id, '') IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
      OR (
        COALESCE(t.vehicle_name, '') <> ''
        AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) = LOWER(t.vehicle_name)
      )
    CROSS JOIN bounds b
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
      AND (
        (t.trip_start >= b.day_start AND t.trip_start < b.day_end)
        OR (t.trip_end >= b.day_start AND t.trip_end < b.day_end)
        OR (t.trip_start < b.day_end AND t.trip_end >= b.day_start)
        OR (t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false)
      )
    ORDER BY t.trip_start ASC NULLS LAST, t.trip_end ASC NULLS LAST
    LIMIT 80
  `;

  const tasksSql = `
    SELECT
      mt.id,
      COALESCE(v.nickname, v.turo_vehicle_name, mt.vehicle_vin) AS vehicle_name,
      mt.title,
      mt.priority,
      mt.status,
      mt.blocks_rental,
      mt.blocks_guest_export,
      mt.needs_review,
      mt.updated_at
    FROM maintenance_tasks mt
    LEFT JOIN vehicles v ON v.vin = mt.vehicle_vin
    WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
    ORDER BY
      CASE mt.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      mt.updated_at DESC
    LIMIT 40
  `;

  const messageSql = `
    SELECT
      COUNT(*) FILTER (WHERE status = 'unread') AS raw_unread_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND message_type IN ('guest_message', 'guest_message_thread')
      ) AS raw_unread_guest_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND COALESCE(message_type, '') NOT IN ('payment_notice', 'renter_activity')
          AND NOT (
            message_type = 'turo_notification'
            AND trip_id IS NOT NULL
            AND subject ILIKE '%upcoming trip%'
          )
      ) AS actionable_unread_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND message_type = 'guest_message'
      ) AS unread_guest_message_count,
      COUNT(DISTINCT CASE
        WHEN status = 'unread'
          AND message_type = 'guest_message'
        THEN COALESCE(
          CASE WHEN trip_id IS NOT NULL THEN 'trip:' || trip_id::text END,
          CASE WHEN reservation_id IS NOT NULL THEN 'reservation:' || reservation_id::text END,
          'guest:' || LOWER(COALESCE(guest_name, 'unknown')) || ':' || LOWER(COALESCE(vehicle_name, 'unknown'))
        )
      END) AS actionable_guest_thread_count,
      MAX(message_timestamp) FILTER (
        WHERE status = 'unread'
          AND COALESCE(message_type, '') NOT IN ('payment_notice', 'renter_activity')
      ) AS newest_unread_at,
      (
        SELECT COALESCE(jsonb_object_agg(message_type, message_count), '{}'::jsonb)
        FROM (
          SELECT
            COALESCE(NULLIF(message_type, ''), 'unknown') AS message_type,
            COUNT(*)::int AS message_count
          FROM messages
          WHERE status = 'unread'
          GROUP BY COALESCE(NULLIF(message_type, ''), 'unknown')
        ) unread_by_type
      ) AS unread_by_type
    FROM messages
  `;

  const tripChangesSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    )
    SELECT
      m.id,
      m.message_type,
      m.subject,
      m.guest_name,
      COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
      COALESCE(t.vehicle_name, m.vehicle_name) AS vehicle_name,
      m.reservation_id,
      COALESCE(m.trip_id, t.id) AS trip_id,
      m.amount,
      m.message_timestamp,
      m.created_at
    FROM messages m
    LEFT JOIN trips t
      ON t.id = m.trip_id
      OR (
        m.reservation_id IS NOT NULL
        AND t.reservation_id IS NOT NULL
        AND m.reservation_id = t.reservation_id
      )
    LEFT JOIN vehicles v
      ON (
        t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
      OR (
        COALESCE(t.vehicle_name, m.vehicle_name, '') <> ''
        AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) =
          LOWER(COALESCE(t.vehicle_name, m.vehicle_name))
      )
    CROSS JOIN bounds b
    WHERE COALESCE(m.message_timestamp, m.created_at) >= b.day_start
      AND COALESCE(m.message_timestamp, m.created_at) < b.day_end
      AND m.message_type IN ('trip_booked', 'trip_changed')
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
    ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC, m.id DESC
    LIMIT 30
  `;

  const operationsSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    ),
    fleet AS (
      SELECT
        v.id,
        v.vin,
        COALESCE(v.nickname, v.turo_vehicle_name, v.vin) AS vehicle_name,
        v.turo_vehicle_id
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) = true
        AND COALESCE(v.in_service, true) = true
    ),
    active_today AS (
      SELECT DISTINCT f.id AS vehicle_id
      FROM fleet f
      JOIN trips t
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND f.turo_vehicle_id IS NOT NULL
          AND t.turo_vehicle_id = f.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) = LOWER(f.vehicle_name)
        )
      CROSS JOIN bounds b
      WHERE t.deleted_at IS NULL
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_start < b.day_end
        AND t.trip_end >= b.day_start
    ),
    latest_booking AS (
      SELECT
        m.id,
        m.subject,
        m.guest_name,
        COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
        COALESCE(t.vehicle_name, m.vehicle_name) AS vehicle_name,
        m.reservation_id,
        COALESCE(m.trip_id, t.id) AS trip_id,
        COALESCE(m.amount, t.amount) AS amount,
        m.message_timestamp,
        m.created_at,
        t.created_at AS trip_created_at,
        t.trip_start,
        t.trip_end
      FROM messages m
      LEFT JOIN trips t
        ON t.id = m.trip_id
        OR (
          m.reservation_id IS NOT NULL
          AND t.reservation_id IS NOT NULL
          AND m.reservation_id = t.reservation_id
        )
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, m.vehicle_name, '') <> ''
          AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) =
            LOWER(COALESCE(t.vehicle_name, m.vehicle_name))
        )
      WHERE m.message_type = 'trip_booked'
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
      ORDER BY COALESCE(m.message_timestamp, m.created_at, t.created_at) DESC NULLS LAST, m.id DESC
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM fleet)::int AS active_fleet_count,
      (SELECT COUNT(*) FROM active_today)::int AS occupied_vehicle_count,
      (
        SELECT COALESCE(jsonb_agg(vehicle_name ORDER BY vehicle_name), '[]'::jsonb)
        FROM (
          SELECT f.vehicle_name
          FROM fleet f
          JOIN active_today a ON a.vehicle_id = f.id
        ) occupied
      ) AS occupied_vehicle_names,
      (
        SELECT to_jsonb(latest_booking)
        FROM latest_booking
      ) AS latest_booking
  `;

  const fleetStatusSql = `
    WITH bounds AS (
      SELECT
        ($1::date + INTERVAL '1 day') AS range_end,
        ($1::date + INTERVAL '1 day' - INTERVAL '10 days') AS range_start
    ),
    fleet AS (
      SELECT
        v.id,
        v.vin,
        COALESCE(v.nickname, v.turo_vehicle_name, v.vin) AS vehicle_name,
        v.turo_vehicle_id
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) = true
        AND COALESCE(v.in_service, true) = true
    ),
    trip_vehicle AS (
      SELECT
        t.*,
        f.id AS vehicle_id,
        f.vehicle_name
      FROM trips t
      JOIN fleet f
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND f.turo_vehicle_id IS NOT NULL
          AND t.turo_vehicle_id = f.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) = LOWER(f.vehicle_name)
        )
      CROSS JOIN bounds b
      WHERE t.deleted_at IS NULL
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_start < b.range_end
        AND t.trip_end >= b.range_start
    ),
    trip_window_metrics AS (
      SELECT
        tv.vehicle_id,
        COALESCE(tf.host_payout, tv.amount, 0) AS total_revenue,
        COALESCE(tf.issue_flag, false) AS issue_flag,
        tv.trip_start >= b.range_start AND tv.trip_start < b.range_end AS started_in_window,
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (
            LEAST(tv.trip_end, b.range_end) - GREATEST(tv.trip_start, b.range_start)
          )) / 86400.0
        ) AS overlap_days,
        GREATEST(
          EXTRACT(EPOCH FROM (tv.trip_end - tv.trip_start)) / 86400.0,
          1
        ) AS trip_days
      FROM trip_vehicle tv
      CROSS JOIN bounds b
      LEFT JOIN trip_financial_facts tf ON tf.trip_id = tv.id
    ),
    trip_metrics AS (
      SELECT
        vehicle_id,
        COUNT(*) FILTER (WHERE started_in_window)::int AS booking_count,
        COUNT(*)::int AS active_trip_count,
        COALESCE(SUM(total_revenue * (overlap_days / NULLIF(trip_days, 0))), 0) AS revenue,
        COALESCE(SUM(overlap_days), 0) AS booked_days,
        COUNT(*) FILTER (WHERE issue_flag = true)::int AS issue_trips
      FROM trip_window_metrics
      GROUP BY vehicle_id
    ),
    expense_vehicle AS (
      SELECT
        COALESCE(e.vehicle_id::bigint, tv.vehicle_id) AS vehicle_id,
        e.price,
        e.tax
      FROM expenses e
      CROSS JOIN bounds b
      LEFT JOIN trip_vehicle tv ON tv.id = e.trip_id
      WHERE e.date >= b.range_start::date
        AND e.date < b.range_end::date
        AND COALESCE(e.is_capitalized, false) = false
    ),
    expense_metrics AS (
      SELECT
        vehicle_id,
        COALESCE(SUM(COALESCE(price, 0) + COALESCE(tax, 0)), 0) AS operating_cost
      FROM expense_vehicle
      WHERE vehicle_id IS NOT NULL
      GROUP BY vehicle_id
    ),
    maintenance_metrics AS (
      SELECT
        f.id AS vehicle_id,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
        )::int AS open_maintenance_tasks,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
            AND (mt.blocks_rental = true OR mt.blocks_guest_export = true)
        )::int AS blocker_tasks,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
            AND mt.priority IN ('urgent', 'high')
        )::int AS high_priority_tasks,
        COALESCE(SUM(
          CASE
            WHEN mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
              AND (mt.blocks_rental = true OR mt.blocks_guest_export = true)
            THEN GREATEST(
              0,
              EXTRACT(EPOCH FROM (
                b.range_end - GREATEST(mt.created_at::timestamptz, b.range_start)
              )) / 86400.0
            )
            ELSE 0
          END
        ), 0) AS blocker_days
      FROM fleet f
      CROSS JOIN bounds b
      LEFT JOIN maintenance_tasks mt ON mt.vehicle_vin = f.vin
      GROUP BY f.id
    )
    SELECT
      f.id AS vehicle_id,
      f.vehicle_name,
      COALESCE(tm.booking_count, 0) AS booking_count,
      COALESCE(tm.active_trip_count, 0) AS active_trip_count,
      COALESCE(tm.revenue, 0) AS revenue,
      COALESCE(tm.booked_days, 0) AS booked_days,
      CASE
        WHEN COALESCE(tm.booked_days, 0) > 0
        THEN COALESCE(tm.revenue, 0) / tm.booked_days
        ELSE 0
      END AS avg_daily_rate,
      COALESCE(tm.issue_trips, 0) AS issue_trips,
      COALESCE(em.operating_cost, 0) AS operating_cost,
      COALESCE(mm.open_maintenance_tasks, 0) AS open_maintenance_tasks,
      COALESCE(mm.blocker_tasks, 0) AS blocker_tasks,
      COALESCE(mm.high_priority_tasks, 0) AS high_priority_tasks,
      COALESCE(mm.blocker_days, 0) AS blocker_days
    FROM fleet f
    LEFT JOIN trip_metrics tm ON tm.vehicle_id = f.id
    LEFT JOIN expense_metrics em ON em.vehicle_id = f.id
    LEFT JOIN maintenance_metrics mm ON mm.vehicle_id = f.id
    ORDER BY COALESCE(tm.revenue, 0) DESC, f.vehicle_name ASC
  `;

  const financeSql = `
    WITH bounds AS (
      SELECT
        $1::date AS day_start,
        ($1::date + INTERVAL '1 day') AS day_end,
        date_trunc('month', $1::date)::date AS month_start,
        (date_trunc('month', $1::date) + INTERVAL '1 month')::date AS month_end
    )
    SELECT
      b.month_start,
      b.month_end,
      EXTRACT(DAY FROM b.day_start)::int AS month_days_elapsed,
      EXTRACT(DAY FROM (b.month_end - INTERVAL '1 day'))::int AS month_days_total,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.day_start AND t.trip_start < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS opening_trip_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_end >= b.day_start AND t.trip_end < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS closing_trip_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.month_start AND t.trip_start < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS month_to_date_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.day_end AND t.trip_start < b.month_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS booked_remaining_month_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false
        THEN COALESCE(t.toll_total, 0)
        ELSE 0
      END), 0) AS open_closeout_tolls,
      COUNT(*) FILTER (
        WHERE t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false
      ) AS open_closeout_count
    FROM trips t
    LEFT JOIN trip_financial_facts tf ON tf.trip_id = t.id
    CROSS JOIN bounds b
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
    GROUP BY b.month_start, b.month_end, b.day_start
  `;

  const tripsResult = await client.query(tripsSql, params);
  const tasksResult = await client.query(tasksSql);
  const messageResult = await client.query(messageSql);
  const tripChangesResult = await client.query(tripChangesSql, params);
  const operationsResult = await client.query(operationsSql, params);
  const fleetStatusResult = await client.query(fleetStatusSql, params);
  const financeResult = await client.query(financeSql, params);

  const trips = tripsResult.rows.map(mapTrip);
  const dayStartMs = new Date(`${date}T00:00:00`).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const inDay = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) && ms >= dayStartMs && ms < dayEndMs;
  };

  const openingTrips = trips.filter((trip) => inDay(trip.start));
  const closingTrips = trips.filter((trip) => inDay(trip.end));
  const activeTrips = trips.filter((trip) => {
    const startMs = trip.start ? new Date(trip.start).getTime() : NaN;
    const endMs = trip.end ? new Date(trip.end).getTime() : NaN;
    return (
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs < dayEndMs &&
      endMs >= dayStartMs
    );
  });
  const pendingCloseouts = trips.filter(
    (trip) =>
      trip.end &&
      new Date(trip.end).getTime() < dayEndMs &&
      trip.closedOut !== true
  );

  const tasks = tasksResult.rows.map(mapTask);
  const finance = financeResult.rows[0] || {};
  const monthlyProjection = buildMonthlyProjection(finance);
  const messages = messageResult.rows[0] || {};
  const operations = operationsResult.rows[0] || {};
  const activeFleetCount = Number(operations.active_fleet_count || 0);
  const occupiedVehicleCount = Number(operations.occupied_vehicle_count || 0);
  const occupancyPercent =
    activeFleetCount > 0
      ? Math.round((occupiedVehicleCount / activeFleetCount) * 1000) / 10
      : null;
  const tripChanges = tripChangesResult.rows.map(mapTripChange);
  const fleetStatus = selectFleetStatus(
    fleetStatusResult.rows.map(mapFleetStatusCandidate)
  );

  return {
    date,
    timeZone,
    generatedAt: new Date().toISOString(),
    trips: {
      opening: openingTrips,
      closing: closingTrips,
      newTripsStarting: openingTrips,
      tripsEndingToday: closingTrips,
      active: activeTrips,
      pendingCloseouts,
      changesToday: tripChanges,
    },
    tasks: {
      totalOpen: tasks.length,
      urgentOrHigh: tasks.filter((task) =>
        ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
      ),
      blockers: tasks.filter(
        (task) => task.blocksRental || task.blocksGuestExport || task.needsReview
      ),
      sample: tasks.slice(0, 12),
    },
    messages: {
      unreadCount: Number(messages.actionable_unread_count || 0),
      unreadGuestCount: Number(messages.actionable_guest_thread_count || 0),
      rawUnreadCount: Number(messages.raw_unread_count || 0),
      rawUnreadGuestCount: Number(messages.raw_unread_guest_count || 0),
      unreadGuestMessageCount: Number(messages.unread_guest_message_count || 0),
      actionableGuestThreadCount: Number(messages.actionable_guest_thread_count || 0),
      newestUnreadAt: messages.newest_unread_at || null,
      unreadByType:
        messages.unread_by_type &&
        typeof messages.unread_by_type === "object" &&
        !Array.isArray(messages.unread_by_type)
          ? messages.unread_by_type
          : {},
    },
    operations: {
      latestBookedTrip: mapLatestBookedTrip(operations.latest_booking),
      occupancy: {
        occupiedVehicleCount,
        activeFleetCount,
        occupancyPercent,
        occupiedVehicleNames: Array.isArray(operations.occupied_vehicle_names)
          ? operations.occupied_vehicle_names
          : [],
      },
    },
    fleetStatus,
    finance: {
      openingTripRevenue: roundMoney(finance.opening_trip_revenue),
      closingTripRevenue: roundMoney(finance.closing_trip_revenue),
      monthToDateRevenue: roundMoney(finance.month_to_date_revenue),
      monthlyProjection,
      openCloseoutTolls: roundMoney(finance.open_closeout_tolls),
      openCloseoutCount: Number(finance.open_closeout_count || 0),
    },
  };
}

function buildBriefPrompt(context) {
  return JSON.stringify(
    {
      context,
      instructions: [
        "Write a concise AM daily brief for the fleet operator.",
        "Use only the supplied JSON. Do not invent amounts, guests, vehicles, or tasks.",
        "Near the top, note the last time a new trip was booked using context.operations.latestBookedTrip. Include the vehicle and guest if supplied.",
        "Near the top, note today's fleet occupancy using context.operations.occupancy: occupiedVehicleCount / activeFleetCount and occupancyPercent.",
        "Use these exact trip section labels when relevant: New Trips Starting, Trips Ending Today, Trip Changes.",
        "Trip Changes can include new trips and changes to existing trips that occurred today; use context.trips.changesToday for that section.",
        "Avoid the labels Openings and Closings.",
        "Include a Chad Status section using context.fleetStatus.chad: the best recent performer over the lookback window.",
        "Include a Princess Status section using context.fleetStatus.princess: the vehicle creating the most cost, downtime, or maintenance drag over the lookback window.",
        "For Chad and Princess, cite the useful metrics supplied: netRevenue, revenue, costs, bookingCount, avgDailyRate, blockerTasks, blockerDays, issueTrips, and lookbackDays.",
        "Include a Monthly Projection section using context.finance.monthlyProjection. Explain month-to-date revenue, booked remaining revenue, run-rate projection, and blendedProjectedRevenue.",
        "Prioritize New Trips Starting, Trips Ending Today, Trip Changes, closeout blockers, maintenance blockers, guest-message workload, and financial watchouts.",
        "For guest messages, lead with messages.actionableGuestThreadCount as the queue workload; mention messages.unreadGuestMessageCount only as raw message volume if useful.",
        "Do not mention messages.rawUnreadCount unless you also include the messages.unreadByType breakdown explaining what makes up that raw total.",
        "Do not say there are no urgent guest messages or that urgent guest messages were flagged; this context does not include an urgency classifier.",
        "Keep it paste-ready for an internal morning post.",
        "Use short sections with bullets. Start with a one-line headline.",
        "Include exact money values where supplied.",
        "If there is nothing in a section, say so briefly.",
      ],
    },
    null,
    2
  );
}

async function generateDailyBrief(options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }

  const context = await collectDailyBriefContext(options);
  const model = options.model || DEFAULT_OPENAI_MODEL;
  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You turn fleet operations JSON into a crisp morning brief. " +
              "Return only the brief text. No markdown table.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: buildBriefPrompt(context) }],
      },
    ],
    temperature: 0.25,
    max_output_tokens: 900,
  };

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(`OpenAI daily brief request failed: HTTP ${response.status}`);
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  const brief = extractResponseText(raw);
  if (!brief) {
    const err = new Error("OpenAI daily brief request returned no text output");
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  return {
    date: context.date,
    timeZone: context.timeZone,
    generatedAt: context.generatedAt,
    model,
    brief,
    context,
  };
}

async function getLatestDailyBrief(client = pool) {
  const { rows } = await client.query(
    `
      SELECT value, updated_at
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [DAILY_BRIEF_LATEST_KEY]
  );

  return rows[0]
    ? {
        ...(rows[0].value || {}),
        savedAt: rows[0].updated_at,
      }
    : null;
}

async function getDailyBriefRunHistory(client = pool) {
  const { rows } = await client.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [DAILY_BRIEF_RUN_HISTORY_KEY]
  );

  const value = rows[0]?.value;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function saveDailyBriefResult(result, client = pool) {
  const value = {
    date: result.date,
    timeZone: result.timeZone,
    generatedAt: result.generatedAt,
    model: result.model,
    brief: result.brief,
    context: result.context,
  };
  const history = await getDailyBriefRunHistory(client);
  const historyValue = {
    ...history,
    [result.date]: {
      generatedAt: result.generatedAt,
      model: result.model,
      briefLength: String(result.brief || "").length,
    },
  };

  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [DAILY_BRIEF_LATEST_KEY, JSON.stringify(value)]
  );

  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [DAILY_BRIEF_RUN_HISTORY_KEY, JSON.stringify(historyValue)]
  );

  return value;
}

async function generateAndSaveDailyBrief(options = {}) {
  const result = await generateDailyBrief(options);
  await saveDailyBriefResult(result, options.client || pool);
  return result;
}

module.exports = {
  collectDailyBriefContext,
  generateAndSaveDailyBrief,
  generateDailyBrief,
  getDailyBriefRunHistory,
  getLatestDailyBrief,
  saveDailyBriefResult,
};
