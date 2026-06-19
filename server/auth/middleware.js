const {
  getPermissionsForRole,
  hasPermission,
  hasRole,
  normalizeRole,
} = require("./permissions");
const { isAuthEnforced } = require("./config");
const { isDatabaseConnectionError } = require("../dbHealth");
const {
  createAuthAuditLog,
  getAuditRequestMeta,
  getServiceTokenByHash,
  getUserById,
  hashServiceToken,
  touchServiceToken,
} = require("./store");

const SESSION_AUTH_CACHE_MS = Number(process.env.SESSION_AUTH_CACHE_MS || 60000);

function buildAuthError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function buildRequestAuthFromUser(user) {
  return {
    kind: "user",
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    role: normalizeRole(user.role),
    permissions: getPermissionsForRole(user.role),
    isActive: user.is_active === true,
    provider: user.provider,
  };
}

function isUsableCachedUser(cachedUser, sessionUserId) {
  return (
    cachedUser?.id === sessionUserId &&
    cachedUser?.is_active === true
  );
}

async function logUnauthorizedAccess(req, details = {}) {
  const authMeta = getAuditRequestMeta(req);
  const principal = req.auth || null;
  await createAuthAuditLog({
    userId: principal?.kind === "user" ? principal.userId : null,
    eventType: "unauthorized_access",
    ipAddress: authMeta.ipAddress,
    userAgent: authMeta.userAgent,
    details: {
      method: req.method,
      path: req.originalUrl,
      role: principal?.role || null,
      auth_kind: principal?.kind || null,
      ...details,
    },
  }).catch(() => null);
}

async function loadRequestAuth(req, res, next) {
  const startedAt = Date.now();
  try {
    if (req.auth) return next();

    const sessionUserId = req.session?.auth?.userId;
    if (!sessionUserId) return next();

    const cachedUser = req.session?.auth?.cachedUser;
    const cachedAt = cachedUser?.cachedAt
      ? new Date(cachedUser.cachedAt).getTime()
      : NaN;
    if (
      isUsableCachedUser(cachedUser, sessionUserId) &&
      Number.isFinite(cachedAt) &&
      Date.now() - cachedAt < SESSION_AUTH_CACHE_MS
    ) {
      req.auth = buildRequestAuthFromUser(cachedUser);
      return next();
    }

    let user;
    try {
      user = await getUserById(sessionUserId);
    } catch (error) {
      if (isDatabaseConnectionError(error) && isUsableCachedUser(cachedUser, sessionUserId)) {
        req.auth = buildRequestAuthFromUser(cachedUser);
        console.warn(
          `[auth] using stale cached session auth after database connection error | path=${
            req.originalUrl || req.url
          } error=${error.message || error}`
        );
        return next();
      }
      throw error;
    }

    if (!user || user.is_active !== true) {
      if (req.session?.auth) {
        delete req.session.auth;
      }
      return next();
    }

    req.session.auth.cachedUser = {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      is_active: user.is_active,
      provider: user.provider,
      cachedAt: new Date().toISOString(),
    };
    req.auth = buildRequestAuthFromUser(user);

    return next();
  } catch (error) {
    console.warn(
      `[auth] request auth load failed | path=${req.originalUrl || req.url} error=${
        error.message || error
      }`
    );
    return next(error);
  } finally {
    if (res.locals) {
      res.locals.authMs = Date.now() - startedAt;
    }
  }
}

function requireAuth(req, res, next) {
  if (!isAuthEnforced()) return next();
  if (req.auth?.isActive) return next();

  logUnauthorizedAccess(req, { reason: "missing_auth" });
  return res.status(401).json({ error: "authentication required" });
}

