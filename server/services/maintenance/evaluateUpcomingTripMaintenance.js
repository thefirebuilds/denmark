const { createTaskIfMissing } = require("./taskHelpers");

const ASSUMED_MILES_PER_DAY = 35;

function getTripLengthDays(trip) {
  if (!trip?.trip_start || !trip?.trip_end) return 0;

  const start = new Date(trip.trip_start);
  const end = new Date(trip.trip_end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }

  const ms = end.getTime() - start.getTime();

  if (ms <= 0) return 0;

  return Math.ceil(ms / 86400000);
}

function shouldFlagMileageProjection(rule, projectedTripMiles, currentOdometerMiles) {
  if (!rule) return false;
  if (rule.nextDueMiles == null) return false;
  if (currentOdometerMiles == null) return false;
  if (projectedTripMiles <= 0) return false;

  const remainingMilesToDue = rule.nextDueMiles - currentOdometerMiles;
  return remainingMilesToDue <= projectedTripMiles;
}

function shouldFlagDateProjection(rule, tripEnd) {
  if (!rule?.nextDueDate || !tripEnd) return false;

  const nextDue = new Date(rule.nextDueDate);
  const tripEndDate = new Date(tripEnd);

  if (Number.isNaN(nextDue.getTime()) || Number.isNaN(tripEndDate.getTime())) {
    return false;
  }

  return nextDue <= tripEndDate;
}

async function evaluateUpcomingTripMaintenance(client, { vehicle, trip, summary }) {
  if (!vehicle?.vin) {
    return {
      createdTasks: [],
      skipped: true,
      reason: "missing_vehicle_vin",
    };
  }

  if (!trip?.id) {
    return {
      createdTasks: [],
      skipped: true,
      reason: "missing_trip_id",
    };
  }

  const ruleStatuses = Array.isArray(summary?.ruleStatuses)
    ? summary.ruleStatuses
    : [];

  if (!ruleStatuses.length) {
    return {
      createdTasks: [],
      skipped: true,
      reason: "no_rule_statuses",
    };
  }

  const createdTasks = [];
  const currentOdometerMiles = summary.currentOdometerMiles ?? null;
  const tripLengthDays = getTripLengthDays(trip);
  const projectedTripMiles = tripLengthDays * ASSUMED_MILES_PER_DAY;

  const baseContext = {
    tripId: trip.id,
    reservationId: trip.reservation_id || null,
    tripStart: trip.trip_start || null,
    tripEnd: trip.trip_end || null,
    tripLengthDays,
    projectedTripMiles,
    assumedMilesPerDay: ASSUMED_MILES_PER_DAY,
  };

  for (const rule of ruleStatuses) {
    const mileageRisk = shouldFlagMileageProjection(
      rule,
      projectedTripMiles,
      currentOdometerMiles
    );

    const dateRisk = shouldFlagDateProjection(rule, trip.trip_end);

    if (!mileageRisk && !dateRisk) {
      continue;
    }

    const remainingMilesToDue =
      rule.nextDueMiles != null && currentOdometerMiles != null
        ? rule.nextDueMiles - currentOdometerMiles
        : null;

    const sourceKey = [
      "trip",
      trip.id,
      "stage",
      "confirmed",
      "rule",
      rule.ruleId,
      "trip_projection_maintenance_risk",
    ].join(":");

    const result = await createTaskIfMissing(client, {
      vehicleVin: vehicle.vin,
      ruleId: rule.ruleId,
      relatedTripId: trip.id,
      taskType: "trip_projection_maintenance_risk",
      title: `${rule.title} likely due during upcoming trip`,
      description:
        `${rule.title} is projected to become due during this scheduled trip. ` +
        `Trip length: ${tripLengthDays} day(s). Estimated trip miles: ${projectedTripMiles}.`,
      priority: "high",
      needsReview: true,
      source: "system",
      triggerType: "trip_projection",
      sourceKey,
      triggerContext: {
        ...baseContext,
        ruleCode: rule.ruleCode,
        ruleStatus: rule.status,
        nextDueMiles: rule.nextDueMiles,
        nextDueDate: rule.nextDueDate,
        currentOdometerMiles,
        remainingMilesToDue,
        mileageRisk,
        dateRisk,
      },
    });

    if (result?.created && result.task) {
      createdTasks.push(result.task);
    }
  }

  return {
    createdTasks,
    skipped: false,
    tripLengthDays,
    projectedTripMiles,
  };
}

module.exports = {
  evaluateUpcomingTripMaintenance,
  ASSUMED_MILES_PER_DAY,
};