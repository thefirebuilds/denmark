const { getToken, exchangeAuthCode, invalidateStoredToken } = require("./auth");

const API_BASE = "https://api.bouncie.dev/v1";

class BouncieClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "BouncieClientError";
  }
}

async function bouncieRequest(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${API_BASE}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;

  let token = await getToken();

  async function attempt(currentToken, retry = true) {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `${currentToken}`,
        Accept: "application/json",
        "User-Agent": "python-requests/2.31.0",
        ...(options.headers || {}),
      },
      body: options.body,
    });

    if (resp.status === 401 && retry) {
      console.warn("Bouncie token rejected — forcing re-auth...");
      await invalidateStoredToken();
      const newToken = await exchangeAuthCode();
      return attempt(newToken.access_token, false);
    }

    if (!resp.ok) {
      const raw = await resp.text();
      throw new BouncieClientError(
        `Bouncie API error ${resp.status}: ${raw}`
      );
    }

    return resp.json();
  }

  return attempt(token, true);
}

async function getVehicles() {
  return bouncieRequest("/vehicles");
}

module.exports = {
  BouncieClientError,
  bouncieRequest,
  getVehicles,
};