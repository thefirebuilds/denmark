const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pool = require("../db");
const { getPermissionsForRole, normalizeRole } = require("./permissions");

let ensureAuthTablesPromise = null;

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
      const migrationPath = path.resolve(
        __dirname,
        "../db/migrations/2026_add_auth_tables.sql"
      );
      const sql = fs.readFileSync(migrationPath, "utf8");
      await client.query(sql);
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
      ON CONFLICT (provider, provider_subject)
      DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
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
    [
      String(provider || "").trim().toLowerCase(),
      String(providerSubject || "").trim(),
      normalizedEmail,
      normalizeDisplayName(displayName),
      defaultRole,
    ]
  );

  const row = result.rows[0];
  return {
    ...row,
    role: normalizeRole(row.role),
    permissions: getPermissionsForRole(row.role),
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
  hashServiceToken,
};
