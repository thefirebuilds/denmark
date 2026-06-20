import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  MapContainer,
  Circle,
  CircleMarker,
  Marker,
  Pane,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const STALE_AFTER_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_CENTER = [30.2672, -97.7431];
const OVERLAP_RADIUS_MILES = 0.035;
const MOVING_SPEED_MPH = 2;
const TRAIL_MINUTES = 90;
const LOCATION_AWARENESS_MILES = 20;
const TRAIL_UNDERLAY_OPTIONS = {
  color: "#0f172a",
  opacity: 0.28,
  weight: 8,
  lineCap: "round",
  lineJoin: "round",
};
const TRAIL_OPTIONS = {
  color: "#10b981",
  opacity: 0.82,
  weight: 4,
  lineCap: "round",
  lineJoin: "round",
};
const HEATMAP_DAYS = 90;
const HEATMAP_FOG_OPTIONS = {
  color: "transparent",
  fillColor: "#f97316",
  fillOpacity: 0.068,
  opacity: 0,
  weight: 0,
};
const LOCATION_ZONE_OPTIONS = {
  color: "#38bdf8",
  fillColor: "#38bdf8",
  fillOpacity: 0.075,
  opacity: 0.42,
  weight: 2,
};

const SPIDER_OFFSETS = [
  [0, -34],
  [34, 0],
  [0, 34],
  [-34, 0],
  [25, -25],
  [25, 25],
  [-25, 25],
  [-25, -25],
  [48, -14],
  [48, 14],
  [-48, 14],
  [-48, -14],
];

const VEHICLE_PIN_IMAGES = {
  belle: "/images/map_pins/kiaNew.png",
  cherry: "/images/map_pins/toyota.png",
  delavan: "/images/map_pins/hyundai.png",
  geneva: "/images/map_pins/hyundai.png",
  honda: "/images/map_pins/honda.png",
  hyundai: "/images/map_pins/hyundai.png",
  juneau: "/images/map_pins/hyundai.png",
  kia: "/images/map_pins/kiaNew.png",
  neenah: "/images/map_pins/toyota.png",
  stripe: "/images/map_pins/toyota.png",
  toyota: "/images/map_pins/toyota.png",
  winnie: "/images/map_pins/honda.png",
};

const VEHICLE_PIN_COLORS = {
  belle: "#dc2626",
  cherry: "#be123c",
  delavan: "#2563eb",
  geneva: "#0f766e",
  honda: "#0891b2",
  hyundai: "#2563eb",
  juneau: "#7c3aed",
  kia: "#dc2626",
  neenah: "#be123c",
  stripe: "#ea580c",
  toyota: "#be123c",
  winnie: "#0891b2",
};

function isStale(lastSeen) {
  if (!lastSeen) return true;
  const seenAt = new Date(lastSeen).getTime();
  if (!Number.isFinite(seenAt)) return true;
  return Date.now() - seenAt > STALE_AFTER_MS;
}

function formatTimestamp(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
    timeZoneName: "short",
  });
}

function formatFreshness(value) {
  if (!value) return "unknown age";
  const date = new Date(value);
  const ageMs = Date.now() - date.getTime();
  if (!Number.isFinite(ageMs)) return "unknown age";
  if (ageMs < 0) return "just now";

  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1 min ago";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatLastSeenLabel(type) {
  if (type === "location_fix") return "Location fix";
  if (type === "vehicle_update") return "Telemetry check-in";
  return "Telemetry snapshot";
}

function formatTelemetryIssue(vehicle) {
  const diagnostic = vehicle?.telemetryDiagnostics || {};
  const issue = String(diagnostic.locationIssue || "");
  const provider = String(diagnostic.provider || vehicle?.source || "Telemetry");
  const missing = Array.isArray(diagnostic.missingPrivileges)
    ? diagnostic.missingPrivileges
    : [];

  if (issue === "dimo_location_signal_stale") {
    return `${provider} GPS signal is stale; latest poll ${formatFreshness(
      diagnostic.latestPollAt
    )}, GPS fix ${formatFreshness(diagnostic.locationSignalAt || vehicle?.lastSeen)}`;
  }

  if (issue.startsWith("missing_privilege:")) {
    return `${provider} is missing ${issue.replace("missing_privilege:", "")}`;
  }

  if (issue === "dimo_location_signal_not_fetched") {
    return `${provider} did not fetch a location signal in the latest poll`;
  }

  if (missing.length) {
    return `${provider} missing ${missing.join(", ")}`;
  }

  return null;
}

