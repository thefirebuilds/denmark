// server/index.js

const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const express = require("express");
const session = require("express-session");
const {
  getLogEntries,
  installConsoleLogBuffer,
} = require("./services/serverLogBuffer");
installConsoleLogBuffer();
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
const systemActivityRouter = require("./routes/systemActivity");
const googleCalendarRoutes = require("./routes/googleCalendar");
const {
  router: notificationRoutes,
  ensureNotificationEventsTable,
} = require("./routes/notificationRoutes");
const {
  ensureGoogleCalendarConnectionHealthColumns,
} = require("./services/googleCalendar/googleCalendarStore");
const {
  ensureVehicleFmvEstimatesTable,
} = require("./services/vehicles/fmvEstimateService");
const {
  ensureBusinessMetricsTables,
} = require("./services/metrics/businessMetricsService");
const {
  ensureMetricsIndexes,
} = require("./services/metrics/metricsIndexes");
const {
  ensureVehicleOdometerRollupTable,
} = require("./services/vehicles/odometerRollupService");
const {
  ensureVehicleAliasesTable,
} = require("./services/vehicles/vehicleAliases");
const {
  ensureVehicleIdentityConstraints,
} = require("./services/vehicles/vehicleIdentityConstraints");
const {
  ensureApplicationUniqueConstraints,
} = require("./services/database/applicationUniqueConstraints");
const {
  ensureSystemActivityLogTable,
} = require("./services/systemActivityLog");
const { ensureIncomeTables } = require("./services/income/incomeService");
const { ensureFleetAlertTables } = require("./services/alerts/fleetAlerts");
const {
  ensureAuthPublicUrlSettings,
} = require("./services/authPublicUrlSettings");
const { isAuthEnforced } = require("./auth/config");
const { getOidcConfig } = require("./auth/oidcProvider");
const { ensureAuthTables } = require("./auth/store");
const {
  RETRY_AFTER_SECONDS,
  buildDatabaseUnavailablePayload,
  databaseUnavailableMiddleware,
  getDatabaseHealth,
  isDatabaseConnectionError,
  isDatabaseSchemaError,
  markDatabaseReady,
  markDatabaseSchemaMissing,
  markDatabaseUnavailable,
  onDatabaseUnavailable,
  summarizeError,
} = require("./dbHealth");
const {
  authenticateServiceToken,
  loadRequestAuth,
  requirePermission,
  requireMethodPermissions,
} = require("./auth/middleware");

const app = express();
const PORT = process.env.PORT || 5000;
app.set("trust proxy", 1);
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production" ? null : "denmark-local-dev-session-secret");

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required when NODE_ENV=production");
}

const defaultCors = cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  credentials: true,
  exposedHeaders: ["Server-Timing", "X-Denmark-Route"],
});

const marketplaceAllowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "https://www.facebook.com",
];

function isMarketplaceExtensionOrigin(origin) {
  if (!origin) return true;
  if (marketplaceAllowedOrigins.includes(origin)) return true;
  return /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);
}

