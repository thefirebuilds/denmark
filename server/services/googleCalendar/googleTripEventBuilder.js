function addMinutes(isoOrDate, minutes) {
  const d = new Date(isoOrDate);
  return new Date(d.getTime() + minutes * 60 * 1000).toISOString();
}

function formatDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getTripLengthDays(tripStart, tripEnd) {
  if (!tripStart || !tripEnd) return null;
  const ms = new Date(tripEnd).getTime() - new Date(tripStart).getTime();
  const days = ms / (1000 * 60 * 60 * 24);
  return Math.round(days * 10) / 10;
}

function coalesceStage(trip) {
  return trip.workflow_stage || trip.status || "unknown";
}

function getVehicleCalendarName(trip) {
  return trip.vehicle_nickname || trip.vehicle_name || "Car";
}

function baseDescriptionLines(trip) {
  const vehicleName = getVehicleCalendarName(trip);
  const lines = [
    `Guest: ${trip.guest_name || "Unknown"}`,
    `Vehicle: ${vehicleName}`,
    `Trip start: ${formatDateTime(trip.trip_start)}`,
    `Trip end: ${formatDateTime(trip.trip_end)}`,
    `Workflow stage: ${coalesceStage(trip)}`,
  ];

  if (trip.vehicle_nickname && trip.vehicle_name && trip.vehicle_nickname !== trip.vehicle_name) {
    lines.push(`Turo vehicle: ${trip.vehicle_name}`);
  }

  const tripDays = getTripLengthDays(trip.trip_start, trip.trip_end);
  if (tripDays !== null) {
    lines.push(`Length: ${tripDays} day${tripDays === 1 ? "" : "s"}`);
  }

  if (trip.reservation_id) {
    lines.push(`Reservation ID: ${trip.reservation_id}`);
  }

  if (trip.trip_details_url) {
    lines.push("", `Trip URL: ${trip.trip_details_url}`);
  }

  if (trip.notes) {
    lines.push("", "Notes:", trip.notes);
  }

  return lines;
}

function buildUnconfirmedEvent(trip) {
  const startAt = trip.trip_start || trip.created_at || new Date().toISOString();
  const vehicleName = getVehicleCalendarName(trip);

  return {
    eventType: "unconfirmed",
    payload: {
      summary: `Turo unconfirmed: ${vehicleName} / ${trip.guest_name || "Guest"}`,
      description: [
        "Action: review and confirm incoming trip",
        ...baseDescriptionLines(trip),
      ].join("\n"),
      start: {
        dateTime: new Date(startAt).toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: addMinutes(startAt, 15),
        timeZone: "America/Chicago",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 30 },
          { method: "popup", minutes: 0 },
        ],
      },
    },
  };
}

function buildPickupEvent(trip) {
  const vehicleName = getVehicleCalendarName(trip);

  return {
    eventType: "pickup",
    payload: {
      summary: `Turo pickup: ${vehicleName} / ${trip.guest_name || "Guest"}`,
      description: [
        "Action: pickup / handoff",
        ...baseDescriptionLines(trip),
      ].join("\n"),
      start: {
        dateTime: new Date(trip.trip_start).toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: addMinutes(trip.trip_start, 15),
        timeZone: "America/Chicago",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 30 },
          { method: "popup", minutes: 0 },
        ],
      },
    },
  };
}

function buildReturnEvent(trip) {
  const vehicleName = getVehicleCalendarName(trip);

  return {
    eventType: "return",
    payload: {
      summary: `Turo return: ${vehicleName} / ${trip.guest_name || "Guest"}`,
      description: [
        "Action: receive car, check condition, photos, mileage, fuel",
        ...baseDescriptionLines(trip),
      ].join("\n"),
      start: {
        dateTime: new Date(trip.trip_end).toISOString(),
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: addMinutes(trip.trip_end, 15),
        timeZone: "America/Chicago",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 30 },
          { method: "popup", minutes: 0 },
        ],
      },
    },
  };
}

function getExpenseCloseoutStart(trip) {
  const now = new Date();
  const stageUpdatedAt = trip.stage_updated_at ? new Date(trip.stage_updated_at) : null;

  if (stageUpdatedAt) {
    const hour = stageUpdatedAt.getHours();
    if (hour >= 8 && hour <= 18) {
      return stageUpdatedAt.toISOString();
    }
  }

  const nextMorning = new Date(now);
  nextMorning.setHours(9, 0, 0, 0);

  if (now >= nextMorning) {
    nextMorning.setDate(nextMorning.getDate() + 1);
  }

  return nextMorning.toISOString();
}

function buildExpenseCloseoutEvent(trip) {
  const startAt = getExpenseCloseoutStart(trip);
  const vehicleName = getVehicleCalendarName(trip);

  const extra = [];
  if (trip.toll_count != null) extra.push(`Toll count: ${trip.toll_count}`);
  if (trip.toll_total != null) extra.push(`Toll total: ${trip.toll_total}`);
  if (trip.fuel_reimbursement_total != null) {
    extra.push(`Fuel reimbursement total: ${trip.fuel_reimbursement_total}`);
  }
  if (trip.expense_status) extra.push(`Expense status: ${trip.expense_status}`);

  return {
    eventType: "expense_closeout",
    payload: {
      summary: `Turo closeout: ${vehicleName} / ${trip.guest_name || "Guest"}`,
      description: [
        "Action: close out expenses",
        ...baseDescriptionLines(trip),
        "",
        ...extra,
      ].join("\n"),
      start: {
        dateTime: startAt,
        timeZone: "America/Chicago",
      },
      end: {
        dateTime: addMinutes(startAt, 15),
        timeZone: "America/Chicago",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 30 },
          { method: "popup", minutes: 0 },
        ],
      },
    },
  };
}

function isCanceledOrDeleted(trip) {
  return Boolean(trip.deleted_at || trip.canceled_at);
}

function isUnconfirmedTrip(trip) {
  const stage = (trip.workflow_stage || "").toLowerCase();

  return stage.includes("unconfirmed");
}

function isWaitingExpenses(trip) {
  return ["waiting expenses", "awaiting_expenses"].includes(
    (trip.workflow_stage || "").toLowerCase()
  );
}

function getDesiredGoogleEventsForTrip(trip) {
  if (!trip || isCanceledOrDeleted(trip)) {
    return [];
  }

  const desired = [];

  if (isUnconfirmedTrip(trip)) {
    desired.push(buildUnconfirmedEvent(trip));
    return desired;
  }

  if (trip.trip_start) {
    desired.push(buildPickupEvent(trip));
  }

  if (trip.trip_end) {
    desired.push(buildReturnEvent(trip));
  }

  if (isWaitingExpenses(trip)) {
    desired.push(buildExpenseCloseoutEvent(trip));
  }

  return desired;
}

module.exports = {
  getDesiredGoogleEventsForTrip,
};
