const dotenv = require("dotenv");
const path = require("path");
const axios = require("axios");
const https = require("https");
const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");
const { getRuntimeSecret } = require("../../config/runtimeSecrets");

// ------------------------------------------------------------
// /server/services/teller/teller.js
// Teller service for:
// - loading the latest Teller access token from the database
// - fetching Teller accounts
// - fetching transactions for each account
// - deduping and storing transactions in teller_transactions
// - applying ignore rules from teller_ignore_rules
// ------------------------------------------------------------

dotenv.config({
  path: path.resolve(__dirname, "../../../.env"),
});

const certBase64 = getRuntimeSecret("TELLER_CERT_BASE64");
const keyBase64 = getRuntimeSecret("TELLER_KEY_BASE64");

if (!certBase64) {
  throw new Error("Missing TELLER_CERT_BASE64 in project .env");
}

if (!keyBase64) {
  throw new Error("Missing TELLER_KEY_BASE64 in project .env");
}

const cert = Buffer.from(certBase64, "base64").toString("utf8");
const key = Buffer.from(keyBase64, "base64").toString("utf8");

const agent = new https.Agent({
  cert,
  key,
});

const API = "https://api.teller.io";
let ensureTellerTokenSecretColumnsPromise = null;

async function ensureTellerTokenSecretColumns() {
  if (!ensureTellerTokenSecretColumnsPromise) {
    ensureTellerTokenSecretColumnsPromise = pool.query(`
      ALTER TABLE teller_tokens
        ADD COLUMN IF NOT EXISTS access_token_encrypted text,
        ALTER COLUMN access_token DROP NOT NULL
    `);
  }

  return ensureTellerTokenSecretColumnsPromise;
}

function hydrateTellerToken(row) {
  if (!row) return null;
  return {
    ...row,
    access_token: row.access_token || (row.access_token_encrypted ? decrypt(row.access_token_encrypted) : ""),
  };
}

async function migrateTellerTokenIfNeeded(row) {
  if (!row?.access_token || row.access_token_encrypted) return row;

  const encrypted = encrypt(row.access_token);
  await pool.query(
    `
      UPDATE teller_tokens
      SET access_token = NULL,
          access_token_encrypted = $2
      WHERE id = $1
    `,
    [row.id, encrypted]
  );
  return {
    ...row,
    access_token: null,
    access_token_encrypted: encrypted,
  };
}

async function getAccessTokens() {
  await ensureTellerTokenSecretColumns();
  const result = await pool.query(
    "SELECT id, access_token, access_token_encrypted, created_at FROM teller_tokens ORDER BY id ASC"
  );
  const rows = [];
  for (const row of result.rows) {
    rows.push(hydrateTellerToken(await migrateTellerTokenIfNeeded(row)));
  }
  return rows.filter((row) => row.access_token);
}

