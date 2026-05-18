import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const STALE_AFTER_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_CENTER = [30.2672, -97.7431];
const OVERLAP_RADIUS_MILES = 0.035;

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
  stripe: "/images/map_pins/toyota.png",
  juneau: "/images/map_pins/hyundai.png",
  winnie: "/images/map_pins/honda.png",
};

const VEHICLE_PIN_COLORS = {
  belle: "#dc2626",
  cherry: "#be123c",
  delavan: "#2563eb",
  geneva: "#0f766e",
  juneau: "#7c3aed",
  stripe: "#ea580c",
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

function formatCoordinate(value) {
  return Number(value).toFixed(5);
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
    source:
      vehicle?.telemetry?.source ||
      vehicle?.telemetry_source?.[0] ||
      "Stored telemetry",
    lat,
    lon,
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

function createVehicleIcon(vehicle, stale, selected, running, spiderOffset) {
  const label = escapeHtml(getMarkerLabel(vehicle));
  const offset = spiderOffset || { x: 0, y: 0, count: 1 };
  const pinKey = getVehiclePinKey(vehicle);
  const imageUrl = VEHICLE_PIN_IMAGES[pinKey] || "";
  const accentColor = VEHICLE_PIN_COLORS[pinKey] || "";
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

function MapFocus({ vehicle, locations, focusKey }) {
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

    if (!locations.length) return;

    if (locations.length === 1) {
      map.setView([locations[0].lat, locations[0].lon], 12, {
        animate: true,
      });
      return;
    }

    const bounds = L.latLngBounds(
      locations.map((location) => [location.lat, location.lon])
    );

    map.fitBounds(bounds, {
      animate: true,
      maxZoom: 13,
      padding: [42, 42],
    });
  }, [map, vehicle, locations, focusKey]);

  return null;
}

export default function FleetMapPanel({ focusVehicleId = null }) {
  const [locations, setLocations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
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
            nextLocations.some((vehicle) => vehicle.id === current)
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
    if (!locations.some((vehicle) => String(vehicle.id) === requestedId)) return;

    lastFocusVehicleIdRef.current = requestedId;
    setSelectedId(requestedId);
    setFocusKey((value) => value + 1);
  }, [focusVehicleId, locations]);

  const selectedVehicle = useMemo(
    () => locations.find((vehicle) => vehicle.id === selectedId) || null,
    [locations, selectedId]
  );
  const spiderOffsets = useMemo(() => buildSpiderOffsets(locations), [locations]);

  const center = selectedVehicle
    ? [selectedVehicle.lat, selectedVehicle.lon]
    : locations[0]
      ? [locations[0].lat, locations[0].lon]
      : DEFAULT_CENTER;

  function toggleSelectedVehicle(vehicleId) {
    setSelectedId((current) => (current === vehicleId ? null : vehicleId));
    setFocusKey((value) => value + 1);
  }

  function showAllVehicles() {
    setSelectedId(null);
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
            older than 15 minutes. Blue markers indicate a vehicle reported as
            running in the latest stored snapshot.
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
                focusKey={focusKey}
              />
              {locations.map((vehicle) => {
                const stale = isStale(vehicle.lastSeen);
                const running = vehicle.isRunning === true;
                return (
                  <Marker
                    key={vehicle.id}
                    position={[vehicle.lat, vehicle.lon]}
                    icon={createVehicleIcon(
                      vehicle,
                      stale,
                      vehicle.id === selectedId,
                      running,
                      spiderOffsets.get(vehicle.id)
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
                            {Number.isFinite(Number(vehicle.speed))
                              ? ` Â· ${Math.round(Number(vehicle.speed))} mph`
                              : ""}
                          </em>
                        ) : null}
                        <span>
                          {formatCoordinate(vehicle.lat)},{" "}
                          {formatCoordinate(vehicle.lon)}
                        </span>
                        <span>
                          {formatLastSeenLabel(vehicle.lastSeenType)}{" "}
                          {formatFreshness(vehicle.lastSeen)}
                        </span>
                        <span className="fleet-map-absolute-time">
                          {formatTimestamp(vehicle.lastSeen)}
                        </span>
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
            {locations.map((vehicle) => {
              const stale = isStale(vehicle.lastSeen);
              const running = vehicle.isRunning === true;
              return (
                <button
                  key={vehicle.id}
                  type="button"
                  className={`fleet-map-list-item ${
                    vehicle.id === selectedId ? "active" : ""
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
                    </small>
                  </span>
                  <span className="fleet-map-list-meta">
                    {running ? "Running" : stale ? "Stale" : "Fresh"} ·{" "}
                    {formatLastSeenLabel(vehicle.lastSeenType)} ·{" "}
                    {formatFreshness(vehicle.lastSeen)}
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



