const pool = require("../../db");
const { encrypt, decrypt } = require("./tokenCrypto");

async function ensureGoogleCalendarConnectionHealthColumns(client = pool) {
  await client.query(`
    ALTER TABLE google_calendar_connections
      ADD COLUMN IF NOT EXISTS token_status text,
      ADD COLUMN IF NOT EXISTS token_error text,
      ADD COLUMN IF NOT EXISTS token_checked_at timestamptz
  `);
}

async function findGoogleCalendarConnectionForWrite(userId = null) {
  if (userId !== null && userId !== undefined) {
    const exact = await pool.query(
      `
        SELECT id
        FROM google_calendar_connections
        WHERE user_id IS NOT DISTINCT FROM $1
        LIMIT 1
      `,
      [userId]
    );

    return exact.rows[0] || null;
  }

  const tenantScoped = await pool.query(`
    SELECT id
    FROM google_calendar_connections
    ORDER BY
      CASE
        WHEN user_id IS NOT NULL AND calendar_id IS NOT NULL THEN 0
        WHEN user_id IS NOT NULL THEN 1
        WHEN calendar_id IS NOT NULL THEN 2
        ELSE 3
      END,
      updated_at DESC NULLS LAST,
      id DESC
    LIMIT 1
  `);

  return tenantScoped.rows[0] || null;
}

async function upsertGoogleCalendarConnection({
  userId = null,
  googleEmail = null,
  refreshToken,
  scopeString = null,
}) {
  const encryptedToken = encrypt(refreshToken);
  const fallbackCalendar = await getFallbackSelectedCalendar(userId);

  const existing = await findGoogleCalendarConnectionForWrite(userId);

  if (existing) {
    const id = existing.id;

    await pool.query(
      `
        UPDATE google_calendar_connections
        SET google_email = COALESCE($2, google_email),
            refresh_token_encrypted = $3,
            scope_string = COALESCE($4, scope_string),
            calendar_id = COALESCE(calendar_id, $5),
            calendar_summary = COALESCE(calendar_summary, $6),
            token_status = 'valid',
            token_error = NULL,
            token_checked_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        id,
        googleEmail,
        encryptedToken,
        scopeString,
        fallbackCalendar?.calendar_id || null,
        fallbackCalendar?.calendar_summary || null,
      ]
    );

    return id;
  }

  const inserted = await pool.query(
    `
      INSERT INTO google_calendar_connections (
        user_id,
        google_email,
        refresh_token_encrypted,
        scope_string,
        calendar_id,
        calendar_summary,
        token_status,
        token_error,
        token_checked_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'valid', NULL, NOW())
      RETURNING id
    `,
    [
      userId,
      googleEmail,
      encryptedToken,
      scopeString,
      fallbackCalendar?.calendar_id || null,
      fallbackCalendar?.calendar_summary || null,
    ]
  );

  return inserted.rows[0].id;
}

async function markGoogleCalendarConnectionHealth({
  connectionId,
  tokenStatus,
  tokenError = null,
}) {
  if (!connectionId || !tokenStatus) return null;

  const result = await pool.query(
    `
      UPDATE google_calendar_connections
      SET token_status = $2,
          token_error = $3,
          token_checked_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [connectionId, tokenStatus, tokenError]
  );

  return result.rows[0] || null;
}

async function getFallbackSelectedCalendar(userId = null) {
  const result = await pool.query(
    `
      SELECT calendar_id, calendar_summary
      FROM google_calendar_connections
      WHERE calendar_id IS NOT NULL
        AND user_id IS DISTINCT FROM $1
      ORDER BY
        CASE WHEN user_id IS NULL THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getGoogleCalendarConnection(userId = null) {
  const result = await pool.query(
    `
      SELECT *
      FROM google_calendar_connections
      WHERE user_id IS NOT DISTINCT FROM $1
      LIMIT 1
    `,
    [userId]
  );

  let row = result.rows[0] || null;

  if (!row || !row.calendar_id) {
    const fallback = await pool.query(
      `
        SELECT *
        FROM google_calendar_connections
        WHERE refresh_token_encrypted IS NOT NULL
          AND calendar_id IS NOT NULL
          AND user_id IS DISTINCT FROM $1
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [userId]
    );

    row = fallback.rows[0] || row;
  }

  if (!row) return null;

  return {
    ...row,
    refresh_token: decrypt(row.refresh_token_encrypted),
  };
}

async function saveSelectedCalendar({
  userId = null,
  calendarId,
  calendarSummary,
}) {
  const existing = await findGoogleCalendarConnectionForWrite(userId);
  if (!existing) return null;

  const result = await pool.query(
    `
      UPDATE google_calendar_connections
      SET calendar_id = $2,
          calendar_summary = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [existing.id, calendarId, calendarSummary]
  );

  return result.rows[0] || null;
}

async function listGoogleCalendarSyncTargets() {
  const result = await pool.query(`
    SELECT id, user_id, google_email, calendar_id, calendar_summary, updated_at
    FROM google_calendar_connections
    WHERE refresh_token_encrypted IS NOT NULL
      AND calendar_id IS NOT NULL
      AND COALESCE(token_status, 'valid') <> 'invalid'
    ORDER BY
      CASE WHEN user_id IS NULL THEN 1 ELSE 0 END,
      updated_at DESC
  `);

  const userScoped = result.rows.filter((row) => row.user_id !== null);
  return userScoped.length ? userScoped : result.rows;
}

module.exports = {
  ensureGoogleCalendarConnectionHealthColumns,
  upsertGoogleCalendarConnection,
  getGoogleCalendarConnection,
  markGoogleCalendarConnectionHealth,
  saveSelectedCalendar,
  listGoogleCalendarSyncTargets,
};
