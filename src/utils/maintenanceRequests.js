let fleetRequest = null;

// The parent, sidebar and planning view mount together. Share their in-flight
// roster request, but give each caller its own response body.
export async function fetchMaintenanceFleet() {
  if (!fleetRequest) {
    fleetRequest = fetch('/api/vehicles', { signal: AbortSignal.timeout(20000) })
      .finally(() => { fleetRequest = null; });
  }
  return (await fleetRequest).clone();
}

export async function mapMaintenanceRequests(items, callback, shouldStop = () => false) {
  let index = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    while (index < items.length && !shouldStop()) {
      const current = index++;
      results[current] = await callback(items[current]);
    }
  }));
  return results;
}
