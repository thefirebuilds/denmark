const pool = require("../../db");

const DEFAULT_RADIUS_MILES = 0.15;
const SETTINGS_KEY = "locations.tracking";

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function coerceCoordinate(value, maxAbs) {
  let number = toNumber(value);
  if (number == null) return null;
  if (Math.abs(number) <= maxAbs) return number;

  for (let scale = 10; scale <= 1e16; scale *= 10) {
    const scaled = number / scale;
    if (Math.abs(scaled) <= maxAbs) return scaled;
  }

  return number;
}

function slugify(value, fallback = "location") {
  const slug = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function getDefaultParkingLocation() {
  const latitude = null;
  const longitude = null;
  const radiusMiles = DEFAULT_RADIUS_MILES;
  const label = "Park My Share";

  return {
    id: slugify(label, "park-my-share"),
    label,
    latitude,
    longitude,
    radiusMiles,
    kind: "parking",
    enabled: latitude != null && longitude != null,
    alertOnEntry: true,
  };
}

function normalizeLocation(raw, index = 0) {
  const label = cleanText(raw?.label || raw?.name, `Location ${index + 1}`);
  const latitude = coerceCoordinate(raw?.latitude ?? raw?.lat, 90);
  const longitude = coerceCoordinate(raw?.longitude ?? raw?.lon ?? raw?.lng, 180);
  const radiusMiles = toNumber(raw?.radiusMiles ?? raw?.radius_miles);

  return {
    id: slugify(raw?.id || label, `location-${index + 1}`),
    label,
    latitude,
    longitude,
    radiusMiles:
      radiusMiles != null && radiusMiles > 0
        ? Math.min(radiusMiles, 25)
        : DEFAULT_RADIUS_MILES,
    kind: cleanText(raw?.kind, index === 0 ? "parking" : "custom").toLowerCase(),
    enabled: raw?.enabled !== false,
    alertOnEntry: raw?.alertOnEntry ?? raw?.alert_on_entry ?? true,
  };
}

function getDefaultLocationSettings() {
  return {
    locations: [getDefaultParkingLocation()],
  };
}

function normalizeLocationSettings(value) {
  const defaults = getDefaultLocationSettings();
  const incoming = Array.isArray(value?.locations)
    ? value.locations
    : Array.isArray(value)
      ? value
      : defaults.locations;
  const seen = new Set();
  const locations = incoming.map(normalizeLocation).map((location, index) => {
    let id = location.id;
    while (seen.has(id)) {
      id = `${location.id}-${index + 1}`;
    }
    seen.add(id);
    return { ...location, id };
  });

  return {
    locations: locations.length ? locations : defaults.locations,
  };
}

function hasValidCoordinates(location) {
  const lat = coerceCoordinate(location?.latitude ?? location?.lat, 90);
  const lon = coerceCoordinate(location?.longitude ?? location?.lon ?? location?.lng, 180);
  return (
    lat != null &&
    lon != null &&
    !(lat === 0 && lon === 0) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

async function getLocationSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );
  return normalizeLocationSettings(rows[0]?.value);
}

async function getEnabledLocations() {
  const settings = await getLocationSettings();
  return settings.locations.filter(
    (location) =>
      location.enabled &&
      hasValidCoordinates(location) &&
      location.radiusMiles > 0
  );
}

async function getPrimaryParkingLocation() {
  const locations = await getEnabledLocations();
  const parking =
    locations.find((location) =>
      /(?:^|\b)(?:garlic creek|home|buda|78610)(?:\b|$)/i.test(
        String(location.label || "")
      )
    ) ||
    locations.find((location) => location.kind === "parking") ||
    locations[0] ||
    null;
  if (!parking) {
    return {
      ...getDefaultParkingLocation(),
      enabled: false,
    };
  }

  return {
    ...parking,
    lat: parking.latitude,
    lon: parking.longitude,
  };
}

module.exports = {
  SETTINGS_KEY,
  getDefaultLocationSettings,
  normalizeLocationSettings,
  getLocationSettings,
  getEnabledLocations,
  getPrimaryParkingLocation,
};
