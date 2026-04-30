const pool = require("../../db");
const { encrypt, decrypt } = require("./tokenCrypto");

async function upsertGoogleCalendarConnection({
  userId = null,
  googleEmail = null,
  refreshToken,
  scopeString = null,
}) {
  const encryptedToken = encrypt(refreshToken);
  const fallbackCalendar = await getFallbackSelectedCalendar(userId);

  const existing = await pool.query(
    `
      SELECT id
      FROM google_calendar_connections
      WHERE user_id IS NOT DISTINCT FROM $1
      LIMIT 1
    `,
    [userId]
  );

  if (existing.rows.length) {
    const id = existing.rows[0].id;

    await pool.query(
      `
        UPDATE google_calendar_connections
        SET google_email = COALESCE($2, google_email),
            refresh_token_encrypted = $3,
            scope_string = COALESCE($4, scope_string),
            calendar_id = COALESCE(calendar_id, $5),
            calendar_summary = COALESCE(calendar_summary, $6),
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
        calendar_summary
      )
      VALUES ($1, $2, $3, $4, $5, $6)
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

  if (!result.rows.length) return null;

  const row = result.rows[0];

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
  const result = await pool.query(
    `
      UPDATE google_calendar_connections
      SET calendar_id = $2,
          calendar_summary = $3,
          updated_at = NOW()
      WHERE user_id IS NOT DISTINCT FROM $1
      RETURNING *
    `,
    [userId, calendarId, calendarSummary]
  );

  return result.rows[0] || null;
}

async function listGoogleCalendarSyncTargets() {
  const result = await pool.query(`
    SELECT id, user_id, google_email, calendar_id, calendar_summary, updated_at
    FROM google_calendar_connections
    WHERE refresh_token_encrypted IS NOT NULL
      AND calendar_id IS NOT NULL
    ORDER BY
      CASE WHEN user_id IS NULL THEN 1 ELSE 0 END,
      updated_at DESC
  `);

  const userScoped = result.rows.filter((row) => row.user_id !== null);
  return userScoped.length ? userScoped : result.rows;
}

module.exports = {
  upsertGoogleCalendarConnection,
  getGoogleCalendarConnection,
  saveSelectedCalendar,
  listGoogleCalendarSyncTargets,
};