async function getTokenSummary() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::integer AS token_count,
      MAX(created_at) AS latest_connected_at
    FROM teller_tokens
  `);

  return result.rows[0] || { token_count: 0, latest_connected_at: null };
}

async function saveAccessToken(accessToken) {
  await ensureTellerTokenSecretColumns();
  const token = String(accessToken || "").trim();

  if (!token) {
    const err = new Error("Teller access token is required");
    err.status = 400;
    throw err;
  }

  const existingTokens = await getAccessTokens();
  const existing = existingTokens.find((row) => row.access_token === token);
  if (existing) {
    return {
      created: false,
      token: { id: existing.id, created_at: existing.created_at || null },
    };
  }

  const result = await pool.query(
    `
      INSERT INTO teller_tokens (access_token, access_token_encrypted)
      VALUES (NULL, $1)
      RETURNING id, created_at
    `,
    [encrypt(token)]
  );

  return { created: true, token: result.rows[0] || null };
}

async function getAccounts(token) {
  const res = await axios.get(`${API}/accounts`, {
    httpsAgent: agent,
    auth: { username: token, password: "" },
  });

  return res.data || [];
}

async function getTransactions(token, accountId) {
  const res = await axios.get(`${API}/accounts/${accountId}/transactions`, {
    httpsAgent: agent,
    auth: { username: token, password: "" },
  });

  return res.data || [];
}

function normalizeAccount(account) {
  if (!account) return null;

  return {
    id: account.id || null,
    name: account.name || null,
    type: account.type || null,
    subtype: account.subtype || null,
    institution: account.institution
      ? {
          id: account.institution.id || null,
          name: account.institution.name || null,
        }
      : null,
    last_four:
      account.last_four ||
      account.last4 ||
      account.mask ||
      account.number_last_four ||
      null,
  };
}

function getAccountBalanceAmount(account, keys) {
  for (const key of keys) {
    const value = key
      .split(".")
      .reduce((current, part) => (current == null ? null : current[part]), account);
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }

  return null;
}

function accountMatchesCiti4483(account) {
  const normalized = normalizeAccount(account);
  const lastFour = String(normalized?.last_four || "").trim();
  if (lastFour !== "4483") return false;

  const institution = String(normalized?.institution?.name || "").toLowerCase();
  const name = String(normalized?.name || "").toLowerCase();
  const type = String(normalized?.type || "").toLowerCase();
  const subtype = String(normalized?.subtype || "").toLowerCase();

  return (
    institution.includes("citi") ||
    name.includes("citi") ||
    type === "credit" ||
    subtype === "credit_card"
  );
}

async function getCiti4483BalanceSummary() {
  const tokens = await getAccessTokens();

  if (!tokens.length) {
    return {
      configured: false,
      found: false,
      lastFour: "4483",
      currentBalance: null,
      availableBalance: null,
      debtBalance: null,
      account: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  for (const tokenRow of tokens) {
    const accounts = await getAccounts(tokenRow.access_token);
    const account = accounts.find(accountMatchesCiti4483);
    if (!account) continue;

    const currentBalance = getAccountBalanceAmount(account, [
      "balances.current",
      "balances.ledger",
      "balances.available",
      "balance.current",
      "balance.ledger",
      "current_balance",
      "ledger_balance",
      "balance",
    ]);
    const availableBalance = getAccountBalanceAmount(account, [
      "balances.available",
      "balance.available",
      "available_balance",
      "credit.available",
    ]);
    const debtBalance =
      currentBalance == null ? null : Math.abs(Number(currentBalance));

    return {
      configured: true,
      found: true,
      lastFour: "4483",
      currentBalance,
      availableBalance,
      debtBalance,
      account: normalizeAccount(account),
      fetchedAt: new Date().toISOString(),
    };
  }

  return {
    configured: true,
    found: false,
    lastFour: "4483",
    currentBalance: null,
    availableBalance: null,
    debtBalance: null,
    account: null,
    fetchedAt: new Date().toISOString(),
  };
}

function getNormalizedAmount(tx, account = null) {
  const amount = Number(tx.amount);
  if (!Number.isFinite(amount)) return amount;

  const isCreditCard =
    account?.type === "credit" || account?.subtype === "credit_card";
  const txType = String(tx.type || "").toLowerCase();
  const isCharge = ["card_payment", "transaction"].includes(txType);

  if (isCreditCard && isCharge && amount > 0) {
    return -amount;
  }

  return amount;
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

async function saveTransaction(tx, ignoreRules, account = null) {
  const ignoreReason = getIgnoreMatch(tx.description, ignoreRules);
  const ignored = Boolean(ignoreReason);
  const rawJson = {
    source: "teller",
    account: normalizeAccount(account),
    ...tx,
  };

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
      tx.id,
      tx.account_id,
      tx.date,
      tx.description || null,
      getNormalizedAmount(tx, account),
      tx.type || null,
      tx.status || null,
      tx.running_balance != null ? Number(tx.running_balance) : null,
      tx.details?.processing_status || null,
      tx.details?.counterparty?.name || null,
      tx.details?.category || null,
      tx.links?.account || null,
      tx.links?.self || null,
      JSON.stringify(rawJson),
      ignored,
      ignoreReason,
    ]
  );
}

async function syncTransactionsForAccount(account, token, ignoreRules) {
  const accountId = account?.id || account;
  const transactions = await getTransactions(token, accountId);

  for (const tx of transactions) {
    await saveTransaction(tx, ignoreRules, account);
  }

  return transactions.length;
}

async function syncTellerTransactions() {
  console.log("[teller] fetching tokens");
  const tokens = await getAccessTokens();

  if (!tokens.length) {
    throw new Error("No Teller token found");
  }

  const ignoreRules = await getIgnoreRules();
  let totalProcessed = 0;
  let totalAccounts = 0;

  for (const tokenRow of tokens) {
    console.log(`[teller] fetching accounts token=${tokenRow.id}`);
    const accounts = await getAccounts(tokenRow.access_token);

    if (!accounts.length) {
      console.warn(`[teller] no accounts returned token=${tokenRow.id}`);
      continue;
    }

    totalAccounts += accounts.length;

    for (const account of accounts) {
      console.log(`[teller] syncing account=${account.id}`);
      const count = await syncTransactionsForAccount(
        account,
        tokenRow.access_token,
        ignoreRules
      );
      totalProcessed += count;
    }
  }

  console.log(
    `[teller] sync done | tokens=${tokens.length} accounts=${totalAccounts} processed=${totalProcessed}`
  );
  return { processed: totalProcessed, tokens: tokens.length, accounts: totalAccounts };
}

module.exports = syncTellerTransactions;
module.exports.saveAccessToken = saveAccessToken;
module.exports.getTokenSummary = getTokenSummary;
module.exports.getCiti4483BalanceSummary = getCiti4483BalanceSummary;
