import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const STALE_AFTER_MS = 15 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_CENTER = [30.2672, -97.7431];

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
  return firstWord.length > 8 ? `${firstWord.slice(0, 7)}…` : firstWord;
}

function mapStatusVehicleToLocation(vehicle) {
  const location = vehicle?.telemetry?.location || {};
  const lat = Number(location.lat);
  const lon = Number(location.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    id:
      vehicle?.id ||
      vehicle?.vin ||
      vehicle?.dimo_token_id ||
      vehicle?.bouncie_vehicle_id ||
      vehicle?.nickname,
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

function createVehicleIcon(vehicle, stale, selected, running) {
  const label = escapeHtml(getMarkerLabel(vehicle));
  return L.divIcon({
    className: [
      "fleet-map-marker",
      running ? "fleet-map-marker--running" : "",
      stale ? "fleet-map-marker--stale" : "",
      selected ? "fleet-map-marker--selected" : "",
    ]
      .filter(Boolean)
      .join(" "),
    html: `<span aria-hidden="true">${label}</span>`,
    iconSize: [74, 34],
    iconAnchor: [37, 34],
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

export default function FleetMapPanel() {
  const [locations, setLocations] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
  const hasLoadedLocationsRef = useRef(false);

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

  const selectedVehicle = useMemo(
    () => locations.find((vehicle) => vehicle.id === selectedId) || null,
    [locations, selectedId]
  );

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
                      running
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



