const express = require("express");
const pool = require("../db");
const {
  getBusinessFinancialSettings,
  upsertBusinessFinancialSettings,
  listVehicleFinancialProfiles,
  upsertVehicleFinancialProfile,
  getBusinessMetrics,
  createBusinessMetricSnapshot,
  listBusinessMetricSnapshots,
  buildQuarterlyAnalysisPayload,
} = require("../services/metrics/businessMetricsService");

const router = express.Router();

router.get("/settings", async (req, res) => {
  try {
    const settings = await getBusinessFinancialSettings();
    res.json(settings);
  } catch (err) {
    console.error("GET /api/metrics/business/settings failed:", err);
    res.status(500).json({ error: "Failed to load business settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const settings = await upsertBusinessFinancialSettings(req.body || {});
    res.json(settings);
  } catch (err) {
    console.error("PUT /api/metrics/business/settings failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to save business settings",
    });
  }
});

router.get("/vehicle-profiles", async (req, res) => {
  try {
    const profiles = await listVehicleFinancialProfiles();
    res.json({ profiles });
  } catch (err) {
    console.error("GET /api/metrics/business/vehicle-profiles failed:", err);
    res.status(500).json({ error: "Failed to load vehicle financial profiles" });
  }
});

router.put("/vehicle-profiles/:vehicleId", async (req, res) => {
  try {
    const profile = await upsertVehicleFinancialProfile(
      req.params.vehicleId,
      req.body || {}
    );
    res.json(profile);
  } catch (err) {
    console.error("PUT /api/metrics/business/vehicle-profiles/:vehicleId failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to save vehicle financial profile",
    });
  }
});

router.get("/current", async (req, res) => {
  try {
    const data = await getBusinessMetrics(req.query.range || "90d");
    res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/business/current failed:", err);
    res.status(500).json({ error: "Failed to load business metrics" });
  }
});

router.post("/snapshots", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const snapshot = await createBusinessMetricSnapshot(
      req.body?.period_type || "quarterly",
      client
    );
    await client.query("COMMIT");
    res.json({ ok: true, snapshot });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/metrics/business/snapshots failed:", err);
    res.status(500).json({ error: "Failed to create business metrics snapshot" });
  } finally {
    client.release();
  }
});

router.get("/snapshots", async (req, res) => {
  try {
    const snapshots = await listBusinessMetricSnapshots();
    res.json({ snapshots });
  } catch (err) {
    console.error("GET /api/metrics/business/snapshots failed:", err);
    res.status(500).json({ error: "Failed to load business metric snapshots" });
  }
});

router.get("/analysis-payload", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payload = await buildQuarterlyAnalysisPayload(client);
    await client.query("COMMIT");
    res.json(payload);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("GET /api/metrics/business/analysis-payload failed:", err);
    res.status(500).json({ error: "Failed to build analysis payload" });
  } finally {
    client.release();
  }
});

module.exports = router;
