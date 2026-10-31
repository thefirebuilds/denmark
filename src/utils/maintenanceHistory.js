function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

export function getUniqueMaintenanceHistory(entries) {
  const seen = new Set();
  return [...entries].sort((a, b) =>
    new Date(b?.performedAt || b?.performed_at || b?.recorded_at || 0).getTime() -
    new Date(a?.performedAt || a?.performed_at || a?.recorded_at || 0).getTime()
  ).filter(entry => {
    const date = entry.performedAt || entry.performed_at || entry.recorded_at || "";
    const parsed = date ? new Date(date) : null;
    const key = JSON.stringify([
      parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : date,
      entry.odometerMiles ?? entry.odometer_miles ?? null,
      String(entry.result || "").trim().toLowerCase(),
      String(entry.notes || "").trim().replace(/\s+/g, " ").toLowerCase(),
      stableValue(entry.data || {}),
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
