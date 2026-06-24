// ------------------------------------------------------------
// Maintenance-related API routes
// /server/routes/maintenance.js
// ------------------------------------------------------------

const express = require("express");
const crypto = require("crypto");

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

function normalizeManualTaskText(value, fieldName) {
  const text = String(value || "").trim();
  if (!text) {
    const err = new Error(`${fieldName} is required`);
    err.statusCode = 400;
    throw err;
  }
  return text;
}

function normalizeManualTaskPriority(value) {
  const priority = String(value || "medium").trim().toLowerCase();
  return ["low", "medium", "high", "urgent"].includes(priority)
    ? priority
    : "medium";
}

async function createManualMaintenanceTask(client, vin, input = {}) {
  const vehicleVin = String(vin || "").trim();
  if (!vehicleVin) {
    const err = new Error("VIN required");
    err.statusCode = 400;
    throw err;
  }

  const vehicleResult = await client.query(
    `
      SELECT vin
      FROM vehicles
      WHERE vin = $1
      LIMIT 1
    `,
    [vehicleVin]
  );

  if (!vehicleResult.rows[0]) {
    const err = new Error(`Vehicle not found: ${vehicleVin}`);
    err.statusCode = 404;
    throw err;
  }

  const title = normalizeManualTaskText(input.title, "title");
  const description =
    input.description == null || String(input.description).trim() === ""
      ? null
      : String(input.description).trim();
  const priority = normalizeManualTaskPriority(input.priority);
  const source = String(input.source || "manual").trim() || "manual";
  const reportedBy =
    input.reportedBy == null || String(input.reportedBy).trim() === ""
      ? null
      : String(input.reportedBy).trim();
  const sourceKey =
    input.sourceKey == null || String(input.sourceKey).trim() === ""
      ? `manual:${vehicleVin}:${crypto.randomUUID()}`
      : String(input.sourceKey).trim();

  const result = await client.query(
    `
      INSERT INTO maintenance_tasks (
        vehicle_vin,
        task_type,
        title,
        description,
        priority,
        status,
        blocks_rental,
        blocks_guest_export,
        needs_review,
        source,
        source_key,
        trigger_type,
        trigger_context
      )
      VALUES (
        $1,
        'manual_todo',
        $2,
        $3,
        $4,
        'open',
        $5,
        $6,
        true,
        $7,
        $8,
        'manual',
        $9::jsonb
      )
      RETURNING *
    `,
    [
      vehicleVin,
      title,
      description,
      priority,
      Boolean(input.blocksRental),
      Boolean(input.blocksGuestExport),
      source,
      sourceKey,
      JSON.stringify({
        reportedBy,
        noteSource: input.noteSource || source,
        createdFrom: "maintenance_todo_form",
      }),
    ]
  );

  return result.rows[0];
}

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
    const refreshOdometerRollup =
      String(req.query.refreshOdometer || req.query.refresh_odometer || "true")
        .toLowerCase() !== "false" &&
      String(req.query.refreshOdometer || req.query.refresh_odometer || "true") !== "0";
    const summary = await getVehicleMaintenanceSummary(vin, null, {
      refreshOdometerRollup,
    });
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
// POST manual maintenance to-do for a vehicle
// ------------------------------------------------------------
router.post("/vehicles/:vin/maintenance-tasks", async (req, res) => {
  const client = await pool.connect();

  try {
    const vin = String(req.params.vin || "").trim();
    const task = await createManualMaintenanceTask(client, vin, req.body || {});
    console.log(
      "[maintenance] manual to-do created",
      {
        taskId: task.id,
        vin: task.vehicle_vin,
        title: task.title,
        sourceKey: task.source_key,
      }
    );

    res.status(201).json({
      ok: true,
      task,
    });
  } catch (err) {
    console.error(
      `POST /vehicles/${req.params.vin}/maintenance-tasks failed:`,
      err
    );

    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance task",
    });
  } finally {
    client.release();
  }
});

// ------------------------------------------------------------
// PATCH maintenance task status / assignment
// ------------------------------------------------------------
router.patch("/maintenance-tasks/:taskId", async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);
    const statusProvided = Object.prototype.hasOwnProperty.call(req.body || {}, "status");
    const vehicleVinProvided = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "vehicle_vin"
    );
    const status = statusProvided
      ? String(req.body?.status || "").trim().toLowerCase()
      : null;
    const vehicleVin = vehicleVinProvided
      ? String(req.body?.vehicle_vin || "").trim()
      : null;

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: "Invalid taskId" });
    }

    if (!statusProvided && !vehicleVinProvided) {
      return res.status(400).json({ error: "No task updates provided" });
    }

    if (
      statusProvided &&
      !["open", "scheduled", "in_progress", "deferred", "resolved"].includes(status)
    ) {
      return res.status(400).json({ error: "Invalid task status" });
    }

    if (vehicleVinProvided) {
      if (!vehicleVin) {
        return res.status(400).json({ error: "vehicle_vin is required" });
      }

      const vehicleResult = await pool.query(
        `
          SELECT vin
          FROM vehicles
          WHERE vin = $1
          LIMIT 1
        `,
        [vehicleVin]
      );

      if (!vehicleResult.rows[0]) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
    }

    const updates = [];
    const values = [taskId];

    if (statusProvided) {
      values.push(status);
      updates.push(`status = $${values.length}`);
    }

    if (vehicleVinProvided) {
      values.push(vehicleVin);
      updates.push(`vehicle_vin = $${values.length}`);
    }

    const result = await pool.query(
      `
        UPDATE maintenance_tasks
        SET
          ${updates.join(",\n          ")},
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      values
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Maintenance task not found" });
    }

    res.json({
      ok: true,
      task: result.rows[0],
    });
  } catch (err) {
    console.error(`PATCH /maintenance-tasks/${req.params.taskId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to update maintenance task",
    });
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
