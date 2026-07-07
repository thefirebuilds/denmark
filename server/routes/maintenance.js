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
const {
  estimateLaborHours,
  normalizeLaborHours,
} = require("../services/maintenance/laborEstimates");
const {
  ensureMaintenanceRuntimeSchema,
} = require("../services/maintenance/maintenanceRuntimeSchema");

const router = express.Router();

function toNullableText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toPositiveInt(value, fieldName) {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    const err = new Error(`Invalid ${fieldName}`);
    err.statusCode = 400;
    throw err;
  }
  return num;
}

function toOptionalPositiveInt(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return toPositiveInt(value, fieldName);
}

function toOptionalNonNegativeMoney(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    const err = new Error(`Invalid ${fieldName}`);
    err.statusCode = 400;
    throw err;
  }
  return Math.round(num * 100) / 100;
}

function toOdometerMiles(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    const err = new Error("Invalid odometerMiles");
    err.statusCode = 400;
    throw err;
  }
  return Math.round(num);
}

function toTimestamp(value, fieldName, { defaultNow = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (defaultNow) return new Date().toISOString();
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const err = new Error(`Invalid ${fieldName}`);
    err.statusCode = 400;
    throw err;
  }
  return date.toISOString();
}

function isTruthy(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeEventStatus(value) {
  if (value == null || String(value).trim() === "") return "completed";
  const status = String(value).trim().toLowerCase();
  if (!["completed", "scheduled", "void", "needs_review"].includes(status)) {
    const err = new Error("Maintenance event status must be completed, scheduled, void, or needs_review");
    err.statusCode = 400;
    throw err;
  }
  return status;
}

async function resolveVehicleSelector(client, selector) {
  const raw = String(selector || "").trim();
  if (!raw) {
    const err = new Error("Vehicle id, VIN, nickname, or plate is required");
    err.statusCode = 400;
    throw err;
  }

  const normalized = raw.toLowerCase();
  const numericId = Number(raw);
  const result = await client.query(
    `
      SELECT id, vin, nickname, make, model, year, license_plate, current_odometer_miles
      FROM vehicles
      WHERE ($1::bigint IS NOT NULL AND id = $1::bigint)
         OR lower(trim(vin)) = $2
         OR lower(trim(COALESCE(nickname, ''))) = $2
         OR lower(trim(COALESCE(license_plate, ''))) = $2
      LIMIT 1
    `,
    [Number.isInteger(numericId) && numericId > 0 ? numericId : null, normalized]
  );

  const vehicle = result.rows[0];
  if (!vehicle) {
    const err = new Error(`Vehicle not found: ${raw}`);
    err.statusCode = 404;
    throw err;
  }
  return vehicle;
}

function mapOdometerReading(row) {
  if (!row) return null;
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    odometerMiles: row.odometer_miles,
    recordedAt: row.recorded_at,
    source: row.source,
    tripId: row.trip_id,
    reservationId: row.reservation_id,
    note: row.note,
    isCorrection: Boolean(row.is_correction),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trip: row.trip_id
      ? {
          id: row.trip_id,
          reservationId: row.trip_reservation_id,
          guestName: row.guest_name,
          tripStart: row.trip_start,
          tripEnd: row.trip_end,
        }
      : null,
  };
}

