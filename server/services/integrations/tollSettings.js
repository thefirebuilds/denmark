const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");

const SETTINGS_KEY = "integrations.tolls";
const SECRET_PLACEHOLDER = "__KEEP__";

const DEFAULT_TOLL_SETTINGS = Object.freeze({
  enabled: true,
  provider: "hctra_eztag",
  providerLabel: "HCTRA EZ TAG",
  sourceKey: "hctra_eztag",
  loginUrl: "https://www.hctra.org/Login",
  activityUrl: "https://www.hctra.org/AccountActivity",
  activityApiPattern: "/api/sessions/AccountActivity/SearchAccountActivity",
  username: "",
  password: "",
  lookbackDays: 30,
  timeoutMs: 45000,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  fingerprintFields:
    "trxnAt,licensePlate,amount,agencyName,facilityName,plazaName,laneName,direction,transType",
  fingerprintSalt: "",
});

function cleanString(value) {
  return String(value || "").trim();
}

function cleanNumber(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function envTollSettings() {
  return {
    ...DEFAULT_TOLL_SETTINGS,
    enabled: true,
    provider: cleanString(process.env.TOLL_PROVIDER) || DEFAULT_TOLL_SETTINGS.provider,
    providerLabel:
      cleanString(process.env.TOLL_PROVIDER_LABEL) ||
      DEFAULT_TOLL_SETTINGS.providerLabel,
    sourceKey: cleanString(process.env.TOLL_SOURCE_KEY) || DEFAULT_TOLL_SETTINGS.sourceKey,
    loginUrl: cleanString(process.env.EZTAG_LOGIN_URL) || DEFAULT_TOLL_SETTINGS.loginUrl,
    activityUrl:
      cleanString(process.env.EZTAG_ACCOUNT_ACTIVITY_URL) ||
      DEFAULT_TOLL_SETTINGS.activityUrl,
    activityApiPattern:
      cleanString(process.env.EZTAG_ACTIVITY_API_PATTERN) ||
      DEFAULT_TOLL_SETTINGS.activityApiPattern,
    username: cleanString(process.env.EZTAG_USERNAME),
    password: cleanString(process.env.EZTAG_PASSWORD),
    lookbackDays: cleanNumber(
      process.env.EZTAG_LOOKBACK_DAYS ?? process.env.TOLL_LOOKBACK_DAYS,
      DEFAULT_TOLL_SETTINGS.lookbackDays,
      { min: 1, max: 365 }
    ),
    timeoutMs: cleanNumber(
      process.env.EZTAG_TIMEOUT_MS,
      DEFAULT_TOLL_SETTINGS.timeoutMs,
      { min: 5000, max: 180000 }
    ),
    userAgent:
      cleanString(process.env.EZTAG_USER_AGENT) || DEFAULT_TOLL_SETTINGS.userAgent,
    fingerprintFields:
      cleanString(process.env.TOLL_FINGERPRINT_FIELDS) ||
      DEFAULT_TOLL_SETTINGS.fingerprintFields,
    fingerprintSalt: cleanString(process.env.TOLL_FINGERPRINT_SALT),
  };
}

function normalizeTollSettings(value = {}, fallback = DEFAULT_TOLL_SETTINGS) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = fallback || DEFAULT_TOLL_SETTINGS;
  const passwordEncrypted = cleanString(
    input.passwordEncrypted ?? input.password_encrypted ?? base.passwordEncrypted
  );
  const fingerprintSaltEncrypted = cleanString(
    input.fingerprintSaltEncrypted ??
      input.fingerprint_salt_encrypted ??
      base.fingerprintSaltEncrypted
  );
  let password = cleanString(input.password ?? base.password);
  let fingerprintSalt = cleanString(
    input.fingerprintSalt ?? input.fingerprint_salt ?? base.fingerprintSalt
  );

  if (!password && passwordEncrypted) {
    password = decrypt(passwordEncrypted);
  }

  if (!fingerprintSalt && fingerprintSaltEncrypted) {
    fingerprintSalt = decrypt(fingerprintSaltEncrypted);
  }

  return {
    enabled: input.enabled !== undefined ? input.enabled !== false : base.enabled !== false,
    provider: cleanString(input.provider ?? base.provider) || DEFAULT_TOLL_SETTINGS.provider,
    providerLabel:
      cleanString(input.providerLabel ?? input.provider_label ?? base.providerLabel) ||
      DEFAULT_TOLL_SETTINGS.providerLabel,
    sourceKey:
      cleanString(input.sourceKey ?? input.source_key ?? base.sourceKey) ||
      DEFAULT_TOLL_SETTINGS.sourceKey,
    loginUrl: cleanString(input.loginUrl ?? input.login_url ?? base.loginUrl),
    activityUrl: cleanString(
      input.activityUrl ?? input.activity_url ?? base.activityUrl
    ),
    activityApiPattern: cleanString(
      input.activityApiPattern ??
        input.activity_api_pattern ??
        base.activityApiPattern
    ),
    username: cleanString(input.username ?? input.user ?? base.username),
    password,
    passwordEncrypted,
    lookbackDays: cleanNumber(
      input.lookbackDays ?? input.lookback_days ?? base.lookbackDays,
      DEFAULT_TOLL_SETTINGS.lookbackDays,
      { min: 1, max: 365 }
    ),
    timeoutMs: cleanNumber(
      input.timeoutMs ?? input.timeout_ms ?? base.timeoutMs,
      DEFAULT_TOLL_SETTINGS.timeoutMs,
      { min: 5000, max: 180000 }
    ),
    userAgent:
      cleanString(input.userAgent ?? input.user_agent ?? base.userAgent) ||
      DEFAULT_TOLL_SETTINGS.userAgent,
    fingerprintFields:
      cleanString(
        input.fingerprintFields ??
          input.fingerprint_fields ??
          base.fingerprintFields
      ) || DEFAULT_TOLL_SETTINGS.fingerprintFields,
    fingerprintSalt,
    fingerprintSaltEncrypted,
  };
}

