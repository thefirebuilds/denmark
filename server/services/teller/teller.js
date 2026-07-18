const dotenv = require("dotenv");
const path = require("path");
const axios = require("axios");
const https = require("https");
const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");
const { getTellerSettings } = require("./tellerSettings");

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

const API = "https://api.teller.io";
let ensureTellerTokenSecretColumnsPromise = null;
let cachedAgent = null;
let cachedAgentKey = "";

function decodePem(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`Missing Teller ${label} in integration settings`);
  if (text.includes("-----BEGIN")) return text;
  const decoded = Buffer.from(text, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(`Teller ${label} must be PEM text or base64-encoded PEM`);
  }
  return decoded;
}

async function getTellerAgent() {
  const settings = await getTellerSettings();
  const cacheKey = `${settings.certificate}\n${settings.privateKey}`;
  if (cachedAgent && cacheKey === cachedAgentKey) return cachedAgent;
  cachedAgent = new https.Agent({
    cert: decodePem(settings.certificate, "client certificate"),
    key: decodePem(settings.privateKey, "private key"),
  });
  cachedAgentKey = cacheKey;
  return cachedAgent;
}

function describeTellerError(err) {
  const status = err?.response?.status || err?.status || null;
  const apiError = err?.response?.data?.error;
  const message =
    (typeof apiError === "string" ? apiError : apiError?.message) ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown Teller error";

  return {
    message: String(message),
    status: status == null ? null : Number(status),
    code: apiError?.code || err?.code || null,
    reconnectRequired: status === 401 || status === 403,
  };
}

