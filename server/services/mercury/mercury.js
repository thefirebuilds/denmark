const dotenv = require("dotenv");
const path = require("path");
const axios = require("axios");

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const pool = require("../../db");

const API = "https://api.mercury.com/api/v1";

function getApiKey() {
  return String(
    process.env.MERCURY_API_KEY || process.env.MERUCRY_API_KEY || ""
  ).trim();
}

function isConfigured() {
  return Boolean(getApiKey());
}

function getConfigSummary() {
  return {
    configured: isConfigured(),
    envKey: process.env.MERCURY_API_KEY
      ? "MERCURY_API_KEY"
      : process.env.MERUCRY_API_KEY
        ? "MERUCRY_API_KEY"
        : null,
  };
}

function getClient() {
  const token = getApiKey();

  if (!token) {
    const err = new Error("Missing MERCURY_API_KEY in project .env");
    err.status = 400;
    throw err;
  }

  return axios.create({
    baseURL: API,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    timeout: 60000,
    proxy: false,
  });
}

function getTransactionDate(tx) {
  return (
    tx.postedAt ||
    tx.posted_at ||
    tx.createdAt ||
    tx.created_at ||
    tx.date ||
    tx.canonicalDay ||
    tx.canonical_day ||
    null
  );
}

function toDateOnly(value) {
  if (!value) return null;

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
}

function getDescription(tx) {
  return (
    tx.note ||
    tx.description ||
    tx.bankDescription ||
    tx.bank_description ||
    tx.counterpartyName ||
    tx.counterparty_name ||
    tx.counterpartyNickname ||
    tx.counterparty_nickname ||
    tx.type ||
    "Mercury transaction"
  );
}

function getCounterpartyName(tx) {
  return (
    tx.counterpartyName ||
    tx.counterparty_name ||
    tx.counterpartyNickname ||
    tx.counterparty_nickname ||
    tx.bankDescription ||
    tx.bank_description ||
    null
  );
}

function getAccountId(tx) {
  return (
    tx.accountId ||
    tx.account_id ||
    tx.sourceAccountId ||
    tx.source_account_id ||
    tx.treasuryId ||
    tx.treasury_id ||
    "mercury"
  );
}

function getAmount(tx) {
  const value =
    tx.amount ??
    tx.amountInDollars ??
    tx.amount_in_dollars ??
    tx.dollarAmount ??
    tx.dollar_amount;
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    const err = new Error(`Mercury transaction ${tx.id || "unknown"} has no valid amount`);
    err.status = 502;
    throw err;
  }

  return amount;
}

function getBalanceAmount(account, keys) {
  for (const key of keys) {
    const value = account?.[key];
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }

  return null;
}

async function fetchAccounts() {
  const client = getClient();
  const res = await client.get("/accounts");
  const payload = res.data || {};

  return Array.isArray(payload)
    ? payload
    : payload.accounts || payload.data || [];
}

async function getBalanceSummary() {
  if (!isConfigured()) {
    return {
      configured: false,
      accounts: [],
      currentBalance: null,
      availableBalance: null,
    };
  }

  const accounts = await fetchAccounts();
  const normalizedAccounts = accounts.map((account) => {
    const currentBalance = getBalanceAmount(account, [
      "currentBalance",
      "current_balance",
      "balance",
    ]);
    const availableBalance = getBalanceAmount(account, [
      "availableBalance",
      "available_balance",
      "available",
    ]);

    return {
      id: account.id || account.accountId || null,
      name: account.name || account.nickname || account.accountName || "Mercury",
      kind: account.kind || account.type || null,
      currentBalance,
      availableBalance,
    };
  });
  const totalCurrent = normalizedAccounts.reduce(
    (sum, account) => sum + Number(account.currentBalance || 0),
    0
  );
  const totalAvailable = normalizedAccounts.reduce(
    (sum, account) => sum + Number(account.availableBalance || 0),
    0
  );

  return {
    configured: true,
    accounts: normalizedAccounts,
    currentBalance: totalCurrent,
    availableBalance: totalAvailable,
    accountCount: normalizedAccounts.length,
    fetchedAt: new Date().toISOString(),
  };
}

async function getIgnoreRules() {
  const result = await pool.query(`
    SELECT match_type, match_value, reason
    FROM teller_ignore_rules
    WHERE is_active = TRUE
  `);

  return result.rows;
}

