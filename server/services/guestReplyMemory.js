const pool = require('../db');
let ready;
function ensure() {
  if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS guest_reply_examples (
    id bigserial PRIMARY KEY, message_key text UNIQUE NOT NULL,
    category text NOT NULL, guest_message text NOT NULL, reply text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT NOW()
  )`).catch(error => { ready = null; throw error; });
  return ready;
}
function validateText(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw Object.assign(new Error('Invalid reply profile or example'), { statusCode: 400 });
  }
  return value.trim();
}
async function getProfile() {
  await ensure();
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key = 'guestReply.profile'");
  const examples = await pool.query('SELECT * FROM guest_reply_examples ORDER BY updated_at DESC LIMIT 100');
  return { guidance: rows[0]?.value?.guidance || '', examples: examples.rows };
}
async function saveProfile(body) {
  const guidance = validateText(body.guidance, 6000);
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('guestReply.profile', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ guidance })]);
  return { guidance };
}
async function saveExample(body) {
  const values = [validateText(body.messageKey, 240, true), validateText(body.category, 100, true),
    validateText(body.guestMessage, 4000, true), validateText(body.reply, 6000, true)];
  await ensure();
  const { rows } = await pool.query(`INSERT INTO guest_reply_examples (message_key, category, guest_message, reply)
    VALUES ($1, $2, $3, $4) ON CONFLICT (message_key) DO UPDATE SET
    category = EXCLUDED.category, guest_message = EXCLUDED.guest_message, reply = EXCLUDED.reply,
    updated_at = NOW() RETURNING *`, values);
  return rows[0];
}
async function deleteExample(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('Invalid example ID'), { statusCode: 400 });
  await ensure();
  await pool.query('DELETE FROM guest_reply_examples WHERE id = $1', [id]);
}
async function getReplyContext(input) {
  await ensure();
  const profile = await pool.query("SELECT value FROM app_settings WHERE key = 'guestReply.profile'");
  const terms = [...new Set(String(input.latestMessage || '').toLowerCase().match(/[a-z]{4,}/g) || [])]
    .filter(word => !['that', 'this', 'have', 'with', 'your', 'just', 'thanks', 'would'].includes(word)).slice(0, 24);
  const examples = await pool.query(`SELECT category, guest_message, reply FROM guest_reply_examples
    WHERE category = $1 OR EXISTS (SELECT 1 FROM unnest($2::text[]) term
      WHERE strpos(lower(guest_message), term) > 0)
    ORDER BY (category = $1) DESC,
      (SELECT count(*) FROM unnest($2::text[]) term WHERE strpos(lower(guest_message), term) > 0) DESC,
      updated_at DESC LIMIT 4`, [input.category || 'general', terms]);
  return { guidance: profile.rows[0]?.value?.guidance || '', examples: examples.rows };
}
module.exports = { getProfile, saveProfile, saveExample, deleteExample, getReplyContext };
