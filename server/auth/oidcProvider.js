const crypto = require("crypto");
const axios = require("axios");

let discoveryPromise = null;

const oidcHttp = axios.create({
  proxy: false,
});

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
    redirectUri: String(process.env.OIDC_REDIRECT_URI || "").trim(),
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
  if (!config.redirectUri) missing.push("OIDC_REDIRECT_URI");
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

  const authorizationUrl = buildAuthorizationUrl(discovery.authorization_endpoint, {
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
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

async function exchangeCodeForTokens({ code, codeVerifier }) {
  const config = assertOidcConfigured();
  const discovery = await getDiscoveryDocument();
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await oidcHttp.post(discovery.token_endpoint, params.toString(), {
    timeout: 10000,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return response.data;
}

async function fetchUserInfo(accessToken) {
  const discovery = await getDiscoveryDocument();
  if (!discovery.userinfo_endpoint) {
    const error = new Error("OIDC provider did not advertise a userinfo endpoint");
    error.statusCode = 500;
    throw error;
  }

  const response = await oidcHttp.get(discovery.userinfo_endpoint, {
    timeout: 10000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return response.data;
}

module.exports = {
  getOidcConfig,
  assertOidcConfigured,
  getDiscoveryDocument,
  buildLoginRequest,
  exchangeCodeForTokens,
  fetchUserInfo,
};
