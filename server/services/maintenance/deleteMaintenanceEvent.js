// ------------------------------------------------------------
// server/services/maintenance/deleteMaintenanceEvent.js
// Delete a single maintenance event for a vehicle
// ------------------------------------------------------------

const pool = require("../../db");

async function deleteMaintenanceEvent({ vin, eventId }) {
  if (!vin) {
    const err = new Error("VIN required");
    err.statusCode = 400;
    throw err;
  }

  if (!eventId) {
    const err = new Error("eventId required");
    err.statusCode = 400;
    throw err;
  }

  const result = await pool.query(
    `
    DELETE FROM maintenance_events
    WHERE id = $1
      AND vehicle_vin = $2
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
    [eventId, vin]
  );

  if (!result.rows.length) {
    const err = new Error("Maintenance event not found");
    err.statusCode = 404;
    throw err;
  }

  return result.rows[0];
}

module.exports = {
  deleteMaintenanceEvent,
};