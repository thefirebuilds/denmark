const session = require("express-session");
const { getRuntimeSecret } = require("../config/runtimeSecrets");

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

  return session({
    name: "denmark.sid",
    secret,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: getCookieSecure(),
    },
  });
}

module.exports = {
  createSessionMiddleware,
  getCookieSecure,
  getSessionSecret,
};
