const pool = require("../../db");

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
  return {
    enabled: value.enabled !== false,
    accountSid: cleanString(value.accountSid ?? value.account_sid),
    authToken: cleanString(
      value.authToken ?? value.auth_token ?? value.clientSecret ?? value.client_secret
    ),
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
  return {
    enabled: settings.enabled !== false,
    accountSid: settings.accountSid || "",
    authToken: settings.authToken ? maskSecret(settings.authToken) : "",
    authTokenConfigured: Boolean(settings.authToken),
    senderNumber: settings.senderNumber || "",
    receiverNumber: settings.receiverNumber || "",
    configured: hasCompleteCredentials(settings),
    source,
  };
}

async function getStoredSmsAlertSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );

  return rows[0]?.value ? normalizeSmsAlertSettings(rows[0].value) : null;
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

  const settings = normalizeSmsAlertSettings({
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