async function listVehicleOdometerReadings(client, vehicleId, limit = 50) {
  await ensureMaintenanceRuntimeSchema(client);
  const result = await client.query(
    `
      SELECT
        h.*,
        t.reservation_id AS trip_reservation_id,
        t.guest_name,
        t.trip_start,
        t.trip_end
      FROM vehicle_odometer_history h
      LEFT JOIN trips t
        ON t.id = h.trip_id
      WHERE h.vehicle_id = $1
      ORDER BY h.recorded_at DESC, h.id DESC
      LIMIT $2
    `,
    [vehicleId, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return result.rows.map(mapOdometerReading);
}

async function createVehicleOdometerReading(client, vehicle, input = {}) {
  await ensureMaintenanceRuntimeSchema(client);
  const odometerMiles = toOdometerMiles(
    input.odometerMiles ?? input.odometer_miles ?? input.odometer
  );
  const recordedAt = toTimestamp(
    input.recordedAt ?? input.recorded_at ?? input.readingDate,
    "recordedAt",
    { defaultNow: true }
  );
  const source = toNullableText(input.source) || "manual";
  const tripId = toOptionalPositiveInt(input.tripId ?? input.trip_id, "tripId");
  const reservationId = toOptionalPositiveInt(
    input.reservationId ?? input.reservation_id,
    "reservationId"
  );
  const note = toNullableText(input.note ?? input.notes);
  const isCorrection = isTruthy(input.isCorrection ?? input.is_correction ?? input.correction);

  if (isCorrection && !note) {
    const err = new Error("Correction odometer readings require a note");
    err.statusCode = 400;
    throw err;
  }

  const priorResult = await client.query(
    `
      SELECT MAX(odometer_miles)::int AS max_odometer
      FROM vehicle_odometer_history
      WHERE vehicle_id = $1
    `,
    [vehicle.id]
  );
  const priorMax = Number(priorResult.rows[0]?.max_odometer);
  const currentOdometer = Number(vehicle.current_odometer_miles);
  const floor = Math.max(
    Number.isFinite(priorMax) ? priorMax : 0,
    Number.isFinite(currentOdometer) ? currentOdometer : 0
  );

  if (odometerMiles < floor && !isCorrection) {
    const err = new Error(
      `Odometer reading ${odometerMiles} is lower than existing mileage ${floor}; mark it as a correction with a note to save it.`
    );
    err.statusCode = 409;
    throw err;
  }

  const duplicateResult = await client.query(
    `
      SELECT id
      FROM vehicle_odometer_history
      WHERE vehicle_id = $1
        AND source = $2
        AND COALESCE(trip_id, 0) = COALESCE($3::bigint, 0)
        AND recorded_at::date = ($4::timestamp)::date
      LIMIT 1
    `,
    [vehicle.id, source, tripId, recordedAt]
  );

  if (duplicateResult.rows[0]) {
    const err = new Error("An odometer reading already exists for that vehicle/source/trip/date");
    err.statusCode = 409;
    throw err;
  }

  const insert = await client.query(
    `
      INSERT INTO vehicle_odometer_history (
        vehicle_id,
        odometer_miles,
        recorded_at,
        source,
        trip_id,
        reservation_id,
        note,
        is_correction,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3::timestamp, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING *
    `,
    [vehicle.id, odometerMiles, recordedAt, source, tripId, reservationId, note, isCorrection]
  );

  await client.query(
    `
      UPDATE vehicles
      SET
        current_odometer_miles = CASE
          WHEN current_odometer_miles IS NULL THEN $2
          WHEN $3::boolean THEN $2
          WHEN $2 >= current_odometer_miles THEN $2
          ELSE current_odometer_miles
        END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [vehicle.id, odometerMiles, isCorrection]
  );

  return mapOdometerReading(insert.rows[0]);
}

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
  const estimatedLaborHours =
    normalizeLaborHours(input.estimatedLaborHours ?? input.estimated_labor_hours) ??
    estimateLaborHours({
      taskType: "manual_todo",
      title,
      description,
    });

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
        trigger_context,
        estimated_labor_hours
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
        $9::jsonb,
        $10
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
      estimatedLaborHours,
    ]
  );

  return result.rows[0];
}

const TASK_RULE_CODE_MAP = new Map([
  ["battery_voltage_inspection", "battery_test"],
  ["post_trip_brake_inspection", "brake_inspection"],
  ["post_trip_tread_depth_check", "tread_depth"],
  ["post_trip_tire_pressure_check", "tire_pressure_check"],
  ["post_trip_fluid_leak_check", "fluid_leak_check"],
  ["post_trip_oil_level_check", "fluid_leak_check"],
  ["post_trip_condition_review", "cleaning"],
  ["handoff_prep", "cleaning"],
  ["vehicle_prep", "cleaning"],
]);

function getTaskRuleCode(task) {
  const contextRuleCode = String(task?.trigger_context?.ruleCode || "").trim();
  if (contextRuleCode) return contextRuleCode;

  return TASK_RULE_CODE_MAP.get(String(task?.task_type || "").trim()) || null;
}

async function getRuleForTask(client, task) {
  if (!task) return null;

  if (task.rule_id) {
    const result = await client.query(
      `
        SELECT id, rule_code, title, requires_pass_result
        FROM maintenance_rules
        WHERE id = $1
        LIMIT 1
      `,
      [task.rule_id]
    );

    if (result.rows[0]) return result.rows[0];
  }

  const ruleCode = getTaskRuleCode(task);
  if (!ruleCode) return null;

  const result = await client.query(
    `
      SELECT id, rule_code, title, requires_pass_result
      FROM maintenance_rules
      WHERE vehicle_vin = $1
        AND rule_code = $2
        AND is_active = TRUE
      LIMIT 1
    `,
    [task.vehicle_vin, ruleCode]
  );

  return result.rows[0] || null;
}

async function getTaskResolutionOdometer(client, task) {
  const context = task?.trigger_context || {};
  const contextOdometer = Number(
    context.currentOdometerMiles ??
      context.odometerMiles ??
      context.nextDueMiles ??
      NaN
  );

  if (Number.isFinite(contextOdometer) && contextOdometer >= 0) {
    return Math.round(contextOdometer);
  }

  const result = await client.query(
    `
      SELECT MAX(odometer_miles)::int AS odometer_miles
      FROM (
        SELECT current_odometer_miles AS odometer_miles
        FROM vehicles
        WHERE vin = $1
        UNION ALL
        SELECT odometer_miles
        FROM maintenance_events
        WHERE vehicle_vin = $1
      ) odometer_sources
      WHERE odometer_miles IS NOT NULL
    `,
    [task.vehicle_vin]
  );

  const odometer = Number(result.rows[0]?.odometer_miles);
  return Number.isFinite(odometer) && odometer >= 0 ? Math.round(odometer) : null;
}

async function createEventForResolvedTask(client, task, { actualLaborHours = null } = {}) {
  const rule = await getRuleForTask(client, task);
  if (!rule) return null;

  const odometerMiles = await getTaskResolutionOdometer(client, task);
  const result = rule.requires_pass_result ? "pass" : "performed";
  const context = task.trigger_context || {};
  const notes = [
    `Completed from maintenance task #${task.id}: ${task.title}`,
    task.description || "",
    context.reason ? `Reason: ${context.reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return createMaintenanceEvent({
    vin: task.vehicle_vin,
    ruleId: rule.id,
    performedAt: new Date().toISOString(),
    odometerMiles,
    result,
    notes,
    data: {
      completedTaskId: task.id,
      completedTaskType: task.task_type,
      triggerType: task.trigger_type || null,
      triggerContext: context,
    },
    source: "inspection",
    actualLaborHours,
    allowMissingOdometer: true,
  });
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
    const actualLaborProvided = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "actual_labor_hours"
    ) || Object.prototype.hasOwnProperty.call(req.body || {}, "actualLaborHours");
    const estimatedLaborProvided = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "estimated_labor_hours"
    ) || Object.prototype.hasOwnProperty.call(req.body || {}, "estimatedLaborHours");
    const actualLaborHours = actualLaborProvided
      ? normalizeLaborHours(req.body?.actual_labor_hours ?? req.body?.actualLaborHours)
      : null;
    const estimatedLaborHours = estimatedLaborProvided
      ? normalizeLaborHours(req.body?.estimated_labor_hours ?? req.body?.estimatedLaborHours)
      : null;

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: "Invalid taskId" });
    }

    if (
      !statusProvided &&
      !vehicleVinProvided &&
      !actualLaborProvided &&
      !estimatedLaborProvided
    ) {
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

    let linkedEvent = null;

    if (statusProvided && status === "resolved") {
      const taskResult = await pool.query(
        `
          SELECT *
          FROM maintenance_tasks
          WHERE id = $1
          LIMIT 1
        `,
        [taskId]
      );
      const task = taskResult.rows[0] || null;

      if (!task) {
        return res.status(404).json({ error: "Maintenance task not found" });
      }

      if (!["resolved", "canceled"].includes(String(task.status || ""))) {
        linkedEvent = await createEventForResolvedTask(pool, task, {
          actualLaborHours,
        });
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

    if (estimatedLaborProvided) {
      values.push(estimatedLaborHours);
      updates.push(`estimated_labor_hours = $${values.length}`);
    }

    if (actualLaborProvided) {
      values.push(actualLaborHours);
      updates.push(`actual_labor_hours = $${values.length}`);
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
      linkedEvent,
    });
  } catch (err) {
    console.error(`PATCH /maintenance-tasks/${req.params.taskId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to update maintenance task",
    });
  }
});

