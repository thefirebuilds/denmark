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
      COUNT(*) FILTER (WHERE status = 'unread') AS unread_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND message_type IN ('guest_message', 'guest_message_thread')
      ) AS unread_guest_count,
      MAX(message_timestamp) FILTER (WHERE status = 'unread') AS newest_unread_at
    FROM messages
  `;

  const financeSql = `
    WITH bounds AS (
      SELECT
        $1::date AS day_start,
        ($1::date + INTERVAL '1 day') AS day_end,
        date_trunc('month', $1::date)::date AS month_start
    )
    SELECT
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
  `;

  const tripsResult = await client.query(tripsSql, params);
  const tasksResult = await client.query(tasksSql);
  const messageResult = await client.query(messageSql);
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
  const messages = messageResult.rows[0] || {};

  return {
    date,
    timeZone,
    generatedAt: new Date().toISOString(),
    trips: {
      opening: openingTrips,
      closing: closingTrips,
      active: activeTrips,
      pendingCloseouts,
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
      unreadCount: Number(messages.unread_count || 0),
      unreadGuestCount: Number(messages.unread_guest_count || 0),
      newestUnreadAt: messages.newest_unread_at || null,
    },
    finance: {
      openingTripRevenue: roundMoney(finance.opening_trip_revenue),
      closingTripRevenue: roundMoney(finance.closing_trip_revenue),
      monthToDateRevenue: roundMoney(finance.month_to_date_revenue),
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
        "Prioritize today's openings, today's closings, closeout blockers, maintenance blockers, guest-message urgency, and financial watchouts.",
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