function formatCoordinate(value) {
  return Number(value).toFixed(5);
}

function normalizeHeading(value) {
  const heading = Number(value);
  if (!Number.isFinite(heading)) return null;
  return ((heading % 360) + 360) % 360;
}

function headingToCompass(value) {
  const heading = normalizeHeading(value);
  if (heading == null) return null;
  const directions = [
    "N",
    "NE",
    "E",
    "SE",
    "S",
    "SW",
    "W",
    "NW",
  ];
  return directions[Math.round(heading / 45) % directions.length];
}

function formatHeading(value) {
  const heading = normalizeHeading(value);
  if (heading == null) return null;
  const compass = headingToCompass(heading);
  return `${compass} ${Math.round(heading)}°`;
}

function formatSpeedMph(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return null;
  return `${Math.max(0, Math.round(speed))} mph`;
}

function HeadingChip({ heading, label }) {
  const normalizedHeading = normalizeHeading(heading);
  if (normalizedHeading == null || !label) return null;

  return (
    <span className="fleet-map-heading-chip" title={`Heading ${label}`}>
      <span
        className="fleet-map-heading-chip-icon"
        style={{ "--fleet-map-heading": `${normalizedHeading}deg` }}
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}

function normalizeTrailPoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => {
      const lat = Number(point?.lat);
      const lon = Number(point?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return [lat, lon];
    })
    .filter(Boolean);
}

function getMovingTrailPositions(vehicle, stale) {
  const speed = Number(vehicle?.speed);
  if (stale || !Number.isFinite(speed) || speed <= MOVING_SPEED_MPH) {
    return [];
  }

  const positions = normalizeTrailPoints(vehicle?.trail);
  const current = [Number(vehicle?.lat), Number(vehicle?.lon)];
  if (!current.every(Number.isFinite)) {
    return positions.length >= 2 ? positions : [];
  }

  const last = positions[positions.length - 1];
  if (!last || distanceMiles({ lat: last[0], lon: last[1] }, vehicle) > 0.003) {
    positions.push(current);
  }

  return positions.length >= 2 ? positions : [];
}

function getNearestHeatmapDistanceMiles(vehicle, heatmapPoints) {
  if (!vehicle || !Array.isArray(heatmapPoints) || heatmapPoints.length === 0) {
    return null;
  }

  const nearest = heatmapPoints.reduce((best, point) => {
    const distance = distanceMiles(vehicle, point);
    return distance < best ? distance : best;
  }, Infinity);

  return Number.isFinite(nearest) ? nearest : null;
}

function formatDistanceMiles(value) {
  const miles = Number(value);
  if (!Number.isFinite(miles)) return null;
  if (miles < 0.1) return "inside normal area";
  if (miles < 1) return `${miles.toFixed(1)} mi from normal`;
  return `${Math.round(miles)} mi from normal`;
}

function getHeatmapCircle(point) {
  const intensity = Math.max(0.08, Math.min(1, Number(point?.intensity) || 0));
  return {
    center: [Number(point.lat), Number(point.lon)],
    radius: 20 + Math.round(Math.sqrt(intensity) * 46),
    pathOptions: {
      color: intensity > 0.55 ? "#991b1b" : "#ea580c",
      fillColor: intensity > 0.55 ? "#ef4444" : "#f97316",
      fillOpacity: 0.136 + intensity * 0.231,
      opacity: 0.326 + intensity * 0.245,
      weight: 2,
    },
  };
}

