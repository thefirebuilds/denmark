const { getVehicleMaintenanceSummary } = require("./getVehicleMaintenanceSummary");
const { evaluateUpcomingTripMaintenance } = require("./evaluateUpcomingTripMaintenance");
const { evaluatePostTripMaintenance } = require("./evaluatePostTripMaintenance");
const { findVehicleForTrip } = require("./findVehicleForTrip");

function isUpcomingTripStatus(status) {
  return ["booked_unconfirmed", "updated_unconfirmed", "booked", "confirmed"].includes(status);
}

function isTripEnded(trip) {
  if (!trip?.trip_end) return false;
  const end = new Date(trip.trip_end);
  if (Number.isNaN(end.getTime())) return false;
  return end.getTime() < Date.now();
}

async function runTripMaintenanceEvaluators(trip) {
  const vehicle = await findVehicleForTrip(trip);
  if (!vehicle?.vin) return { skipped: true, reason: "vehicle_not_found" };

  const summary = await getVehicleMaintenanceSummary(vehicle.vin);

  const results = {
    skipped: false,
    vehicleVin: vehicle.vin,
    upcoming: null,
    postTrip: null,
  };

  if (isUpcomingTripStatus(trip.status)) {
    results.upcoming = await evaluateUpcomingTripMaintenance({
      vehicle,
      trip,
      summary,
    });
  }

  if (isTripEnded(trip)) {
    results.postTrip = await evaluatePostTripMaintenance({
      vehicle,
      trip,
      summary,
    });
  }

  return results;
}

module.exports = {
  runTripMaintenanceEvaluators,
};