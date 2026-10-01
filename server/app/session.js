const session = require("express-session");
const { getRuntimeSecret } = require("../config/runtimeSecrets");
const { PostgresSessionStore } = require('../auth/sessionStore');
let sessionStore;

function getSessionSecret() {
  return (
    getRuntimeSecret("SESSION_SECRET") ||
    (process.env.NODE_ENV === "production"
      ? null
      : "denmark-local-dev-session-secret")
  );
}

function getCookieSecure() {
  return String(process.env.AUTH_COOKIE_SECURE || "").trim() !== ""
    ? String(process.env.AUTH_COOKIE_SECURE).trim().toLowerCase() === "true"
    : process.env.NODE_ENV === "production";
}

function createSessionMiddleware() {
  const secret = getSessionSecret();

  if (!secret) {
    throw new Error("SESSION_SECRET is required when NODE_ENV=production");
  }

  const maxAge = 7 * 24 * 60 * 60 * 1000;
  if (!sessionStore) {
    const { Pool } = require('pg');
    const applicationPool = require('../db');
    // pg-pool deliberately makes the password non-enumerable.
    const pool = new Pool({ ...applicationPool.options, password: applicationPool.options.password, max: 2,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
    pool.on('error', error => console.warn('[session] database connection error:', error.message));
    sessionStore = new PostgresSessionStore(pool, maxAge);
    const cleanup = setInterval(() => {
      sessionStore.ensure().then(() => pool.query('DELETE FROM auth_sessions WHERE expires_at <= NOW()'))
        .catch(error => console.warn('[session] cleanup failed:', error.message));
    }, 60 * 60 * 1000);
    cleanup.unref();
  }
  return session({
    store: sessionStore,
    name: "denmark.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: getCookieSecure(),
      maxAge,
    },
  });
}

module.exports = {
  createSessionMiddleware,
  getCookieSecure,
  getSessionSecret,
};
