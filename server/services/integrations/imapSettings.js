const { ImapFlow } = require("imapflow");
const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");

const SETTINGS_KEY = "integrations.imap";

const DEFAULT_IMAP_SETTINGS = Object.freeze({
  enabled: true,
  host: "",
  port: 993,
  secure: true,
  user: "",
  pass: "",
  targetMailboxes: "INBOX",
  lookbackHours: 72,
  ingestLimit: 100,
  connectionTimeout: 90000,
  greetingTimeout: 30000,
  socketTimeout: 600000,
});
const SECRET_PLACEHOLDER = "__KEEP__";

function cleanString(value) {
  return String(value || "").trim();
}

function cleanNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envImapSettings() {
  return {
    enabled: true,
    host: cleanString(process.env.IMAP_HOST),
    port: cleanNumber(process.env.IMAP_PORT, 993),
    secure: true,
    user: cleanString(process.env.IMAP_USER),
    pass: cleanString(process.env.IMAP_PASS),
    targetMailboxes: cleanString(process.env.IMAP_TARGET_MAILBOXES) || "INBOX",
    lookbackHours: cleanNumber(process.env.IMAP_LOOKBACK_HOURS, 72),
    ingestLimit: cleanNumber(process.env.IMAP_INGEST_LIMIT, 100),
    connectionTimeout: cleanNumber(process.env.IMAP_CONNECTION_TIMEOUT, 90000),
    greetingTimeout: cleanNumber(process.env.IMAP_GREETING_TIMEOUT, 30000),
    socketTimeout: cleanNumber(process.env.IMAP_SOCKET_TIMEOUT, 600000),
  };
}

function normalizeImapSettings(value = {}, fallback = DEFAULT_IMAP_SETTINGS) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = fallback || DEFAULT_IMAP_SETTINGS;
  const passEncrypted = cleanString(
    input.passEncrypted ?? input.pass_encrypted ?? base.passEncrypted
  );
  let pass = cleanString(input.pass ?? base.pass);

  if (!pass && passEncrypted) {
    pass = decrypt(passEncrypted);
  }

  return {
    enabled: input.enabled !== undefined ? input.enabled !== false : base.enabled !== false,
    host: cleanString(input.host ?? base.host),
    port: cleanNumber(input.port ?? base.port, 993),
    secure: input.secure !== undefined ? input.secure !== false : base.secure !== false,
    user: cleanString(input.user ?? base.user),
    pass,
    passEncrypted,
    targetMailboxes: cleanString(input.targetMailboxes ?? input.target_mailboxes ?? base.targetMailboxes) || "INBOX",
    lookbackHours: cleanNumber(input.lookbackHours ?? input.lookback_hours ?? base.lookbackHours, 72),
    ingestLimit: cleanNumber(input.ingestLimit ?? input.ingest_limit ?? base.ingestLimit, 100),
    connectionTimeout: cleanNumber(input.connectionTimeout ?? base.connectionTimeout, 90000),
    greetingTimeout: cleanNumber(input.greetingTimeout ?? base.greetingTimeout, 30000),
    socketTimeout: cleanNumber(input.socketTimeout ?? base.socketTimeout, 600000),
  };
}

function hasCompleteImapCredentials(settings) {
  return Boolean(settings?.host && settings?.user && settings?.pass);
}

function sanitizeImapSettings(settings, { source = "database" } = {}) {
  const normalized = normalizeImapSettings(settings);
  return {
    enabled: normalized.enabled,
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    user: normalized.user,
    pass: "",
    passEncrypted: undefined,
    passConfigured: Boolean(normalized.pass),
    targetMailboxes: normalized.targetMailboxes,
    lookbackHours: normalized.lookbackHours,
    ingestLimit: normalized.ingestLimit,
    connectionTimeout: normalized.connectionTimeout,
    greetingTimeout: normalized.greetingTimeout,
    socketTimeout: normalized.socketTimeout,
    configured: hasCompleteImapCredentials(normalized),
    source,
  };
}

