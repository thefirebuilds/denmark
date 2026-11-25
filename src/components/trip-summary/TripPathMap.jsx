import { useEffect, useMemo, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const DEFAULT_CENTER = [30.2672, -97.7431];
const MAX_RENDER_POINTS = 1200;
const ACTIVITY_GAP_MS = 30 * 60 * 1000;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePoint(point) {
  const lat = toNumber(point?.lat ?? point?.latitude);
  const lon = toNumber(point?.lon ?? point?.longitude);
  if (lat == null || lon == null) return null;

  return {
    id: point?.id,
    lat,
    lon,
    seenAt: point?.seen_at || point?.seenAt || point?.captured_at || null,
    isRunning: point?.is_running,
    speed: toNumber(point?.speed),
    heading: toNumber(point?.heading),
    source: point?.service_name || point?.source || "telemetry",
  };
}

function splitActivities(points) {
  const activities = [];
  let previous = null;
  for (const point of points) {
    const gap = Date.parse(point.seenAt) - Date.parse(previous?.seenAt);
    const restarted = previous?.isRunning === false && point.isRunning === true;
    if (!previous || gap >= ACTIVITY_GAP_MS || restarted) activities.push([]);
    activities.at(-1).push(point);
    previous = point;
  }
  return activities;
}

function samplePoints(points, maxPoints = MAX_RENDER_POINTS) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];

  const sampled = [];
  const lastIndex = points.length - 1;

  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i / (maxPoints - 1)) * lastIndex);
    sampled.push(points[index]);
  }

  return sampled;
}

function distanceMiles(a, b) {
  if (!a || !b) return 0;

  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function getPathMiles(points) {
  return points.reduce((sum, point, index) => {
    if (index === 0) return 0;
    return sum + distanceMiles(points[index - 1], point);
  }, 0);
}

function formatDateTime(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function FitTripPath({ points }) {
  const map = useMap();

  useEffect(() => {
    if (!points.length) return;

    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 13);
      return;
    }

    map.fitBounds(
      points.map((point) => [point.lat, point.lon]),
      { padding: [24, 24], maxZoom: 14 }
    );
  }, [map, points]);

  return null;
}

