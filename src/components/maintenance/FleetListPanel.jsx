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
  getNextServiceDue,
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

function getNextActivitySort(trips = []) {
  const relevantTrips = Array.isArray(trips) ? trips : [];
  const now = Date.now();

  const candidates = relevantTrips
    .map((trip) => {
      const bucket = String(trip?.queue_bucket || "").toLowerCase();
      const stage = String(trip?.workflow_stage || "").toLowerCase();
      const startMs = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;
      const endMs = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;

      if (bucket === "in_progress" || stage === "in_progress") {
        return Number.isFinite(endMs) ? endMs : Number.POSITIVE_INFINITY;
      }

      if (
        bucket === "unconfirmed" ||
        bucket === "upcoming" ||
        stage === "ready_for_handoff" ||
        stage === "confirmed"
      ) {
        return Number.isFinite(startMs) ? startMs : Number.POSITIVE_INFINITY;
      }

      if (bucket === "needs_closeout") {
        return Number.isFinite(endMs) ? endMs : Number.POSITIVE_INFINITY;
      }

      return Number.POSITIVE_INFINITY;
    })
    .filter(Number.isFinite);

  if (!candidates.length) {
    return { group: 3, value: Number.POSITIVE_INFINITY };
  }

  const nextAt = Math.min(...candidates);
  return {
    group: nextAt <= now ? 0 : 1,
    value: nextAt,
  };
}

function getMaintenanceSort(vehicleCard) {
  const due = vehicleCard?.nextMaintenanceDue;
  const currentOdometer =
    vehicleCard?.currentOdometerMiles != null
      ? Number(vehicleCard.currentOdometerMiles)
      : NaN;
  const dueMiles = due?.miles != null ? Number(due.miles) : NaN;
  const dateMs = due?.estimatedDate
    ? new Date(due.estimatedDate).getTime()
    : due?.date
    ? new Date(due.date).getTime()
    : NaN;

  if (vehicleCard?.milOn || vehicleCard?.serviceDue) {
    return { group: 0, value: 0 };
  }

  if (
    Number.isFinite(currentOdometer) &&
    Number.isFinite(dueMiles) &&
    dueMiles <= currentOdometer
  ) {
    return { group: 0, value: dueMiles - currentOdometer };
  }

  if (Number.isFinite(dateMs)) {
    return { group: dateMs <= Date.now() ? 0 : 1, value: dateMs };
  }

  if (Number.isFinite(currentOdometer) && Number.isFinite(dueMiles)) {
    return { group: 2, value: dueMiles - currentOdometer };
  }

  return { group: 3, value: Number.POSITIVE_INFINITY };
}

function compareFleetByMaintenance(a, b) {
  const aActivity = a?.nextActivitySort || { group: 3, value: Number.POSITIVE_INFINITY };
  const bActivity = b?.nextActivitySort || { group: 3, value: Number.POSITIVE_INFINITY };

  if (aActivity.group !== bActivity.group) return aActivity.group - bActivity.group;
  if (aActivity.value !== bActivity.value) return aActivity.value - bActivity.value;

  const aSort = getMaintenanceSort(a);
  const bSort = getMaintenanceSort(b);

  if (aSort.group !== bSort.group) return aSort.group - bSort.group;
  if (aSort.value !== bSort.value) return aSort.value - bSort.value;

  const aAvailable = a.nextAvailableDate
    ? new Date(a.nextAvailableDate).getTime()
    : Number.POSITIVE_INFINITY;
  const bAvailable = b.nextAvailableDate
    ? new Date(b.nextAvailableDate).getTime()
    : Number.POSITIVE_INFINITY;

  if (aAvailable !== bAvailable) return aAvailable - bAvailable;

  return String(a.nickname).localeCompare(String(b.nickname));
}

function buildLiveFleetCard(vehicle, trips = [], maintenanceSummary = null) {
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
    currentOdometerMiles:
      maintenanceSummary?.currentOdometerMiles ??
      vehicle?.telemetry?.odometer ??
      null,
    nextActivitySort: getNextActivitySort(trips),
    nextMaintenanceDue: maintenanceSummary
      ? getNextServiceDue(maintenanceSummary)
      : null,
    milOn,
    serviceDue,
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
            const maintenanceSelector = vehicle?.vin || routeKey;

            try {
              const [tripsRes, maintenanceRes] = await Promise.all([
                fetch(`http://localhost:5000/api/trips/vehicle/${routeKey}?mode=relevant`),
                maintenanceSelector
                  ? fetch(
                      `http://localhost:5000/api/vehicles/${encodeURIComponent(
                        maintenanceSelector
                      )}/maintenance-summary`
                    )
                  : Promise.resolve(null),
              ]);

              if (!tripsRes.ok) {
                throw new Error(`Trip status HTTP ${tripsRes.status}`);
              }

              const tripData = await tripsRes.json();
              const maintenanceSummary =
                maintenanceRes?.ok ? await maintenanceRes.json() : null;

              return {
                vehicle,
                trips: Array.isArray(tripData) ? tripData : [],
                maintenanceSummary,
              };
            } catch (err) {
              console.error(`Failed to load trips for ${routeKey}:`, err);

              return {
                vehicle,
                trips: [],
                maintenanceSummary: null,
              };
            }
          })
        );

        const liveFleet = tripResults
          .map(({ vehicle, trips, maintenanceSummary }) =>
            buildLiveFleetCard(vehicle, trips, maintenanceSummary)
          )
          .filter(Boolean)
          .sort(compareFleetByMaintenance);

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

                <div className="fleet-status-card-meta">
                  <span className="fleet-status-card-label">
                    Next Maintenance:{" "}
                  </span>
                  <span className="fleet-status-card-value">
                    {vehicle.nextMaintenanceDue?.text &&
                    vehicle.nextMaintenanceDue.text !== "Unknown"
                      ? `${vehicle.nextMaintenanceDue.label}: ${vehicle.nextMaintenanceDue.text}`
                      : "No scheduled item"}
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
