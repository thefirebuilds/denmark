const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");

const SETTINGS_KEY = "integrations.plaid";
const SECRET_MASK = "********";
const TRANSACTION_INTERVAL_HOURS = 8;
const BALANCE_INTERVAL_HOURS = 7 * 24;

function clean(value) { return String(value || "").trim(); }
function normalizeEnvironment(value) {
  const environment = clean(value || "production").toLowerCase();
  if (environment !== "production") return "production";
  return "production";
}
function decryptSecret(value) { return value ? decrypt(value) : ""; }

async function getPlaidSettings() {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = $1 LIMIT 1", [SETTINGS_KEY]);
  const value = rows[0]?.value || {};
  return {
    clientId: clean(value.clientId || process.env.PLAID_CLIENT_ID),
    secret: value.secretEncrypted ? decryptSecret(value.secretEncrypted) : clean(process.env.PLAID_SECRET),
    environment: normalizeEnvironment(value.environment || process.env.PLAID_ENV || "production"),
    source: rows[0] ? "database" : "environment",
    transactionIntervalHours: TRANSACTION_INTERVAL_HOURS,
    balanceIntervalHours: BALANCE_INTERVAL_HOURS,
  };
}

function sanitizePlaidSettings(settings) {
  return { clientId: settings.clientId, environment: settings.environment,
    secretConfigured: Boolean(settings.secret), configured: Boolean(settings.clientId && settings.secret),
    source: settings.source, transactionIntervalHours: TRANSACTION_INTERVAL_HOURS,
    balanceIntervalHours: BALANCE_INTERVAL_HOURS };
}

async function savePlaidSettings(input = {}) {
  const current = await getPlaidSettings();
  const incoming = clean(input.secret);
  const secret = incoming && !incoming.startsWith(SECRET_MASK) ? incoming : current.secret;
  const stored = { clientId: clean(input.clientId ?? current.clientId),
    environment: normalizeEnvironment(input.environment ?? current.environment),
    secretEncrypted: secret ? encrypt(secret) : "" };
  await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2::jsonb,NOW())
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [SETTINGS_KEY, JSON.stringify(stored)]);
  return { ...stored, secret, source: "database", transactionIntervalHours: TRANSACTION_INTERVAL_HOURS, balanceIntervalHours: BALANCE_INTERVAL_HOURS };
}

module.exports = { getPlaidSettings, sanitizePlaidSettings, savePlaidSettings,
  TRANSACTION_INTERVAL_HOURS, BALANCE_INTERVAL_HOURS };
