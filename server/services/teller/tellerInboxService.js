// ------------------------------------------------------------
// /server/services/teller/tellerInboxService.js
// Read-only Teller inbox service for:
// - listing Teller transactions with filters + pagination
// - fetching a single Teller transaction by id
// - returning summary counts by review status
// ------------------------------------------------------------

const pool = require("../../db");
const { scoreSuggestion } = require("./tellerMatchService");

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function parseBooleanFilter(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

async function listIgnoredVendorGroups(filters = {}) {
  const limit = parsePositiveInt(filters.limit, 25);
  const page = parsePositiveInt(filters.page, 1);
  const offset = (page - 1) * limit;

  const values = [];
  const where = [`tt.review_status = 'ignored'`];

  if (filters.q) {
    values.push(`%${String(filters.q).trim()}%`);
    where.push(`(
      COALESCE(tt.counterparty_name, '') ILIKE $${values.length}
      OR COALESCE(tt.description, '') ILIKE $${values.length}
      OR COALESCE(tt.ignore_reason, '') ILIKE $${values.length}
    )`);
  }

  const whereSql = `WHERE ${where.join(" AND ")}`;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT
        COALESCE(
          NULLIF(TRIM(tt.counterparty_name), ''),
          NULLIF(TRIM(tt.description), ''),
          'Unknown'
        ) AS vendor_key
      FROM teller_transactions tt
      ${whereSql}
      GROUP BY 1
    ) grouped
  `;

  const dataValues = [...values];
  dataValues.push(limit);
  const limitParam = `$${dataValues.length}`;

  dataValues.push(offset);
  const offsetParam = `$${dataValues.length}`;

  const sql = `
    SELECT
      COALESCE(
        NULLIF(TRIM(tt.counterparty_name), ''),
        NULLIF(TRIM(tt.description), ''),
        'Unknown'
      ) AS vendor_key,
      COUNT(*)::int AS transaction_count,
      MAX(tt.transaction_date) AS latest_transaction_date,
      MIN(tt.transaction_date) AS earliest_transaction_date,
      MIN(tt.description) AS sample_description,
      BOOL_OR(tt.ignored = TRUE) AS has_ignored_rows,
      MAX(tt.ignore_reason) AS sample_ignore_reason
    FROM teller_transactions tt
    ${whereSql}
    GROUP BY 1
    ORDER BY MAX(tt.transaction_date) DESC, 1 ASC
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
  `;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(sql, dataValues),
    pool.query(countSql, values),
  ]);

  return {
    data: rowsResult.rows,
    pagination: {
      page,
      limit,
      total: countResult.rows[0]?.total || 0,
      total_pages: Math.ceil((countResult.rows[0]?.total || 0) / limit),
    },
  };
}

async function getIgnoredVendorGroupDetails(vendorKey, filters = {}) {
  const limit = parsePositiveInt(filters.limit, 50);

  const result = await pool.query(
    `
    SELECT
      tt.id,
      tt.teller_transaction_id,
      tt.teller_account_id,
      tt.transaction_date,
      tt.description,
      tt.amount,
      tt.transaction_type,
      tt.status,
      tt.running_balance,
      tt.processing_status,
      tt.counterparty_name,
      tt.category,
      tt.account_link,
      tt.self_link,
      tt.raw_json,
      tt.ignored,
      tt.ignore_reason,
      tt.review_status,
      tt.matched_expense_id,
      tt.match_confidence,
      tt.match_method,
      tt.reviewed_at,
      tt.review_notes,
      tt.created_at,
      tt.updated_at
    FROM teller_transactions tt
    WHERE tt.review_status = 'ignored'
      AND COALESCE(
        NULLIF(TRIM(tt.counterparty_name), ''),
        NULLIF(TRIM(tt.description), ''),
        'Unknown'
      ) = $1
    ORDER BY tt.transaction_date DESC, tt.id DESC
    LIMIT $2
    `,
    [vendorKey, limit]
  );

  return {
    vendor_key: vendorKey,
    transactions: result.rows,
  };
}

async function listTellerTransactions(filters = {}) {
  const limit = parsePositiveInt(filters.limit, 50);
  const page = parsePositiveInt(filters.page, 1);
  const offset = (page - 1) * limit;

  const values = [];
  const where = [];

  if (filters.review_status) {
    values.push(filters.review_status);
    where.push(`tt.review_status = $${values.length}`);
  }

  const ignored = parseBooleanFilter(filters.ignored);
  if (ignored !== null) {
    values.push(ignored);
    where.push(`tt.ignored = $${values.length}`);
  }

  if (filters.status) {
    values.push(filters.status);
    where.push(`tt.status = $${values.length}`);
  }

  if (filters.q) {
    values.push(`%${String(filters.q).trim()}%`);
    where.push(`(
      COALESCE(tt.description, '') ILIKE $${values.length}
      OR COALESCE(tt.counterparty_name, '') ILIKE $${values.length}
      OR COALESCE(tt.category, '') ILIKE $${values.length}
    )`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM teller_transactions tt
    ${whereSql}
  `;

  const dataValues = [...values];
  dataValues.push(limit);
  const limitParam = `$${dataValues.length}`;

  dataValues.push(offset);
  const offsetParam = `$${dataValues.length}`;

  const sql = `
    SELECT
      tt.id,
      tt.teller_transaction_id,
      tt.teller_account_id,
      tt.transaction_date,
      tt.description,
      tt.amount,
      tt.transaction_type,
      tt.status,
      tt.running_balance,
      tt.processing_status,
      tt.counterparty_name,
      tt.category,
      tt.account_link,
      tt.self_link,
      tt.raw_json,
      tt.ignored,
      tt.ignore_reason,
      tt.review_status,
      tt.matched_expense_id,
      tt.match_confidence,
      tt.match_method,
      tt.reviewed_at,
      tt.review_notes,
      tt.created_at,
      tt.updated_at
    FROM teller_transactions tt
    ${whereSql}
    ORDER BY tt.transaction_date DESC, tt.id DESC
    LIMIT ${limitParam}
    OFFSET ${offsetParam}
  `;

  const [rowsResult, countResult] = await Promise.all([
    pool.query(sql, dataValues),
    pool.query(countSql, values),
  ]);

  const rows = rowsResult.rows;

  if (!rows.length) {
    return {
      data: [],
      pagination: {
        page,
        limit,
        total: countResult.rows[0]?.total || 0,
        total_pages: Math.ceil((countResult.rows[0]?.total || 0) / limit),
      },
    };
  }

  const txIds = rows.map((row) => row.id);
  const txById = new Map(rows.map((row) => [String(row.id), row]));

  const candidateResult = await pool.query(
    `
    SELECT
      tt.id AS teller_transaction_row_id,
      e.id,
      e.vehicle_id,
      v.nickname AS vehicle_nickname,
      e.vendor,
      e.price,
      e.tax,
      (COALESCE(e.price, 0) + COALESCE(e.tax, 0))::numeric(10,2) AS total_cost,
      e.is_capitalized,
      e.category,
      e.notes,
      e.date,
      e.expense_scope,
      e.trip_id
    FROM teller_transactions tt
    JOIN expenses e
      ON e.date BETWEEN (tt.transaction_date::date - INTERVAL '3 days')
                    AND (tt.transaction_date::date + INTERVAL '3 days')
     AND ABS((COALESCE(e.price, 0) + COALESCE(e.tax, 0)) - tt.amount::numeric) <= 1.00
    LEFT JOIN vehicles v
      ON v.id = e.vehicle_id
    WHERE tt.id = ANY($1::int[])
    `,
    [txIds]
  );

  const statsByTxId = new Map();

  for (const candidate of candidateResult.rows) {
    const txId = String(candidate.teller_transaction_row_id);
    const tx = txById.get(txId);
    if (!tx) continue;

    const match = scoreSuggestion(tx, candidate);
    const numericScore = Number(match?.score || 0);

    if (!statsByTxId.has(txId)) {
      statsByTxId.set(txId, {
        suggestion_count: 0,
        best_match_score: 0,
      });
    }

    const stats = statsByTxId.get(txId);
    stats.suggestion_count += 1;
    stats.best_match_score = Math.max(stats.best_match_score, numericScore);
  }

  const hydratedRows = rows.map((row) => {
    const stats = statsByTxId.get(String(row.id)) || {
      suggestion_count: 0,
      best_match_score: 0,
    };

    return {
      ...row,
      suggestion_count: stats.suggestion_count,
      best_match_score: Math.round(stats.best_match_score),
    };
  });

  return {
    data: hydratedRows,
    pagination: {
      page,
      limit,
      total: countResult.rows[0]?.total || 0,
      total_pages: Math.ceil((countResult.rows[0]?.total || 0) / limit),
    },
  };
}

