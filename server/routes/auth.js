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

const router = express.Router();

function getFrontendRedirectBase() {
  return String(process.env.FRONTEND_BASE_URL || "http://localhost:5173").replace(
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

    const loginRequest = await buildLoginRequest();
    req.session.oidcAuth = {
      state: loginRequest.state,
      nonce: loginRequest.nonce,
      codeVerifier: loginRequest.codeVerifier,
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
      return res.redirect(`${getFrontendRedirectBase()}/?authError=login_failed`);
    }

    if (state !== pendingAuth.state) {
      await createAuthAuditLog({
        eventType: "login_failure",
        ...auditMeta,
        details: {
          reason: "state_mismatch",
        },
      });
      return res.redirect(`${getFrontendRedirectBase()}/?authError=state_mismatch`);
    }

    const tokens = await exchangeCodeForTokens({
      code: String(code),
      codeVerifier: pendingAuth.codeVerifier,
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
      return res.redirect(`${getFrontendRedirectBase()}/?authError=inactive_user`);
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

    return res.redirect(`${getFrontendRedirectBase()}/?auth=success`);
  } catch (error) {
    await createAuthAuditLog({
      eventType: "login_failure",
      ...auditMeta,
      details: {
        reason: "callback_error",
        message: error.message || "unknown error",
      },
    }).catch(() => null);
    return res.redirect(`${getFrontendRedirectBase()}/?authError=callback_failed`);
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
