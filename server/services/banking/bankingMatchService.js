// ------------------------------------------------------------
// /server/services/banking/bankingMatchService.js
// This service provides functions to generate matching suggestions between Banking transactions and existing expenses,
// perform the matching action, create new expenses from Banking transactions, and manage the review status of Banking transactions.
// It uses a heuristic scoring system to evaluate how well a Banking transaction matches an expense
// based on amount, date, and text similarity.
//
// The main functions include:
// - getBankingSuggestions: Given a Banking transaction ID, returns a list of potential matching expenses with confidence scores.
// - matchBankingTransaction: Manually matches a Banking transaction to an expense and updates the review status.
// - createBankingIgnoreRule: Creates a rule to ignore Banking transactions based on certain criteria.
// - ignoreBankingTransaction: Marks a Banking transaction as ignored, optionally creating an ignore rule.
// - dismissBankingTransaction: Marks a Banking transaction as dismissed after review.
// ------------------------------------------------------------

const pool = require("../../db");
const { createExpense } = require("../expenses/expenseService");

const REFUND_SIGNAL_PATTERNS = [
  /\brefund\b/i,
  /\brefunded\b/i,
  /\breturn\b/i,
  /\breturned\b/i,
  /\bcredit\b/i,
  /\breimbursement\b/i,
  /\breimbursed\b/i,
  /\bauth(?:orization)? refund\b/i,
];

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectRefundSignal(...values) {
  const haystack = values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  if (!haystack) {
    return { detected: false, reason: "" };
  }

  const match = REFUND_SIGNAL_PATTERNS.find((pattern) => pattern.test(haystack));
  return {
    detected: Boolean(match),
    reason: match ? `Matched refund signal: ${match}` : "",
  };
}

function getKeywordCandidates(value = "") {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word.length >= 3)
    .slice(0, 5);
}

async function getCategorySuggestionsForTransaction(tx) {
  const keywords = getKeywordCandidates(
    `${tx.counterparty_name || ""} ${tx.description || ""}`
  );

  if (!keywords.length) return [];

  const likeClauses = [];
  const values = [];

  keywords.forEach((word, index) => {
    const param = `$${index + 1}`;
    likeClauses.push(`
      LOWER(COALESCE(vendor, '')) LIKE ${param}
      OR LOWER(COALESCE(notes, '')) LIKE ${param}
    `);
    values.push(`%${word}%`);
  });

  const sql = `
    SELECT
      category,
      COUNT(*)::int AS usage_count
    FROM expenses
    WHERE category IS NOT NULL
      AND (${likeClauses.join(" OR ")})
    GROUP BY category
    ORDER BY usage_count DESC, category ASC
    LIMIT 5
  `;

  const result = await pool.query(sql, values);

  const topCount = Number(result.rows[0]?.usage_count || 0);

  return result.rows.map((row) => {
    const usageCount = Number(row.usage_count || 0);

    return {
      category: row.category,
      usage_count: usageCount,
      confidence:
        topCount > 0
          ? Math.max(1, Math.round((usageCount / topCount) * 100))
          : 0,
    };
  });
}

function toExpenseDate(value) {
  if (!value) return null;

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
}

function cleanOptionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function amountDiff(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0));
}

function scoreSuggestion(tx, expense) {
  let score = 0;
  const reasons = [];

  const txAmount = Math.abs(Number(tx.amount || 0));
  const expenseTotal = Math.abs(Number(expense.total_cost || 0));

  if (amountDiff(txAmount, expenseTotal) < 0.01) {
    score += 60;
    reasons.push("Exact amount match");
  } else if (amountDiff(txAmount, expenseTotal) <= 1.0) {
    score += 25;
    reasons.push("Close amount match");
  }

  if (tx.transaction_date && expense.date) {
    const txDate = new Date(tx.transaction_date);
    const expenseDate = new Date(expense.date);
    const dayDiff = Math.abs(
      Math.round((txDate.getTime() - expenseDate.getTime()) / (1000 * 60 * 60 * 24))
    );

    if (dayDiff === 0) {
      score += 25;
      reasons.push("Same date");
    } else if (dayDiff <= 1) {
      score += 15;
      reasons.push("Within 1 day");
    } else if (dayDiff <= 3) {
      score += 8;
      reasons.push("Within 3 days");
    } else if (dayDiff <= 7) {
      score += 5;
      reasons.push("Within 7 days");
    } else if (dayDiff <= 30) {
      score += 2;
      reasons.push("Within 30 days");
    }
  }

  const txText = normalizeText(tx.description);
  const vendorText = normalizeText(expense.vendor);
  const notesText = normalizeText(expense.notes);

  if (txText && notesText && txText === notesText) {
    score += 40;
    reasons.push("Exact description/notes match");
  } else if (
    txText &&
    notesText &&
    (notesText.includes(txText) || txText.includes(notesText))
  ) {
    score += 20;
    reasons.push("Description similar to notes");
  }

  if (txText && vendorText) {
    const txWords = txText.split(" ").filter(Boolean);
    const vendorWords = vendorText.split(" ").filter(Boolean);
    const shared = txWords.filter((word) => vendorWords.includes(word));

    if (shared.length >= 1) {
      score += 10;
      reasons.push("Vendor resembles description");
    }
  }

  return {
    score,
    confidence: score,
    reason: reasons.join(", ") || "Weak heuristic match",
  };
}

