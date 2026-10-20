const { getTripEventIdentity } = require("./googleEventIdentity");

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

function withTripIdentity(trip, eventType, payload) {
  const identity = getTripEventIdentity(trip, eventType);

  return {
    eventType,
    eventId: identity.eventId,
    payload: {
      ...payload,
      extendedProperties: {
        ...(payload.extendedProperties || {}),
        private: {
          ...(payload.extendedProperties?.private || {}),
          ...identity.privateProperties,
        },
      },
    },
  };
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

  return withTripIdentity(trip, "unconfirmed", {
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
  });
}

function buildPickupEvent(trip) {
  const vehicleName = getVehicleCalendarName(trip);

  return withTripIdentity(trip, "pickup", {
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
  });
}

function buildReturnEvent(trip) {
  const vehicleName = getVehicleCalendarName(trip);

  return withTripIdentity(trip, "return", {
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
  });
}

function isCanceledOrDeleted(trip) {
  const stage = getNormalizedStage(trip);
  return Boolean(
    trip.deleted_at ||
      trip.canceled_at ||
      trip.closed_out === true ||
      stage === "complete" ||
      stage === "closed"
  );
}

function isUnconfirmedTrip(trip) {
  const stage = (trip.workflow_stage || "").toLowerCase();

  return stage.includes("unconfirmed");
}

function getNormalizedStage(trip) {
  return (trip.workflow_stage || trip.status || "").toLowerCase();
}

function shouldKeepPickupNotice(trip) {
  const stage = getNormalizedStage(trip);
  return ![
    "ready_for_handoff",
    "ready_for_guest",
    "in_progress",
    "check_in",
    "awaiting_expenses",
    "waiting expenses",
    "complete",
  ].includes(stage);
}

function shouldKeepReturnNotice(trip) {
  const stage = getNormalizedStage(trip);
  return !["check_in", "awaiting_expenses", "waiting expenses", "complete"].includes(stage);
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

  if (trip.trip_start && shouldKeepPickupNotice(trip)) {
    desired.push(buildPickupEvent(trip));
  }

  if (trip.trip_end && shouldKeepReturnNotice(trip)) {
    desired.push(buildReturnEvent(trip));
  }

  // Awaiting expenses ends calendar action reminders; reconciliation removes
  // previously synced expense_closeout events along with handoff notices.

  return desired;
}

module.exports = {
  getDesiredGoogleEventsForTrip,
};