// ------------------------------------------------------------
// DELETE maintenance task
// ------------------------------------------------------------
router.delete("/maintenance-tasks/:taskId", async (req, res) => {
  try {
    const taskId = Number(req.params.taskId);

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: "Invalid taskId" });
    }

    const result = await pool.query(
      `
        DELETE FROM maintenance_tasks
        WHERE id = $1
        RETURNING *
      `,
      [taskId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Maintenance task not found" });
    }

    console.log("[maintenance] to-do deleted", {
      taskId: result.rows[0].id,
      vin: result.rows[0].vehicle_vin,
      title: result.rows[0].title,
    });

    res.json({
      ok: true,
      task: result.rows[0],
    });
  } catch (err) {
    console.error(`DELETE /maintenance-tasks/${req.params.taskId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to delete maintenance task",
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
      estimatedLaborHours,
      actualLaborHours,
      estimated_labor_hours,
      actual_labor_hours,
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
      estimatedLaborHours: estimatedLaborHours ?? estimated_labor_hours,
      actualLaborHours: actualLaborHours ?? actual_labor_hours,
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

// ------------------------------------------------------------
// Internal admin maintenance and odometer API aliases.
// Mounted under /api with maintenance.read/maintenance.write permissions.
// ------------------------------------------------------------

router.get("/admin/vehicles/:vehicleId/odometer", async (req, res) => {
  const client = await pool.connect();
  try {
    const vehicle = await resolveVehicleSelector(client, req.params.vehicleId);
    const readings = await listVehicleOdometerReadings(
      client,
      vehicle.id,
      req.query.limit
    );
    res.json({ ok: true, vehicle, readings });
  } catch (err) {
    console.error(`GET /admin/vehicles/${req.params.vehicleId}/odometer failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load odometer readings",
    });
  } finally {
    client.release();
  }
});

