require("./bootstrapWarnings");

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const {
  installConsoleLogBuffer,
} = require("./services/serverLogBuffer");
installConsoleLogBuffer();

const { isAuthEnforced } = require("./auth/config");
const { getOidcConfig } = require("./auth/oidcProvider");
const { createApp } = require("./app/createApp");
const {
  initializeStartupTablesWithRetry,
} = require("./startup/startupState");

process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection:", reason);
});

process.on("SIGTERM", () => {
  console.warn("[server] received SIGTERM");
});

process.on("SIGINT", () => {
  console.warn("[server] received SIGINT");
});

const PORT = process.env.PORT || 5000;
const app = createApp({ port: PORT });

app.listen(PORT, () => {
  const authEnforced = isAuthEnforced();
  const oidcConfig = getOidcConfig();

  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(
    `[server] auth enforcement: ${authEnforced ? "ENABLED" : "DISABLED"}`
  );
  console.log(
    `[server] auth provider: ${oidcConfig.providerName || "oidc"} | issuer: ${
      oidcConfig.issuerUrl || "(not set)"
    } | redirect: app_settings/auth.public_base_url + auth.google_callback_path`
  );

  void initializeStartupTablesWithRetry();
});
