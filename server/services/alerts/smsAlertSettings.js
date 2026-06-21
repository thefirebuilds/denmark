const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");

const SETTINGS_KEY = "alerts.sms";
const SECRET_MASK = "********";

const DEFAULT_SMS_ALERT_SETTINGS = {
  enabled: true,
  accountSid: "",
  authToken: "",
  senderNumber: "",
  receiverNumber: "",
};

function cleanString(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function envSmsSettings() {
  return {
    enabled: true,
    accountSid: cleanString(process.env.TWILIO_ACCOUNT_SID),
    authToken: cleanString(
      process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_CLIENT_SECRET
    ),
    senderNumber: cleanString(
      process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_SENDER_NUMBER
    ),
    receiverNumber: cleanString(
      process.env.TWILIO_TO_NUMBER || process.env.TWILIO_RECEIVER_NUMBER
    ),
  };
}

function normalizeSmsAlertSettings(value = {}) {
  const authTokenEncrypted = cleanString(
    value.authTokenEncrypted ?? value.auth_token_encrypted
  );
  let authToken = cleanString(
    value.authToken ?? value.auth_token ?? value.clientSecret ?? value.client_secret
  );

  if (!authToken && authTokenEncrypted) {
    authToken = decrypt(authTokenEncrypted);
  }

  return {
    enabled: value.enabled !== false,
    accountSid: cleanString(value.accountSid ?? value.account_sid),
    authToken,
    authTokenEncrypted,
    senderNumber: cleanString(
      value.senderNumber ?? value.sender_number ?? value.from ?? value.fromNumber
    ),
    receiverNumber: cleanString(
      value.receiverNumber ?? value.receiver_number ?? value.to ?? value.toNumber
    ),
  };
}

function hasCompleteCredentials(settings) {
  return Boolean(
    settings?.accountSid &&
      settings?.authToken &&
      settings?.senderNumber &&
      settings?.receiverNumber
  );
}

function maskSecret(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 4) return SECRET_MASK;
  return `${SECRET_MASK}${text.slice(-4)}`;
}

function sanitizeSmsAlertSettings(settings, { source = "database" } = {}) {
  const normalized = normalizeSmsAlertSettings(settings);
  return {
    enabled: normalized.enabled !== false,
    accountSid: normalized.accountSid || "",
    authToken: normalized.authToken ? maskSecret(normalized.authToken) : "",
    authTokenEncrypted: undefined,
    authTokenConfigured: Boolean(normalized.authToken),
    senderNumber: normalized.senderNumber || "",
    receiverNumber: normalized.receiverNumber || "",
    configured: hasCompleteCredentials(normalized),
    source,
  };
}

function buildStoredSmsAlertSettings(settings) {
  const normalized = normalizeSmsAlertSettings(settings);
  const stored = {
    enabled: normalized.enabled,
    accountSid: normalized.accountSid,
    senderNumber: normalized.senderNumber,
    receiverNumber: normalized.receiverNumber,
  };

  if (normalized.authToken) {
    stored.authTokenEncrypted = encrypt(normalized.authToken);
  }

  return stored;
}

async function migrateStoredSmsSecretIfNeeded(rawValue) {
  if (
    !rawValue ||
    typeof rawValue !== "object" ||
    Array.isArray(rawValue) ||
    !cleanString(
      rawValue.authToken ??
        rawValue.auth_token ??
        rawValue.clientSecret ??
        rawValue.client_secret
    ) ||
    cleanString(rawValue.authTokenEncrypted ?? rawValue.auth_token_encrypted)
  ) {
    return rawValue;
  }

  const stored = buildStoredSmsAlertSettings(rawValue);
  await pool.query(
    `
      UPDATE app_settings
      SET value = $2::jsonb,
          updated_at = NOW()
      WHERE key = $1
    `,
    [SETTINGS_KEY, JSON.stringify(stored)]
  );
  return stored;
}

async function getStoredSmsAlertSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );

  if (!rows[0]?.value) return null;

  const migratedValue = await migrateStoredSmsSecretIfNeeded(rows[0].value);
  return normalizeSmsAlertSettings(migratedValue);
}

async function getEffectiveSmsAlertSettings() {
  const stored = await getStoredSmsAlertSettings();
  if (stored) {
    return {
      ...stored,
      configured: hasCompleteCredentials(stored),
      source: "database",
    };
  }

  const env = envSmsSettings();
  return {
    ...env,
    configured: hasCompleteCredentials(env),
    source: "environment",
  };
}

async function saveSmsAlertSettings(input = {}) {
  const current = (await getStoredSmsAlertSettings()) || envSmsSettings();
  const nextInput = { ...input };
  const incomingSecret = cleanString(
    nextInput.authToken ??
      nextInput.auth_token ??
      nextInput.clientSecret ??
      nextInput.client_secret
  );

  if (!incomingSecret || incomingSecret === SECRET_MASK || incomingSecret.startsWith(SECRET_MASK)) {
    nextInput.authToken = current.authToken || "";
  }

  const settings = buildStoredSmsAlertSettings({
    ...current,
    ...nextInput,
  });

  const { rows } = await pool.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value,
                    updated_at = NOW()
      RETURNING value
    `,
    [SETTINGS_KEY, JSON.stringify(settings)]
  );

  return normalizeSmsAlertSettings(rows[0]?.value || settings);
}

module.exports = {
  SETTINGS_KEY,
  SECRET_MASK,
  DEFAULT_SMS_ALERT_SETTINGS,
  normalizeSmsAlertSettings,
  sanitizeSmsAlertSettings,
  getEffectiveSmsAlertSettings,
  saveSmsAlertSettings,
};