router.post("/admin/vehicles/:vehicleId/odometer", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const vehicle = await resolveVehicleSelector(client, req.params.vehicleId);
    const reading = await createVehicleOdometerReading(client, vehicle, req.body || {});
    await client.query("COMMIT");
    res.json({ ok: true, vehicle, reading });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    console.error(`POST /admin/vehicles/${req.params.vehicleId}/odometer failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to save odometer reading",
    });
  } finally {
    client.release();
  }
});

router.get("/admin/vehicles/:vehicleId/maintenance", async (req, res) => {
  const client = await pool.connect();
  try {
    const vehicle = await resolveVehicleSelector(client, req.params.vehicleId);
    const summary = await getVehicleMaintenanceSummary(client, vehicle.vin, {
      refreshOdometerRollup:
        String(req.query.refreshOdometer || req.query.refresh_odometer || "true")
          .toLowerCase() !== "false" &&
        String(req.query.refreshOdometer || req.query.refresh_odometer || "true") !==
          "0",
    });
    const odometerReadings = await listVehicleOdometerReadings(client, vehicle.id, 25);
    res.json({ ok: true, ...summary, odometerReadings });
  } catch (err) {
    console.error(`GET /admin/vehicles/${req.params.vehicleId}/maintenance failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load maintenance summary",
    });
  } finally {
    client.release();
  }
});

