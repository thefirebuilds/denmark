const pool = require("../db");

const PUBLIC_BASE_URL_KEY = "auth.public_base_url";
const GOOGLE_CALLBACK_PATH_KEY = "auth.google_callback_path";
const DEFAULT_GOOGLE_CALLBACK_PATH = "/api/auth/callback";

function isLocalhostHost(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

function allowsLocalhostPublicBaseUrl() {
  return (
    process.env.NODE_ENV !== "production" ||
    String(process.env.ALLOW_LOCALHOST_PUBLIC_BASE_URL || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function normalizePublicBaseUrl(value, { allowEmpty = true } = {}) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");

  if (!trimmed) {
    if (allowEmpty) return "";
    throw new Error("Public app base URL is required");
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Public app base URL must be a valid http:// or https:// URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Public app base URL must start with http:// or https://");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error("Public app base URL should include only scheme and host");
  }

  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";

  if (isLocalhostHost(parsed.hostname) && !allowsLocalhostPublicBaseUrl()) {
    throw new Error(
      "Public app base URL cannot be localhost in production. Set the deployed HTTPS URL instead."
    );
  }

  return parsed.toString().replace(/\/+$/, "");
}

function normalizeGoogleCallbackPath(value) {
  const raw = String(value || DEFAULT_GOOGLE_CALLBACK_PATH).trim();
  const path = raw.startsWith("/") ? raw : `/${raw}`;

  if (/^https?:\/\//i.test(raw)) {
    throw new Error("Google OAuth callback path must be a path, not a full URL");
  }

  return path || DEFAULT_GOOGLE_CALLBACK_PATH;
}

function computeGoogleRedirectUri(publicBaseUrl, googleCallbackPath) {
  const base = normalizePublicBaseUrl(publicBaseUrl, { allowEmpty: true });
  const path = normalizeGoogleCallbackPath(googleCallbackPath);
  return base ? `${base}${path}` : "";
}

function getRequestPublicBaseUrl(req) {
  if (!req) return "";

  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host");

  return host ? normalizePublicBaseUrl(`${proto}://${host}`, { allowEmpty: true }) : "";
}

function readBaseUrlValue(value) {
  if (typeof value === "string") return value;
  return value?.publicBaseUrl || value?.url || "";
}

function readCallbackPathValue(value) {
  if (typeof value === "string") return value;
  return value?.googleCallbackPath || value?.callbackPath || DEFAULT_GOOGLE_CALLBACK_PATH;
}

async function loadAuthPublicUrlSettings() {
  const { rows } = await pool.query(
    `
      SELECT key, value, updated_at
      FROM app_settings
      WHERE key = ANY($1::text[])
    `,
    [[PUBLIC_BASE_URL_KEY, GOOGLE_CALLBACK_PATH_KEY]]
  );

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const publicBaseUrl = normalizePublicBaseUrl(
    readBaseUrlValue(byKey.get(PUBLIC_BASE_URL_KEY)?.value),
    { allowEmpty: true }
  );
  const googleCallbackPath = normalizeGoogleCallbackPath(
    readCallbackPathValue(byKey.get(GOOGLE_CALLBACK_PATH_KEY)?.value)
  );

  return {
    publicBaseUrl,
    googleCallbackPath,
    googleRedirectUri: computeGoogleRedirectUri(publicBaseUrl, googleCallbackPath),
    updatedAt:
      byKey.get(PUBLIC_BASE_URL_KEY)?.updated_at ||
      byKey.get(GOOGLE_CALLBACK_PATH_KEY)?.updated_at ||
      null,
  };
}

async function saveAuthPublicUrlSettings(input = {}) {
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl, {
    allowEmpty: true,
  });
  const googleCallbackPath = normalizeGoogleCallbackPath(input.googleCallbackPath);

  await pool.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES
        ($1, $2::jsonb, NOW()),
        ($3, $4::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
    `,
    [
      PUBLIC_BASE_URL_KEY,
      JSON.stringify({ publicBaseUrl }),
      GOOGLE_CALLBACK_PATH_KEY,
      JSON.stringify({ googleCallbackPath }),
    ]
  );

  return loadAuthPublicUrlSettings();
}

async function resolveAuthPublicUrlSettings(req) {
  const settings = await loadAuthPublicUrlSettings();
  const warnings = [];
  let effectivePublicBaseUrl = settings.publicBaseUrl;
  let source = "database";

  if (!effectivePublicBaseUrl) {
    effectivePublicBaseUrl = getRequestPublicBaseUrl(req);
    source = "request";
    warnings.push(
      "auth.public_base_url is not configured; deriving OAuth redirect base from request headers"
    );
    console.warn(
      `[auth] auth.public_base_url missing; deriving from request headers: ${
        effectivePublicBaseUrl || "unavailable"
      }`
    );
  }

  const googleRedirectUri = computeGoogleRedirectUri(
    effectivePublicBaseUrl,
    settings.googleCallbackPath
  );

  return {
    ...settings,
    effectivePublicBaseUrl,
    googleRedirectUri,
    source,
    warnings,
  };
}

async function ensureAuthPublicUrlSettings() {
  await pool.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES
        ($1, $2::jsonb, NOW()),
        ($3, $4::jsonb, NOW())
      ON CONFLICT (key) DO NOTHING
    `,
    [
      PUBLIC_BASE_URL_KEY,
      JSON.stringify({ publicBaseUrl: "" }),
      GOOGLE_CALLBACK_PATH_KEY,
      JSON.stringify({ googleCallbackPath: DEFAULT_GOOGLE_CALLBACK_PATH }),
    ]
  );
}

module.exports = {
  PUBLIC_BASE_URL_KEY,
  GOOGLE_CALLBACK_PATH_KEY,
  DEFAULT_GOOGLE_CALLBACK_PATH,
  normalizePublicBaseUrl,
  normalizeGoogleCallbackPath,
  computeGoogleRedirectUri,
  getRequestPublicBaseUrl,
  loadAuthPublicUrlSettings,
  saveAuthPublicUrlSettings,
  resolveAuthPublicUrlSettings,
  ensureAuthPublicUrlSettings,
};