function buildGoogleMapsUrl(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

function distanceMiles(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

  const radiusMiles = 3958.7613;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;

  return 2 * radiusMiles * Math.asin(Math.sqrt(h));
}

function coerceCoordinate(value, maxAbs) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (Math.abs(number) <= maxAbs) return number;

  for (let scale = 10; scale <= 1e16; scale *= 10) {
    const scaled = number / scale;
    if (Math.abs(scaled) <= maxAbs) return scaled;
  }

  return number;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getMarkerLabel(vehicle) {
  const name = String(vehicle?.name || "Vehicle").trim();
  const firstWord = name.split(/\s+/)[0] || name;
  return firstWord.length > 10 ? `${firstWord.slice(0, 9)}…` : firstWord;
}

function getVehiclePinKey(vehicle) {
  return String(vehicle?.name || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
}

function getVehicleMakeKey(vehicle) {
  return String(vehicle?.make || "")
    .trim()
    .toLowerCase();
}

function getVehiclePinImageUrl(vehicle) {
  const explicit =
    vehicle?.mapPinImageUrl || vehicle?.imageUrl || vehicle?.photoUrl || "";
  if (explicit) return explicit;

  return (
    VEHICLE_PIN_IMAGES[getVehiclePinKey(vehicle)] ||
    VEHICLE_PIN_IMAGES[getVehicleMakeKey(vehicle)] ||
    ""
  );
}

function getVehiclePinAccentColor(vehicle) {
  return (
    VEHICLE_PIN_COLORS[getVehiclePinKey(vehicle)] ||
    VEHICLE_PIN_COLORS[getVehicleMakeKey(vehicle)] ||
    ""
  );
}

function normalizeVehicleId(value) {
  if (value == null || value === "") return null;
  return String(value);
}

function vehicleMatchesSelector(vehicle, selector) {
  const normalized = normalizeVehicleId(selector);
  if (!normalized || !vehicle) return false;
  const lowered = normalized.trim().toLowerCase();
  return (
    normalizeVehicleId(vehicle.id) === normalized ||
    getVehiclePinKey(vehicle) === lowered ||
    String(vehicle.name || "").trim().toLowerCase() === lowered
  );
}

function mapStatusVehicleToLocation(vehicle) {
  const location = vehicle?.telemetry?.location || {};
  const lat = Number(location.lat);
  const lon = Number(location.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id: String(
      vehicle?.id ||
        vehicle?.vin ||
        vehicle?.dimo_token_id ||
        vehicle?.bouncie_vehicle_id ||
        vehicle?.nickname
    ),
    name:
      vehicle?.nickname ||
      vehicle?.turo_vehicle_name ||
      [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") ||
      vehicle?.vin ||
      "Vehicle",
    make: vehicle?.make || null,
    model: vehicle?.model || null,
    year: vehicle?.year || null,
    vin: vehicle?.vin || null,
    source:
      vehicle?.telemetry?.source ||
      vehicle?.telemetry_source?.[0] ||
      "Stored telemetry",
    lat,
    lon,
    heading:
      vehicle?.telemetry?.location?.heading == null
        ? null
        : Number(vehicle.telemetry.location.heading),
    lastSeen:
      vehicle?.telemetry?.location?.last_updated ||
      vehicle?.telemetry?.timestamps?.vehicle_last_updated ||
      vehicle?.telemetry?.timestamps?.captured_at ||
      vehicle?.telemetry?.last_comm ||
      null,
    lastSeenType: vehicle?.telemetry?.location?.last_updated
      ? "location_fix"
      : vehicle?.telemetry?.timestamps?.vehicle_last_updated
        ? "vehicle_update"
        : "telemetry_snapshot",
    isRunning:
      typeof vehicle?.telemetry?.engine_running === "boolean"
        ? vehicle.telemetry.engine_running
        : null,
    speed:
      vehicle?.telemetry?.speed == null ? null : Number(vehicle.telemetry.speed),
    googleMapsUrl: buildGoogleMapsUrl(lat, lon),
  };
}

async function fetchJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
  });

  if (!response.ok) {
    const error = new Error(`${path} failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function fetchVehicleLocations() {
  try {
    const data = await fetchJson("/api/vehicles/locations");
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err?.status !== 404) throw err;

    // During rollout, an older backend may not have /locations yet. Fall back
    // to the existing cached status feed, which already carries stored coords.
    const data = await fetchJson("/api/vehicles/cached-status");
    return Array.isArray(data)
      ? data.map(mapStatusVehicleToLocation).filter(Boolean)
      : [];
  }
}

async function fetchVehicleHeatmap(vehicleId) {
  if (!vehicleId) return null;
  return fetchJson(
    `/api/vehicles/locations/heatmap?vehicleId=${encodeURIComponent(
      vehicleId
    )}&days=${HEATMAP_DAYS}`
  );
}

async function fetchVehicleTrail(vehicleId) {
  if (!vehicleId) return null;
  return fetchJson(
    `/api/vehicles/locations/trail?vehicleId=${encodeURIComponent(
      vehicleId
    )}&minutes=${TRAIL_MINUTES}`
  );
}

async function fetchNamedLocations() {
  const data = await fetchJson("/api/settings/locations.tracking");
  const configured = Array.isArray(data?.value?.locations)
    ? data.value.locations
    : [];

  return configured
    .map((location) => {
      const rawLat = location?.latitude ?? location?.lat;
      const rawLon = location?.longitude ?? location?.lon ?? location?.lng;
      if (rawLat == null || rawLat === "" || rawLon == null || rawLon === "") {
        return null;
      }

      const lat = coerceCoordinate(rawLat, 90);
      const lon = coerceCoordinate(rawLon, 180);
      const radiusMiles = Number(location?.radiusMiles ?? location?.radius_miles);
      if (lat == null || lon == null) return null;
      if (lat === 0 && lon === 0) return null;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
      if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) return null;
      if (location?.enabled === false) return null;

      return {
        id: String(location?.id || location?.label || `${lat},${lon}`),
        label: String(location?.label || location?.name || "Location"),
        lat,
        lon,
        radiusMeters: radiusMiles * 1609.344,
        radiusMiles,
        kind: String(location?.kind || "custom"),
        alertOnEntry: location?.alertOnEntry !== false,
      };
    })
    .filter(Boolean);
}

function buildSpiderOffsets(locations) {
  const offsets = new Map();
  const visited = new Set();

  locations.forEach((vehicle) => {
    if (visited.has(vehicle.id)) return;

    const group = locations.filter(
      (candidate) => distanceMiles(vehicle, candidate) <= OVERLAP_RADIUS_MILES
    );
    group.forEach((item) => visited.add(item.id));

    if (group.length <= 1) {
      offsets.set(vehicle.id, { x: 0, y: 0, count: 1 });
      return;
    }

    group
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .forEach((item, index) => {
        const [x, y] = SPIDER_OFFSETS[index] || [
          Math.round(Math.cos(index) * 56),
          Math.round(Math.sin(index) * 56),
        ];
        offsets.set(item.id, { x, y, count: group.length });
      });
  });

  return offsets;
}

function getContainingGeoLocation(vehicle, namedLocations) {
  if (!vehicle || !Array.isArray(namedLocations)) return null;
  return (
    namedLocations.find(
      (location) => distanceMiles(vehicle, location) <= location.radiusMiles
    ) || null
  );
}

function createVehicleIcon(
  vehicle,
  stale,
  selected,
  running,
  spiderOffset,
  containingGeoLocation
) {
  const label = escapeHtml(getMarkerLabel(vehicle));
  const offset = spiderOffset || { x: 0, y: 0, count: 1 };
  const pinKey = getVehiclePinKey(vehicle);
  const imageUrl = getVehiclePinImageUrl(vehicle);
  const accentColor = getVehiclePinAccentColor(vehicle);
  const badgeHtml = imageUrl
    ? `<img class="fleet-map-marker-badge-image" src="${escapeHtml(
        imageUrl
      )}" alt="" />`
    : "";
  return L.divIcon({
    className: "fleet-map-marker-wrap",
    html: `
      <div
        class="${[
          "fleet-map-marker",
          pinKey ? `fleet-map-marker--${pinKey}` : "",
          imageUrl ? "fleet-map-marker--image-badge" : "",
          offset.count > 1 ? "fleet-map-marker--spidered" : "",
          containingGeoLocation ? "fleet-map-marker--in-location" : "",
          running ? "fleet-map-marker--running" : "",
          stale ? "fleet-map-marker--stale" : "",
          selected ? "fleet-map-marker--selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}"
        style="--fleet-map-offset-x: ${offset.x}px; --fleet-map-offset-y: ${offset.y}px;${
          accentColor ? ` --fleet-map-badge-color: ${accentColor};` : ""
        }"
      >
        ${badgeHtml}
        <span aria-hidden="true">${label}</span>
      </div>`,
    iconSize: [118, 72],
    iconAnchor: [59, 68],
    popupAnchor: [0, -32],
  });
}