function hasCompleteTollCredentials(settings) {
  return Boolean(
    settings?.loginUrl &&
      settings?.activityUrl &&
      settings?.activityApiPattern &&
      settings?.username &&
      settings?.password
  );
}

function sanitizeTollSettings(settings, { source = "database" } = {}) {
  const normalized = normalizeTollSettings(settings);
  return {
    enabled: normalized.enabled,
    provider: normalized.provider,
    providerLabel: normalized.providerLabel,
    sourceKey: normalized.sourceKey,
    loginUrl: normalized.loginUrl,
    activityUrl: normalized.activityUrl,
    activityApiPattern: normalized.activityApiPattern,
    username: normalized.username,
    password: "",
    passwordEncrypted: undefined,
    passwordConfigured: Boolean(normalized.password),
    lookbackDays: normalized.lookbackDays,
    timeoutMs: normalized.timeoutMs,
    userAgent: normalized.userAgent,
    fingerprintFields: normalized.fingerprintFields,
    fingerprintSalt: normalized.fingerprintSalt ? "__CONFIGURED__" : "",
    fingerprintSaltConfigured: Boolean(normalized.fingerprintSalt),
    configured: hasCompleteTollCredentials(normalized),
    source,
  };
}

function buildStoredTollSettings(settings) {
  const normalized = normalizeTollSettings(settings);
  const stored = {
    enabled: normalized.enabled,
    provider: normalized.provider,
    providerLabel: normalized.providerLabel,
    sourceKey: normalized.sourceKey,
    loginUrl: normalized.loginUrl,
    activityUrl: normalized.activityUrl,
    activityApiPattern: normalized.activityApiPattern,
    username: normalized.username,
    lookbackDays: normalized.lookbackDays,
    timeoutMs: normalized.timeoutMs,
    userAgent: normalized.userAgent,
    fingerprintFields: normalized.fingerprintFields,
  };

  if (normalized.password) {
    stored.passwordEncrypted = encrypt(normalized.password);
  }

  if (normalized.fingerprintSalt) {
    stored.fingerprintSaltEncrypted = encrypt(normalized.fingerprintSalt);
  }

  return stored;
}

async function migrateStoredTollSecretsIfNeeded(rawValue, client = pool) {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    return rawValue;
  }

  const hasPlainPassword =
    cleanString(rawValue.password) &&
    !cleanString(rawValue.passwordEncrypted ?? rawValue.password_encrypted);
  const hasPlainSalt =
    cleanString(rawValue.fingerprintSalt) &&
    !cleanString(rawValue.fingerprintSaltEncrypted);

  if (!hasPlainPassword && !hasPlainSalt) {
    return rawValue;
  }

  const stored = buildStoredTollSettings(rawValue);
  await client.query(
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

function decryptStoredSalt(rawValue) {
  const encrypted = cleanString(rawValue?.fingerprintSaltEncrypted);
  if (!encrypted) return cleanString(rawValue?.fingerprintSalt);
  return decrypt(encrypted);
}

async function getStoredTollSettings(client = pool) {
  const { rows } = await client.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );
  if (!rows[0]?.value) return null;

  const migratedValue = await migrateStoredTollSecretsIfNeeded(rows[0].value, client);
  const normalized = normalizeTollSettings(migratedValue, envTollSettings());
  normalized.fingerprintSalt = decryptStoredSalt(migratedValue);
  return normalized;
}

async function getEffectiveTollSettings(client = pool) {
  const stored = await getStoredTollSettings(client);
  if (stored) {
    return {
      ...stored,
      source: "database",
      configured: hasCompleteTollCredentials(stored),
    };
  }

  const env = envTollSettings();
  return {
    ...env,
    source: "env",
    configured: hasCompleteTollCredentials(env),
  };
}

async function saveTollSettings(input = {}, client = pool) {
  const current = (await getStoredTollSettings(client)) || envTollSettings();
  const preservePassword =
    input.password === undefined ||
    input.password === null ||
    String(input.password).trim() === "" ||
    input.password === SECRET_PLACEHOLDER;
  const preserveFingerprintSalt =
    input.fingerprintSalt === undefined ||
    input.fingerprintSalt === null ||
    String(input.fingerprintSalt).trim() === "" ||
    input.fingerprintSalt === SECRET_PLACEHOLDER ||
    input.fingerprintSalt === "__CONFIGURED__";

  const next = buildStoredTollSettings(
    {
      ...current,
      ...input,
      password: preservePassword ? current.password : input.password,
      fingerprintSalt: preserveFingerprintSalt
        ? current.fingerprintSalt
        : input.fingerprintSalt,
    },
    current
  );

  const { rows } = await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      RETURNING value
    `,
    [SETTINGS_KEY, JSON.stringify(next)]
  );

  return normalizeTollSettings(rows[0]?.value || next);
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_TOLL_SETTINGS,
  SECRET_PLACEHOLDER,
  normalizeTollSettings,
  sanitizeTollSettings,
  getEffectiveTollSettings,
  saveTollSettings,
  hasCompleteTollCredentials,
};
