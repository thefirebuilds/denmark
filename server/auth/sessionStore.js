const session = require('express-session');

// Durable sessions use a small separate pool so analytical fleet queries cannot
// consume every connection available for session reads and writes.
class PostgresSessionStore extends session.Store {
  constructor(pool, maxAge) {
    super();
    this.pool = pool;
    this.maxAge = maxAge;
    this.ready = null;
  }
  ensure() {
    if (!this.ready) this.ready = this.pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
      sid text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
    )`).catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  get(sid, callback) {
    this.ensure().then(() => this.pool.query(
      'SELECT data FROM auth_sessions WHERE sid = $1 AND expires_at > NOW()', [sid]
    )).then(result => callback(null, result.rows[0]?.data || null), callback);
  }
  set(sid, data, callback = () => {}) {
    const expires = data.cookie?.expires || new Date(Date.now() + this.maxAge).toISOString();
    this.ensure().then(() => this.pool.query(`INSERT INTO auth_sessions (sid, data, expires_at)
      VALUES ($1, $2::jsonb, $3) ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data,
      expires_at = EXCLUDED.expires_at`, [sid, JSON.stringify(data), expires]))
      .then(() => callback(null), callback);
  }
  touch(sid, data, callback = () => {}) {
    const expires = data.cookie?.expires || new Date(Date.now() + this.maxAge).toISOString();
    this.ensure().then(() => this.pool.query(
      'UPDATE auth_sessions SET expires_at = $2 WHERE sid = $1', [sid, expires]
    )).then(() => callback(null), callback);
  }
  destroy(sid, callback = () => {}) {
    this.ensure().then(() => this.pool.query('DELETE FROM auth_sessions WHERE sid = $1', [sid]))
      .then(() => callback(null), callback);
  }
}

module.exports = { PostgresSessionStore };
