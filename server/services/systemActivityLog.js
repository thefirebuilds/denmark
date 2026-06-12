const pool = require("../db");

const VALID_CATEGORIES = new Set([
  "auth",
  "security",
  "integration",
  "database",
  "automation",
  "admin",
  "system",
]);

const VALID_SEVERITIES = new Set(["debug", "info", "notice", "warning", "error"]);

let ensureSystemActivityLogPromise = null;

function normalizeCategory(value) {
  const category = String(value || "").trim().toLowerCase();
  return VALID_CATEGORIES.has(category) ? category : "system";
}

function normalizeSeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  return VALID_SEVERITIES.has(severity) ? severity : "info";
}

function getPrincipalFromRequest(req) {
  const auth = req?.auth || null;
  if (!auth) return {};

  if (auth.kind === "user") {
    return {
      actorType: "user",
      actorUserId: auth.userId || null,
      actorLabel: auth.email || auth.displayName || null,
    };
  }

  if (auth.kind === "service") {
    return {
      actorType: "service",
      actorServiceTokenId: auth.serviceTokenId || null,
      actorLabel: auth.serviceTokenName || null,
    };
  }

  return {
    actorType: auth.kind || "system",
    actorLabel: auth.email || auth.displayName || auth.serviceTokenName || null,
  };
}

function getRequestMeta(req) {
  if (!req) return {};

  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();

  return {
    ipAddress: forwardedFor || req.ip || req.socket?.remoteAddress || null,
    userAgent: typeof req.get === "function" ? req.get("user-agent") || null : null,
    requestMethod: req.method || null,
    requestPath: req.originalUrl || req.url || null,
    ...getPrincipalFromRequest(req),
  };
}

async function ensureSystemActivityLogTable(client = pool) {
  if (!ensureSystemActivityLogPromise) {
    ensureSystemActivityLogPromise = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.system_activity_log (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          occurred_at timestamp with time zone DEFAULT now() NOT NULL,
          category text NOT NULL,
          event_type text NOT NULL,
          severity text DEFAULT 'info'::text NOT NULL,
          actor_type text DEFAULT 'system'::text NOT NULL,
          actor_user_id bigint,
          actor_service_token_id bigint,
          actor_label text,
          subject_type text,
          subject_id text,
          subject_label text,
          source text,
          request_method text,
          request_path text,
          ip_address text,
          user_agent text,
          outcome text DEFAULT 'success'::text NOT NULL,
          details jsonb DEFAULT '{}'::jsonb NOT NULL,
          CONSTRAINT system_activity_log_category_check
            CHECK (category = ANY (ARRAY[
              'auth'::text,
              'security'::text,
              'integration'::text,
              'database'::text,
              'automation'::text,
              'admin'::text,
              'system'::text
            ])),
          CONSTRAINT system_activity_log_severity_check
            CHECK (severity = ANY (ARRAY[
              'debug'::text,
              'info'::text,
              'notice'::text,
              'warning'::text,
              'error'::text
            ]))
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_system_activity_log_occurred_at
          ON public.system_activity_log (occurred_at DESC)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_system_activity_log_category_event
          ON public.system_activity_log (category, event_type, occurred_at DESC)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_system_activity_log_actor_user
          ON public.system_activity_log (actor_user_id, occurred_at DESC)
          WHERE actor_user_id IS NOT NULL
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_system_activity_log_subject
          ON public.system_activity_log (subject_type, subject_id, occurred_at DESC)
          WHERE subject_type IS NOT NULL
      `);
    })().catch((error) => {
      ensureSystemActivityLogPromise = null;
      throw error;
    });
  }

  return ensureSystemActivityLogPromise;
}

async function logSystemActivity(event = {}) {
  const client = event.client || pool;
  const eventType = String(event.eventType || event.event_type || "").trim();

  if (!eventType) {
    throw new Error("eventType is required for system activity logging");
  }

  await ensureSystemActivityLogTable(client);

  const values = {
    category: normalizeCategory(event.category),
    eventType,
    severity: normalizeSeverity(event.severity),
    actorType: String(event.actorType || event.actor_type || "system").trim() || "system",
    actorUserId: event.actorUserId ?? event.actor_user_id ?? null,
    actorServiceTokenId:
      event.actorServiceTokenId ?? event.actor_service_token_id ?? null,
    actorLabel: event.actorLabel ?? event.actor_label ?? null,
    subjectType: event.subjectType ?? event.subject_type ?? null,
    subjectId: event.subjectId ?? event.subject_id ?? null,
    subjectLabel: event.subjectLabel ?? event.subject_label ?? null,
    source: event.source || "denmark",
    requestMethod: event.requestMethod ?? event.request_method ?? null,
    requestPath: event.requestPath ?? event.request_path ?? null,
    ipAddress: event.ipAddress ?? event.ip_address ?? null,
    userAgent: event.userAgent ?? event.user_agent ?? null,
    outcome: String(event.outcome || "success").trim() || "success",
    details: event.details || {},
  };

  const result = await client.query(
    `
      INSERT INTO public.system_activity_log (
        category,
        event_type,
        severity,
        actor_type,
        actor_user_id,
        actor_service_token_id,
        actor_label,
        subject_type,
        subject_id,
        subject_label,
        source,
        request_method,
        request_path,
        ip_address,
        user_agent,
        outcome,
        details
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17::jsonb
      )
      RETURNING id, occurred_at
    `,
    [
      values.category,
      values.eventType,
      values.severity,
      values.actorType,
      values.actorUserId,
      values.actorServiceTokenId,
      values.actorLabel,
      values.subjectType,
      values.subjectId,
      values.subjectLabel,
      values.source,
      values.requestMethod,
      values.requestPath,
      values.ipAddress,
      values.userAgent,
      values.outcome,
      JSON.stringify(values.details),
    ]
  );

  return result.rows[0] || null;
}

async function logRequestActivity(req, event = {}) {
  return logSystemActivity({
    ...getRequestMeta(req),
    ...event,
  });
}

async function listSystemActivity(options = {}) {
  await ensureSystemActivityLogTable();

  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const filters = [];
  const params = [];

  function addFilter(sql, value) {
    params.push(value);
    filters.push(sql.replace("?", `$${params.length}`));
  }

  if (options.category) addFilter("category = ?", normalizeCategory(options.category));
  if (options.eventType) addFilter("event_type = ?", String(options.eventType));
  if (options.actorUserId) addFilter("actor_user_id = ?", options.actorUserId);
  if (options.subjectType) addFilter("subject_type = ?", String(options.subjectType));
  if (options.subjectId) addFilter("subject_id = ?", String(options.subjectId));
  if (options.since) addFilter("occurred_at >= ?", options.since);

  params.push(limit);

  const result = await pool.query(
    `
      SELECT
        id,
        occurred_at,
        category,
        event_type,
        severity,
        actor_type,
        actor_user_id,
        actor_service_token_id,
        actor_label,
        subject_type,
        subject_id,
        subject_label,
        source,
        request_method,
        request_path,
        ip_address,
        user_agent,
        outcome,
        details
      FROM public.system_activity_log
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

module.exports = {
  ensureSystemActivityLogTable,
  getRequestMeta,
  listSystemActivity,
  logRequestActivity,
  logSystemActivity,
};
