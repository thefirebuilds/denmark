// ------------------------------------------------------------
// server/services/maintenance/createMaintenanceEvent.js
// Service function to create a maintenance event — validated and persisted
// ------------------------------------------------------------

const pool = require("../../db");

function getResolvableTaskTypesForRuleCode(ruleCode) {
  const normalized = String(ruleCode || "").trim().toLowerCase();

  if (normalized === "fluid_leak_check" || normalized === "leak_check") {
    return ["post_trip_fluid_leak_check", "post_trip_oil_level_check"];
  }

  if (
    normalized === "tire_pressure_check" ||
    normalized === "tire_pressure_inspection"
  ) {
    return ["post_trip_tire_pressure_check"];
  }

  return [];
}

async function resolveRule(client, { ruleId, ruleCode }) {
  if (ruleId) {
    const byId = await client.query(
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

  const result = await client.query(
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

async function ensureVehicleExists(client, vin) {
  const result = await client.query(
    `
    SELECT id, vin, current_odometer_miles
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

  return result.rows[0];
}

function normalizePerformedAt(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("Invalid performedAt date");
    err.statusCode = 400;
    throw err;
  }

  const maxFutureMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
  if (d.getTime() > maxFutureMs) {
    const err = new Error("performedAt cannot be more than 7 days in the future");
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
  if (value === undefined || value === null || value === "") {
    const err = new Error("Odometer is required for maintenance entries");
    err.statusCode = 400;
    throw err;
  }

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

async function recordVehicleOdometer(client, vehicle, odometerMiles, recordedAt) {
  await client.query(
    `
      UPDATE vehicles
      SET
        current_odometer_miles = CASE
          WHEN current_odometer_miles IS NULL THEN $2
          WHEN $2 >= current_odometer_miles THEN $2
          ELSE current_odometer_miles
        END,
        updated_at = NOW()
      WHERE vin = $1
    `,
    [vehicle.vin, odometerMiles]
  );

  await client.query(
    `
      INSERT INTO vehicle_odometer_history (
        vehicle_id,
        odometer_miles,
        recorded_at,
        source
      )
      VALUES ($1, $2, $3::timestamp, 'maintenance_event')
    `,
    [vehicle.id, odometerMiles, recordedAt]
  );
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

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const vehicle = await ensureVehicleExists(client, vin);
    const rule = await resolveRule(client, { ruleId, ruleCode });
    const performedTimestamp = normalizePerformedAt(performedAt);
    const odo = normalizeOdometerMiles(odometerMiles);
    const normalizedResult = normalizeResult(result);
    const normalizedData = normalizeData(data);

    const finalSource =
      source == null || String(source).trim() === "" ? "manual" : String(source).trim();

    const finalPerformedBy =
      performedBy == null || String(performedBy).trim() === ""
        ? null
        : String(performedBy).trim();

    const insert = await client.query(
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

    await recordVehicleOdometer(client, vehicle, odo, performedTimestamp);

    const resolvableTaskTypes = getResolvableTaskTypesForRuleCode(rule.rule_code);

    const taskCloseResult = await client.query(
      `
      UPDATE maintenance_tasks
      SET
        status = 'resolved',
        updated_at = NOW()
      WHERE vehicle_vin = $1
        AND status IN ('open', 'scheduled', 'in_progress', 'deferred')
        AND (
          rule_id = $2
          OR trigger_context->>'ruleCode' = $3
          OR task_type = ANY($4::text[])
        )
      `,
      [vin, rule.id, rule.rule_code, resolvableTaskTypes]
    );

    await client.query("COMMIT");

    return {
      ...insert.rows[0],
      closed_task_count: taskCloseResult.rowCount,
      vehicle_current_odometer_miles: Math.max(
        Number(vehicle.current_odometer_miles || 0),
        odo
      ),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createMaintenanceEvent,
};