function buildStoredImapSettings(settings) {
  const normalized = normalizeImapSettings(settings);
  const stored = {
    enabled: normalized.enabled,
    host: normalized.host,
    port: normalized.port,
    secure: normalized.secure,
    user: normalized.user,
    targetMailboxes: normalized.targetMailboxes,
    lookbackHours: normalized.lookbackHours,
    ingestLimit: normalized.ingestLimit,
    connectionTimeout: normalized.connectionTimeout,
    greetingTimeout: normalized.greetingTimeout,
    socketTimeout: normalized.socketTimeout,
  };

  if (normalized.pass) {
    stored.passEncrypted = encrypt(normalized.pass);
  }

  return stored;
}

async function migrateStoredImapPasswordIfNeeded(rawValue, client = pool) {
  if (
    !rawValue ||
    typeof rawValue !== "object" ||
    Array.isArray(rawValue) ||
    !cleanString(rawValue.pass) ||
    cleanString(rawValue.passEncrypted ?? rawValue.pass_encrypted)
  ) {
    return rawValue;
  }

  const stored = buildStoredImapSettings(rawValue);
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

async function getStoredImapSettings(client = pool) {
  const { rows } = await client.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );
  if (!rows[0]?.value) return null;

  const migratedValue = await migrateStoredImapPasswordIfNeeded(rows[0].value, client);
  return normalizeImapSettings(migratedValue, envImapSettings());
}

async function getEffectiveImapSettings(client = pool) {
  const stored = await getStoredImapSettings(client);
  if (stored) {
    return {
      ...stored,
      source: "database",
      configured: hasCompleteImapCredentials(stored),
    };
  }

  const env = envImapSettings();
  return {
    ...env,
    source: "env",
    configured: hasCompleteImapCredentials(env),
  };
}

async function saveImapSettings(input = {}, client = pool) {
  const current = (await getStoredImapSettings(client)) || envImapSettings();
  const preservePassword =
    input.pass === undefined ||
    input.pass === null ||
    String(input.pass).trim() === "" ||
    input.pass === SECRET_PLACEHOLDER;

  const next = buildStoredImapSettings({
    ...current,
    ...input,
    pass: preservePassword ? current.pass : input.pass,
  }, current);

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

  return normalizeImapSettings(rows[0]?.value || next);
}

function splitMailboxes(value) {
  return cleanString(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getImapErrorMessage(err) {
  const parts = [
    err?.message,
    err?.response,
    err?.code,
    err?.authenticationFailed ? "authentication failed" : "",
  ]
    .map((part) => cleanString(part))
    .filter(Boolean);

  const uniqueParts = [...new Set(parts)];
  if (!uniqueParts.length) return "IMAP connection test failed";
  return `IMAP connection test failed: ${uniqueParts.join(" | ")}`;
}

async function testImapConnection(settings) {
  const config = normalizeImapSettings(settings);
  if (!hasCompleteImapCredentials(config)) {
    const err = new Error("IMAP host, user, and password are required");
    err.status = 400;
    throw err;
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure !== false,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    logger: false,
    connectionTimeout: config.connectionTimeout,
    greetingTimeout: config.greetingTimeout,
    socketTimeout: config.socketTimeout,
  });

  const mailboxes = splitMailboxes(config.targetMailboxes);
  const checked = [];

  try {
    await client.connect();

    for (const mailbox of mailboxes.length ? mailboxes : ["INBOX"]) {
      const lock = await client.getMailboxLock(mailbox);
      try {
        checked.push(mailbox);
      } finally {
        lock.release();
      }
    }

    return { ok: true, checkedMailboxes: checked };
  } catch (err) {
    const wrapped = new Error(getImapErrorMessage(err));
    wrapped.status = err.status || 502;
    throw wrapped;
  } finally {
    try {
      if (client.usable) await client.logout();
    } catch {
      // Ignore logout errors after a successful connection test.
    }
  }
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_IMAP_SETTINGS,
  SECRET_PLACEHOLDER,
  normalizeImapSettings,
  sanitizeImapSettings,
  getEffectiveImapSettings,
  saveImapSettings,
  testImapConnection,
  splitMailboxes,
};
