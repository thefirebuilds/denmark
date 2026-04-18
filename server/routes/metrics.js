// ------------------------------------------------------------
// /server/routes/metrics.js
// Fleet metrics endpoints for dashboard summary, vehicle cards,
// and trend charts.
// ------------------------------------------------------------

const express = require("express");
const {
  getSummaryMetrics,
} = require("../services/metrics/summaryService");
const {
  getVehicleMetrics,
} = require("../services/metrics/vehicleMetricsService");
const {
  getTrendMetrics,
} = require("../services/metrics/trendMetricsService");

const router = express.Router();

router.get("/summary", async (req, res) => {
  try {
    const data = await getSummaryMetrics(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/summary failed:", err);
    return res.status(500).json({ error: "Failed to load summary metrics" });
  }
});

router.get("/vehicles", async (req, res) => {
  try {
    const data = await getVehicleMetrics(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/vehicles failed:", err);
    return res.status(500).json({ error: "Failed to load vehicle metrics" });
  }
});

router.get("/trends", async (req, res) => {
  try {
    const data = await getTrendMetrics(req.query.range || "90d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/trends failed:", err);
    return res.status(500).json({ error: "Failed to load trend metrics" });
  }
});

module.exports = router;