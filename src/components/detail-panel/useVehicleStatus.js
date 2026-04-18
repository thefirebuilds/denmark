// --------------------------------
// useVehicleStatus.js
// React hook to poll vehicle status and determine highlight state for recently started/started moving vehicles
// --------------------------------

import { useEffect, useRef, useState } from "react";

/**
 * Poll fleet telemetry on an interval and expose a highlight state
 * when a vehicle newly starts or begins moving.
 */
export function useVehicleStatus(pollMs = 60000) {
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [vehiclesError, setVehiclesError] = useState("");
  const [highlightedVehicles, setHighlightedVehicles] = useState({});

  const previousVehiclesRef = useRef(new Map());

  function getVehicleKey(vehicle) {
    return (
      vehicle?.turo_vehicle_id ||
      vehicle?.bouncie_vehicle_id ||
      vehicle?.dimo_token_id ||
      vehicle?.vin ||
      vehicle?.imei ||
      vehicle?.nickname
    );
  }

  function markVehicleHighlighted(vehicleKey) {
    if (!vehicleKey) return;

    setHighlightedVehicles((prev) => ({
      ...prev,
      [vehicleKey]: true,
    }));

    window.setTimeout(() => {
      setHighlightedVehicles((prev) => {
        const next = { ...prev };
        delete next[vehicleKey];
        return next;
      });
    }, 12000);
  }

  useEffect(() => {
    let cancelled = false;

    async function loadVehicles() {
      setVehiclesLoading(true);
      setVehiclesError("");

      try {
        const resp = await fetch("http://localhost:5000/api/vehicles/live-status");
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const nextVehicles = Array.isArray(data) ? data : [];

        if (cancelled) return;

        const prevMap = previousVehiclesRef.current;

        for (const vehicle of nextVehicles) {
          const key = getVehicleKey(vehicle);
          const prev = prevMap.get(key);

          const justStarted =
            prev &&
            prev.telemetry?.engine_running !== true &&
            vehicle.telemetry?.engine_running === true;

          const justStartedMoving =
            prev &&
            Number(prev.telemetry?.speed || 0) <= 0 &&
            Number(vehicle.telemetry?.speed || 0) > 0;

          if (justStarted || justStartedMoving) {
            markVehicleHighlighted(key);
          }
        }

        const nextMap = new Map();
        for (const vehicle of nextVehicles) {
          const key = getVehicleKey(vehicle);
          nextMap.set(key, vehicle);
        }

        previousVehiclesRef.current = nextMap;
        setVehicles(nextVehicles);
      } catch (err) {
        if (!cancelled) {
          setVehiclesError(err.message || "Failed to load vehicle status");
        }
      } finally {
        if (!cancelled) {
          setVehiclesLoading(false);
        }
      }
    }

    loadVehicles();
    const interval = setInterval(loadVehicles, pollMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs]);

  return {
    vehicles,
    vehiclesLoading,
    vehiclesError,
    highlightedVehicles,
  };
}
