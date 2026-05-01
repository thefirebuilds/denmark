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

function parseLastFourFromText(value) {
  const match = String(value || "").match(/(?:^|[^0-9])([0-9]{4})(?:[^0-9]|$)/);
  return match?.[1] || null;
}

async function loadTellerAccountMetadataMap() {
  const result = await pool.query(`
    SELECT DISTINCT ON (raw_json->'account'->>'id')
      raw_json->'account' AS account
    FROM teller_transactions
    WHERE raw_json->>'source' = 'teller'
      AND raw_json->'account'->>'id' IS NOT NULL
    ORDER BY raw_json->'account'->>'id', updated_at DESC
  `);

  return new Map(
    result.rows
      .map((row) => row.account)
      .filter((account) => account?.id)
      .map((account) => [String(account.id), account])
  );
}

function getTransactionSourceFields(row, accountById = new Map()) {
  const raw = row?.raw_json && typeof row.raw_json === "object" ? row.raw_json : {};
  const txId = String(row?.teller_transaction_id || "");
  const accountId = String(row?.teller_account_id || "");
  const rawSource = String(raw.source || "").trim().toLowerCase();
  const account =
    raw.account || raw.source_account || accountById.get(accountId) || {};
  const institution =
    account.institution?.name ||
    account.institution_name ||
    raw.institution?.name ||
    raw.institution_name ||
    null;
  const accountName = account.name || raw.account_name || null;
  const lastFour =
    account.last_four ||
    account.last4 ||
    account.mask ||
    raw.last_four ||
    raw.last4 ||
    parseLastFourFromText(accountName);

  if (txId.startsWith("mercury:") || accountId.startsWith("mercury:") || rawSource === "mercury") {
    return {
      transaction_source: "mercury",
      transaction_source_label: "Mercury",
      source_account_label: lastFour ? `Mercury ****${lastFour}` : "Mercury",
      source_account_last_four: lastFour || null,
    };
  }

  const sourceLabel = institution || (rawSource === "teller" ? "Teller" : "Teller");
  const accountLabel = accountName
    ? lastFour
      ? `${accountName.replace(/\s+-\s+[0-9]{4}\s*$/, "")} ****${lastFour}`
      : accountName
    : lastFour
      ? `${sourceLabel} ****${lastFour}`
      : sourceLabel;

  return {
    transaction_source: "teller",
    transaction_source_label: sourceLabel,
    source_account_label: accountLabel,
    source_account_last_four: lastFour || null,
  };
}

function hydrateTransactionRow(row, accountById = new Map()) {
  if (!row) return row;

  return {
    ...row,
    ...getTransactionSourceFields(row, accountById),
  };
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

  const accountById = await loadTellerAccountMetadataMap();

  return {
    vendor_key: vendorKey,
    transactions: result.rows.map((row) => hydrateTransactionRow(row, accountById)),
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

  const accountById = await loadTellerAccountMetadataMap();
  const rows = rowsResult.rows.map((row) => hydrateTransactionRow(row, accountById));

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
     AND ABS((COALESCE(e.price, 0) + COALESCE(e.tax, 0)) - ABS(tt.amount::numeric)) <= 1.00
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

  const accountById = await loadTellerAccountMetadataMap();
  return hydrateTransactionRow(result.rows[0] || null, accountById);
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
