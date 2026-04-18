const pool = require("../../db");

const CLIENT_ID = process.env.BOUNCIE_CLIENT_ID;
const CLIENT_SECRET = process.env.BOUNCIE_CLIENT_SECRET;
const AUTH_CODE = process.env.BOUNCIE_AUTH_CODE;
const REDIRECT_URI = process.env.BOUNCIE_REDIRECT_URI;

const TOKEN_URL = "https://auth.bouncie.com/oauth/token";
const TOKEN_LIFETIME_SECONDS = 3600;

class BouncieAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "BouncieAuthError";
  }
}

async function getStoredToken() {
  const result = await pool.query(
    `
      SELECT
        access_token,
        refresh_token,
        token_type,
        expires_at,
        raw_token,
        updated_at
      FROM api_auth_tokens
      WHERE service_name = 'bouncie'
      LIMIT 1
    `
  );

  return result.rows[0] || null;
}

function isTokenExpired(tokenRow, bufferSeconds = 60) {
  if (!tokenRow?.access_token) return true;
  if (!tokenRow?.expires_at) return true;

  const expiresAtMs = new Date(tokenRow.expires_at).getTime();
  const nowMs = Date.now();

  return expiresAtMs <= nowMs + bufferSeconds * 1000;
}

async function saveToken(accessToken, rawToken = null) {
  const expiresAt = new Date(
    Date.now() + TOKEN_LIFETIME_SECONDS * 1000
  ).toISOString();

  const tokenType = rawToken?.token_type || "Bearer";

  const result = await pool.query(
    `
      INSERT INTO api_auth_tokens (
        service_name,
        access_token,
        refresh_token,
        token_type,
        expires_at,
        raw_token,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (service_name)
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        raw_token = EXCLUDED.raw_token,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `,
    [
      "bouncie",
      accessToken,
      rawToken?.refresh_token || null,
      tokenType,
      expiresAt,
      rawToken ? JSON.stringify(rawToken) : null,
    ]
  );

  return result.rows[0];
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