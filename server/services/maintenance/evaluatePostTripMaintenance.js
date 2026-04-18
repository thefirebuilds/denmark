// -------------------------------------------------
// /server/services/maintenance/evaluatePostTripMaintenance.js
// Evaluates post-trip maintenance needs based on vehicle rules and creates tasks accordingly
// -------------------------------------------------


const { createTaskIfMissing } = require("./taskHelpers");

function getRuleMap(ruleStatuses) {
  const map = new Map();

  for (const rule of ruleStatuses || []) {
    if (rule?.ruleCode) {
      map.set(rule.ruleCode, rule);
    }
  }

  return map;
}

function isAttentionNeeded(ruleStatus) {
  if (!ruleStatus) return false;
  return ruleStatus.status === "due_soon" || ruleStatus.status === "overdue";
}

async function evaluatePostTripMaintenance(client, { vehicle, trip, summary }) {
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

  const createdTasks = [];
  const ruleMap = getRuleMap(summary?.ruleStatuses || []);

  const baseContext = {
    tripId: trip.id,
    tripStart: trip.trip_start || null,
    tripEnd: trip.trip_end || null,
    reservationId: trip.reservation_id || null,
  };

  // Always: oil level check after every trip
  {
    const result = await createTaskIfMissing(client, {
      vehicleVin: vehicle.vin,
      relatedTripId: trip.id,
      taskType: "post_trip_oil_level_check",
      title: "Check oil level",
      description: "Post-trip oil level check required after vehicle return.",
      priority: "medium",
      source: "system",
      triggerType: "trip_end",
      sourceKey: `trip:${trip.id}:stage:turnaround:post_trip_oil_level_check`,
      triggerContext: {
        ...baseContext,
        reason: "after_every_trip",
      },
    });

    if (result?.created && result.task) {
      createdTasks.push(result.task);
    }
  }

  // Always: post-trip condition review
  {
    const result = await createTaskIfMissing(client, {
      vehicleVin: vehicle.vin,
      relatedTripId: trip.id,
      taskType: "post_trip_condition_review",
      title: "Post-trip condition review",
      description:
        "Walkaround for new damage, unusual wear, cabin condition, odors, and cosmetic changes.",
      priority: "medium",
      source: "system",
      triggerType: "trip_end",
      sourceKey: `trip:${trip.id}:stage:turnaround:post_trip_condition_review`,
      triggerContext: {
        ...baseContext,
        reason: "after_every_trip",
      },
    });

    if (result?.created && result.task) {
      createdTasks.push(result.task);
    }
  }

  const conditionalRules = [
    {
      ruleCode: "tire_pressure_check",
      taskType: "post_trip_tire_pressure_check",
      title: "Check tire pressure",
      description: "Tire pressure check is due or nearly due after this trip.",
      priority: "medium",
    },
    {
      ruleCode: "fluid_leak_check",
      taskType: "post_trip_fluid_leak_check",
      title: "Perform fluid / leak inspection",
      description: "Fluid / leak inspection is due or nearly due after this trip.",
      priority: "medium",
    },
    {
      ruleCode: "tread_depth",
      taskType: "post_trip_tread_depth_check",
      title: "Inspect tread depth",
      description: "Tread depth inspection is due or nearly due after this trip.",
      priority: "high",
    },
    {
      ruleCode: "brake_inspection",
      taskType: "post_trip_brake_inspection",
      title: "Inspect brakes",
      description: "Brake inspection is due or nearly due after this trip.",
      priority: "high",
    },
  ];

  for (const config of conditionalRules) {
    const rule = ruleMap.get(config.ruleCode);

    if (!isAttentionNeeded(rule)) {
      continue;
    }

    const sourceKey = [
      "trip",
      trip.id,
      "stage",
      "turnaround",
      "rule",
      rule.ruleId,
      config.taskType,
    ].join(":");

    const result = await createTaskIfMissing(client, {
      vehicleVin: vehicle.vin,
      ruleId: rule.ruleId,
      relatedTripId: trip.id,
      taskType: config.taskType,
      title: config.title,
      description: config.description,
      priority: config.priority,
      needsReview: rule.status === "overdue",
      blocksRental:
        config.ruleCode === "brake_inspection" && rule.status === "overdue",
      blocksGuestExport:
        config.ruleCode === "brake_inspection" && rule.status === "overdue",
      source: "system",
      triggerType: "trip_end",
      sourceKey,
      triggerContext: {
        ...baseContext,
        ruleCode: rule.ruleCode,
        ruleStatus: rule.status,
        nextDueMiles: rule.nextDueMiles,
        nextDueDate: rule.nextDueDate,
      },
    });

    if (result?.created && result.task) {
      createdTasks.push(result.task);
    }
  }

  return {
    createdTasks,
    skipped: false,
  };
}

module.exports = {
  evaluatePostTripMaintenance,
};