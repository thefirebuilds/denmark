const express = require("express");
const {
  buildLoginRequest,
  exchangeCodeForTokens,
  fetchUserInfo,
  getOidcConfig,
} = require("../auth/oidcProvider");
const { isAuthEnforced } = require("../auth/config");
const { requireAuth } = require("../auth/middleware");
const {
  createAuthAuditLog,
  ensureAuthTables,
  getAuditRequestMeta,
  upsertUserFromOidcProfile,
} = require("../auth/store");
const {
  resolveAuthPublicUrlSettings,
} = require("../services/authPublicUrlSettings");

const router = express.Router();

function getRequestOrigin(req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host");

  return host ? `${proto}://${host}` : "";
}

async function getFrontendRedirectBase(req) {
  const resolved = await resolveAuthPublicUrlSettings(req);
  return String(resolved.effectivePublicBaseUrl || getRequestOrigin(req) || "").replace(
    /\/+$/,
    ""
  );
}

function sessionRegenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sessionSave(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sessionDestroy(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

router.get("/login", async (req, res) => {
  try {
    await ensureAuthTables();
    if (!isAuthEnforced()) {
      return res.status(400).json({
        error: "auth enforcement is disabled for this environment",
      });
    }
    const provider = getOidcConfig();
    if (!provider.enabled) {
      return res.status(503).json({ error: "OIDC login is disabled" });
    }

    const publicUrl = await resolveAuthPublicUrlSettings(req);
    if (!publicUrl.googleRedirectUri) {
      return res.status(500).json({
        error:
          "Authentication public URL is not configured. Set it in Settings > Authentication.",
      });
    }

    console.log(`[auth] google redirect uri: ${publicUrl.googleRedirectUri}`);
    const loginRequest = await buildLoginRequest({
      loginHint: req.query?.login_hint,
      redirectUri: publicUrl.googleRedirectUri,
    });
    req.session.oidcAuth = {
      state: loginRequest.state,
      nonce: loginRequest.nonce,
      codeVerifier: loginRequest.codeVerifier,
      redirectUri: publicUrl.googleRedirectUri,
      startedAt: Date.now(),
    };
    await sessionSave(req);

    return res.redirect(loginRequest.authorizationUrl);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || "failed to start login",
    });
  }
});

router.get("/auth/callback", async (req, res) => {
  const auditMeta = getAuditRequestMeta(req);
  try {
    await ensureAuthTables();
    const { code, state } = req.query;
    const pendingAuth = req.session?.oidcAuth;

    if (!code || !state || !pendingAuth) {
      await createAuthAuditLog({
        eventType: "login_failure",
        ...auditMeta,
        details: {
          reason: "missing_code_or_state",
        },
      });
      const redirectBase = await getFrontendRedirectBase(req);
      return res.redirect(`${redirectBase}/?authError=login_failed`);
    }

    if (state !== pendingAuth.state) {
      await createAuthAuditLog({
        eventType: "login_failure",
        ...auditMeta,
        details: {
          reason: "state_mismatch",
        },
      });
      const redirectBase = await getFrontendRedirectBase(req);
      return res.redirect(`${redirectBase}/?authError=state_mismatch`);
    }

    const publicUrl = await resolveAuthPublicUrlSettings(req);
    const redirectUri = pendingAuth.redirectUri || publicUrl.googleRedirectUri;
    console.log(`[auth] google redirect uri: ${redirectUri}`);
    const tokens = await exchangeCodeForTokens({
      code: String(code),
      codeVerifier: pendingAuth.codeVerifier,
      redirectUri,
    });
    const userInfo = await fetchUserInfo(tokens.access_token);
    const provider = getOidcConfig();

    const user = await upsertUserFromOidcProfile({
      provider: provider.providerName,
      providerSubject: userInfo.sub,
      email: userInfo.email,
      displayName:
        userInfo.name ||
        userInfo.preferred_username ||
        userInfo.email ||
        userInfo.sub,
    });

    if (user.is_active !== true) {
      await createAuthAuditLog({
        userId: user.id,
        eventType: "login_failure",
        ...auditMeta,
        details: {
          reason: "inactive_user",
          email: user.email,
        },
      });
      const redirectBase = await getFrontendRedirectBase(req);
      return res.redirect(`${redirectBase}/?authError=inactive_user`);
    }

    await sessionRegenerate(req);
    req.session.auth = {
      userId: user.id,
      provider: user.provider,
      providerSubject: user.provider_subject,
      loggedInAt: new Date().toISOString(),
    };
    await sessionSave(req);

    await createAuthAuditLog({
      userId: user.id,
      eventType: "login_success",
      ...auditMeta,
      details: {
        email: user.email,
        role: user.role,
      },
    });

    const redirectBase = await getFrontendRedirectBase(req);
    return res.redirect(`${redirectBase}/?auth=success`);
  } catch (error) {
    await createAuthAuditLog({
      eventType: "login_failure",
      ...auditMeta,
      details: {
        reason: "callback_error",
        message: error.message || "unknown error",
      },
    }).catch(() => null);
    const redirectBase = await getFrontendRedirectBase(req).catch(() => "");
    return res.redirect(`${redirectBase}/?authError=callback_failed`);
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  const auditMeta = getAuditRequestMeta(req);
  const currentAuth = req.auth;
  try {
    await createAuthAuditLog({
      userId: currentAuth?.userId || null,
      eventType: "logout",
      ...auditMeta,
      details: {
        email: currentAuth?.email || null,
        role: currentAuth?.role || null,
      },
    });

    await sessionDestroy(req);
    res.clearCookie("denmark.sid");
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || "failed to logout" });
  }
});

router.get("/me", requireAuth, (req, res) => {
  if (!isAuthEnforced()) {
    return res.json({
      id: null,
      email: null,
      display_name: "Local development",
      role: "owner",
      permissions: ["*"],
      auth_enforced: false,
    });
  }

  return res.json({
    id: req.auth.userId || null,
    email: req.auth.email || null,
    display_name: req.auth.displayName || null,
    role: req.auth.role,
    permissions: req.auth.permissions || [],
    auth_enforced: true,
  });
});

module.exports = router;
