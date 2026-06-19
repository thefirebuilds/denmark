const crypto = require("crypto");

function normalizeIdentityPart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function buildGoogleEventId(parts) {
  const stableKey = parts.map(normalizeIdentityPart).filter(Boolean).join("|");
  const digest = crypto.createHash("sha256").update(stableKey).digest("hex");
  return `denmark${digest.slice(0, 48)}`;
}

function getTripStableKey(trip) {
  if (trip?.reservation_id) return `reservation:${trip.reservation_id}`;
  if (trip?.id) return `trip:${trip.id}`;

  return [
    "trip",
    trip?.guest_name || "guest",
    trip?.vehicle_nickname || trip?.vehicle_name || "vehicle",
    trip?.trip_start || "start",
    trip?.trip_end || "end",
  ].join(":");
}

function getTripEventIdentity(trip, eventType) {
  const tripKey = getTripStableKey(trip);
  const eventKey = `trip:${tripKey}:${eventType}`;

  return {
    eventId: buildGoogleEventId(["trip", tripKey, eventType]),
    privateProperties: {
      denmarkEventType: `trip_${eventType}`,
      denmarkTripEventKey: eventKey,
      denmarkReservationId: trip?.reservation_id ? String(trip.reservation_id) : "",
      denmarkTripId: trip?.id ? String(trip.id) : "",
    },
  };
}

function getMaintenanceEventIdentity(maintenanceKey) {
  return {
    eventId: buildGoogleEventId(["maintenance", maintenanceKey]),
    privateProperties: {
      denmarkEventType: "maintenance_required",
      denmarkMaintenanceKey: String(maintenanceKey || ""),
    },
  };
}

module.exports = {
  buildGoogleEventId,
  getTripEventIdentity,
  getMaintenanceEventIdentity,
};
