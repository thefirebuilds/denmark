const ROLE_PERMISSIONS = Object.freeze({
  owner: ["*"],
  operator: [
    "telemetry.read",
    "vehicles.read",
    "vehicles.write",
    "trips.read",
    "trips.write",
    "trip_summaries.read",
    "trip_summaries.write",
    "calendar.read",
    "calendar.write",
    "calendar.sync",
    "messages.read",
    "messages.write",
    "maintenance.read",
    "maintenance.write",
    "tolls.read",
    "tolls.write",
    "tolls.sync",
    "expenses.read",
    "expenses.write",
    "metrics.read",
    "metrics.write",
    "marketplace.read",
    "marketplace.write",
    "business.read",
    "settings.read",
  ],
  viewer: [
    "telemetry.read",
    "vehicles.read",
    "trips.read",
    "trip_summaries.read",
    "calendar.read",
    "messages.read",
    "maintenance.read",
    "tolls.read",
    "expenses.read",
    "metrics.read",
    "marketplace.read",
    "business.read",
  ],
  family: ["trip_summaries.read", "calendar.read"],
  service: [
    "service_jobs.run",
    "notifications.ingest",
    "telemetry.read",
    "vehicles.read",
    "trips.read",
    "trip_summaries.read",
    "calendar.read",
    "calendar.write",
    "calendar.sync",
    "tolls.read",
    "tolls.sync",
    "metrics.read",
  ],
});

const ROLE_RANK = Object.freeze({
  family: 1,
  viewer: 2,
  operator: 3,
  owner: 4,
  service: 0,
});

function normalizeRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value)
    ? value
    : "viewer";
}

function getPermissionsForRole(role) {
  const normalized = normalizeRole(role);
  return [...(ROLE_PERMISSIONS[normalized] || [])];
}

function hasPermission(role, permission) {
  if (!permission) return true;
  const permissions = getPermissionsForRole(role);
  return permissions.includes("*") || permissions.includes(permission);
}

function hasRole(currentRole, requiredRole) {
  const current = normalizeRole(currentRole);
  const required = normalizeRole(requiredRole);

  if (current === "owner") return true;
  if (current === required) return true;
  if (current === "service" || required === "service") return false;

  return Number(ROLE_RANK[current] || 0) >= Number(ROLE_RANK[required] || 0);
}

module.exports = {
  ROLE_PERMISSIONS,
  normalizeRole,
  getPermissionsForRole,
  hasPermission,
  hasRole,
};