function getIgnoreMatch(description, rules) {
  const text = String(description || "").trim();

  for (const rule of rules) {
    const value = String(rule.match_value || "").trim();

    if (
      rule.match_type === "exact" &&
      text.toLowerCase() === value.toLowerCase()
    ) {
      return rule.reason || "Ignored by exact match rule";
    }

    if (
      rule.match_type === "contains" &&
      text.toLowerCase().includes(value.toLowerCase())
    ) {
      return rule.reason || "Ignored by contains match rule";
    }
  }

  return null;
}

async function fetchTransactions({ start, end, limit = 1000, maxPages = 20 } = {}) {
  const client = getClient();
  const transactions = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const params = {
      limit,
      order: "desc",
    };

    if (start) params.start = start;
    if (end) params.end = end;
    if (cursor != null) params.cursor = cursor;

    const res = await client.get("/transactions", { params });
    const payload = res.data || {};
    const rows = Array.isArray(payload)
      ? payload
      : payload.transactions || payload.data || [];

    transactions.push(...rows);

    cursor = payload.cursor ?? payload.nextCursor ?? payload.next_cursor ?? null;
    if (!cursor || rows.length === 0) break;
  }

  return transactions;
}

async function saveTransaction(tx, ignoreRules) {
  const sourceId = tx.id || tx.transactionId || tx.transaction_id;

  if (!sourceId) {
    return false;
  }

  const transactionDate = toDateOnly(getTransactionDate(tx));

  if (!transactionDate) {
    return false;
  }

  const description = getDescription(tx);
  const ignoreReason = getIgnoreMatch(description, ignoreRules);
  const ignored = Boolean(ignoreReason);
  const accountId = getAccountId(tx);

  await pool.query(
    `
    INSERT INTO teller_transactions (
      teller_transaction_id,
      teller_account_id,
      transaction_date,
      description,
      amount,
      transaction_type,
      status,
      running_balance,
      processing_status,
      counterparty_name,
      category,
      account_link,
      self_link,
      raw_json,
      ignored,
      ignore_reason,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16, NOW()
    )
    ON CONFLICT (teller_transaction_id)
    DO UPDATE SET
      teller_account_id = EXCLUDED.teller_account_id,
      transaction_date = EXCLUDED.transaction_date,
      description = EXCLUDED.description,
      amount = EXCLUDED.amount,
      transaction_type = EXCLUDED.transaction_type,
      status = EXCLUDED.status,
      running_balance = EXCLUDED.running_balance,
      processing_status = EXCLUDED.processing_status,
      counterparty_name = EXCLUDED.counterparty_name,
      category = EXCLUDED.category,
      account_link = EXCLUDED.account_link,
      self_link = EXCLUDED.self_link,
      raw_json = EXCLUDED.raw_json,
      ignored = EXCLUDED.ignored,
      ignore_reason = EXCLUDED.ignore_reason,
      updated_at = NOW()
    `,
    [
      `mercury:${sourceId}`,
      `mercury:${accountId}`,
      transactionDate,
      description || null,
      getAmount(tx),
      tx.kind || tx.type || tx.transactionType || null,
      tx.status || null,
      tx.balance != null ? Number(tx.balance) : null,
      tx.processingStatus || tx.processing_status || null,
      getCounterpartyName(tx),
      tx.category || tx.mercuryCategory || tx.mercury_category || null,
      accountId ? `mercury:${accountId}` : null,
      tx.dashboardLink || tx.dashboard_link || null,
      JSON.stringify({ source: "mercury", ...tx }),
      ignored,
      ignoreReason,
    ]
  );

  return true;
}

async function syncMercuryTransactions(options = {}) {
  if (!isConfigured()) {
    const err = new Error("Missing MERCURY_API_KEY in project .env");
    err.status = 400;
    throw err;
  }

  console.log("[mercury] syncing transactions");

  const ignoreRules = await getIgnoreRules();
  const transactions = await fetchTransactions(options);
  let processed = 0;
  let skipped = 0;

  for (const tx of transactions) {
    const saved = await saveTransaction(tx, ignoreRules);
    if (saved) {
      processed += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(
    `[mercury] sync done | seen=${transactions.length} processed=${processed} skipped=${skipped}`
  );

  return {
    source: "mercury",
    seen: transactions.length,
    processed,
    skipped,
  };
}

module.exports = syncMercuryTransactions;
module.exports.getConfigSummary = getConfigSummary;
module.exports.getBalanceSummary = getBalanceSummary;
