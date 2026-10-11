// Trailing calendar windows; missing readings are excluded, never converted to zero.
export function movingAverages(points, key, monthly = false) {
  return points.map((point, index) => {
    if (point[key] == null || !Number.isFinite(Number(point[key]))) return null;
    const current = new Date(`${String(point.label).slice(0, 10)}T12:00:00Z`);
    const period = date => monthly
      ? date.getUTCFullYear() * 12 + date.getUTCMonth()
      : Math.floor(date.getTime() / 86400000);
    const end = period(current);
    const values = points.slice(0, index + 1).filter(p => {
      const age = end - period(new Date(`${String(p.label).slice(0, 10)}T12:00:00Z`));
      return age >= 0 && age < (monthly ? 3 : 7) && p[key] != null && Number.isFinite(Number(p[key]));
    }).map(p => Number(p[key]));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  });
}