const marketplaceCors = cors({
  origin(origin, callback) {
    callback(null, isMarketplaceExtensionOrigin(origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Authorization",
    "X-Service-Token",
    "X-Denmark-Marketplace-Extension",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
});

const marketplaceExtensionWritePaths = new Set([
  "/enrich",
  "/ingest",
  "/listings/ignoreByUrl",
]);

function isMarketplaceExtensionWriteRequest(req) {
  const extensionHeader = String(req.get("x-denmark-marketplace-extension") || "").trim();
  const origin = String(req.get("origin") || "").trim();
  const originalPath = String(req.originalUrl || "").split("?")[0];
  const mountedPath = String(req.path || "").split("?")[0];
  const marketplacePath = originalPath.replace(/^\/api\/marketplace/i, "") || mountedPath;
  const hasExtensionMarker = extensionHeader === "1";
  const hasLegacyExtensionOrigin =
    origin === "https://www.facebook.com" ||
    /^chrome-extension:\/\/[a-z0-9]+$/i.test(origin);

  return (
    req.method === "POST" &&
    (marketplaceExtensionWritePaths.has(mountedPath) ||
      marketplaceExtensionWritePaths.has(marketplacePath)) &&
    (hasExtensionMarker || hasLegacyExtensionOrigin) &&
    isMarketplaceExtensionOrigin(origin)
  );
}

function allowMarketplaceExtensionWrite(req, res, next) {
  if (isMarketplaceExtensionWriteRequest(req)) {
    req.auth = {
      kind: "marketplace_extension",
      role: "owner",
      permissions: ["*"],
      isActive: true,
    };
  }

  return next();
}

function requireMarketplacePermissions(req, res, next) {
  if (isMarketplaceExtensionWriteRequest(req)) return next();
  return requireMethodPermissions({
    GET: "marketplace.read",
    POST: "marketplace.write",
    PUT: "marketplace.write",
    PATCH: "marketplace.write",
  })(req, res, next);
}

const cookieSecure =
  String(process.env.AUTH_COOKIE_SECURE || "").trim() !== ""
    ? String(process.env.AUTH_COOKIE_SECURE).trim().toLowerCase() === "true"
    : process.env.NODE_ENV === "production";

app.set("trust proxy", 1);

// Marketplace requests can originate from Facebook content scripts. Apply this
// before JSON parsing/database/auth gates so any error still includes CORS.
app.use("/api/marketplace", marketplaceCors);
app.options(/^\/api\/marketplace(?:\/.*)?$/, marketplaceCors);

app.use(
  session({
    name: "denmark.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
    },
  })
);

app.use(express.json({ limit: "500mb" }));
app.get("/api/health", defaultCors, (req, res) => {
  if (!startupTablesReady && !startupTablesInitializing) {
    void initializeStartupTablesWithRetry();
  }

  res.json({
    ok: true,
    service: "denmark-backend",
    database: getDatabaseHealth(),
    startup: {
      tables_ready: startupTablesReady,
      tables_initializing: startupTablesInitializing,
      scheduler_started: schedulerStarted,
    },
  });
});
app.get("/api/database/health", defaultCors, (req, res) => {
  if (!startupTablesReady && !startupTablesInitializing) {
    void initializeStartupTablesWithRetry();
  }

  res.json({
    ok: true,
    database: getDatabaseHealth(),
    startup: {
      tables_ready: startupTablesReady,
      tables_initializing: startupTablesInitializing,
      scheduler_started: schedulerStarted,
    },
  });
});
app.use("/api", databaseUnavailableMiddleware);

//load denmark notification bridge before auth is started
app.use("/api/notifications", defaultCors, notificationRoutes);

app.use(loadRequestAuth);
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload" });
  }

  return next(err);
});

app.get("/api/startup/status", defaultCors, requirePermission("settings.read"), (req, res) => {
  res.json(startScheduler.getStartupStatus());
});

app.get("/api/server/logs", defaultCors, requirePermission("settings.read"), (req, res) => {
  res.json({
    generated_at: new Date().toISOString(),
    entries: getLogEntries({
      limit: req.query.limit,
      afterId: req.query.afterId,
    }),
  });
});

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
  "/api/settings",
  defaultCors,
  requireMethodPermissions({ GET: "settings.read", PUT: "settings.write" }),
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

const clientDistPath = path.resolve(__dirname, "../dist");
const clientIndexPath = path.join(clientDistPath, "index.html");

if (fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistPath));
  app.get(/^(?!\/api(?:\/|$)|\/__whoami$).*/, (req, res) => {
    res.sendFile(clientIndexPath);
  });
}

app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    buildMarker: "messages-fast-debug-2026-05-08",
    cwd: process.cwd(),
    pid: process.pid,
    envPort: process.env.PORT || null,
    finalPort: PORT,
    message: "This is the Denmark backend",
  });
});

let startupTablesReady = false;
let startupTablesInitializing = false;
let schedulerStarted = false;
let startupRetryHandle = null;
const STARTUP_ENSURE_TIMEOUT_MS = Number(
  process.env.STARTUP_ENSURE_TIMEOUT_MS || 30000
);

