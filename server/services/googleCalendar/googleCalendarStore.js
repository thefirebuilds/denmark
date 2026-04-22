const pool = require("../../db");
const { encrypt, decrypt } = require("./tokenCrypto");

async function upsertGoogleCalendarConnection({
  userId = null,
  googleEmail = null,
  refreshToken,
  scopeString = null,
}) {
  const encryptedToken = encrypt(refreshToken);

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
            updated_at = NOW()
        WHERE id = $1
      `,
      [id, googleEmail, encryptedToken, scopeString]
    );

    return id;
  }

  const inserted = await pool.query(
    `
      INSERT INTO google_calendar_connections (
        user_id,
        google_email,
        refresh_token_encrypted,
        scope_string
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [userId, googleEmail, encryptedToken, scopeString]
  );

  return inserted.rows[0].id;
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

module.exports = {
  upsertGoogleCalendarConnection,
  getGoogleCalendarConnection,
  saveSelectedCalendar,
};
