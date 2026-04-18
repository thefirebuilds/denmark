const dotenv = require("dotenv");
const path = require("path");
const axios = require("axios");
const https = require("https");
const pool = require("../../db");

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

const certBase64 = process.env.TELLER_CERT_BASE64?.trim();
const keyBase64 = process.env.TELLER_KEY_BASE64?.trim();

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

async function getAccessToken() {
  const result = await pool.query(
    "SELECT access_token FROM teller_tokens ORDER BY id DESC LIMIT 1"
  );
  return result.rows[0]?.access_token || null;
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

async function saveTransaction(tx, ignoreRules) {
  const ignoreReason = getIgnoreMatch(tx.description, ignoreRules);
  const ignored = Boolean(ignoreReason);

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
      Number(tx.amount),
      tx.type || null,
      tx.status || null,
      tx.running_balance != null ? Number(tx.running_balance) : null,
      tx.details?.processing_status || null,
      tx.details?.counterparty?.name || null,
      tx.details?.category || null,
      tx.links?.account || null,
      tx.links?.self || null,
      JSON.stringify(tx),
      ignored,
      ignoreReason,
    ]
  );
}

async function syncTransactionsForAccount(accountId, token, ignoreRules) {
  const transactions = await getTransactions(token, accountId);

  for (const tx of transactions) {
    await saveTransaction(tx, ignoreRules);
  }

  return transactions.length;
}

async function syncTellerTransactions() {
  console.log("🔐 Fetching Teller token...");
  const token = await getAccessToken();

  if (!token) {
    throw new Error("No Teller token found");
  }

  console.log("🏦 Fetching Teller accounts...");
  const accounts = await getAccounts(token);

  if (!accounts.length) {
    throw new Error("No accounts returned from Teller");
  }

  const ignoreRules = await getIgnoreRules();
  let totalProcessed = 0;

  for (const account of accounts) {
    console.log(`💸 Syncing Teller transactions for account ${account.id}...`);
    const count = await syncTransactionsForAccount(account.id, token, ignoreRules);
    totalProcessed += count;
  }

  console.log(`✨ Teller sync complete. Processed ${totalProcessed} transactions.`);
  return { processed: totalProcessed };
}

module.exports = syncTellerTransactions;