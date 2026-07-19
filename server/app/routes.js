const authRoutes = require("../routes/auth");
const messagesRoute = require("../routes/messages");
const tripsRoutes = require("../routes/trips");
const tripSummariesRouter = require("../routes/tripSummaries");
const bouncieRoutes = require("../routes/bouncie");
const dimoRoutes = require("../routes/dimo");
const vehiclesRoutes = require("../routes/vehicles");
const maintenanceRoutes = require("../routes/maintenance");
const tollRoutes = require("../routes/tolls");
const expensesRouter = require("../routes/expenses");
const tellerRoutes = require("../routes/teller");
const plaidRoutes = require("../routes/plaid");
const metricsRouter = require("../routes/metrics");
const businessMetricsRouter = require("../routes/businessMetrics");
const marketplaceRoutes = require("../routes/marketplace");
const publicAvailabilityRouter = require("../routes/publicAvailability");
const settingsRouter = require("../routes/settings");
const databaseRouter = require("../routes/database");
const systemActivityRouter = require("../routes/systemActivity");
const googleCalendarRoutes = require("../routes/googleCalendar");
const {
  authenticateServiceToken,
  requirePermission,
  requireMethodPermissions,
} = require("../auth/middleware");
const { defaultCors, marketplaceCors } = require("./cors");
const {
  allowMarketplaceExtensionWrite,
  requireMarketplacePermissions,
} = require("./marketplaceExtensionAuth");

function registerApiRoutes(app) {
  app.use(
    "/api/marketplace",
    marketplaceCors,
    allowMarketplaceExtensionWrite,
    requireMarketplacePermissions,
    marketplaceRoutes
  );

  app.use("/api", defaultCors, authRoutes);
  app.use(
    "/api/messages",
    defaultCors,
    requireMethodPermissions({ GET: "messages.read", PATCH: "messages.write" }),
    messagesRoute
  );
  app.use(
    "/api/trips",
    defaultCors,
    requireMethodPermissions({ GET: "trips.read", PATCH: "trips.write" }),
    tripsRoutes
  );
  app.use(
    "/api/trip-summaries",
    defaultCors,
    requireMethodPermissions({
      GET: "trip_summaries.read",
      POST: "trip_summaries.write",
      PATCH: "trip_summaries.write",
      DELETE: "trip_summaries.write",
    }),
    tripSummariesRouter
  );
  app.use("/api/bouncie", defaultCors, requirePermission("telemetry.read"), bouncieRoutes);
  app.use("/api/dimo", defaultCors, requirePermission("telemetry.read"), dimoRoutes);
  app.use(
    "/api/vehicles",
    defaultCors,
    requireMethodPermissions({
      GET: "vehicles.read",
      POST: "vehicles.write",
      PATCH: "vehicles.write",
    }),
    vehiclesRoutes
  );
  app.use(
    "/api",
    defaultCors,
    requireMethodPermissions({
      GET: "maintenance.read",
      POST: "maintenance.write",
      PUT: "maintenance.write",
      PATCH: "maintenance.write",
      DELETE: "maintenance.write",
    }),
    maintenanceRoutes
  );
  app.use(
    "/api/tolls",
    defaultCors,
    authenticateServiceToken({ optional: true }),
    requireMethodPermissions({ POST: "tolls.sync", GET: "tolls.read" }),
    tollRoutes
  );
  app.use(
    "/api/expenses",
    defaultCors,
    requireMethodPermissions({
      GET: "expenses.read",
      POST: "expenses.write",
      PUT: "expenses.write",
      DELETE: "expenses.write",
    }),
    expensesRouter
  );
  app.use(
    "/api/teller",
    defaultCors,
    requireMethodPermissions({ GET: "expenses.read", POST: "expenses.write" }),
    tellerRoutes
  );
  app.use(
    "/api/plaid",
    defaultCors,
    requireMethodPermissions({ GET: "expenses.read", POST: "expenses.write", PUT: "settings.write", DELETE: "settings.write" }),
    plaidRoutes
  );
  app.use(
    "/api/metrics/business",
    defaultCors,
    requireMethodPermissions({
      GET: "business.read",
      PUT: "business.write",
      POST: "business.write",
    }),
    businessMetricsRouter
  );
  app.use(
    "/api/metrics",
    defaultCors,
    requireMethodPermissions({
      GET: "metrics.read",
      PUT: "metrics.write",
      POST: "metrics.write",
    }),
    metricsRouter
  );
  app.use(
    "/api/settings",
    defaultCors,
    requireMethodPermissions({
      GET: "settings.read",
      PUT: "settings.write",
      POST: "settings.write",
    }),
    settingsRouter
  );
  app.use("/api/database", defaultCors, requirePermission("database.admin"), databaseRouter);
  app.use(
    "/api/system-activity",
    defaultCors,
    requirePermission("settings.read"),
    systemActivityRouter
  );
  app.use(
    "/api/integrations/google-calendar",
    defaultCors,
    authenticateServiceToken({ optional: true }),
    requirePermission("calendar.write"),
    googleCalendarRoutes
  );

  app.use("/api", publicAvailabilityRouter);
}

module.exports = {
  registerApiRoutes,
};
