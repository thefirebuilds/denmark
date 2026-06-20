const crypto = require("crypto");
const pool = require("../db");
const { getPermissionsForRole, normalizeRole } = require("./permissions");
const { logSystemActivity } = require("../services/systemActivityLog");

let ensureAuthTablesPromise = null;
const REQUIRED_AUTH_TABLES = ["app_users", "auth_audit_log", "service_tokens"];

function normalizeEmail(value) {
  const text = String(value || "").trim().toLowerCase();
  return text || null;
}

function normalizeDisplayName(value) {
  const text = String(value || "").trim();
  return text || null;
}

function hashServiceToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getBootstrapOwnerEmails() {
  return new Set(
    String(process.env.AUTH_OWNER_EMAILS || "")
      .split(",")
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function getAuditRequestMeta(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return {
    ipAddress: forwardedFor || req.ip || req.socket?.remoteAddress || null,
    userAgent: req.get("user-agent") || null,
  };
}

async function ensureAuthTables(client = pool) {
  if (!ensureAuthTablesPromise) {
    ensureAuthTablesPromise = (async () => {
      const result = await client.query(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = ANY($1::text[])
        `,
        [REQUIRED_AUTH_TABLES]
      );
      const found = new Set(result.rows.map((row) => row.table_name));
      const missing = REQUIRED_AUTH_TABLES.filter((table) => !found.has(table));

      if (missing.length) {
        throw new Error(
          `Database schema is missing auth table(s): ${missing.join(
            ", "
          )}. Initialize or migrate the database before starting the app.`
        );
      }
    })().catch((error) => {
      ensureAuthTablesPromise = null;
      throw error;
    });
  }

  return ensureAuthTablesPromise;
}

async function getUserById(userId, client = pool) {
  await ensureAuthTables(client);
  const result = await client.query(
    `
      SELECT
        id,
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active,
        created_at,
        updated_at
      FROM public.app_users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    ...row,
    role: normalizeRole(row.role),
    permissions: getPermissionsForRole(row.role),
  };
}

async function getServiceTokenByHash(tokenHash, client = pool) {
  await ensureAuthTables(client);
  const result = await client.query(
    `
      SELECT
        id,
        name,
        token_hash,
        role,
        last_used_at,
        expires_at,
        created_at,
        revoked_at
      FROM public.service_tokens
      WHERE token_hash = $1
      LIMIT 1
    `,
    [tokenHash]
  );

  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    ...row,
    role: normalizeRole(row.role),
    permissions: getPermissionsForRole(row.role),
  };
}

async function touchServiceToken(tokenId, client = pool) {
  await ensureAuthTables(client);
  await client.query(
    `
      UPDATE public.service_tokens
      SET last_used_at = NOW()
      WHERE id = $1
    `,
    [tokenId]
  );
}

async function createAuthAuditLog({
  userId = null,
  eventType,
  ipAddress = null,
  userAgent = null,
  details = {},
  client = pool,
}) {
  await ensureAuthTables(client);
  await client.query(
    `
      INSERT INTO public.auth_audit_log (
        user_id,
        event_type,
        ip_address,
        user_agent,
        details
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [userId, eventType, ipAddress, userAgent, JSON.stringify(details || {})]
  );

  await logSystemActivity({
    client,
    category:
      String(eventType || "").includes("unauthorized") ||
      String(eventType || "").includes("rejected")
        ? "security"
        : "auth",
    eventType,
    severity:
      String(eventType || "").includes("failure") ||
      String(eventType || "").includes("unauthorized") ||
      String(eventType || "").includes("rejected")
        ? "warning"
        : "info",
    actorType: userId ? "user" : "system",
    actorUserId: userId,
    source: "auth",
    ipAddress,
    userAgent,
    outcome:
      String(eventType || "").includes("failure") ||
      String(eventType || "").includes("unauthorized") ||
      String(eventType || "").includes("rejected")
        ? "failure"
        : "success",
    details,
  }).catch(() => null);
}

async function upsertUserFromOidcProfile(
  {
    provider,
    providerSubject,
    email,
    displayName,
  },
  client = pool
) {
  await ensureAuthTables(client);

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    const error = new Error("OIDC profile did not provide an email address");
    error.statusCode = 400;
    throw error;
  }

  const ownerEmails = getBootstrapOwnerEmails();
  const defaultRole = ownerEmails.has(normalizedEmail) ? "owner" : "viewer";

  const result = await client.query(
    `
      INSERT INTO public.app_users (
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active
      )
      VALUES ($1, $2, $3, $4, $5, TRUE)
      ON CONFLICT (email)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        provider_subject = EXCLUDED.provider_subject,
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING
        id,
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active,
        created_at,
        updated_at,
        (xmax = 0) AS inserted
    `,
    [
      String(provider || "").trim().toLowerCase(),
      String(providerSubject || "").trim(),
      normalizedEmail,
      normalizeDisplayName(displayName),
      defaultRole,
    ]
  );

  const row = result.rows[0];
  if (row?.inserted === true) {
    await logSystemActivity({
      client,
      category: "admin",
      eventType: "user_added",
      severity: "notice",
      actorType: "system",
      subjectType: "app_user",
      subjectId: String(row.id),
      subjectLabel: row.email,
      source: "auth",
      details: {
        provider: row.provider,
        role: normalizeRole(row.role),
      },
    }).catch(() => null);
  }

  return {
    ...row,
    role: normalizeRole(row.role),
    permissions: getPermissionsForRole(row.role),
  };
}

async function listUsers(client = pool) {
  await ensureAuthTables(client);
  const { rows } = await client.query(`
    SELECT
      id,
      provider,
      provider_subject,
      email,
      display_name,
      role,
      is_active,
      created_at,
      updated_at
    FROM public.app_users
    ORDER BY email ASC
  `);

  return rows.map((row) => ({
    ...row,
    role: normalizeRole(row.role),
    invited: row.provider === "pending",
  }));
}

async function inviteUser({ email, role = "viewer", displayName = null }, client = pool) {
  await ensureAuthTables(client);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    const err = new Error("Email is required");
    err.status = 400;
    throw err;
  }

  const normalizedRole = normalizeRole(role);
  const { rows } = await client.query(
    `
      INSERT INTO public.app_users (
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active
      )
      VALUES ('pending', $1, $1, $2, $3, TRUE)
      ON CONFLICT (email)
      DO UPDATE SET
        role = EXCLUDED.role,
        display_name = COALESCE(EXCLUDED.display_name, public.app_users.display_name),
        is_active = TRUE,
        updated_at = NOW()
      RETURNING
        id,
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active,
        created_at,
        updated_at
    `,
    [normalizedEmail, normalizeDisplayName(displayName), normalizedRole]
  );

  const row = rows[0];
  await logSystemActivity({
    client,
    category: "admin",
    eventType: "user_invited",
    severity: "notice",
    actorType: "system",
    subjectType: "app_user",
    subjectId: String(row.id),
    subjectLabel: row.email,
    source: "auth",
    details: {
      role: normalizeRole(row.role),
    },
  }).catch(() => null);

  return {
    ...row,
    role: normalizeRole(row.role),
    invited: row.provider === "pending",
  };
}

async function updateUser(userId, patch = {}, client = pool) {
  await ensureAuthTables(client);
  const role = patch.role === undefined ? undefined : normalizeRole(patch.role);
  const isActive =
    patch.is_active === undefined && patch.isActive === undefined
      ? undefined
      : (patch.is_active ?? patch.isActive) !== false;

  const { rows } = await client.query(
    `
      UPDATE public.app_users
      SET
        role = COALESCE($2, role),
        is_active = COALESCE($3, is_active),
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        provider,
        provider_subject,
        email,
        display_name,
        role,
        is_active,
        created_at,
        updated_at
    `,
    [userId, role, isActive]
  );

  if (!rows[0]) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  return {
    ...rows[0],
    role: normalizeRole(rows[0].role),
    invited: rows[0].provider === "pending",
  };
}

module.exports = {
  ensureAuthTables,
  getUserById,
  getServiceTokenByHash,
  touchServiceToken,
  createAuthAuditLog,
  getAuditRequestMeta,
  upsertUserFromOidcProfile,
  listUsers,
  inviteUser,
  updateUser,
  hashServiceToken,
};
