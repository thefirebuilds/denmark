// ------------------------------------------------------------
// server/services/maintenance/createMaintenanceEvent.js
// Service function to create a maintenance event — validated and persisted
// ------------------------------------------------------------

const pool = require("../../db");

async function resolveRule({ ruleId, ruleCode }) {
  if (ruleId) {
    const byId = await pool.query(
      `
      SELECT id, rule_code, title
      FROM maintenance_rules
      WHERE id = $1
      LIMIT 1
      `,
      [ruleId]
    );

    if (!byId.rows.length) {
      const err = new Error(`Unknown maintenance rule id: ${ruleId}`);
      err.statusCode = 400;
      throw err;
    }

    return byId.rows[0];
  }

  if (!ruleCode) {
    const err = new Error("ruleId or ruleCode required");
    err.statusCode = 400;
    throw err;
  }

  const result = await pool.query(
    `
    SELECT id, rule_code, title
    FROM maintenance_rules
    WHERE rule_code = $1
    LIMIT 1
    `,
    [ruleCode]
  );

  if (!result.rows.length) {
    const err = new Error(`Unknown maintenance rule: ${ruleCode}`);
    err.statusCode = 400;
    throw err;
  }

  return result.rows[0];
}

async function ensureVehicleExists(vin) {
  const result = await pool.query(
    `
    SELECT vin
    FROM vehicles
    WHERE vin = $1
    LIMIT 1
    `,
    [vin]
  );

  if (!result.rows.length) {
    const err = new Error(`Vehicle not found: ${vin}`);
    err.statusCode = 404;
    throw err;
  }
}

function normalizePerformedAt(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("Invalid performedAt date");
    err.statusCode = 400;
    throw err;
  }
  return d.toISOString();
}

function normalizeResult(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  const allowed = new Set([
    "pass",
    "fail",
    "attention",
    "performed",
    "measured",
    "not_applicable",
  ]);
  if (!allowed.has(normalized)) {
    const err = new Error(`Invalid result value: ${normalized}`);
    err.statusCode = 400;
    throw err;
  }
  return normalized;
}

function normalizeOdometerMiles(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    const err = new Error("Invalid odometerMiles value");
    err.statusCode = 400;
    throw err;
  }
  return Math.round(num);
}

function normalizeData(value) {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    const err = new Error("data must be a JSON object");
    err.statusCode = 400;
    throw err;
  }
  return value;
}

async function createMaintenanceEvent({
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
}) {
  if (!vin) {
    const err = new Error("VIN required");
    err.statusCode = 400;
    throw err;
  }

  await ensureVehicleExists(vin);

  const rule = await resolveRule({ ruleId, ruleCode });
  const performedTimestamp = normalizePerformedAt(performedAt);
  const odo = normalizeOdometerMiles(odometerMiles);
  const normalizedResult = normalizeResult(result);
  const normalizedData = normalizeData(data);

  const finalSource =
    source == null || String(source).trim() === "" ? "manual" : String(source).trim();

  const finalPerformedBy =
    performedBy == null || String(performedBy).trim() === "" ? null : String(performedBy).trim();

  const insert = await pool.query(
    `
    INSERT INTO maintenance_events (
      vehicle_vin,
      rule_id,
      title,
      event_type,
      performed_at,
      odometer_miles,
      result,
      notes,
      data,
      performed_by,
      source,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      NOW(),
      NOW()
    )
    RETURNING
      id,
      vehicle_vin,
      rule_id,
      title,
      event_type,
      performed_at,
      odometer_miles,
      result,
      notes,
      data,
      performed_by,
      source,
      created_at,
      updated_at
    `,
    [
      vin,
      rule.id,
      rule.title,
      rule.rule_code,
      performedTimestamp,
      odo,
      normalizedResult,
      notes ?? null,
      normalizedData,
      finalPerformedBy,
      finalSource,
    ]
  );

  return insert.rows[0];
}

module.exports = {
  createMaintenanceEvent,
};