async function saveSyncStatus(status) {
  await pool.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('integrations.teller.sync_status', $1::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = app_settings.value || jsonb_strip_nulls(EXCLUDED.value),
        updated_at = NOW()
    `,
    [JSON.stringify(status)]
  );
}

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

  const accountResult = await pool.query(`
    SELECT
      teller_account_id,
      TO_CHAR(MAX(transaction_date), 'YYYY-MM-DD') AS latest_transaction_date,
      MAX(updated_at) AS latest_import_at,
      (ARRAY_AGG(raw_json->'account' ORDER BY updated_at DESC))[1] AS account
    FROM teller_transactions
    WHERE raw_json->>'source' = 'teller'
    GROUP BY teller_account_id
    ORDER BY MAX(transaction_date) DESC NULLS LAST
  `);
  const statusResult = await pool.query(`
    SELECT value FROM app_settings
    WHERE key = 'integrations.teller.sync_status'
    LIMIT 1
  `);

  return {
    ...(result.rows[0] || { token_count: 0, latest_connected_at: null }),
    sync_status: statusResult.rows[0]?.value || null,
    accounts: accountResult.rows,
  };
}

async function saveAccessToken(accessToken, options = {}) {
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

  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    result = await client.query(
      `
        INSERT INTO teller_tokens (access_token, access_token_encrypted)
        VALUES (NULL, $1)
        RETURNING id, created_at
      `,
      [encrypt(token)]
    );
    if (options.replaceExisting === true && result.rows[0]?.id) {
      await client.query("DELETE FROM teller_tokens WHERE id <> $1", [
        result.rows[0].id,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }

  return {
    created: true,
    replaced: options.replaceExisting === true,
    token: result.rows[0] || null,
  };
}

async function getAccounts(token) {
  const res = await axios.get(`${API}/accounts`, {
    httpsAgent: await getTellerAgent(),
    auth: { username: token, password: "" },
  });

  return res.data || [];
}

async function getTransactions(token, accountId) {
  const res = await axios.get(`${API}/accounts/${accountId}/transactions`, {
    httpsAgent: await getTellerAgent(),
    auth: { username: token, password: "" },
  });

  return res.data || [];
}

async function getAccountBalances(token, accountId) {
  const res = await axios.get(`${API}/accounts/${accountId}/balances`, {
    httpsAgent: await getTellerAgent(),
    auth: { username: token, password: "" },
  });

  return res.data || {};
}

function normalizeAccount(account) {
  if (!account) return null;

  return {
    id: account.id || null,
    enrollment_id: account.enrollment_id || null,
    status: account.status || null,
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

async function getLatestStoredAccountBalance(accountId) {
  if (!accountId) return null;

  const { rows } = await pool.query(
    `
      SELECT running_balance, transaction_date, updated_at
      FROM teller_transactions
      WHERE teller_account_id = $1
        AND running_balance IS NOT NULL
      ORDER BY transaction_date DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
      LIMIT 1
    `,
    [accountId]
  );

  const row = rows[0];
  if (!row) return null;
  const balance = Number(row.running_balance);
  if (!Number.isFinite(balance)) return null;

  return {
    balance,
    transactionDate: row.transaction_date || null,
    updatedAt: row.updated_at || null,
  };
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
      balanceSource: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  for (const tokenRow of tokens) {
    const accounts = await getAccounts(tokenRow.access_token);
    const account = accounts.find(accountMatchesCiti4483);
    if (!account) continue;

    let liveBalances = null;
    try {
      liveBalances = await getAccountBalances(tokenRow.access_token, account.id);
    } catch (err) {
      console.warn(
        `[teller] failed to fetch Citi 4483 balances account=${account.id}: ${
          err.message || err
        }`
      );
    }

    const accountCurrentBalance = getAccountBalanceAmount(account, [
      "balances.current",
      "balances.ledger",
      "balances.available",
      "balance.current",
      "balance.ledger",
      "current_balance",
      "ledger_balance",
      "balance",
    ]);
    const liveCurrentBalance = getAccountBalanceAmount(liveBalances, [
      "current",
      "ledger",
      "available",
      "current_balance",
      "ledger_balance",
      "balance",
      "balances.current",
      "balances.ledger",
      "balances.available",
    ]);
    const accountAvailableBalance = getAccountBalanceAmount(account, [
      "balances.available",
      "balance.available",
      "available_balance",
      "credit.available",
    ]);
    const liveAvailableBalance = getAccountBalanceAmount(liveBalances, [
      "available",
      "available_balance",
      "balances.available",
    ]);
    const storedBalance = await getLatestStoredAccountBalance(account.id);
    const currentBalance =
      liveCurrentBalance ?? accountCurrentBalance ?? storedBalance?.balance ?? null;
    const availableBalance = liveAvailableBalance ?? accountAvailableBalance ?? null;
    const balanceSource =
      liveCurrentBalance != null
        ? "teller_balances"
        : accountCurrentBalance != null
        ? "teller_account"
        : storedBalance?.balance != null
        ? "stored_transaction_running_balance"
        : null;
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
      balanceSource,
      balanceAsOf: storedBalance?.transactionDate || null,
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
    balanceSource: null,
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
  const transactionIds = transactions.map((tx) => tx.id).filter(Boolean);
  const existingResult = transactionIds.length
    ? await pool.query(
        `
          SELECT teller_transaction_id
          FROM teller_transactions
          WHERE teller_transaction_id = ANY($1::text[])
        `,
        [transactionIds]
      )
    : { rows: [] };
  const existingIds = new Set(
    existingResult.rows.map((row) => row.teller_transaction_id)
  );

  for (const tx of transactions) {
    await saveTransaction(tx, ignoreRules, account);
  }

  const newestTransactionDate = transactions.reduce((latest, tx) => {
    const date = String(tx?.date || "");
    return date && (!latest || date > latest) ? date : latest;
  }, null);

  return {
    fetched: transactions.length,
    inserted: transactionIds.filter((id) => !existingIds.has(id)).length,
    newestTransactionDate,
  };
}

async function syncTellerTransactions() {
  console.log("[teller] fetching tokens");
  const tokens = await getAccessTokens();

  if (!tokens.length) {
    throw new Error("No Teller token found");
  }

  const ignoreRules = await getIgnoreRules();
  const tellerSettings = await getTellerSettings();
  const staleTransactionDays = tellerSettings.staleTransactionDays;
  let totalProcessed = 0;
  let totalInserted = 0;
  let totalAccounts = 0;
  const errors = [];
  const accountDiagnostics = [];

  for (const tokenRow of tokens) {
    console.log(`[teller] fetching accounts token=${tokenRow.id}`);
    let accounts;
    try {
      accounts = await getAccounts(tokenRow.access_token);
    } catch (err) {
      errors.push({
        tokenId: tokenRow.id,
        accountId: null,
        ...describeTellerError(err),
      });
      continue;
    }

    if (!accounts.length) {
      console.warn(`[teller] no accounts returned token=${tokenRow.id}`);
      continue;
    }

    totalAccounts += accounts.length;

    for (const account of accounts) {
      console.log(`[teller] syncing account=${account.id}`);
      try {
        const accountResult = await syncTransactionsForAccount(
          account,
          tokenRow.access_token,
          ignoreRules
        );
        totalProcessed += accountResult.fetched;
        totalInserted += accountResult.inserted;
        const diagnostic = {
          tokenId: tokenRow.id,
          account: normalizeAccount(account),
          fetched: accountResult.fetched,
          inserted: accountResult.inserted,
          newestTransactionDate: accountResult.newestTransactionDate,
        };
        accountDiagnostics.push(diagnostic);
        console.log(
          `[teller] account done | account=${account.id} institution=${
            diagnostic.account?.institution?.name || "unknown"
          } name=${diagnostic.account?.name || "unknown"} lastFour=${
            diagnostic.account?.last_four || "unknown"
          } fetched=${diagnostic.fetched} inserted=${diagnostic.inserted} newest=${
            diagnostic.newestTransactionDate || "none"
          }`
        );
      } catch (err) {
        errors.push({
          tokenId: tokenRow.id,
          accountId: account.id,
          account: normalizeAccount(account),
          ...describeTellerError(err),
        });
      }
    }
  }

  console.log(
    `[teller] sync done | tokens=${tokens.length} accounts=${totalAccounts} fetched=${totalProcessed} inserted=${totalInserted}`
  );
  const syncStatus = {
    lastCheckedAt: new Date().toISOString(),
    lastSuccessfulAt: errors.length ? null : new Date().toISOString(),
    accountsChecked: totalAccounts,
    transactionsProcessed: totalProcessed,
    transactionsInserted: totalInserted,
    accountDiagnostics,
    status: errors.length ? "error" : "ok",
    errors,
  };

  if (!errors.length) {
    const staleBefore = new Date(
      Date.now() - staleTransactionDays * 24 * 60 * 60 * 1000
    );
    const staleAccounts = accountDiagnostics.filter((item) => {
      if (!item.newestTransactionDate) return true;
      const latest = new Date(`${item.newestTransactionDate}T00:00:00Z`);
      return Number.isNaN(latest.getTime()) || latest < staleBefore;
    });

    if (staleAccounts.length) {
      syncStatus.status = "warning";
      syncStatus.warning = `${staleAccounts.length} Teller account${
        staleAccounts.length === 1 ? " has" : "s have"
      } no transactions in the last ${staleTransactionDays} days`;
      syncStatus.staleTransactionDays = staleTransactionDays;
      syncStatus.staleAccounts = staleAccounts;
    } else {
      syncStatus.warning = null;
      syncStatus.staleAccounts = [];
    }
  }
  await saveSyncStatus(syncStatus);

  if (errors.length) {
    const err = new Error(
      `Teller sync failed for ${errors.length} connection/account${errors.length === 1 ? "" : "s"}: ${errors[0].message}`
    );
    err.status = 502;
    err.details = syncStatus;
    throw err;
  }
  return {
    processed: totalProcessed,
    inserted: totalInserted,
    tokens: tokens.length,
    accounts: totalAccounts,
    status: syncStatus.status,
    warning: syncStatus.warning || null,
  };
}

module.exports = syncTellerTransactions;
module.exports.saveAccessToken = saveAccessToken;
module.exports.getTokenSummary = getTokenSummary;
module.exports.getCiti4483BalanceSummary = getCiti4483BalanceSummary;