router.get("/admin/vehicles/:vehicleId/maintenance/due", async (req, res) => {
  const client = await pool.connect();
  try {
    const vehicle = await resolveVehicleSelector(client, req.params.vehicleId);
    const summary = await getVehicleMaintenanceSummary(client, vehicle.vin);
    const due = (Array.isArray(summary.ruleStatuses) ? summary.ruleStatuses : []).filter(
      (rule) => ["overdue", "due", "due_soon", "no_history"].includes(rule.status)
    );
    res.json({ ok: true, vehicle: summary.vehicle, due, blocksRental: summary.blocksRental });
  } catch (err) {
    console.error(`GET /admin/vehicles/${req.params.vehicleId}/maintenance/due failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load due maintenance",
    });
  } finally {
    client.release();
  }
});

router.get("/admin/maintenance/due", async (req, res) => {
  const client = await pool.connect();
  try {
    const vehicleResult = await client.query(
      `
        SELECT id, vin, nickname, make, model, year
        FROM vehicles
        WHERE COALESCE(is_active, true) = true
          AND COALESCE(in_service, true) = true
        ORDER BY COALESCE(nickname, vin)
        LIMIT 250
      `
    );
    const vehicles = [];
    for (const vehicle of vehicleResult.rows) {
      const summary = await getVehicleMaintenanceSummary(client, vehicle.vin, {
        refreshOdometerRollup: false,
      });
      const due = (Array.isArray(summary.ruleStatuses) ? summary.ruleStatuses : []).filter(
        (rule) => ["overdue", "due", "due_soon", "no_history"].includes(rule.status)
      );
      if (due.length || summary.blocksRental) {
        vehicles.push({
          vehicle: summary.vehicle,
          due,
          blocksRental: summary.blocksRental,
          currentOdometerMiles: summary.currentOdometerMiles,
        });
      }
    }
    res.json({ ok: true, vehicles });
  } catch (err) {
    console.error("GET /admin/maintenance/due failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load fleet maintenance due",
    });
  } finally {
    client.release();
  }
});

router.get("/admin/maintenance/events", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureMaintenanceRuntimeSchema(client);
    let vehicle = null;
    if (req.query.vehicleId || req.query.vehicle_id || req.query.vin) {
      vehicle = await resolveVehicleSelector(
        client,
        req.query.vehicleId || req.query.vehicle_id || req.query.vin
      );
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const result = await client.query(
      `
        SELECT
          me.*,
          v.id AS vehicle_id,
          v.nickname AS vehicle_nickname,
          v.make,
          v.model,
          v.year,
          mr.rule_code,
          mr.category
        FROM maintenance_events me
        LEFT JOIN vehicles v
          ON v.vin = me.vehicle_vin
        LEFT JOIN maintenance_rules mr
          ON mr.id = me.rule_id
        WHERE ($1::text IS NULL OR me.vehicle_vin = $1)
          AND ($2::text IS NULL OR COALESCE(me.status, 'completed') = $2)
          AND ($3::text IS NULL OR COALESCE(mr.category, 'other') = $3)
        ORDER BY me.performed_at DESC, me.id DESC
        LIMIT $4
      `,
      [
        vehicle?.vin || null,
        toNullableText(req.query.status),
        toNullableText(req.query.category),
        limit,
      ]
    );
    res.json({ ok: true, events: result.rows });
  } catch (err) {
    console.error("GET /admin/maintenance/events failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load maintenance events",
    });
  } finally {
    client.release();
  }
});

router.post("/admin/maintenance/events", async (req, res) => {
  try {
    const body = req.body || {};
    const selector = body.vehicleId || body.vehicle_id || body.vin || body.vehicleVin;
    if (!selector) {
      return res.status(400).json({ error: "vehicleId or vin is required" });
    }
    const client = await pool.connect();
    let vehicle;
    try {
      vehicle = await resolveVehicleSelector(client, selector);
    } finally {
      client.release();
    }

    const event = await createMaintenanceEvent({
      vin: vehicle.vin,
      ruleId: body.ruleId ?? body.rule_id,
      ruleCode: body.ruleCode ?? body.rule_code ?? body.maintenanceType,
      performedAt: body.performedAt ?? body.performed_at ?? body.serviceDate,
      odometerMiles:
        body.odometerMiles ?? body.odometer_miles ?? body.odometerAtService,
      result: body.result || "performed",
      notes: body.notes ?? body.description,
      data: {
        ...(body.data && typeof body.data === "object" ? body.data : {}),
        maintenanceType: body.maintenanceType ?? body.maintenance_type ?? null,
      },
      performedBy: body.performedBy ?? body.performed_by ?? body.vendor,
      source: body.source || "manual",
      estimatedLaborHours: body.estimatedLaborHours ?? body.estimated_labor_hours,
      actualLaborHours: body.actualLaborHours ?? body.actual_labor_hours,
      vendor: body.vendor,
      cost: body.cost,
      expenseId: body.expenseId ?? body.expense_id,
      tripId: body.tripId ?? body.trip_id,
      reservationId: body.reservationId ?? body.reservation_id,
      status: body.status,
    });

    res.json({ ok: true, event });
  } catch (err) {
    console.error("POST /admin/maintenance/events failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance event",
    });
  }
});

router.put("/admin/maintenance/events/:eventId", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureMaintenanceRuntimeSchema(client);
    const eventId = toPositiveInt(req.params.eventId, "eventId");
    const body = req.body || {};
    const result = await client.query(
      `
        UPDATE maintenance_events
        SET
          performed_at = COALESCE($2::timestamp, performed_at),
          odometer_miles = COALESCE($3::int, odometer_miles),
          result = COALESCE($4::text, result),
          notes = COALESCE($5::text, notes),
          performed_by = COALESCE($6::text, performed_by),
          vendor = COALESCE($7::text, vendor),
          cost = COALESCE($8::numeric, cost),
          expense_id = COALESCE($9::bigint, expense_id),
          status = COALESCE($10::text, status),
          data = COALESCE(data, '{}'::jsonb) || COALESCE($11::jsonb, '{}'::jsonb),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        eventId,
        toTimestamp(body.performedAt ?? body.performed_at, "performedAt"),
        body.odometerMiles === undefined && body.odometer_miles === undefined
          ? null
          : toOdometerMiles(body.odometerMiles ?? body.odometer_miles),
        toNullableText(body.result),
        body.notes === undefined ? null : toNullableText(body.notes),
        toNullableText(body.performedBy ?? body.performed_by),
        toNullableText(body.vendor),
        toOptionalNonNegativeMoney(body.cost, "cost"),
        toOptionalPositiveInt(body.expenseId ?? body.expense_id, "expenseId"),
        body.status == null ? null : normalizeEventStatus(body.status),
        body.data && typeof body.data === "object" ? JSON.stringify(body.data) : null,
      ]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Maintenance event not found" });
    }
    res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    console.error(`PUT /admin/maintenance/events/${req.params.eventId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to update maintenance event",
    });
  } finally {
    client.release();
  }
});

router.delete("/admin/maintenance/events/:eventId", async (req, res) => {
  try {
    const eventId = toPositiveInt(req.params.eventId, "eventId");
    const result = await pool.query(
      "DELETE FROM maintenance_events WHERE id = $1 RETURNING *",
      [eventId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Maintenance event not found" });
    }
    res.json({ ok: true, event: result.rows[0] });
  } catch (err) {
    console.error(`DELETE /admin/maintenance/events/${req.params.eventId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to delete maintenance event",
    });
  }
});

