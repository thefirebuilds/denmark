const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function provider(http, verifyIdToken, issuer = "https://example.com") {
  const context = {
    module: { exports: {} },
    require: (name) => {
      if (name === "axios") return { create: () => http };
      if (name === "googleapis") return { google: { auth: { OAuth2: class { verifyIdToken = verifyIdToken; } } } };
      return require(name);
    },
    process: { env: {
      OIDC_ISSUER_URL: issuer,
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

test("Google login uses verified ID token with intended audience without userinfo", async () => {
  const profile = { iss: "https://accounts.google.com", sub: "user", email: "user@example.com", email_verified: true, nonce: "expected" };
  const auth = provider({ get: () => assert.fail("must not call userinfo") }, async (options) => {
    assert.equal(options.idToken, "signed-token");
    assert.equal(options.audience, "test-client");
    return { getPayload: () => profile };
  }, "https://accounts.google.com");
  assert.equal(await auth.resolveLoginProfile({ id_token: "signed-token" }, "expected"), profile);
  await assert.rejects(auth.resolveLoginProfile({ id_token: "signed-token" }, "wrong"), /nonce_mismatch/);
  await assert.rejects(auth.resolveLoginProfile({}, "expected"), /missing_id_token/);
  profile.email_verified = false;
  await assert.rejects(auth.resolveLoginProfile({ id_token: "signed-token" }, "expected"), /unverified_google_identity/);
});

test("Google login propagates signature, audience, or expiry verification failures", async () => {
  const auth = provider({}, async () => { throw new Error("verification rejected"); }, "https://accounts.google.com");
  await assert.rejects(auth.resolveLoginProfile({ id_token: "invalid" }, "expected"), /verification rejected/);
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
