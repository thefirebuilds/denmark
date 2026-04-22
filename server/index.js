// server/index.js

const cors = require("cors");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const express = require("express");
const session = require("express-session");
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
const marketplaceRoutes = require("./routes/marketplace");
const publicAvailabilityRouter = require("./routes/publicAvailability");
const settingsRouter = require("./routes/settings");
const databaseRouter = require("./routes/database");
const googleCalendarRoutes = require("./routes/googleCalendar");

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

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true only when using HTTPS in production
    },
  })
);

app.use(express.json({ limit: "500mb" }));

// Explicit preflight handling for marketplace routes
app.options(/^\/api\/marketplace\/.*$/, marketplaceCors);

app.get("/api/startup/status", defaultCors, (req, res) => {
  res.json(startScheduler.getStartupStatus());
});

app.use("/api/messages", defaultCors, messagesRoute);
app.use("/api/trips", defaultCors, tripsRoutes);
app.use("/api/trip-summaries", defaultCors, tripSummariesRouter);
app.use("/api/bouncie", defaultCors, bouncieRoutes);
app.use("/api/dimo", defaultCors, dimoRoutes);
app.use("/api/vehicles", defaultCors, vehiclesRoutes);
app.use("/api", defaultCors, maintenanceRoutes);
app.use("/api/tolls", defaultCors, tollRoutes);
app.use("/api/expenses", defaultCors, expensesRouter);
app.use("/api/teller", defaultCors, tellerRoutes);
app.use("/api/metrics", defaultCors, metricsRouter);
app.use("/api/marketplace", marketplaceCors, marketplaceRoutes);
app.use("/api/settings", defaultCors, settingsRouter);
app.use("/api/database", defaultCors, databaseRouter);
app.use("/api/integrations/google-calendar", defaultCors, googleCalendarRoutes);
app.use("/api", publicAvailabilityRouter);

app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    envPort: process.env.PORT || null,
    finalPort: PORT,
    message: "This is the Denmark backend",
  });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  startScheduler();
});
