const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function provider(http) {
  const context = {
    module: { exports: {} },
    require: (name) => name === "axios" ? { create: () => http } : require(name),
    process: { env: {
      OIDC_ISSUER_URL: "https://example.com",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    } },
    console: { info() {} },
    URL, URLSearchParams,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../auth/oidcProvider.js"), "utf8"), context);
  return context.module.exports;
}

test("rejects missing and malformed access tokens before sending requests", async () => {
  const auth = provider({ get: () => assert.fail("must not send request") });
  for (const token of [undefined, "", "token with spaces", "token\r\nheader"]) {
    await assert.rejects(auth.fetchUserInfo(token), /access_token/);
  }
});

test("rejects a successful token response without an access token", async () => {
  const auth = provider({
    get: async () => ({ data: { token_endpoint: "https://example.com/token" } }),
    post: async () => ({ data: { token_type: "Bearer" } }),
  });
  await assert.rejects(auth.exchangeCodeForTokens({ code: "code", codeVerifier: "verifier", redirectUri: "https://example.com/callback" }), /missing_access_token/);
});

test("sends bearer header and redacts secrets from provider diagnostics", async () => {
  const auth = provider({
    get: async (url, options) => {
      if (url.endsWith("openid-configuration")) return { data: { userinfo_endpoint: "https://example.com/userinfo" } };
      assert.equal(options.headers.Authorization, "Bearer test-access-token");
      throw Object.assign(new Error("401"), { response: { data: {
        error_description: "Rejected test-access-token test-secret test-client",
      } } });
    },
  });
  await assert.rejects(auth.fetchUserInfo("test-access-token"), (error) => {
    assert.equal(error.authProviderDescription, "Rejected [redacted] [redacted] [redacted]");
    return true;
  });
});
