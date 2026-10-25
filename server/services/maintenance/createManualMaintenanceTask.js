const crypto = require("node:crypto");
const { estimateLaborHours, normalizeLaborHours } = require("./laborEstimates");

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
        createdFrom: input.createdFrom || "maintenance_todo_form",
      }),
      estimatedLaborHours,
    ]
  );

  return result.rows[0];
}

module.exports = { createManualMaintenanceTask };