async function createBankingIgnoreRule(payload = {}) {
  const matchType = payload.match_type === "contains" ? "contains" : "exact";
  const matchValue = String(payload.match_value || "").trim();
  const reason = payload.reason || "Ignored manually";

  if (!matchValue) {
    const err = new Error("match_value is required");
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ruleResult = await client.query(
      `
      INSERT INTO banking_ignore_rules (match_type, match_value, reason, is_active)
      VALUES ($1, $2, $3, TRUE)
      RETURNING *
      `,
      [matchType, matchValue, reason]
    );

    await client.query(
      `
      UPDATE banking_transactions
      SET
        ignored = TRUE,
        ignore_reason = $3,
        review_status = 'ignored',
        reviewed_at = NOW(),
        updated_at = NOW()
      WHERE
        ($1 = 'exact' AND COALESCE(description, '') = $2)
        OR
        ($1 = 'contains' AND (
          COALESCE(description, '') ILIKE '%' || $2 || '%'
          OR COALESCE(counterparty_name, '') ILIKE '%' || $2 || '%'
        ))
      `,
      [matchType, matchValue, reason]
    );

    await client.query("COMMIT");
    return ruleResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getBankingTransactionRow(id) {
  const result = await pool.query(
    `
    SELECT
      tt.id,
      tt.provider_transaction_id,
      tt.provider_account_id,
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
    FROM banking_transactions tt
    WHERE tt.id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function getExpenseRow(id) {
  const result = await pool.query(
    `
    SELECT
      e.id,
      e.vehicle_id,
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
    FROM expenses e
    WHERE e.id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function getBankingSuggestions(id) {
  const tx = await getBankingTransactionRow(id);

  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const amount = Number(tx.amount || 0);
  const txDate = tx.transaction_date;

  const result = await pool.query(
    `
    SELECT
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
      e.trip_id,
      linked_tx.id AS linked_banking_transaction_id,
      linked_tx.transaction_date AS linked_transaction_date,
      linked_tx.description AS linked_transaction_description
    FROM expenses e
    LEFT JOIN vehicles v
      ON v.id = e.vehicle_id
    LEFT JOIN LATERAL (
      SELECT bt.id,bt.transaction_date,bt.description
      FROM banking_transactions bt
      WHERE bt.matched_expense_id=e.id AND bt.id<>$3
      ORDER BY bt.reviewed_at DESC NULLS LAST,bt.id DESC
      LIMIT 1
    ) linked_tx ON TRUE
    WHERE e.date BETWEEN ($1::date - INTERVAL '30 days') AND ($1::date + INTERVAL '30 days')
      AND (
        ABS(ABS(COALESCE(e.price,0)+COALESCE(e.tax,0))-ABS($2::numeric)) < 0.01
        OR (
          e.date BETWEEN ($1::date - INTERVAL '7 days') AND ($1::date + INTERVAL '7 days')
          AND ABS(ABS(COALESCE(e.price,0)+COALESCE(e.tax,0))-ABS($2::numeric))
            <= GREATEST(1.00,LEAST(10.00,ABS($2::numeric)*0.05))
        )
      )
    ORDER BY
      ABS(ABS(COALESCE(e.price,0)+COALESCE(e.tax,0))-ABS($2::numeric)) ASC,
      ABS(EXTRACT(EPOCH FROM (e.date::timestamp - $1::timestamp))) ASC
    LIMIT 15
    `,
    [txDate, amount, id]
  );

  const suggestions = result.rows
    .map((expense) => {
      const match = scoreSuggestion(tx, expense);
      const numericScore = Math.round(Number(match.score || 0));

      return {
        expense_id: expense.id,
        score: numericScore,
        confidence: numericScore,
        reason: match.reason,
        amount_difference: Math.abs(
          Math.abs(Number(expense.total_cost || 0)) - Math.abs(amount)
        ),
        day_difference: Math.abs(
          Math.round(
            (new Date(txDate).getTime() - new Date(expense.date).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        ),
        already_linked: Boolean(expense.linked_banking_transaction_id),
        expense,
      };
    })
    .sort((a, b) => {
      if (a.day_difference !== b.day_difference) {
        return a.day_difference - b.day_difference;
      }
      if (a.amount_difference !== b.amount_difference) {
        return a.amount_difference - b.amount_difference;
      }
      return b.score - a.score;
    });

  return suggestions;
}

async function matchBankingTransaction(id, expenseId, options = {}) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const expense = await getExpenseRow(expenseId);
  if (!expense) {
    const err = new Error("Expense not found");
    err.status = 404;
    throw err;
  }

  const existingLink = await pool.query(`SELECT id
    FROM banking_transactions
    WHERE matched_expense_id=$1 AND id<>$2
    LIMIT 1`, [expenseId, id]);
  if (existingLink.rowCount) {
    const err = new Error("This expense is already matched to another imported transaction");
    err.status = 409;
    throw err;
  }

  const match = scoreSuggestion(tx, expense);

  const result = await pool.query(
    `
    UPDATE banking_transactions
    SET
      matched_expense_id = $2,
      review_status = 'matched',
      match_confidence = $3,
      match_method = $4,
      reviewed_at = NOW(),
      review_notes = $5,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [
      id,
      expenseId,
      match.score,
      options.match_method || "manual",
      options.review_notes || null,
    ]
  );

  return result.rows[0];
}

async function dismissBankingTransaction(id, payload = {}) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const result = await pool.query(
    `
    UPDATE banking_transactions
    SET
      review_status = 'dismissed',
      reviewed_at = NOW(),
      review_notes = $2,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [id, payload.review_notes || null]
  );

  return result.rows[0];
}

async function ignoreBankingTransaction(id, payload = {}) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let ignoreReason = payload.reason || "Ignored manually";
    let createdRule = null;

    if (payload.create_rule === true) {
      const matchType = payload.match_type === "contains" ? "contains" : "exact";
      const matchValue =
        String(payload.match_value || tx.description || "").trim();

      if (!matchValue) {
        const err = new Error("match_value is required when create_rule is true");
        err.status = 400;
        throw err;
      }

      const ruleResult = await client.query(
        `
        INSERT INTO banking_ignore_rules (match_type, match_value, reason, is_active)
        VALUES ($1, $2, $3, TRUE)
        RETURNING *
        `,
        [matchType, matchValue, ignoreReason]
      );

      createdRule = ruleResult.rows[0];

      await client.query(
        `
        UPDATE banking_transactions
        SET
          ignored = TRUE,
          ignore_reason = $2,
          review_status = 'ignored',
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE
          ($3 = 'exact' AND COALESCE(description, '') = $4)
          OR
          ($3 = 'contains' AND COALESCE(description, '') ILIKE '%' || $4 || '%')
        `,
        [id, ignoreReason, matchType, matchValue]
      );
    } else {
      await client.query(
        `
        UPDATE banking_transactions
        SET
          ignored = TRUE,
          ignore_reason = $2,
          review_status = 'ignored',
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        `,
        [id, ignoreReason]
      );
    }

    const finalResult = await client.query(
      `SELECT * FROM banking_transactions WHERE id = $1 LIMIT 1`,
      [id]
    );

    await client.query("COMMIT");

    return {
      transaction: finalResult.rows[0] || null,
      created_rule: createdRule,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createExpenseFromBanking(id, payload = {}) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const amount = Math.abs(Number(tx.amount || 0));
  const absoluteAmount = Math.abs(amount);
  const refundSignal = detectRefundSignal(
    payload.vendor,
    payload.notes,
    tx.counterparty_name,
    tx.description
  );
  const requestedPrice =
    payload.price == null || payload.price === ""
      ? absoluteAmount
      : Number(payload.price);
  const finalPrice =
    refundSignal.detected && Number.isFinite(requestedPrice) && requestedPrice > 0
      ? -Math.abs(requestedPrice)
      : requestedPrice;
  const requestedTax =
    payload.tax == null || payload.tax === "" ? 0 : Number(payload.tax);
  const finalTax =
    refundSignal.detected && Number.isFinite(requestedTax) && requestedTax > 0
      ? -Math.abs(requestedTax)
      : requestedTax;

  const expensePayload = {
    vehicle_id: payload.vehicle_id ?? null,
    vendor: payload.vendor ?? tx.counterparty_name ?? null,
    price: finalPrice,
    tax: finalTax,
    is_capitalized: payload.is_capitalized ?? false,
    category: payload.category ?? null,
    notes: payload.notes ?? tx.description ?? null,
    date: toExpenseDate(payload.date ?? tx.transaction_date),
    expense_scope: payload.expense_scope ?? (payload.vehicle_id ? "direct" : "shared"),
    trip_id: payload.trip_id ?? null,
  };

  const createdExpense = await createExpense(expensePayload);

  const result = await pool.query(
    `
    UPDATE banking_transactions
    SET
      matched_expense_id = $2,
      review_status = 'created',
      match_confidence = $3,
      match_method = $4,
      reviewed_at = NOW(),
      review_notes = $5,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [
      id,
      createdExpense.id,
      100,
      payload.match_method || "created_from_banking",
      payload.review_notes || null,
    ]
  );

  return {
    banking_transaction: result.rows[0],
    expense: createdExpense,
  };
}

async function getIncomeDraftForBanking(id) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const amount = Number(tx.amount || 0);
  const txDate = toExpenseDate(tx.transaction_date);

  return {
    transaction_id: tx.id,
    amount,
    income_date: txDate,
    payer: tx.counterparty_name || "Turo",
    notes: tx.description || null,
  };
}

async function createIncomeFromBanking(id, payload = {}) {
  const tx = await getBankingTransactionRow(id);
  if (!tx) {
    const err = new Error("Banking transaction not found");
    err.status = 404;
    throw err;
  }

  const amount = Number(payload.amount ?? tx.amount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error("Income amount must be a positive number");
    err.status = 400;
    throw err;
  }

  const incomeDate = toExpenseDate(payload.income_date ?? tx.transaction_date);
  if (!incomeDate) {
    const err = new Error("Income date is required");
    err.status = 400;
    throw err;
  }

  const tripId =
    payload.trip_id === "" || payload.trip_id == null ? null : Number(payload.trip_id);
  if (tripId != null && (!Number.isInteger(tripId) || tripId <= 0)) {
    const err = new Error("trip_id must be a valid trip id");
    err.status = 400;
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let expectedTripAmount = null;
    if (tripId != null) {
      const tripResult = await client.query(
        `SELECT amount FROM trips WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tripId]
      );

      if (!tripResult.rows[0]) {
        const err = new Error("Trip not found");
        err.status = 404;
        throw err;
      }

      expectedTripAmount =
        tripResult.rows[0].amount == null ? null : Number(tripResult.rows[0].amount);
    }

    const variance =
      expectedTripAmount == null ? null : Number(amount) - Number(expectedTripAmount);

    const incomeResult = await client.query(
      `
      INSERT INTO income_transactions (
        banking_transaction_row_id,
        trip_id,
        source,
        income_type,
        payer,
        amount,
        income_date,
        expected_trip_amount,
        variance,
        notes,
        raw_json,
        updated_at
      )
      VALUES (
        $1, $2, 'bank_import', $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW()
      )
      ON CONFLICT (banking_transaction_row_id)
      DO UPDATE SET
        trip_id = EXCLUDED.trip_id,
        income_type = EXCLUDED.income_type,
        payer = EXCLUDED.payer,
        amount = EXCLUDED.amount,
        income_date = EXCLUDED.income_date,
        expected_trip_amount = EXCLUDED.expected_trip_amount,
        variance = EXCLUDED.variance,
        notes = EXCLUDED.notes,
        raw_json = EXCLUDED.raw_json,
        updated_at = NOW()
      RETURNING *
      `,
      [
        tx.id,
        tripId,
        cleanOptionalText(payload.income_type) || "turo_payout",
        cleanOptionalText(payload.payer) || tx.counterparty_name || "Turo",
        amount,
        incomeDate,
        expectedTripAmount,
        variance,
        cleanOptionalText(payload.notes) || tx.description || null,
        JSON.stringify({
          banking_transaction: tx,
          payload,
        }),
      ]
    );

    const txResult = await client.query(
      `
      UPDATE banking_transactions
      SET
        review_status = 'created',
        matched_expense_id = NULL,
        match_confidence = 100,
        match_method = 'created_income',
        reviewed_at = NOW(),
        review_notes = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        tripId
          ? `Created income transaction linked to trip ${tripId}`
          : "Created income transaction",
      ]
    );

    await client.query("COMMIT");

    return {
      income: incomeResult.rows[0],
      banking_transaction: txResult.rows[0],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getBankingSuggestions,
  matchBankingTransaction,
  createExpenseFromBanking,
  dismissBankingTransaction,
  ignoreBankingTransaction,
  createBankingIgnoreRule,
  getCategorySuggestionsForTransaction,
  getIncomeDraftForBanking,
  createIncomeFromBanking,
  scoreSuggestion,
  detectRefundSignal,
};
