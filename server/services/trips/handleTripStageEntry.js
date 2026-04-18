const { findVehicleForTrip } = require("../maintenance/findVehicleForTrip");
const { getVehicleMaintenanceSummary } = require("../maintenance/getVehicleMaintenanceSummary");
const { evaluateUpcomingTripMaintenance } = require("../maintenance/evaluateUpcomingTripMaintenance");
const { evaluatePostTripMaintenance } = require("../maintenance/evaluatePostTripMaintenance");

async function handleTripStageEntry(client, trip, previousStage = null) {
  if (!trip?.workflow_stage) {
    return { skipped: true, reason: "missing_workflow_stage" };
  }

  if (previousStage && previousStage === trip.workflow_stage) {
    return {
      skipped: true,
      reason: "same_stage",
      workflowStage: trip.workflow_stage,
      previousStage,
    };
  }

  // Only run automation for the lifecycle entry points we care about right now.
  if (
    trip.workflow_stage !== "confirmed" &&
    trip.workflow_stage !== "turnaround"
  ) {
    return {
      skipped: true,
      reason: "no_stage_entry_automation",
      workflowStage: trip.workflow_stage,
      previousStage,
    };
  }

  const vehicle = await findVehicleForTrip(client, trip);

  if (!vehicle?.vin) {
    return {
      skipped: true,
      reason: "vehicle_not_found",
      workflowStage: trip.workflow_stage,
      previousStage,
    };
  }

  const summary = await getVehicleMaintenanceSummary(client, vehicle.vin);

  const results = {
    skipped: false,
    vehicleVin: vehicle.vin,
    workflowStage: trip.workflow_stage,
    previousStage,
    upcoming: null,
    postTrip: null,
  };

  if (trip.workflow_stage === "confirmed") {
    results.upcoming = await evaluateUpcomingTripMaintenance(client, {
      vehicle,
      trip,
      summary,
    });
  }

  if (trip.workflow_stage === "turnaround") {
    results.postTrip = await evaluatePostTripMaintenance(client, {
      vehicle,
      trip,
      summary,
    });
  }

  return results;
}

module.exports = {
  handleTripStageEntry,
};