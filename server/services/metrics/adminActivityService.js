const pool = require('../../db');
let schemaPromise;

function ensureAdminActivitySchema(db = pool) {
  if (!schemaPromise) schemaPromise = db.query(`
    CREATE TABLE IF NOT EXISTS utility_admin_activity (
      session_id uuid NOT NULL,
      panel text NOT NULL,
      activity_date date NOT NULL,
      seconds double precision NOT NULL CHECK (seconds >= 0),
      PRIMARY KEY (session_id, panel, activity_date)
    )
  `).then(() => db.query(`CREATE INDEX IF NOT EXISTS utility_admin_activity_date_idx
    ON utility_admin_activity (activity_date)`))
    .catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function validateActivity(body) {
  const { session_id, panel, activity_date, seconds } = body || {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session_id || '') ||
      typeof panel !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(panel) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(activity_date || '') ||
      !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
    throw Object.assign(new Error('Invalid admin activity'), { status: 400 });
  }
  return [session_id, panel, activity_date, seconds];
}

async function saveAdminActivity(body, db = pool) {
  const values = validateActivity(body);
  await ensureAdminActivitySchema(db);
  // Cumulative counters make retries and out-of-order requests idempotent.
  await db.query(`INSERT INTO utility_admin_activity
    (session_id, panel, activity_date, seconds) VALUES ($1, $2, $3, $4)
    ON CONFLICT (session_id, panel, activity_date) DO UPDATE
    SET seconds = GREATEST(utility_admin_activity.seconds, EXCLUDED.seconds)`, values);
}

async function getAdminActivityHours(start, end, db = pool) {
  await ensureAdminActivitySchema(db);
  const { rows } = await db.query(`SELECT COALESCE(SUM(seconds), 0) / 3600 AS hours
    FROM utility_admin_activity
    WHERE ($1::date IS NULL OR activity_date >= $1::date)
      AND ($2::date IS NULL OR activity_date <= $2::date)`, [start, end]);
  return Number(rows[0]?.hours || 0);
}

module.exports = { ensureAdminActivitySchema, saveAdminActivity, getAdminActivityHours, validateActivity };
