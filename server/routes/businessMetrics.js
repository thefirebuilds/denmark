const express = require("express");
const pool = require("../db");
const {
  ensureMaintenanceRuntimeSchema,
} = require("../services/maintenance/maintenanceRuntimeSchema");
const {
  estimateLaborHours,
  normalizeLaborHours,
} = require("../services/maintenance/laborEstimates");
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

function normalizeMissingLaborRow(kind, row) {
  const suggestedHours = estimateLaborHours({
    ruleCode: row.rule_code,
    taskType: row.task_type || row.event_type,
    title: row.title,
    description: row.description || row.notes,
  });

  return {
    kind,
    id: Number(row.id),
    vehicleId: Number(row.vehicle_id),
    vehicleVin: row.vehicle_vin,
    vehicleName: row.vehicle_name,
    title: row.title || (kind === "event" ? "Maintenance event" : "Maintenance task"),
    taskType: row.task_type || row.event_type || null,
    status: row.status || null,
    priority: row.priority || null,
    description: row.description || null,
    notes: row.notes || null,
    source: row.source || null,
    ruleCode: row.rule_code || null,
    occurredAt: row.performed_at || row.updated_at || row.created_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    suggestedHours,
  };
}

function shouldSaveActualLabor(kind, row) {
  if (kind === "event") return true;
  const status = String(row?.status || "").trim().toLowerCase();
  return status === "resolved" || status === "complete" || status === "completed";
}

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

router.get("/maintenance-labor-missing/:vehicleId", async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
      return res.status(400).json({ error: "Invalid vehicleId" });
    }

    await ensureMaintenanceRuntimeSchema();

    const vehicleResult = await pool.query(
      `
        SELECT id, vin, nickname
        FROM vehicles
        WHERE id = $1
        LIMIT 1
      `,
      [vehicleId]
    );

    const vehicle = vehicleResult.rows[0];
    if (!vehicle) {
      return res.status(404).json({ error: "Vehicle not found" });
    }

    const taskResult = await pool.query(
      `
        SELECT
          mt.id,
          v.id AS vehicle_id,
          mt.vehicle_vin,
          COALESCE(v.nickname, mt.vehicle_vin) AS vehicle_name,
          mt.task_type,
          mt.title,
          mt.description,
          mt.priority,
          mt.status,
          mt.source,
          mt.created_at,
          mt.updated_at,
          mr.rule_code
        FROM maintenance_tasks mt
        JOIN vehicles v
          ON v.vin = mt.vehicle_vin
        LEFT JOIN maintenance_rules mr
          ON mr.id = mt.rule_id
        WHERE v.id = $1
          AND mt.estimated_labor_hours IS NULL
          AND mt.actual_labor_hours IS NULL
          AND COALESCE(mt.status, '') <> 'canceled'
        ORDER BY
          CASE
            WHEN mt.status IN ('open', 'scheduled', 'in_progress', 'deferred') THEN 0
            ELSE 1
          END,
          mt.updated_at DESC NULLS LAST,
          mt.id DESC
      `,
      [vehicleId]
    );

    const eventResult = await pool.query(
      `
        SELECT
          me.id,
          v.id AS vehicle_id,
          me.vehicle_vin,
          COALESCE(v.nickname, me.vehicle_vin) AS vehicle_name,
          me.event_type,
          me.title,
          me.notes,
          me.source,
          me.performed_at,
          me.created_at,
          me.updated_at,
          mr.rule_code
        FROM maintenance_events me
        JOIN vehicles v
          ON v.vin = me.vehicle_vin
        LEFT JOIN maintenance_rules mr
          ON mr.id = me.rule_id
        WHERE v.id = $1
          AND me.estimated_labor_hours IS NULL
          AND me.actual_labor_hours IS NULL
        ORDER BY me.performed_at DESC NULLS LAST, me.id DESC
      `,
      [vehicleId]
    );

    res.json({
      vehicle: {
        id: Number(vehicle.id),
        vin: vehicle.vin,
        name: vehicle.nickname || vehicle.vin,
      },
      items: [
        ...taskResult.rows.map((row) => normalizeMissingLaborRow("task", row)),
        ...eventResult.rows.map((row) => normalizeMissingLaborRow("event", row)),
      ],
    });
  } catch (err) {
    console.error(
      "GET /api/metrics/business/maintenance-labor-missing/:vehicleId failed:",
      err
    );
    res.status(500).json({ error: "Failed to load missing maintenance labor" });
  }
});

router.patch("/maintenance-labor/:kind/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const kind = String(req.params.kind || "").trim().toLowerCase();
    const id = Number(req.params.id);
    const hours = normalizeLaborHours(req.body?.hours);

    if (!["task", "event"].includes(kind)) {
      return res.status(400).json({ error: "Invalid maintenance labor kind" });
    }

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid maintenance labor id" });
    }

    if (hours == null) {
      return res.status(400).json({ error: "Enter labor hours as a positive number" });
    }

    await ensureMaintenanceRuntimeSchema();

    await client.query("BEGIN");

    const table = kind === "task" ? "maintenance_tasks" : "maintenance_events";
    const existingColumns = kind === "task" ? "id, status" : "id";
    const existingResult = await client.query(
      `
        SELECT ${existingColumns}
        FROM ${table}
        WHERE id = $1
        FOR UPDATE
      `,
      [id]
    );

    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Maintenance labor item not found" });
    }

    const targetColumn = shouldSaveActualLabor(kind, existing)
      ? "actual_labor_hours"
      : "estimated_labor_hours";

    const updateResult = await client.query(
      `
        UPDATE ${table}
        SET
          ${targetColumn} = $2,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [id, hours]
    );

    await client.query("COMMIT");
    res.json({
      ok: true,
      kind,
      savedColumn: targetColumn,
      item: updateResult.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("PATCH /api/metrics/business/maintenance-labor/:kind/:id failed:", err);
    res.status(500).json({ error: "Failed to save maintenance labor hours" });
  } finally {
    client.release();
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
