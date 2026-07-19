const express = require("express");
const { databaseUnavailableMiddleware } = require("../dbHealth");
const { loadRequestAuth } = require("../auth/middleware");
const {
  router: notificationRoutes,
} = require("../routes/notificationRoutes");
const {
  createProtectedHealthRouter,
  createPublicHealthRouter,
} = require("./healthRoutes");
const { createSessionMiddleware } = require("./session");
const { defaultCors, marketplaceCors } = require("./cors");
const { registerApiRoutes } = require("./routes");
const { installStaticClient } = require("./staticClient");
const {
  appErrorHandler,
  jsonParseErrorHandler,
} = require("./errorHandlers");
const plaidWebhookRoutes = require("../routes/plaidWebhook");

function createApp({ port }) {
  const app = express();
  app.set("trust proxy", 1);

  // Marketplace content-script requests need CORS even when later gates fail.
  app.use("/api/marketplace", marketplaceCors);
  app.options(/^\/api\/marketplace(?:\/.*)?$/, marketplaceCors);

  app.use(createSessionMiddleware());
  app.use(
    "/api/webhooks/plaid",
    express.json({ limit: "256kb" }),
    plaidWebhookRoutes
  );
  app.use(express.json({ limit: "500mb" }));
  app.use(createPublicHealthRouter({ port }));
  app.use("/api", databaseUnavailableMiddleware);
  // The Android notification bridge intentionally sits before user auth.
  app.use("/api/notifications", defaultCors, notificationRoutes);

  app.use(loadRequestAuth);
  app.use(jsonParseErrorHandler);
  app.use(createProtectedHealthRouter());
  registerApiRoutes(app);
  installStaticClient(app);
  app.use(appErrorHandler);

  return app;
}

module.exports = {
  createApp,
};
