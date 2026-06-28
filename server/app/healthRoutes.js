const express = require("express");
const {
  getLogEntries,
} = require("../services/serverLogBuffer");
const startScheduler = require("../services/scheduler");
const { requirePermission } = require("../auth/middleware");
const { defaultCors } = require("./cors");
const { getDatabaseHealth } = require("../dbHealth");
const {
  getPoolActivitySnapshot,
  getPoolStats,
} = require("../db");
const {
  getStartupState,
  initializeStartupTablesWithRetry,
  startupState,
} = require("../startup/startupState");

function createPublicHealthRouter({ port }) {
  const router = express.Router();

  router.get("/api/health", defaultCors, (req, res) => {
    if (
      !startupState.startupTablesReady &&
      !startupState.startupTablesInitializing
    ) {
      void initializeStartupTablesWithRetry();
    }

    const includeActivity =
      String(req.query.activity || "").trim() === "1" ||
      String(process.env.DB_HEALTH_INCLUDE_ACTIVITY || "").trim() === "true";
    const payload = {
      ok: true,
      service: "denmark-backend",
      database: getDatabaseHealth(),
      db_pool: getPoolStats(),
      startup: getStartupState(),
    };

    if (includeActivity) {
      payload.db_activity = getPoolActivitySnapshot();
    }

    res.json(payload);
  });

  router.get("/api/database/health", defaultCors, (req, res) => {
    if (
      !startupState.startupTablesReady &&
      !startupState.startupTablesInitializing
    ) {
      void initializeStartupTablesWithRetry();
    }

    const includeActivity =
      String(req.query.activity || "").trim() === "1" ||
      String(process.env.DB_HEALTH_INCLUDE_ACTIVITY || "").trim() === "true";
    const payload = {
      ok: true,
      database: getDatabaseHealth(),
      db_pool: getPoolStats(),
      startup: getStartupState(),
    };

    if (includeActivity) {
      payload.db_activity = getPoolActivitySnapshot();
    }

    res.json(payload);
  });

  router.get("/__whoami", (req, res) => {
    res.json({
      ok: true,
      buildMarker: "messages-fast-debug-2026-05-08",
      cwd: process.cwd(),
      pid: process.pid,
      envPort: process.env.PORT || null,
      finalPort: port,
      message: "This is the Denmark backend",
    });
  });

  return router;
}

function createProtectedHealthRouter() {
  const router = express.Router();

  router.get(
    "/api/startup/status",
    defaultCors,
    requirePermission("settings.read"),
    (req, res) => {
      res.json(startScheduler.getStartupStatus());
    }
  );

  router.get(
    "/api/server/logs",
    defaultCors,
    requirePermission("settings.read"),
    (req, res) => {
      res.json({
        generated_at: new Date().toISOString(),
        entries: getLogEntries({
          limit: req.query.limit,
          afterId: req.query.afterId,
        }),
      });
    }
  );

  return router;
}

module.exports = {
  createProtectedHealthRouter,
  createPublicHealthRouter,
};
