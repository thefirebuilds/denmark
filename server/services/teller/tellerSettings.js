const pool = require("../../db");
const { getRuntimeSecret } = require("../../config/runtimeSecrets");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");

const SETTINGS_KEY = "integrations.teller";
const SECRET_MASK = "********";

function clean(value) {
  return String(value || "").trim();
}

function normalizeEnvironment(value) {
  const environment = clean(value || "development").toLowerCase();
  if (!["sandbox", "development", "production"].includes(environment)) {
    throw new Error("Teller environment must be sandbox, development, or production");
  }
  return environment;
}

function readEncrypted(value) {
  return value ? decrypt(value) : "";
}

function envSettings() {
  return {
    applicationId: clean(process.env.TELLER_APPLICATION_ID),
    environment: normalizeEnvironment(
      process.env.TELLER_CONNECT_ENVIRONMENT || "development"
    ),
    staleTransactionDays: Math.max(
      1,
      Number(process.env.TELLER_STALE_TRANSACTION_DAYS) || 7
    ),
    certificate: getRuntimeSecret("TELLER_CERT_BASE64"),
    privateKey: getRuntimeSecret("TELLER_KEY_BASE64"),
    source: "environment",
  };
}

function hydrateStored(value = {}) {
  return {
    applicationId: clean(value.applicationId),
    environment: normalizeEnvironment(value.environment),
    staleTransactionDays: Math.max(1, Number(value.staleTransactionDays) || 7),
    certificate: readEncrypted(value.certificateEncrypted),
    privateKey: readEncrypted(value.privateKeyEncrypted),
    source: "database",
  };
}

async function getTellerSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );
  return rows[0]?.value ? hydrateStored(rows[0].value) : envSettings();
}

function sanitize(settings) {
  return {
    applicationId: settings.applicationId,
    environment: settings.environment,
    staleTransactionDays: settings.staleTransactionDays,
    certificateConfigured: Boolean(settings.certificate),
    privateKeyConfigured: Boolean(settings.privateKey),
    configured: Boolean(
      settings.applicationId && settings.certificate && settings.privateKey
    ),
    source: settings.source,
  };
}

async function saveTellerSettings(input = {}) {
  const current = await getTellerSettings();
  const incomingCertificate = clean(input.certificate);
  const incomingPrivateKey = clean(input.privateKey);
  const certificate =
    incomingCertificate && !incomingCertificate.startsWith(SECRET_MASK)
      ? incomingCertificate
      : current.certificate;
  const privateKey =
    incomingPrivateKey && !incomingPrivateKey.startsWith(SECRET_MASK)
      ? incomingPrivateKey
      : current.privateKey;
  const stored = {
    applicationId: clean(input.applicationId ?? current.applicationId),
    environment: normalizeEnvironment(input.environment ?? current.environment),
    staleTransactionDays: Math.max(
      1,
      Number(input.staleTransactionDays ?? current.staleTransactionDays) || 7
    ),
    certificateEncrypted: certificate ? encrypt(certificate) : "",
    privateKeyEncrypted: privateKey ? encrypt(privateKey) : "",
  };

  await pool.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [SETTINGS_KEY, JSON.stringify(stored)]
  );
  return { ...hydrateStored(stored), source: "database" };
}

module.exports = {
  getTellerSettings,
  sanitizeTellerSettings: sanitize,
  saveTellerSettings,
};
