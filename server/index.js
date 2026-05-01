// server/index.js

const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const express = require("express");
const session = require("express-session");
const authRoutes = require("./routes/auth");
const startScheduler = require("./services/scheduler");

const messagesRoute = require("./routes/messages");
const tripsRoutes = require("./routes/trips");
const tripSummariesRouter = require("./routes/tripSummaries");
const bouncieRoutes = require("./routes/bouncie");
const dimoRoutes = require("./routes/dimo");
const vehiclesRoutes = require("./routes/vehicles");
const maintenanceRoutes = require("./routes/maintenance");
const tollRoutes = require("./routes/tolls");
const expensesRouter = require("./routes/expenses");
const tellerRoutes = require("./routes/teller");
const metricsRouter = require("./routes/metrics");
const businessMetricsRouter = require("./routes/businessMetrics");
const marketplaceRoutes = require("./routes/marketplace");
const publicAvailabilityRouter = require("./routes/publicAvailability");
const settingsRouter = require("./routes/settings");
const databaseRouter = require("./routes/database");
const googleCalendarRoutes = require("./routes/googleCalendar");
const {
  router: notificationRoutes,
  ensureNotificationEventsTable,
} = require("./routes/notificationRoutes");
const {
  ensureVehicleFmvEstimatesTable,
} = require("./services/vehicles/fmvEstimateService");
const {
  ensureBusinessMetricsTables,
} = require("./services/metrics/businessMetricsService");
const { ensureIncomeTables } = require("./services/income/incomeService");
const { isAuthEnforced } = require("./auth/config");
const { getOidcConfig } = require("./auth/oidcProvider");
const { ensureAuthTables } = require("./auth/store");
const {
  authenticateServiceToken,
  loadRequestAuth,
  requirePermission,
  requireMethodPermissions,
} = require("./auth/middleware");

const app = express();
const PORT = process.env.PORT || 5000;
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? null : "denmark-local-dev-session-secret");

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required when NODE_ENV=production");
}

const defaultCors = cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  credentials: true,
});

const marketplaceCors = cors({
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://www.facebook.com",
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
  credentials: true,
  optionsSuccessStatus: 204,
});

const cookieSecure =
  String(process.env.AUTH_COOKIE_SECURE || "").trim() !== ""
    ? String(process.env.AUTH_COOKIE_SECURE).trim().toLowerCase() === "true"
    : process.env.NODE_ENV === "production";

app.set("trust proxy", 1);

app.use(
  session({
    name: "denmark.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
    },
  })
);

app.use(express.json({ limit: "500mb" }));
app.use(loadRequestAuth);
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
  }

  return next(err);
});

// Explicit preflight handling for marketplace routes
app.options(/^\/api\/marketplace\/.*$/, marketplaceCors);

app.get("/api/startup/status", defaultCors, requirePermission("settings.read"), (req, res) => {
  res.json(startScheduler.getStartupStatus());
});

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
  requireMethodPermissions({ GET: "vehicles.read", POST: "vehicles.write", PATCH: "vehicles.write" }),
  vehiclesRoutes
);
app.use(
  "/api",
  defaultCors,
  requireMethodPermissions({ GET: "maintenance.read", POST: "maintenance.write", DELETE: "maintenance.write" }),
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
  "/api/metrics/business",
  defaultCors,
  requireMethodPermissions({ GET: "business.read", PUT: "business.write", POST: "business.write" }),
  businessMetricsRouter
);
app.use(
  "/api/metrics",
  defaultCors,
  requireMethodPermissions({ GET: "metrics.read", PUT: "metrics.write", POST: "metrics.write" }),
  metricsRouter
);
app.use(
  "/api/marketplace",
  marketplaceCors,
  requireMethodPermissions({ GET: "marketplace.read", POST: "marketplace.write", PUT: "marketplace.write", PATCH: "marketplace.write" }),
  marketplaceRoutes
);
app.use(
  "/api/settings",
  defaultCors,
  requireMethodPermissions({ GET: "settings.read", PUT: "settings.write" }),
  settingsRouter
);
app.use("/api/database", defaultCors, requirePermission("database.admin"), databaseRouter);
app.use(
  "/api/integrations/google-calendar",
  defaultCors,
  authenticateServiceToken({ optional: true }),
  requirePermission("calendar.write"),
  googleCalendarRoutes
);
app.use("/api/notifications", notificationRoutes);
app.use("/api", publicAvailabilityRouter);

app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    envPort: process.env.PORT || null,
    finalPort: PORT,
    message: "This is the Denmark backend",
  });
});

Promise.all([
  ensureNotificationEventsTable(),
  ensureVehicleFmvEstimatesTable(),
  ensureBusinessMetricsTables(),
  ensureIncomeTables(),
  ensureAuthTables(),
])
  .then(() => {
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
        } | redirect: ${oidcConfig.redirectUri || "(not set)"}`
      );
      startScheduler();
    });
  })
  .catch((err) => {
    console.error("[server] failed to initialize startup tables:", err);
    process.exit(1);
  });
