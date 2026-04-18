// ------------------------------------------------------------
// Maintenance-related API routes
// /server/routes/maintenance.js
// ------------------------------------------------------------

const express = require("express");

const {
  getVehicleMaintenanceSummary,
} = require("../services/maintenance/getVehicleMaintenanceSummary");

const {
  createMaintenanceEvent,
} = require("../services/maintenance/createMaintenanceEvent");

const {
  deleteMaintenanceEvent,
} = require("../services/maintenance/deleteMaintenanceEvent");

const {
  createMaintenanceRuleTemplate,
  createCustomMaintenanceRule,
  ensureDefaultMaintenanceRulesForVehicle,
  listMaintenanceRuleTemplates,
} = require("../services/maintenance/ruleTemplates");

const pool = require("../db");

const router = express.Router();

// ------------------------------------------------------------
// GET reusable maintenance rule templates
// ------------------------------------------------------------
router.get("/maintenance-rule-templates", async (req, res) => {
  const client = await pool.connect();

  try {
    const includeInactive =
      String(req.query.include_inactive || req.query.includeInactive || "")
        .trim()
        .toLowerCase() === "true";
    const templates = await listMaintenanceRuleTemplates(client, {
      includeInactive,
    });

    res.json({
      ok: true,
      templates,
    });
  } catch (err) {
    console.error("GET /maintenance-rule-templates failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load maintenance templates",
    });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// POST reusable maintenance rule template
// ------------------------------------------------------------
router.post("/maintenance-rule-templates", async (req, res) => {
  const client = await pool.connect();

  try {
    const template = await createMaintenanceRuleTemplate(client, req.body || {});

    res.status(201).json({
      ok: true,
      template,
    });
  } catch (err) {
    console.error("POST /maintenance-rule-templates failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance template",
    });
  } finally {
    client.release();
  }
});


// ------------------------------------------------------------
// DELETE maintenance event
// ------------------------------------------------------------
router.delete("/vehicles/:vin/maintenance-events/:eventId", async (req, res) => {
  try {
    const vin = String(req.params.vin || "").trim();
    const eventId = Number(req.params.eventId);

    const deleted = await deleteMaintenanceEvent({
      vin,
      eventId,
    });

    res.json({
      ok: true,
      deleted,
    });
  } catch (err) {
    console.error(
      `DELETE /vehicles/${req.params.vin}/maintenance-events/${req.params.eventId} failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to delete maintenance event",
    });
  }
});

// ------------------------------------------------------------
// GET vehicle maintenance summary
// ------------------------------------------------------------
router.get("/vehicles/:vin/maintenance-summary", async (req, res) => {
  try {
    const vin = String(req.params.vin || "").trim();
    const summary = await getVehicleMaintenanceSummary(vin);
    res.json(summary);
  } catch (err) {
    console.error(
      `GET /vehicles/${req.params.vin}/maintenance-summary failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load maintenance summary",
    });
  }
});

// ------------------------------------------------------------
// POST default maintenance rules for a vehicle
// ------------------------------------------------------------
router.post("/vehicles/:vin/maintenance-rules/seed-defaults", async (req, res) => {
  const client = await pool.connect();

  try {
    const vin = String(req.params.vin || "").trim();
    const inserted = await ensureDefaultMaintenanceRulesForVehicle(client, vin);

    res.json({
      ok: true,
      insertedCount: inserted.length,
      inserted,
    });
  } catch (err) {
    console.error(
      `POST /vehicles/${req.params.vin}/maintenance-rules/seed-defaults failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to seed maintenance rules",
    });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// POST custom maintenance rule for a vehicle
// ------------------------------------------------------------
router.post("/vehicles/:vin/maintenance-rules", async (req, res) => {
  const client = await pool.connect();

  try {
    const vin = String(req.params.vin || "").trim();
    const rule = await createCustomMaintenanceRule(client, vin, req.body || {});

    res.status(201).json({
      ok: true,
      rule,
    });
  } catch (err) {
    console.error(
      `POST /vehicles/${req.params.vin}/maintenance-rules failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance rule",
    });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// POST maintenance event (inspection/service entry)
// ------------------------------------------------------------
router.post("/vehicles/:vin/maintenance-events", async (req, res) => {
  try {
    const vin = String(req.params.vin || "").trim();
    const {
      ruleId,
      ruleCode,
      performedAt,
      odometerMiles,
      result,
      notes,
      data,
      performedBy,
      source,
    } = req.body || {};

    const event = await createMaintenanceEvent({
      vin,
      ruleId,
      ruleCode,
      performedAt,
      odometerMiles,
      result,
      notes,
      data,
      performedBy,
      source,
    });

    res.json({
      ok: true,
      event,
    });
  } catch (err) {
    console.error(
      `POST /vehicles/${req.params.vin}/maintenance-events failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance event",
    });
  }
});


module.exports = router;
