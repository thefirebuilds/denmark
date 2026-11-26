const MAX_RENDER_POINTS = 1200;
const ACTIVITY_GAP_MS = 30 * 60 * 1000;

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizePoint(point) {
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

export function splitActivities(points) {
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

export function samplePoints(points, maxPoints = MAX_RENDER_POINTS) {
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

export function getPathMiles(points) {
  return points.reduce((sum, point, index) => {
    if (index === 0) return 0;
    return sum + distanceMiles(points[index - 1], point);
  }, 0);
}

export function formatDateTime(value) {
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

