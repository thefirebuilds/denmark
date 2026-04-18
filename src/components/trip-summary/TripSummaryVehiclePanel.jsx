// ------------------------------------------------------------
// src/components/trip-summary/TripSummaryVehiclePanel.jsx
// Left panel for trip summary page. Loads vehicles and allows
// selecting a vehicle to filter the trip ledger, including
// trips that have no vehicle assigned.
// ------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:5000";
const UNASSIGNED_VEHICLE_FILTER = "__UNASSIGNED__";

function getVehicleLabel(vehicle) {
  const nickname = String(vehicle?.nickname || "").trim();
  if (nickname) return nickname;

  const fallback = [vehicle?.year, vehicle?.make, vehicle?.model]
    .filter(Boolean)
    .join(" ");

  return fallback || "Unknown vehicle";
}

function getVehicleSub(vehicle) {
  const details = [vehicle?.year, vehicle?.make, vehicle?.model]
    .filter(Boolean)
    .join(" ");

  return details || "Vehicle details unavailable";
}

export default function TripSummaryVehiclePanel({
  selectedVehicleId = null,
  onSelectVehicle,
}) {
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadVehicles() {
      setLoading(true);
      setLoadError("");

      try {
        const res = await fetch(`${API_BASE}/api/vehicles/status`);

        if (!res.ok) {
          throw new Error(`Vehicle request failed: ${res.status}`);
        }

        const data = await res.json();

        if (ignore) return;
        setVehicles(Array.isArray(data) ? data : []);
      } catch (err) {
        if (ignore) return;
        setLoadError(err.message || "Failed to load vehicles");
        setVehicles([]);
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadVehicles();

    return () => {
      ignore = true;
    };
  }, []);

  const sortedVehicles = useMemo(() => {
    return [...vehicles].sort((a, b) =>
      getVehicleLabel(a).localeCompare(getVehicleLabel(b), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  }, [vehicles]);

  const isAllSelected = selectedVehicleId == null;
  const isUnassignedSelected =
    String(selectedVehicleId) === UNASSIGNED_VEHICLE_FILTER;

  return (
    <section className="panel trip-summary-vehicle-panel">
      <div className="panel-header">
        <h2>Vehicles</h2>
        <span>select a car to filter trips</span>
      </div>

      <div className="panel-subbar">
        <div className="chip">{sortedVehicles.length} vehicles</div>
      </div>

      <div className="trip-summary-vehicle-list">
        <button
          type="button"
          className={`trip-summary-vehicle-row ${
            isAllSelected ? "selected" : ""
          }`}
          onClick={() => onSelectVehicle?.(null)}
        >
          <div className="trip-summary-vehicle-name">All Vehicles</div>
          <div className="trip-summary-vehicle-sub">
            Show trips across the whole fleet
          </div>
        </button>

        <button
          type="button"
          className={`trip-summary-vehicle-row ${
            isUnassignedSelected ? "selected" : ""
          }`}
          onClick={() => onSelectVehicle?.(UNASSIGNED_VEHICLE_FILTER)}
        >
          <div className="trip-summary-vehicle-name">Unassigned Trips</div>
          <div className="trip-summary-vehicle-sub">
            Show trips with no vehicle assigned
          </div>
        </button>

        {loading ? (
          <div className="trip-summary-empty-state">Loading vehicles...</div>
        ) : null}

        {!loading && loadError ? (
          <div className="trip-summary-error-state">{loadError}</div>
        ) : null}

        {!loading && !loadError && !sortedVehicles.length ? (
          <div className="trip-summary-empty-state">No vehicles found.</div>
        ) : null}

        {!loading &&
          !loadError &&
          sortedVehicles.map((vehicle) => {
            const selected =
              String(vehicle.id) === String(selectedVehicleId);

            return (
              <button
                key={vehicle.id}
                type="button"
                className={`trip-summary-vehicle-row ${
                  selected ? "selected" : ""
                }`}
                onClick={() => onSelectVehicle?.(vehicle.id)}
              >
                <div className="trip-summary-vehicle-name">
                  {getVehicleLabel(vehicle)}
                </div>

                <div className="trip-summary-vehicle-sub">
                  {getVehicleSub(vehicle)}
                </div>
              </button>
            );
          })}
      </div>
    </section>
  );
}

export { UNASSIGNED_VEHICLE_FILTER };