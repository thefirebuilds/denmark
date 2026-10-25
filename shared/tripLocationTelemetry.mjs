export function withMapTelemetry(vehicle, locations) {
  if (!vehicle?.vin) return vehicle;
  const vin = String(vehicle.vin).trim().toLowerCase();
  const location = locations.find(item => String(item?.vin || '').trim().toLowerCase() === vin);
  if (!location) return vehicle;
  return { ...vehicle, telemetry: {
    ...vehicle.telemetry,
    // Keep odometer and diagnostics from the status feed, but use the same
    // stored location/motion observation displayed by the fleet map.
    location: { lat: location.lat, lon: location.lon, heading: location.heading },
    speed: location.speed,
    engine_running: location.isRunning,
    location_diagnostics: location.telemetryDiagnostics,
    timestamps: { ...vehicle.telemetry?.timestamps,
      location_last_updated: location.telemetryDiagnostics?.locationSignalAt ||
        (location.lastSeenType === 'location_fix' ? location.lastSeen : null),
      speed_last_updated: location.speedLastSeen,
      ignition_last_updated: location.runningLastSeen,
    },
  } };
}

export function describeVehicleBehavior(telemetry) {
  const speed = telemetry?.speed;
  if (speed != null && Number.isFinite(Number(speed)) && Number(speed) > 0) {
    return `${telemetry?.engine_running === true ? 'Driving' : 'Moving'} at ${Math.round(Number(speed))} mph`;
  }
  if (telemetry?.engine_running === true) {
    return speed == null ? 'Engine running; speed unavailable' : 'Engine running, currently stopped';
  }
  if (telemetry?.engine_running === false) return 'Parked / engine off';
  return 'Current movement unavailable';
}