router.get("/admin/maintenance/rules", async (req, res) => {
  const client = await pool.connect();
  try {
    let vehicle = null;
    if (req.query.vehicleId || req.query.vehicle_id || req.query.vin) {
      vehicle = await resolveVehicleSelector(
        client,
        req.query.vehicleId || req.query.vehicle_id || req.query.vin
      );
    }
    const result = await client.query(
      `
        SELECT
          r.*,
          v.id AS vehicle_id,
          v.nickname AS vehicle_nickname
        FROM maintenance_rules r
        LEFT JOIN vehicles v
          ON v.vin = r.vehicle_vin
        WHERE ($1::text IS NULL OR r.vehicle_vin = $1)
          AND ($2::boolean = true OR r.is_active = true)
        ORDER BY COALESCE(v.nickname, r.vehicle_vin), r.category, r.title
      `,
      [vehicle?.vin || null, isTruthy(req.query.includeInactive)]
    );
    res.json({ ok: true, rules: result.rows });
  } catch (err) {
    console.error("GET /admin/maintenance/rules failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to load maintenance rules",
    });
  } finally {
    client.release();
  }
});

router.post("/admin/maintenance/rules", async (req, res) => {
  const client = await pool.connect();
  try {
    const selector = req.body?.vehicleId || req.body?.vehicle_id || req.body?.vin;
    const vehicle = await resolveVehicleSelector(client, selector);
    const rule = await createCustomMaintenanceRule(client, vehicle.vin, req.body || {});
    res.json({ ok: true, rule });
  } catch (err) {
    console.error("POST /admin/maintenance/rules failed:", err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create maintenance rule",
    });
  } finally {
    client.release();
  }
});