function requireRole(role) {
  return (req, res, next) => {
    if (!isAuthEnforced()) return next();
    if (!req.auth?.isActive) {
      logUnauthorizedAccess(req, {
        reason: "missing_auth",
        required_role: role,
      });
      return res.status(401).json({ error: "authentication required" });
    }

    if (!hasRole(req.auth.role, role)) {
      logUnauthorizedAccess(req, {
        reason: "role_denied",
        required_role: role,
      });
      return res.status(403).json({ error: "forbidden" });
    }

    return next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!isAuthEnforced()) return next();
    if (!req.auth?.isActive) {
      logUnauthorizedAccess(req, {
        reason: "missing_auth",
        required_permission: permission,
      });
      return res.status(401).json({ error: "authentication required" });
    }

    if (!hasPermission(req.auth.role, permission)) {
      logUnauthorizedAccess(req, {
        reason: "permission_denied",
        required_permission: permission,
      });
      return res.status(403).json({ error: "forbidden" });
    }

    return next();
  };
}

function requireMethodPermissions(methodPermissions = {}, fallbackPermission = null) {
  const normalized = {};
  Object.entries(methodPermissions || {}).forEach(([method, permission]) => {
    normalized[String(method || "").trim().toUpperCase()] = permission;
  });

  return (req, res, next) => {
    const permission = normalized[req.method] || fallbackPermission;
    if (!permission) return next();
    return requirePermission(permission)(req, res, next);
  };
}

function extractPresentedServiceToken(req) {
  const authHeader = String(req.get("authorization") || "");
  if (/^bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^bearer\s+/i, "").trim();
  }

  return String(req.get("x-service-token") || "").trim();
}

function authenticateServiceToken(options = {}) {
  const { optional = false } = options;

  return async (req, res, next) => {
    if (!isAuthEnforced()) return next();
    try {
      const token = extractPresentedServiceToken(req);

      if (!token) {
        if (optional) return next();

        await createAuthAuditLog({
          eventType: "service_token_rejected",
          ...getAuditRequestMeta(req),
          details: {
            reason: "missing_token",
            method: req.method,
            path: req.originalUrl,
          },
        }).catch(() => null);
        return res.status(401).json({ error: "service token required" });
      }

      const tokenHash = hashServiceToken(token);
      const serviceToken = await getServiceTokenByHash(tokenHash);

      if (!serviceToken) {
        await createAuthAuditLog({
          eventType: "service_token_rejected",
          ...getAuditRequestMeta(req),
          details: {
            reason: "unknown_token",
            method: req.method,
            path: req.originalUrl,
          },
        }).catch(() => null);
        return res.status(401).json({ error: "invalid service token" });
      }

      if (serviceToken.revoked_at) {
        await createAuthAuditLog({
          eventType: "service_token_rejected",
          ...getAuditRequestMeta(req),
          details: {
            reason: "revoked_token",
            token_id: serviceToken.id,
            token_name: serviceToken.name,
            method: req.method,
            path: req.originalUrl,
          },
        }).catch(() => null);
        return res.status(401).json({ error: "service token revoked" });
      }

      if (serviceToken.expires_at && new Date(serviceToken.expires_at).getTime() <= Date.now()) {
        await createAuthAuditLog({
          eventType: "service_token_rejected",
          ...getAuditRequestMeta(req),
          details: {
            reason: "expired_token",
            token_id: serviceToken.id,
            token_name: serviceToken.name,
            method: req.method,
            path: req.originalUrl,
          },
        }).catch(() => null);
        return res.status(401).json({ error: "service token expired" });
      }

      await touchServiceToken(serviceToken.id).catch(() => null);
      await createAuthAuditLog({
        eventType: "service_token_used",
        ...getAuditRequestMeta(req),
        details: {
          token_id: serviceToken.id,
          token_name: serviceToken.name,
          method: req.method,
          path: req.originalUrl,
        },
      }).catch(() => null);

      req.auth = {
        kind: "service",
        serviceTokenId: serviceToken.id,
        serviceTokenName: serviceToken.name,
        role: normalizeRole(serviceToken.role),
        permissions: getPermissionsForRole(serviceToken.role),
        isActive: true,
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  buildAuthError,
  loadRequestAuth,
  requireAuth,
  requireRole,
  requirePermission,
  requireMethodPermissions,
  authenticateServiceToken,
};
