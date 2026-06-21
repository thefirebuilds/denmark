const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");
const { getRuntimeSecret } = require("../../config/runtimeSecrets");

const CLIENT_ID = getRuntimeSecret("BOUNCIE_CLIENT_ID");
const CLIENT_SECRET = getRuntimeSecret("BOUNCIE_CLIENT_SECRET");
const AUTH_CODE = getRuntimeSecret("BOUNCIE_AUTH_CODE");
const REDIRECT_URI = getRuntimeSecret("BOUNCIE_REDIRECT_URI");

const TOKEN_URL = "https://auth.bouncie.com/oauth/token";
const TOKEN_LIFETIME_SECONDS = 3600;

class BouncieAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "BouncieAuthError";
  }
}

let ensureTokenSecretColumnsPromise = null;

function decryptMaybe(value) {
  return value ? decrypt(value) : null;
}

async function ensureTokenSecretColumns() {
  if (!ensureTokenSecretColumnsPromise) {
    ensureTokenSecretColumnsPromise = pool.query(`
      ALTER TABLE api_auth_tokens
        ADD COLUMN IF NOT EXISTS access_token_encrypted text,
        ADD COLUMN IF NOT EXISTS refresh_token_encrypted text,
        ADD COLUMN IF NOT EXISTS raw_token_encrypted text
    `);
  }

  return ensureTokenSecretColumnsPromise;
}