async function getTellerTransactionById(id) {
  const result = await pool.query(
    `
    SELECT
      tt.id,
      tt.teller_transaction_id,
      tt.teller_account_id,
      tt.transaction_date,
      tt.description,
      tt.amount,
      tt.transaction_type,
      tt.status,
      tt.running_balance,
      tt.processing_status,
      tt.counterparty_name,
      tt.category,
      tt.account_link,
      tt.self_link,
      tt.raw_json,
      tt.ignored,
      tt.ignore_reason,
      tt.review_status,
      tt.matched_expense_id,
      tt.match_confidence,
      tt.match_method,
      tt.reviewed_at,
      tt.review_notes,
      tt.created_at,
      tt.updated_at,
      e.vendor AS matched_expense_vendor,
      e.category AS matched_expense_category,
      e.notes AS matched_expense_notes,
      e.date AS matched_expense_date,
      (COALESCE(e.price, 0) + COALESCE(e.tax, 0))::numeric(10,2) AS matched_expense_total,
      e.vehicle_id AS matched_expense_vehicle_id
    FROM teller_transactions tt
    LEFT JOIN expenses e
      ON e.id = tt.matched_expense_id
    WHERE tt.id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function getTellerSummary() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE review_status = 'pending' AND ignored = FALSE)::int AS pending,
      COUNT(*) FILTER (WHERE review_status = 'matched')::int AS matched,
      COUNT(*) FILTER (WHERE review_status = 'created')::int AS created,
      COUNT(*) FILTER (WHERE review_status = 'dismissed')::int AS dismissed,
      COUNT(*) FILTER (WHERE review_status = 'ignored' OR ignored = TRUE)::int AS ignored
    FROM teller_transactions
  `);

  return (
    result.rows[0] || {
      total: 0,
      pending: 0,
      matched: 0,
      created: 0,
      dismissed: 0,
      ignored: 0,
    }
  );
}

module.exports = {
  listTellerTransactions,
  listIgnoredVendorGroups,
  getIgnoredVendorGroupDetails,
  getTellerTransactionById,
  getTellerSummary,
};