function withStartupEnsureTimeout(label, promise) {
  let timeoutHandle = null;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `Startup schema ensure timed out after ${STARTUP_ENSURE_TIMEOUT_MS}ms: ${label}`
        )
      );
    }, STARTUP_ENSURE_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

async function initializeStartupTables() {
  console.log("[server] ensuring vehicle identity constraints");
  await withStartupEnsureTimeout(
    "vehicle identity constraints",
    ensureVehicleIdentityConstraints()
  );
  console.log("[server] ensuring application unique constraints");
  await withStartupEnsureTimeout(
    "application unique constraints",
    ensureApplicationUniqueConstraints()
  );
  console.log("[server] ensuring runtime support tables");
  const startupEnsures = [
    ["notification events", ensureNotificationEventsTable],
    ["vehicle FMV estimates", ensureVehicleFmvEstimatesTable],
    ["business metrics", ensureBusinessMetricsTables],
    ["metrics indexes", ensureMetricsIndexes],
    ["vehicle odometer rollups", ensureVehicleOdometerRollupTable],
    ["vehicle aliases", ensureVehicleAliasesTable],
    ["income tables", ensureIncomeTables],
    ["fleet alerts", ensureFleetAlertTables],
    ["Google Calendar health columns", ensureGoogleCalendarConnectionHealthColumns],
    ["auth tables", ensureAuthTables],
    ["system activity log", ensureSystemActivityLogTable],
    ["auth public URL settings", ensureAuthPublicUrlSettings],
  ];

  for (const [label, ensureFn] of startupEnsures) {
    console.log(`[server] ensuring ${label}`);
    await withStartupEnsureTimeout(label, ensureFn());
  }
}

async function initializeStartupTablesWithRetry() {
  if (startupTablesReady || startupTablesInitializing) return;

  if (startupRetryHandle) {
    clearTimeout(startupRetryHandle);
    startupRetryHandle = null;
  }

  startupTablesInitializing = true;

  try {
    await initializeStartupTables();
    startupTablesReady = true;
    markDatabaseReady();
    console.log("[server] startup tables ready");

    if (!schedulerStarted) {
      schedulerStarted = true;
      startScheduler();
    }
  } catch (err) {
    if (isDatabaseSchemaError(err)) {
      markDatabaseSchemaMissing(err);
      console.warn(
        `[server] database schema not initialized. Run npm run db:bootstrap. Retrying in ${RETRY_AFTER_SECONDS}s. ${summarizeError(err)}`
      );
    } else {
      markDatabaseUnavailable(err);
      console.warn(
        `[server] database unavailable; startup tables not ready. Retrying in ${RETRY_AFTER_SECONDS}s. ${summarizeError(err)}`
      );
    }

    startupRetryHandle = setTimeout(() => {
      startupRetryHandle = null;
      void initializeStartupTablesWithRetry();
    }, RETRY_AFTER_SECONDS * 1000);
    startupRetryHandle.unref?.();
  } finally {
    startupTablesInitializing = false;
  }
}

onDatabaseUnavailable(() => {
  startupTablesReady = false;
  void initializeStartupTablesWithRetry();
});

app.use((err, req, res, next) => {
  if (!err) return next();

  if (isDatabaseConnectionError(err)) {
    markDatabaseUnavailable(err);
    startupTablesReady = false;
    void initializeStartupTablesWithRetry();
    res.set("Retry-After", String(RETRY_AFTER_SECONDS));
    return res.status(503).json(buildDatabaseUnavailablePayload());
  }

  if (isDatabaseSchemaError(err)) {
    markDatabaseSchemaMissing(err);
    startupTablesReady = false;
    void initializeStartupTablesWithRetry();
    res.set("Retry-After", String(RETRY_AFTER_SECONDS));
    return res.status(503).json(buildDatabaseUnavailablePayload());
  }

  res.status(err.statusCode || err.status || 500).json({
    ok: false,
    error: err.statusCode || err.status ? err.message : "internal server error",
  });
});

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