router.put("/admin/maintenance/rules/:ruleId", async (req, res) => {
  const client = await pool.connect();
  try {
    const ruleId = toPositiveInt(req.params.ruleId, "ruleId");
    const body = req.body || {};
    const result = await client.query(
      `
        UPDATE maintenance_rules
        SET
          title = COALESCE($2::text, title),
          description = COALESCE($3::text, description),
          category = COALESCE($4::text, category),
          interval_miles = COALESCE($5::int, interval_miles),
          interval_days = COALESCE($6::int, interval_days),
          due_soon_miles = COALESCE($7::int, due_soon_miles),
          due_soon_days = COALESCE($8::int, due_soon_days),
          blocks_rental_when_overdue = COALESCE($9::boolean, blocks_rental_when_overdue),
          blocks_guest_export_when_overdue = COALESCE($10::boolean, blocks_guest_export_when_overdue),
          requires_pass_result = COALESCE($11::boolean, requires_pass_result),
          is_active = COALESCE($12::boolean, is_active),
          rule_config = COALESCE(rule_config, '{}'::jsonb) || COALESCE($13::jsonb, '{}'::jsonb),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        ruleId,
        toNullableText(body.title),
        body.description === undefined ? null : toNullableText(body.description),
        toNullableText(body.category),
        body.intervalMiles ?? body.interval_miles ?? null,
        body.intervalDays ?? body.interval_days ?? null,
        body.dueSoonMiles ?? body.due_soon_miles ?? null,
        body.dueSoonDays ?? body.due_soon_days ?? null,
        body.blocksRentalWhenOverdue ?? body.blocks_rental_when_overdue ?? null,
        body.blocksGuestExportWhenOverdue ??
          body.blocks_guest_export_when_overdue ??
          null,
        body.requiresPassResult ?? body.requires_pass_result ?? null,
        body.isActive ?? body.is_active ?? null,
        body.ruleConfig && typeof body.ruleConfig === "object"
          ? JSON.stringify(body.ruleConfig)
          : body.rule_config && typeof body.rule_config === "object"
          ? JSON.stringify(body.rule_config)
          : null,
      ]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: "Maintenance rule not found" });
    }
    res.json({ ok: true, rule: result.rows[0] });
  } catch (err) {
    console.error(`PUT /admin/maintenance/rules/${req.params.ruleId} failed:`, err);
    res.status(err.statusCode || 500).json({
      error: err.message || "Failed to update maintenance rule",
    });
  } finally {
    client.release();
  }
});


module.exports = router;
