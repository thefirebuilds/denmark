const crypto = require("crypto");
const axios = require("axios");

let discoveryPromise = null;

const oidcHttp = axios.create({
  proxy: false,
  responseType: "json",
  transitional: { silentJSONParsing: false },
});

function authDiagnosticError(code) {
  const error = new Error(code);
  error.authDiagnosticCode = code;
  return error;
}

function validateAccessToken(token) {
  if (typeof token !== "string" || !token) {
    throw authDiagnosticError("missing_access_token");
  }
  if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) {
    throw authDiagnosticError("malformed_access_token");
  }
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getClientId() {
  return String(
    process.env.OIDC_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ""
  ).trim();
}

function getClientSecret() {
  return String(
    process.env.OIDC_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || ""
  ).trim();
}

function getOidcConfig() {
  return {
    enabled: String(process.env.OIDC_ENABLED || "true").trim().toLowerCase() !== "false",
    providerName: String(process.env.OIDC_PROVIDER_NAME || "oidc").trim().toLowerCase(),
    issuerUrl: trimTrailingSlash(process.env.OIDC_ISSUER_URL || ""),
    clientId: getClientId(),
    clientSecret: getClientSecret(),
    scopes: String(process.env.OIDC_SCOPES || "openid profile email").trim(),
    prompt: String(process.env.OIDC_PROMPT || "").trim(),
  };
}

function assertOidcConfigured() {
  const config = getOidcConfig();
  const missing = [];
  if (!config.issuerUrl) missing.push("OIDC_ISSUER_URL");
  if (!config.clientId) missing.push("OIDC_CLIENT_ID or GOOGLE_CLIENT_ID");
  if (!config.clientSecret) missing.push("OIDC_CLIENT_SECRET or GOOGLE_CLIENT_SECRET");
  if (missing.length) {
    const error = new Error(
      `OIDC is not fully configured. Missing: ${missing.join(", ")}`
    );
    error.statusCode = 500;
    throw error;
  }
  return config;
}

async function getDiscoveryDocument() {
  if (!discoveryPromise) {
    const config = assertOidcConfigured();
    const discoveryUrl = `${config.issuerUrl}/.well-known/openid-configuration`;
    discoveryPromise = oidcHttp
      .get(discoveryUrl, {
        timeout: 10000,
        headers: { Accept: "application/json" },
      })
      .then((response) => response.data)
      .catch((error) => {
        discoveryPromise = null;
        throw error;
      });
  }

  return discoveryPromise;
}

function generatePkcePair() {
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

function buildAuthorizationUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value != null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

async function buildLoginRequest(options = {}) {
  const config = assertOidcConfigured();
  const discovery = await getDiscoveryDocument();
  const state = crypto.randomBytes(24).toString("hex");
  const nonce = crypto.randomBytes(24).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const loginHint = String(options.loginHint || "").trim();
  const redirectUri = String(options.redirectUri || "").trim();

  if (!redirectUri) {
    const error = new Error("OIDC redirect URI is not configured");
    error.statusCode = 500;
    throw error;
  }

  const authorizationUrl = buildAuthorizationUrl(discovery.authorization_endpoint, {
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    login_hint: loginHint,
    prompt: config.prompt,
  });

  return {
    state,
    nonce,
    codeVerifier,
    authorizationUrl,
  };
}

async function exchangeCodeForTokens({ code, codeVerifier, redirectUri }) {
  const config = assertOidcConfigured();
  const discovery = await getDiscoveryDocument();
  const effectiveRedirectUri = String(redirectUri || "").trim();

  if (!effectiveRedirectUri) {
    const error = new Error("OIDC redirect URI is not configured");
    error.statusCode = 500;
    throw error;
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: effectiveRedirectUri,
    code_verifier: codeVerifier,
  });

  const response = await oidcHttp.post(discovery.token_endpoint, params.toString(), {
    timeout: 10000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  console.info("[auth] token response metadata", {
    has_access_token: typeof response.data?.access_token === "string" && Boolean(response.data.access_token),
    bearer_token_type: String(response.data?.token_type || "").toLowerCase() === "bearer",
    identity_scopes: String(response.data?.scope || "").split(/\s+/).filter(
      (scope) => ["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"].includes(scope)
    ),
  });
  validateAccessToken(response.data?.access_token);
  return response.data;
}

async function fetchUserInfo(accessToken) {
  validateAccessToken(accessToken);
  const discovery = await getDiscoveryDocument();
  if (!discovery.userinfo_endpoint) {
    const error = new Error("OIDC provider did not advertise a userinfo endpoint");
    error.statusCode = 500;
    throw error;
  }

  let response;
  try {
    response = await oidcHttp.get(discovery.userinfo_endpoint, {
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    });
  } catch (error) {
    const description = error.response?.data?.error_description;
    if (typeof description === "string") {
      let safeDescription = description;
      for (const secret of [accessToken, getClientSecret(), getClientId()]) {
        if (secret) safeDescription = safeDescription.split(secret).join("[redacted]");
      }
      error.authProviderDescription = safeDescription
        .replace(/[A-Za-z0-9._~+\/-]{24,}=*/g, "[redacted]")
        .replace(/[\r\n\t]/g, " ")
        .slice(0, 300);
    }
    throw error;
  }

  return response.data;
}

async function resolveLoginProfile(tokens, nonce) {
  const config = getOidcConfig();
  if (config.issuerUrl !== "https://accounts.google.com") {
    return fetchUserInfo(tokens.access_token);
  }
  if (typeof tokens.id_token !== "string" || !tokens.id_token) {
    throw authDiagnosticError("missing_id_token");
  }
  if (typeof nonce !== "string" || !nonce) {
    throw authDiagnosticError("missing_login_nonce");
  }
  // googleapis is already a runtime dependency. Verify, never just decode.
  const { google } = require("googleapis");
  const verifier = new google.auth.OAuth2();
  const ticket = await verifier.verifyIdToken({
    idToken: tokens.id_token,
    audience: config.clientId,
  });
  const profile = ticket.getPayload();
  if (!profile || !["accounts.google.com", "https://accounts.google.com"].includes(profile.iss)) {
    throw authDiagnosticError("invalid_id_token_issuer");
  }
  if (profile.nonce !== nonce) {
    throw authDiagnosticError("id_token_nonce_mismatch");
  }
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    throw authDiagnosticError("unverified_google_identity");
  }
  return profile;
}

module.exports = {
  getOidcConfig,
  assertOidcConfigured,
  getDiscoveryDocument,
  buildLoginRequest,
  exchangeCodeForTokens,
  fetchUserInfo,
  resolveLoginProfile,
};
