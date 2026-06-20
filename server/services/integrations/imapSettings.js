const { ImapFlow } = require("imapflow");
const pool = require("../../db");

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

  return {
    enabled: input.enabled !== undefined ? input.enabled !== false : base.enabled !== false,
    host: cleanString(input.host ?? base.host),
    port: cleanNumber(input.port ?? base.port, 993),
    secure: input.secure !== undefined ? input.secure !== false : base.secure !== false,
    user: cleanString(input.user ?? base.user),
    pass: cleanString(input.pass ?? base.pass),
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
  return {
    ...settings,
    pass: settings?.pass ? "" : "",
    passConfigured: Boolean(settings?.pass),
    configured: hasCompleteImapCredentials(settings),
    source,
  };
}

async function getStoredImapSettings(client = pool) {
  const { rows } = await client.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );
  return rows[0]?.value ? normalizeImapSettings(rows[0].value, envImapSettings()) : null;
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
    input.pass === "__KEEP__";

  const next = normalizeImapSettings({
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
  normalizeImapSettings,
  sanitizeImapSettings,
  getEffectiveImapSettings,
  saveImapSettings,
  testImapConnection,
  splitMailboxes,
};