function MapFocus({ vehicle, locations, namedLocations, includeNamedLocations, focusKey }) {
  const map = useMap();
  const lastFocusKeyRef = useRef(null);

  useEffect(() => {
    if (lastFocusKeyRef.current === focusKey) return;
    lastFocusKeyRef.current = focusKey;

    if (vehicle) {
      map.setView([vehicle.lat, vehicle.lon], Math.max(map.getZoom(), 14), {
        animate: true,
      });
      return;
    }

    const focusLocations = includeNamedLocations
      ? [
          ...locations,
          ...namedLocations.map((location) => ({
            lat: location.lat,
            lon: location.lon,
          })),
        ]
      : locations;

    if (!focusLocations.length) return;

    if (focusLocations.length === 1) {
      map.setView([focusLocations[0].lat, focusLocations[0].lon], 12, {
        animate: true,
      });
      return;
    }

    const bounds = L.latLngBounds(
      focusLocations.map((location) => [location.lat, location.lon])
    );

    map.fitBounds(bounds, {
      animate: true,
      maxZoom: 13,
      padding: [42, 42],
    });
  }, [map, vehicle, locations, namedLocations, includeNamedLocations, focusKey]);

  return null;
}

export default function FleetMapPanel({ focusVehicleId = null }) {
  const [locations, setLocations] = useState([]);
  const [namedLocations, setNamedLocations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const [heatmap, setHeatmap] = useState(null);
  const [heatmapError, setHeatmapError] = useState("");
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapEnabled, setHeatmapEnabled] = useState(true);
  const [geoLocationsVisible, setGeoLocationsVisible] = useState(true);
  const [trail, setTrail] = useState(null);
  const [trailError, setTrailError] = useState("");
  const [trailLoading, setTrailLoading] = useState(false);
  const hasLoadedLocationsRef = useRef(false);
  const lastFocusVehicleIdRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function loadLocations() {
      setLoading((current) => current && locations.length === 0);
      setRefreshing(locations.length > 0);
      setError("");

      try {
        const nextLocations = await fetchVehicleLocations();
        if (!cancelled) {
          setLocations(nextLocations);
          setSelectedId((current) =>
            nextLocations.some((vehicle) => vehicleMatchesSelector(vehicle, current))
              ? current
              : null
          );
          if (!hasLoadedLocationsRef.current) {
            hasLoadedLocationsRef.current = true;
            setFocusKey((value) => value + 1);
          }
          setLastRefreshedAt(new Date().toISOString());
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || "Failed to load vehicle locations");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    loadLocations();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;

    async function loadNamedLocations() {
      try {
        const nextNamedLocations = await fetchNamedLocations();
        if (!cancelled) {
          setNamedLocations(nextNamedLocations);
        }
      } catch (err) {
        if (!cancelled) {
          setNamedLocations([]);
        }
      }
    }

    loadNamedLocations();

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRefreshKey((value) => value + 1);
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const requestedId =
      focusVehicleId == null || focusVehicleId === ""
        ? null
        : String(focusVehicleId);
    if (!requestedId || requestedId === lastFocusVehicleIdRef.current) return;
    const requestedVehicle = locations.find((vehicle) =>
      vehicleMatchesSelector(vehicle, requestedId)
    );
    if (!requestedVehicle) return;

    lastFocusVehicleIdRef.current = requestedId;
    setSelectedId(normalizeVehicleId(requestedVehicle.id));
    setFocusKey((value) => value + 1);
  }, [focusVehicleId, locations]);

  useEffect(() => {
    let cancelled = false;

    async function loadHeatmap() {
      if (!selectedId || !heatmapEnabled) {
        setHeatmap(null);
        setHeatmapError("");
        setHeatmapLoading(false);
        return;
      }

      setHeatmapLoading(true);
      setHeatmapError("");

      try {
        const nextHeatmap = await fetchVehicleHeatmap(selectedId);
        if (!cancelled) {
          setHeatmap(nextHeatmap);
        }
      } catch (err) {
        if (!cancelled) {
          setHeatmap(null);
          setHeatmapError(err?.message || "Failed to load heatmap");
        }
      } finally {
        if (!cancelled) {
          setHeatmapLoading(false);
        }
      }
    }

    loadHeatmap();

    return () => {
      cancelled = true;
    };
  }, [selectedId, heatmapEnabled, refreshKey]);

  const selectedVehicle = useMemo(
    () =>
      locations.find((vehicle) => vehicleMatchesSelector(vehicle, selectedId)) ||
      null,
    [locations, selectedId]
  );
  const spiderOffsets = useMemo(() => buildSpiderOffsets(locations), [locations]);
  const selectedHeatmapPoints =
    selectedVehicle && heatmapEnabled && Array.isArray(heatmap?.points)
      ? heatmap.points
      : [];
  const selectedHeatmapDistance = getNearestHeatmapDistanceMiles(
    selectedVehicle,
    selectedHeatmapPoints
  );
  const selectedHeatmapDistanceLabel = formatDistanceMiles(
    selectedHeatmapDistance
  );
  const selectedOutsideNorm =
    selectedHeatmapPoints.length >= 8 &&
    selectedHeatmapDistance != null &&
    selectedHeatmapDistance > LOCATION_AWARENESS_MILES;
  const visibleMapVehicles = selectedVehicle ? [selectedVehicle] : locations;
  const selectedTrailVehicle = selectedVehicle
    ? { ...selectedVehicle, trail: trail?.points || [] }
    : null;
  const selectedTrailPositions = selectedTrailVehicle
    ? getMovingTrailPositions(
        selectedTrailVehicle,
        isStale(selectedTrailVehicle.lastSeen)
      )
    : [];

  useEffect(() => {
    let cancelled = false;

    async function loadTrail() {
      const speed = Number(selectedVehicle?.speed);
      if (
        !selectedVehicle ||
        isStale(selectedVehicle.lastSeen) ||
        !Number.isFinite(speed) ||
        speed <= MOVING_SPEED_MPH
      ) {
        setTrail(null);
        setTrailError("");
        setTrailLoading(false);
        return;
      }

      setTrailLoading(true);
      setTrailError("");

      try {
        const nextTrail = await fetchVehicleTrail(selectedVehicle.id);
        if (!cancelled) {
          setTrail(nextTrail);
        }
      } catch (err) {
        if (!cancelled) {
          setTrail(null);
          setTrailError(err?.message || "Failed to load trail");
        }
      } finally {
        if (!cancelled) {
          setTrailLoading(false);
        }
      }
    }

    loadTrail();

    return () => {
      cancelled = true;
    };
  }, [
    selectedVehicle?.id,
    selectedVehicle?.lastSeen,
    selectedVehicle?.speed,
    refreshKey,
  ]);

  const center = selectedVehicle
    ? [selectedVehicle.lat, selectedVehicle.lon]
    : locations[0]
      ? [locations[0].lat, locations[0].lon]
      : DEFAULT_CENTER;

  function toggleSelectedVehicle(vehicleId) {
    const nextId = normalizeVehicleId(vehicleId);
    setSelectedId((current) =>
      normalizeVehicleId(current) === nextId ? null : nextId
    );
    setFocusKey((value) => value + 1);
  }

  function showAllVehicles() {
    setSelectedId(null);
    setFocusKey((value) => value + 1);
  }

  function toggleGeoLocationsVisible(checked) {
    setGeoLocationsVisible(checked);
    setFocusKey((value) => value + 1);
  }

  return (
    <section className="panel fleet-map-panel">
      <header className="fleet-map-header">
        <div>
          <div className="fleet-map-eyebrow">Fleet Map</div>
          <h2>Last known locations</h2>
          <p>
            Stored vehicle telemetry only. Stale means the latest location is
            older than 15 minutes. Green markers indicate a vehicle reported as
            running, while blue markers indicate fresh telemetry. Moving
            vehicles draw a recent location trail. Selecting a vehicle shows
            its recent location heatmap.
          </p>
        </div>
        <div className="fleet-map-actions">
          <span className="fleet-map-refresh-meta">
            {refreshing
              ? "Refreshing..."
              : lastRefreshedAt
                ? `Updated ${formatTimestamp(lastRefreshedAt)}`
                : "Auto-refresh every minute"}
          </span>
          <label className="fleet-map-toggle">
            <input
              type="checkbox"
              checked={heatmapEnabled}
              onChange={(event) => setHeatmapEnabled(event.target.checked)}
            />
            Heatmap
          </label>
          <label className="fleet-map-toggle">
            <input
              type="checkbox"
              checked={geoLocationsVisible}
              onChange={(event) =>
                toggleGeoLocationsVisible(event.target.checked)
              }
            />
            Geo locations
            {namedLocations.length ? ` (${namedLocations.length})` : ""}
          </label>
          <button
            type="button"
            className="fleet-map-refresh"
            onClick={() => setRefreshKey((value) => value + 1)}
            disabled={loading || refreshing}
          >
            Refresh
          </button>
        </div>
      </header>

      {loading ? (
        <div className="fleet-map-state">Loading vehicle locations...</div>
      ) : error ? (
        <div className="fleet-map-state fleet-map-state--error">{error}</div>
      ) : locations.length === 0 ? (
        <div className="fleet-map-state">
          No vehicle locations are available yet. Once telemetry snapshots
          include coordinates, they will show up here.
        </div>
      ) : (
        <div className="fleet-map-layout">
          <div className="fleet-map-canvas" aria-label="Last known locations">
            <MapContainer
              center={center}
              zoom={11}
              scrollWheelZoom
              className="fleet-map-leaflet"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapFocus
                vehicle={selectedVehicle}
                locations={locations}
                namedLocations={namedLocations}
                includeNamedLocations={geoLocationsVisible}
                focusKey={focusKey}
              />
              {geoLocationsVisible && namedLocations.length ? (
                <Pane name="fleet-map-location-zone-pane" style={{ zIndex: 410 }}>
                  {namedLocations.map((location) => {
                    return (
                      <Circle
                        key={location.id}
                        center={[location.lat, location.lon]}
                        radius={location.radiusMeters}
                        pathOptions={LOCATION_ZONE_OPTIONS}
                      >
                        <Tooltip
                          permanent
                          direction="bottom"
                          offset={[0, 18]}
                          pane="fleet-map-location-zone-pane"
                          className="fleet-map-location-tooltip"
                          opacity={1}
                        >
                          {location.label}
                        </Tooltip>
                        <Popup>
                          <div className="fleet-map-popup">
                            <strong>{location.label}</strong>
                            <span>{location.kind}</span>
                            <span>{location.radiusMiles.toFixed(2)} mi radius</span>
                            {location.alertOnEntry ? (
                              <em>Entry alerts enabled</em>
                            ) : null}
                          </div>
                        </Popup>
                      </Circle>
                    );
                  })}
                </Pane>
              ) : null}
              {selectedHeatmapPoints.length ? (
                <Pane name="fleet-map-heatmap-pane" style={{ zIndex: 430 }}>
                  {selectedHeatmapPoints.map((point, index) => (
                    <CircleMarker
                      key={`${selectedId}-fog-${index}`}
                      center={[Number(point.lat), Number(point.lon)]}
                      radius={86}
                      pathOptions={HEATMAP_FOG_OPTIONS}
                    />
                  ))}
                  {selectedHeatmapPoints.map((point, index) => {
                    const circle = getHeatmapCircle(point);
                    return (
                      <CircleMarker
                        key={`${selectedId}-heat-${index}`}
                        center={circle.center}
                        radius={circle.radius}
                        pathOptions={circle.pathOptions}
                      />
                    );
                  })}
                </Pane>
              ) : null}
              {selectedTrailPositions.length >= 2 ? (
                <Fragment key={`${selectedId}-trail`}>
                  <Polyline
                    positions={selectedTrailPositions}
                    pathOptions={TRAIL_UNDERLAY_OPTIONS}
                  />
                  <Polyline
                    positions={selectedTrailPositions}
                    pathOptions={TRAIL_OPTIONS}
                  />
                </Fragment>
              ) : null}
              {visibleMapVehicles.map((vehicle) => {
                const stale = isStale(vehicle.lastSeen);
                const running = vehicle.isRunning === true;
                const headingLabel = formatHeading(vehicle.heading);
                const speedLabel = formatSpeedMph(vehicle.speed);
                const telemetryIssue = formatTelemetryIssue(vehicle);
                const containingGeoLocation = geoLocationsVisible
                  ? getContainingGeoLocation(vehicle, namedLocations)
                  : null;
                return (
                  <Marker
                    key={vehicle.id}
                    position={[vehicle.lat, vehicle.lon]}
                    icon={createVehicleIcon(
                      vehicle,
                      stale,
                      vehicleMatchesSelector(vehicle, selectedId),
                      running,
                      spiderOffsets.get(vehicle.id),
                      containingGeoLocation
                    )}
                    eventHandlers={{
                      click: () => toggleSelectedVehicle(vehicle.id),
                    }}
                  >
                    <Popup>
                      <div className="fleet-map-popup">
                        <strong>{vehicle.name}</strong>
                        <span>{vehicle.source}</span>
                        {running ? (
                          <em className="fleet-map-running-label">
                            Running
                          </em>
                        ) : null}
                        <span>
                          {formatCoordinate(vehicle.lat)},{" "}
                          {formatCoordinate(vehicle.lon)}
                        </span>
                        {headingLabel || speedLabel ? (
                          <span>
                            {[headingLabel ? `Heading ${headingLabel}` : "", speedLabel]
                              .filter(Boolean)
                              .join(" | ")}
                          </span>
                        ) : null}
                        {containingGeoLocation ? (
                          <span>Inside {containingGeoLocation.label}</span>
                        ) : null}
                        <span>
                          {formatLastSeenLabel(vehicle.lastSeenType)}{" "}
                          {formatFreshness(vehicle.lastSeen)}
                        </span>
                        <span className="fleet-map-absolute-time">
                          {formatTimestamp(vehicle.lastSeen)}
                        </span>
                        {telemetryIssue ? <em>{telemetryIssue}</em> : null}
                        {stale ? <em>Stale location</em> : null}
                        <a
                          href={vehicle.googleMapsUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Google Maps
                        </a>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          <aside className="fleet-map-list" aria-label="Vehicle locations">
            <button
              type="button"
              className={`fleet-map-list-item fleet-map-list-item--all ${
                selectedId == null ? "active" : ""
              }`}
              onClick={showAllVehicles}
            >
              <span>
                <strong>All vehicles</strong>
                <small>Fit every known location on the map</small>
              </span>
              <span className="fleet-map-list-meta">
                {locations.length} vehicle{locations.length === 1 ? "" : "s"}
              </span>
            </button>
            {selectedVehicle ? (
              <div
                className={`fleet-map-heatmap-card ${
                  selectedOutsideNorm ? "fleet-map-heatmap-card--outside" : ""
                }`}
              >
                <strong>{selectedVehicle.name} norm</strong>
                <span>
                  {heatmapLoading
                    ? "Loading heatmap..."
                    : heatmapError
                      ? "Heatmap unavailable"
                      : selectedHeatmapPoints.length
                        ? `${selectedHeatmapPoints.length} common area${
                            selectedHeatmapPoints.length === 1 ? "" : "s"
                          } over ${heatmap?.days || HEATMAP_DAYS} days`
                        : "Not enough location history yet"}
                </span>
                {selectedHeatmapDistanceLabel && !heatmapLoading ? (
                  <em>
                    {selectedOutsideNorm ? "Travel awareness: " : ""}
                    {selectedHeatmapDistanceLabel}
                  </em>
                ) : null}
              </div>
            ) : null}
            {locations.map((vehicle) => {
              const stale = isStale(vehicle.lastSeen);
              const running = vehicle.isRunning === true;
              const headingLabel = formatHeading(vehicle.heading);
              const speedLabel = formatSpeedMph(vehicle.speed);
              const telemetryIssue = formatTelemetryIssue(vehicle);
              const containingGeoLocation = geoLocationsVisible
                ? getContainingGeoLocation(vehicle, namedLocations)
                : null;
              return (
                <button
                  key={vehicle.id}
                  type="button"
                  className={`fleet-map-list-item ${
                    vehicleMatchesSelector(vehicle, selectedId) ? "active" : ""
                  }`}
                  onClick={() => toggleSelectedVehicle(vehicle.id)}
                >
                  <span>
                    <strong>{vehicle.name}</strong>
                    <small>
                      {vehicle.source}
                      {running ? (
                        <span className="fleet-map-running-pill">Running</span>
                      ) : null}
                      {containingGeoLocation ? (
                        <span className="fleet-map-location-pill">
                          {containingGeoLocation.label}
                        </span>
                      ) : null}
                    </small>
                  </span>
                  <span className="fleet-map-list-meta">
                    {running ? "Running" : stale ? "Stale" : "Fresh"} ·{" "}
                    {containingGeoLocation
                      ? `Inside ${containingGeoLocation.label} · `
                      : ""}
                    {formatLastSeenLabel(vehicle.lastSeenType)} ·{" "}
                    {formatFreshness(vehicle.lastSeen)}
                    {telemetryIssue ? ` · ${telemetryIssue}` : ""}
                    {speedLabel ? ` · ${speedLabel}` : ""}
                    {headingLabel ? (
                      <>
                        {" · "}
                        <HeadingChip
                          heading={vehicle.heading}
                          label={headingLabel}
                        />
                      </>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </aside>
        </div>
      )}
    </section>
  );
}



