const pool = require("../../db");

async function findVehicleForTrip(clientOrTrip, maybeTrip = null) {
  const client = maybeTrip ? clientOrTrip : pool;
  const trip = maybeTrip || clientOrTrip;

  if (!trip) return null;

  // Best match: direct VIN
  if (trip.vehicle_vin) {
    const byVin = await client.query(
      `
        SELECT
          id,
          vin,
          turo_vehicle_id,
          nickname,
          year,
          make,
          model,
          current_odometer_miles
        FROM vehicles
        WHERE vin = $1
        LIMIT 1
      `,
      [trip.vehicle_vin]
    );

    if (byVin.rows[0]) return byVin.rows[0];
  }

  // Next best: Turo vehicle id
  if (trip.turo_vehicle_id) {
    const byTuroVehicleId = await client.query(
      `
        SELECT
          id,
          vin,
          turo_vehicle_id,
          nickname,
          year,
          make,
          model,
          current_odometer_miles
        FROM vehicles
        WHERE turo_vehicle_id = $1
        LIMIT 1
      `,
      [trip.turo_vehicle_id]
    );

    if (byTuroVehicleId.rows[0]) return byTuroVehicleId.rows[0];
  }

  // Fallback: nickname match
  const tripVehicleName = String(trip.vehicle_name || "").trim().toLowerCase();

  if (tripVehicleName) {
    const byNickname = await client.query(
      `
        SELECT
          id,
          vin,
          turo_vehicle_id,
          nickname,
          year,
          make,
          model,
          current_odometer_miles
        FROM vehicles
        WHERE LOWER(nickname) = $1
        LIMIT 1
      `,
      [tripVehicleName]
    );

    if (byNickname.rows[0]) return byNickname.rows[0];
  }

  return null;
}

module.exports = {
  findVehicleForTrip,
};