import { useEffect, useMemo, useState } from "react";
import { normalizePoint, samplePoints, splitActivities } from "./tripPath";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const EMPTY_ACTIVITIES = [];

export default function useFleetTripPath(tripId, refreshKey) {
  const [result, setResult] = useState(null);
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    if (!tripId) return;
    const controller = new AbortController();

    async function loadPath() {
      try {
        const response = await fetch(
          `${API_BASE}/api/trips/${encodeURIComponent(tripId)}/telemetry-path?limit=5000&latest=true`,
          { credentials: "include", signal: controller.signal }
        );
        if (!response.ok) throw new Error("Trip GPS path unavailable");
        const body = await response.json();
        if (controller.signal.aborted) return;

        const points = (body.points || []).map(normalizePoint).filter(Boolean);
        setResult({
          tripId,
          activities: splitActivities(points),
          truncated: body.point_count > body.returned_point_count,
          error: "",
        });
      } catch {
        if (controller.signal.aborted) return;
        setResult(current => ({
          ...(current?.tripId === tripId ? current : {}),
          tripId,
          error: "Trip GPS path unavailable",
        }));
      }
    }

    loadPath();
    return () => controller.abort();
  }, [tripId, refreshKey]);

  const current = result?.tripId === tripId ? result : null;
  const activities = current?.activities || EMPTY_ACTIVITIES;
  const choice = selection?.tripId === tripId ? selection.choice : "latest";
  const selectedIndex = activities.findIndex(activity => activity[0].id === choice);
  const index = selectedIndex < 0 ? activities.length - 1 : selectedIndex;
  const fullTrip = choice === "all";
  const latest = !fullTrip && selectedIndex < 0;

  const geometry = useMemo(() => {
    const visible = fullTrip ? activities : activities.slice(Math.max(index, 0), index + 1);
    const points = samplePoints(visible.flat());
    const sampled = new Set(points);
    return {
      positions: visible.map(activity => activity.filter(point => sampled.has(point)).map(point => [point.lat, point.lon])),
      startPoint: points[0],
      endPoint: points.at(-1),
    };
  }, [activities, fullTrip, index]);

  return {
    ...geometry,
    count: activities.length,
    index,
    fullTrip,
    latest,
    loading: !current,
    error: current?.error,
    truncated: current?.truncated,
    select(choice) {
      setSelection({ tripId, choice: typeof choice === "number" ? activities[choice]?.[0].id : choice });
    },
    reset() {
      setSelection(null);
    },
  };
}
