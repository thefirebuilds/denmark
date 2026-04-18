// ------------------------------------------------------------
// /components/maintenance/FleetListPanel.jsx
// This component renders the left-hand panel in the FleetMaintenancePanel,
// showing a list of all vehicles in the fleet with their current
// maintenance status. It fetches live vehicle status and trip data to
// provide up-to-date information on each vehicle's availability and any maintenance needs.
// ------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  normalizeVehicleKey,
  getEarliestAvailableDate,
  getEarliestAvailableLabel,
} from "../../utils/maintUtils";

function getVehicleRouteKey(vehicle) {
  return normalizeVehicleKey(
    vehicle?.nickname ||
      vehicle?.vin ||
      vehicle?.id ||
      vehicle?.dimo_token_id ||
      vehicle?.bouncie_vehicle_id
  );
}

function buildLiveFleetCard(vehicle, trips = []) {
  if (!vehicle) return null;

  const milOn = vehicle?.telemetry?.mil?.mil_on;
  const serviceDue = vehicle?.service_due;
  const batteryStatus = vehicle?.telemetry?.battery?.status;
  const batteryStale = vehicle?.telemetry?.battery?.is_stale;
  const hasActiveTrip = trips.some((trip) => trip?.queue_bucket === "in_progress");
  const hasUpcomingTrip = trips.some((trip) =>
    ["unconfirmed", "upcoming"].includes(trip?.queue_bucket)
  );

  let status = "Guest-ready";
  let tone = "good";

  if (milOn || serviceDue) {
    status = "Maintenance due";
    tone = "bad";
  } else if (hasActiveTrip) {
    status = "On trip";
    tone = "good";
  } else if (hasUpcomingTrip) {
    status = "Booked";
    tone = "warn";
  } else if (batteryStatus !== "normal" || batteryStale) {
    status = "Needs review";
    tone = "warn";
  }

  return {
    id: getVehicleRouteKey(vehicle),
    vin: vehicle.vin || null,
    turoVehicleId: vehicle.turo_vehicle_id || null,
    nickname: vehicle.nickname || "Unknown",
    year: vehicle.year || "—",
    make: vehicle.make || "",
    model: vehicle.model || "",
    status,
    tone,
    nextOffTrip: getEarliestAvailableLabel(trips),
    nextAvailableDate: getEarliestAvailableDate(trips),
    isLive: true,
  };
}

export default function FleetListPanel({
  selectedVehicleId,
  onSelectVehicle,
}) {
  const [fleet, setFleet] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadFleet() {
      try {
        if (isMounted) {
          setLoading(true);
          setLoadError("");
        }

        const vehicleRes = await fetch("http://localhost:5000/api/vehicles/live-status");

        if (!vehicleRes.ok) {
          throw new Error(`Vehicle status HTTP ${vehicleRes.status}`);
        }

        const vehicleData = await vehicleRes.json();
        const vehicles = Array.isArray(vehicleData) ? vehicleData : [];

        const tripResults = await Promise.all(
          vehicles.map(async (vehicle) => {
            const routeKey = getVehicleRouteKey(vehicle);

            try {
              const tripsRes = await fetch(
                `http://localhost:5000/api/trips/vehicle/${routeKey}?mode=relevant`
              );

              if (!tripsRes.ok) {
                throw new Error(`Trip status HTTP ${tripsRes.status}`);
              }

              const tripData = await tripsRes.json();

              return {
                vehicle,
                trips: Array.isArray(tripData) ? tripData : [],
              };
            } catch (err) {
              console.error(`Failed to load trips for ${routeKey}:`, err);

              return {
                vehicle,
                trips: [],
              };
            }
          })
        );

        const liveFleet = tripResults
          .map(({ vehicle, trips }) => buildLiveFleetCard(vehicle, trips))
          .filter(Boolean)
          .sort((a, b) => String(a.nickname).localeCompare(String(b.nickname)));

        if (isMounted) {
          setFleet(liveFleet);
        }
      } catch (err) {
        console.error("Failed to load live fleet status:", err);

        if (isMounted) {
          setFleet([]);
          setLoadError(err.message || "Failed to load fleet");
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    loadFleet();

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <section className="panel fleet-list-panel">
      <div className="panel-header">
        <h2>Fleet Status</h2>
        <span>{fleet.length} vehicles</span>
      </div>

      <div className="panel-subbar">
        <div className="chip search">Maintenance mode</div>
        <div className="chip">
          {loading
            ? "Loading live fleet"
            : loadError
            ? "Fleet load failed"
            : "Live fleet"}
        </div>
      </div>

      {loadError ? (
        <div className="fleet-maintenance-note">{loadError}</div>
      ) : null}

      <div className="fleet-status-list">
        {fleet.length ? (
          fleet.map((vehicle) => {
            const isSelected = selectedVehicleId === vehicle.id;

            return (
              <button
                key={vehicle.id}
                type="button"
                className={`fleet-status-card ${isSelected ? "selected" : ""}`}
                onClick={() => onSelectVehicle?.(isSelected ? null : vehicle.id)}
              >
                <div className="fleet-status-card-head">
                  <div className="fleet-status-card-title">
                    {vehicle.nickname}
                  </div>
                  <div className={`fleet-status-pill fleet-status-pill--${vehicle.tone}`}>
                    {vehicle.status}
                  </div>
                </div>

                <div className="fleet-status-card-sub">
                  {vehicle.year} {vehicle.make} {vehicle.model}
                </div>

                <div className="fleet-status-card-meta">
                  <span className="fleet-status-card-label">
                    Available for Maintenance:{" "}
                  </span>
                  <span className="fleet-status-card-value">
                    {vehicle.nextOffTrip}
                  </span>
                </div>
              </button>
            );
          })
        ) : (
          <div className="fleet-maintenance-note">
            {loading ? "Loading fleet vehicles…" : "No live vehicles found."}
          </div>
        )}
      </div>
    </section>
  );
}