export default function TripPathMap({ tripId, activityUrl, compact = false, title = "GPS Path" }) {
  const [path, setPath] = useState([]);
  const [pointCount, setPointCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadPath() {
      setPage(0);
      if (!tripId && !activityUrl) {
        setPath([]);
        setPointCount(0);
        setError("");
        return;
      }

      try {
        setLoading(true);
        setError("");

        const res = await fetch(
          activityUrl ? `${API_BASE}${activityUrl}` : `${API_BASE}/api/trips/${encodeURIComponent(
            tripId
          )}/telemetry-path?limit=5000`,
          { credentials: "include" }
        );

        const body = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(body?.error || `Path request failed: ${res.status}`);
        }

        if (cancelled) return;

        const points = Array.isArray(body?.points)
          ? body.points.map(normalizePoint).filter(Boolean)
          : [];

        setPath(points);
        setPointCount(Number(body?.point_count || points.length || 0));
      } catch (err) {
        if (!cancelled) {
          setPath([]);
          setPointCount(0);
          setError(err.message || "Failed to load trip path");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPath();

    return () => {
      cancelled = true;
    };
  }, [tripId, activityUrl]);

  const activities = useMemo(() => activityUrl ? [path] : splitActivities(path), [activityUrl, path]);
  const visibleActivities = useMemo(() => page ? activities.slice(page - 1, page) : activities, [activities, page]);
  const renderPoints = useMemo(() => samplePoints(visibleActivities.flat()), [visibleActivities]);
  const positions = useMemo(
    () => {
      const visiblePoints = new Set(renderPoints);
      return visibleActivities.map(activity => activity
        .filter(point => visiblePoints.has(point))
        .map(point => [point.lat, point.lon]));
    },
    [renderPoints, visibleActivities]
  );
  const startPoint = renderPoints[0] || null;
  const endPoint = renderPoints[renderPoints.length - 1] || null;
  const pathMiles = useMemo(() => visibleActivities.reduce((sum, activity) => sum + getPathMiles(activity), 0), [visibleActivities]);
  const visiblePointCount = page ? visibleActivities[0]?.length ?? 0 : path.length;
  const center = startPoint ? [startPoint.lat, startPoint.lon] : DEFAULT_CENTER;

  return (
    <section
      className={`trip-summary-drawer-section trip-path-section ${
        compact ? "trip-path-section--compact" : ""
      }`}
    >
      <div className="trip-path-header">
        <div>
          <div className="trip-summary-drawer-section-title">{title}</div>
          <span>
            {loading
              ? "Loading path..."
              : path.length
                ? `${(page ? visiblePointCount : pointCount).toLocaleString("en-US")} snapshots`
                : "No GPS snapshots available"}
          </span>
        </div>

        {path.length && !activityUrl ? (
          <strong>{Math.round(pathMiles).toLocaleString("en-US")} mi traced</strong>
        ) : null}
      </div>

      {!activityUrl && !loading && activities.length > 1 && (
        <div className="trip-path-pagination" role="group" aria-label="Trip GPS activities">
          <button type="button" onClick={() => setPage(0)} aria-pressed={page === 0}>Full trip</button>
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <button type="button" disabled={page >= activities.length} onClick={() => setPage(page + 1)}>{page ? "Next" : "First activity"}</button>
          <span aria-live="polite">
            {page ? `Activity ${page} of ${activities.length} · ${formatDateTime(startPoint?.seenAt)} – ${formatDateTime(endPoint?.seenAt)}` : `${activities.length} recorded activities`}
          </span>
        </div>
      )}

      <div className="trip-path-map-shell">
        {error ? <div className="trip-path-state">{error}</div> : null}
        {!error && loading ? (
          <div className="trip-path-state">Loading GPS path...</div>
        ) : null}
        {!error && !loading && !path.length ? (
          <div className="trip-path-state">{activityUrl ? "No GPS history is available for this vehicle during this segment." : "No GPS path has been attributed to this trip yet."}</div>
        ) : null}

        {path.length ? (
          <MapContainer
            className="trip-path-map"
            center={center}
            zoom={11}
            scrollWheelZoom={false}
            attributionControl={Boolean(activityUrl)}
          >
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
            <FitTripPath points={renderPoints} />
            <Polyline
              positions={positions}
              pathOptions={{
                color: "#0f172a",
                weight: 7,
                opacity: 0.72,
              }}
            />
            <Polyline
              positions={positions}
              pathOptions={{
                color: "#60a5fa",
                weight: 4,
                opacity: 0.92,
              }}
            />
            {startPoint ? (
              <CircleMarker
                center={[startPoint.lat, startPoint.lon]}
                radius={7}
                pathOptions={{
                  color: "#bbf7d0",
                  fillColor: "#22c55e",
                  fillOpacity: 1,
                  weight: 2,
                }}
              >
                <Popup>
                  <strong>{activityUrl || page ? "First recorded location" : "Trip start"}</strong>
                  <br />
                  {formatDateTime(startPoint.seenAt)}
                </Popup>
              </CircleMarker>
            ) : null}
            {endPoint && endPoint !== startPoint ? (
              <CircleMarker
                center={[endPoint.lat, endPoint.lon]}
                radius={7}
                pathOptions={{
                  color: "#fecaca",
                  fillColor: "#ef4444",
                  fillOpacity: 1,
                  weight: 2,
                }}
              >
                <Popup>
                  <strong>{activityUrl || page ? "Last recorded location" : "Trip end"}</strong>
                  <br />
                  {formatDateTime(endPoint.seenAt)}
                </Popup>
              </CircleMarker>
            ) : null}
          </MapContainer>
        ) : null}
      </div>

      {path.length > 0 && pointCount > path.length && (
        <div className="trip-path-note">Loaded the first {path.length.toLocaleString("en-US")} of {pointCount.toLocaleString("en-US")} snapshots.</div>
      )}
      {visiblePointCount > renderPoints.length ? (
        <div className="trip-path-note">
          Rendering {renderPoints.length.toLocaleString("en-US")} sampled points for map speed.
        </div>
      ) : null}
      {activityUrl && path.length ? <div className="trip-path-note">Recorded GPS activity within this segment. Lines connect snapshots and may cross gaps in coverage; audit miles still come from odometer readings.</div> : null}
    </section>
  );
}
