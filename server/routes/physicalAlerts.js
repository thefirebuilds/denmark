const express = require("express");
const { buildRuntime } = require("../services/physicalAlerts/runtime");

const router = express.Router();

router.get("/alerts", async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    res.json({ alerts: await buildRuntime().repository.listAlerts({ limit }) });
  } catch (error) { next(error); }
});

router.get("/alerts/active", async (req, res, next) => {
  try {
    res.json({ alerts: await buildRuntime().repository.listAlerts({ active: true, deviceId: req.query.deviceId || null }) });
  } catch (error) { next(error); }
});

router.post("/alerts", async (req, res, next) => {
  try {
    const { type = "manual_test", severity = "critical", title, message, tripId, deviceId, metadata } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: "title and message are required" });
    const alert = await buildRuntime().alertService.createAlert({
      type, severity, title, message, tripId, metadata,
      deviceId: deviceId || buildRuntime().config.defaultDeviceId,
      dedupeKey: req.body.dedupeKey || null,
    });
    return res.status(alert.inserted ? 201 : 200).json({ alert });
  } catch (error) { return next(error); }
});

router.post("/alerts/:id/ack", async (req, res, next) => {
  try {
    const alert = await buildRuntime().alertService.acknowledgeAlert(
      req.params.id, req.auth?.email || req.auth?.serviceTokenName || "api", req.body?.timestamp || new Date()
    );
    if (!alert) return res.status(404).json({ error: "Alert not found" });
    return res.json({ alert });
  } catch (error) { return next(error); }
});

router.post("/alerts/:id/resolve", async (req, res, next) => {
  try {
    const current = buildRuntime();
    const alert = await current.alertService.resolveAlert(req.params.id, req.body?.timestamp || new Date());
    if (!alert) return res.status(404).json({ error: "Alert not found" });
    if (alert.device_id) {
      const health = await current.healthService.computeHealth();
      await current.alertService.publishDeviceState(alert.device_id, health.health);
    }
    return res.json({ alert });
  } catch (error) { return next(error); }
});

router.get("/devices", async (_req, res, next) => {
  try { res.json({ devices: await buildRuntime().repository.listDevices() }); }
  catch (error) { next(error); }
});

router.get("/devices/:deviceId", async (req, res, next) => {
  try {
    const [device] = await buildRuntime().repository.listDevices(req.params.deviceId);
    if (!device) return res.status(404).json({ error: "Device not found" });
    return res.json({ device });
  } catch (error) { return next(error); }
});

module.exports = router;
