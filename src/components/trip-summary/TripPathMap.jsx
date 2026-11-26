import TripPathLayers from "./TripPathLayers";
import { normalizePoint, splitActivities, samplePoints, formatDateTime, getPathMiles } from "./tripPath";
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
            <TripPathLayers {...{ positions, startPoint, endPoint }} activity={Boolean(activityUrl || page)} />
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