async function migrateStoredTokenIfNeeded(row) {
  if (!row) return null;
  if (
    !row.access_token ||
    row.access_token_encrypted ||
    row.service_name !== "bouncie"
  ) {
    return row;
  }

  const encryptedAccessToken = encrypt(row.access_token);
  const encryptedRefreshToken = row.refresh_token ? encrypt(row.refresh_token) : null;
  const encryptedRawToken = row.raw_token ? encrypt(JSON.stringify(row.raw_token)) : null;

  await pool.query(
    `
      UPDATE api_auth_tokens
      SET access_token = NULL,
          refresh_token = NULL,
          raw_token = NULL,
          access_token_encrypted = $2,
          refresh_token_encrypted = $3,
          raw_token_encrypted = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [row.id, encryptedAccessToken, encryptedRefreshToken, encryptedRawToken]
  );

  return {
    ...row,
    access_token: null,
    refresh_token: null,
    raw_token: null,
    access_token_encrypted: encryptedAccessToken,
    refresh_token_encrypted: encryptedRefreshToken,
    raw_token_encrypted: encryptedRawToken,
  };
}

function hydrateTokenRow(row) {
  if (!row) return null;
  const rawTokenText = decryptMaybe(row.raw_token_encrypted);
  return {
    ...row,
    access_token: row.access_token || decryptMaybe(row.access_token_encrypted),
    refresh_token: row.refresh_token || decryptMaybe(row.refresh_token_encrypted),
    raw_token: row.raw_token || (rawTokenText ? JSON.parse(rawTokenText) : null),
  };
}

async function getStoredToken() {
  await ensureTokenSecretColumns();
  const result = await pool.query(
    `
      SELECT
        id,
        service_name,
        access_token,
        refresh_token,
        access_token_encrypted,
        refresh_token_encrypted,
        token_type,
        expires_at,
        raw_token,
        raw_token_encrypted,
        updated_at
      FROM api_auth_tokens
      WHERE service_name = 'bouncie'
      LIMIT 1
    `
  );

  return hydrateTokenRow(await migrateStoredTokenIfNeeded(result.rows[0] || null));
}

function isTokenExpired(tokenRow, bufferSeconds = 60) {
  if (!tokenRow?.access_token) return true;
  if (!tokenRow?.expires_at) return true;

  const expiresAtMs = new Date(tokenRow.expires_at).getTime();
  const nowMs = Date.now();

  return expiresAtMs <= nowMs + bufferSeconds * 1000;
}

async function saveToken(accessToken, rawToken = null) {
  await ensureTokenSecretColumns();
  const expiresAt = new Date(
    Date.now() + TOKEN_LIFETIME_SECONDS * 1000
  ).toISOString();

  const tokenType = rawToken?.token_type || "Bearer";
  const encryptedAccessToken = encrypt(accessToken);
  const encryptedRefreshToken = rawToken?.refresh_token
    ? encrypt(rawToken.refresh_token)
    : null;
  const encryptedRawToken = rawToken ? encrypt(JSON.stringify(rawToken)) : null;

  const result = await pool.query(
    `
      INSERT INTO api_auth_tokens (
        service_name,
        access_token,
        refresh_token,
        access_token_encrypted,
        refresh_token_encrypted,
        token_type,
        expires_at,
        raw_token,
        raw_token_encrypted,
        updated_at
      )
      VALUES ($1, NULL, NULL, $2, $3, $4, $5, NULL, $6, CURRENT_TIMESTAMP)
      ON CONFLICT (service_name)
      DO UPDATE SET
        access_token = NULL,
        refresh_token = NULL,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        raw_token = NULL,
        raw_token_encrypted = EXCLUDED.raw_token_encrypted,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `,
    [
      "bouncie",
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenType,
      expiresAt,
      encryptedRawToken,
    ]
  );

  return hydrateTokenRow(result.rows[0]);
}

async function exchangeAuthCode() {
  if (!CLIENT_ID || !CLIENT_SECRET || !AUTH_CODE || !REDIRECT_URI) {
    throw new BouncieAuthError(
      "Missing Bouncie env vars. Need BOUNCIE_CLIENT_ID, BOUNCIE_CLIENT_SECRET, BOUNCIE_AUTH_CODE, and BOUNCIE_REDIRECT_URI."
    );
  }

  const payload = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code: AUTH_CODE,
    redirect_uri: REDIRECT_URI,
  };

  const compactJson = JSON.stringify(payload);
  const contentLength = Buffer.byteLength(compactJson).toString();

  console.log("Bouncie: requesting new access token via auth code exchange...");

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "User-Agent": "python-requests/2.31.0",
      "Accept-Encoding": "gzip, deflate",
      Accept: "*/*",
      Connection: "keep-alive",
      "Content-Type": "application/json",
      "Content-Length": contentLength,
    },
    body: compactJson,
  });

  if (!resp.ok) {
    const raw = await resp.text();
    throw new BouncieAuthError(
      `Bouncie token exchange failed (${resp.status}): ${raw}`
    );
  }

  const data = await resp.json();

  if (!data?.access_token) {
    throw new BouncieAuthError(
      "Bouncie token exchange succeeded but no access_token was returned."
    );
  }

  const saved = await saveToken(data.access_token, data);
  return saved;
}

async function getToken() {
  const existing = await getStoredToken();

  if (existing?.access_token && !isTokenExpired(existing, 0)) {
    return existing.access_token;
  }

  console.log("Bouncie token missing or expired — requesting a fresh one...");
  const refreshed = await exchangeAuthCode();
  return refreshed.access_token;
}

async function getValidAccessToken() {
  const existing = await getStoredToken();

  if (existing?.access_token && !isTokenExpired(existing)) {
    return {
      accessToken: existing.access_token,
      tokenType: existing.token_type || "Bearer",
      expiresAt: existing.expires_at,
      source: "database",
    };
  }

  console.log("Bouncie token missing or expired — requesting a fresh one...");
  const refreshed = await exchangeAuthCode();

  return {
    accessToken: refreshed.access_token,
    tokenType: refreshed.token_type || "Bearer",
    expiresAt: refreshed.expires_at,
    source: "auth_code_exchange",
  };
}

async function invalidateStoredToken() {
  await pool.query(
    `
      UPDATE api_auth_tokens
      SET
        access_token = NULL,
        access_token_encrypted = NULL,
        expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE service_name = 'bouncie'
    `
  );
}

module.exports = {
  BouncieAuthError,
  getStoredToken,
  isTokenExpired,
  saveToken,
  exchangeAuthCode,
  getToken,
  getValidAccessToken,
  invalidateStoredToken,
};
