// --------------------------------
// /src/components/detail-panel/FleetSnapshotPanel.jsx
// Fleet-only view shown when no trip is selected.
// This keeps the general fleet health screen separate from selected-trip UI.
// --------------------------------

import { useEffect, useMemo, useState } from "react";
import {
  formatDateShort,
  formatFuelLevel,
  formatOdometer,
  formatRelativeComm,
  getBatteryAlert,
  getBatteryStatusLabel,
  getCommAlert,
  getVehicleEmergencyTone,
  getVehicleLocationLinkData,
  getVehicleStatusLabel,
  normalizeText,
  openUrl,
} from "./detailPanel.utils";
import {
  getTripEndMs,
  getTripStartMs,
  isCanceledTrip,
  isTripInProgress,
} from "../../utils/tripUtils";
import { getNextServiceDue } from "../../utils/maintUtils";

const API_BASE = "http://localhost:5000";

/**
 * Fleet-only view shown when no trip is selected.
 * This keeps the general fleet health screen separate from selected-trip UI.
 */
export default function FleetSnapshotPanel({
  vehicles,
  vehiclesLoading,
  vehiclesError,
  highlightedVehicles,
  trips = [],
}) {
  const [expandedVehicles, setExpandedVehicles] = useState({});

  function getVehicleKey(vehicle) {
    return (
      vehicle?.turo_vehicle_id ||
      vehicle?.vin ||
      vehicle?.imei ||
      vehicle?.nickname ||
      vehicle?.bouncie_vehicle_id ||
      vehicle?.dimo_token_id
    );
  }

  function normalizeValue(value) {
    return normalizeText(value || "");
  }

  function isActiveTrip(trip) {
    const displayStatus = String(trip?.display_status || "").toLowerCase();
    return (
      isTripInProgress(trip) ||
      displayStatus === "active" ||
      displayStatus === "ending_today"
    );
  }

  function tripMatchesVehicle(vehicle, trip) {
    const vehicleKeys = [
      normalizeValue(vehicle?.vin),
      normalizeValue(vehicle?.turo_vehicle_id),
      normalizeValue(vehicle?.bouncie_vehicle_id),
      normalizeValue(vehicle?.dimo_token_id),
      normalizeValue(vehicle?.imei),
      normalizeValue(vehicle?.nickname),
      normalizeValue(vehicle?.turo_vehicle_name),
      normalizeValue(vehicle?.vehicle_name),
    ].filter(Boolean);

    const tripKeys = [
      normalizeValue(trip?.turo_vehicle_id),
      normalizeValue(trip?.vehicle_vin),
      normalizeValue(trip?.vehicle_nickname),
      normalizeValue(trip?.vehicle_name),
    ].filter(Boolean);

    return tripKeys.some((tripKey) => vehicleKeys.includes(tripKey));
  }

  const [serviceDueByVin, setServiceDueByVin] = useState({});

  function toggleVehicleExpanded(vehicleKey) {
    setExpandedVehicles((prev) => ({
      ...prev,
      [vehicleKey]: !prev[vehicleKey],
    }));
  }

  const vehicleVins = useMemo(
    () =>
      Array.from(
        new Set(
          vehicles
            .map((vehicle) => vehicle?.vin)
            .filter((vin) => typeof vin === "string" && vin.trim().length > 0)
        )
      ),
    [vehicles]
  );

  useEffect(() => {
    if (!vehicleVins.length) return;

    const pendingVins = vehicleVins.filter((vin) => !serviceDueByVin[vin]);
    if (!pendingVins.length) return;

    let cancelled = false;

    async function loadServiceDue() {
      const nextServiceDueMap = {};

      await Promise.all(
        pendingVins.map(async (vin) => {
          try {
            const resp = await fetch(
              `${API_BASE}/api/vehicles/${encodeURIComponent(vin)}/maintenance-summary`
            );
            if (!resp.ok) return;
            const summary = await resp.json();
            if (!cancelled) {
              nextServiceDueMap[vin] = getNextServiceDue(summary);
            }
          } catch (err) {
            // ignore individual failures
          }
        })
      );

      if (cancelled) return;
      setServiceDueByVin((prev) => ({
        ...prev,
        ...nextServiceDueMap,
      }));
    }

    loadServiceDue();

    return () => {
      cancelled = true;
    };
  }, [vehicleVins.join(","), serviceDueByVin]);

  function getServiceDueText(vehicle) {
    const nextServiceDue =
      vehicle?.next_service_due || serviceDueByVin[vehicle?.vin];

    if (nextServiceDue?.text) {
      const text = String(nextServiceDue.text).trim();
      if (text && text !== "Unknown") return `Service due ${text}`;
    }

    if (nextServiceDue?.label) {
      const label = String(nextServiceDue.label).trim();
      if (label && label !== "Unknown") return `Service due ${label}`;
    }

    if (vehicle?.telemetry?.mil?.mil_on) return "MIL on";
    if (vehicle?.service_due) return "Maintenance due";
    return "No service due";
  }

  function getReturnLabel(trip) {
    const endMs = getTripEndMs(trip);
    if (!Number.isFinite(endMs)) return "Returning soon";

    const hours = (endMs - Date.now()) / (1000 * 60 * 60);
    if (hours <= 0) return "Returning soon";
    if (hours < 24) return `Returning in ${Math.round(hours)} hr`;

    const days = Math.ceil(hours / 24);
    return `Returning in ${days} day${days === 1 ? "" : "s"}`;
  }

  function getCurrentTripForVehicle(vehicle) {
    return trips.find(
      (trip) => tripMatchesVehicle(vehicle, trip) && isActiveTrip(trip)
    );
  }

  function getNextTripForVehicle(vehicle) {
    return trips
      .filter(
        (trip) =>
          tripMatchesVehicle(vehicle, trip) &&
          !isActiveTrip(trip) &&
          !isCanceledTrip(trip) &&
          getTripStartMs(trip) > Date.now()
      )
      .sort((a, b) => getTripStartMs(a) - getTripStartMs(b))[0];
  }

  const sortedVehicleRows = useMemo(() => {
    return vehicles
      .map((vehicle) => {
        const currentTrip = getCurrentTripForVehicle(vehicle);
        const nextTrip = currentTrip ? null : getNextTripForVehicle(vehicle);
        const currentReturnMs = currentTrip
          ? getTripEndMs(currentTrip)
          : Number.POSITIVE_INFINITY;
        const nextStartMs = nextTrip
          ? getTripStartMs(nextTrip)
          : Number.POSITIVE_INFINITY;
        const name = normalizeValue(
          vehicle?.nickname || vehicle?.vehicle_name || vehicle?.vin || ""
        );

        return {
          vehicle,
          currentTrip,
          nextTrip,
          sortGroup: currentTrip ? 0 : nextTrip ? 1 : 2,
          sortTime: currentTrip ? currentReturnMs : nextStartMs,
          name,
        };
      })
      .sort((a, b) => {
        if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
        if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
        return a.name.localeCompare(b.name);
      });
  }, [vehicles, trips]);

  function renderLocationLink(vehicle) {
  const { label, url, title, clickable } = getVehicleLocationLinkData(vehicle);

  if (!clickable) {
    return <span>{label}</span>;
  }

  return (
    <a
      className="detail-inline-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

  return (
    <aside className="panel detail-panel">
      <div className="panel-header">
        <h2>Fleet Snapshot</h2>
        <span>{vehiclesLoading ? "Refreshing telemetry…" : `${vehicles.length} vehicles`}</span>
      </div>

      <div className="detail-body">
        {vehiclesError ? (
          <div className="detail-card">
            <div className="detail-label">Telemetry</div>
            <div className="detail-value">{vehiclesError}</div>
          </div>
        ) : null}

        <div className="fleet-list">
          {sortedVehicleRows.map(({ vehicle, currentTrip, nextTrip }) => {
            const nameTitle = vehicle.nickname || "Unknown vehicle";
            const subtitle = [vehicle.year, vehicle.make, vehicle.model]
              .filter(Boolean)
              .join(" ");
            const vehicleKey = getVehicleKey(vehicle);
            const commAlert = getCommAlert(vehicle);
            const batteryAlert = getBatteryAlert(vehicle);
            const fuelLabel = formatFuelLevel(vehicle?.telemetry?.fuel_level);
            const statusTone = getVehicleEmergencyTone(vehicle);
            const tripStateLabel = currentTrip
              ? `On trip • ${getReturnLabel(currentTrip)}`
              : nextTrip
              ? `Booked • ${formatDateShort(nextTrip.trip_start)}`
              : "Available";

            const serviceDueLabel = getServiceDueText(vehicle);
            const hasServiceDue = serviceDueLabel && serviceDueLabel !== "No service due";
            const serviceDueBadgeClass = hasServiceDue
              ? "fleet-maintenance-badge fleet-maintenance-badge--info"
              : "";

            const isExpanded = expandedVehicles[vehicleKey] || false;

            return (
              <div
                key={vehicleKey}
                className={`fleet-row ${isExpanded ? "expanded" : "collapsed"} ${
                  highlightedVehicles?.[vehicleKey] ? "fleet-row--highlighted" : ""
                }`}
              >
                <button
                  type="button"
                  className="fleet-row-summary"
                  onClick={() => toggleVehicleExpanded(vehicleKey)}
                >
                  <div className="fleet-row-summary-main">
                    <div className="fleet-row-summary-header">
                      <div>
                        <div className="fleet-row-title">{nameTitle}</div>
                        {subtitle ? (
                          <div className="fleet-row-subtitle">{subtitle}</div>
                        ) : null}
                      </div>
                      <div className="fleet-row-summary-badges">
                        <div className={`fleet-status-pill ${statusTone}`}>
                          {getVehicleStatusLabel(vehicle)}
                        </div>
                        {hasServiceDue ? (
                          <div className={serviceDueBadgeClass}>
                            {serviceDueLabel}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div className="fleet-row-trip-state">{tripStateLabel}</div>

                    <div className="fleet-row-summary-tags">
                      <div className="fleet-row-odometer">
                        {formatOdometer(vehicle?.telemetry?.odometer)}
                      </div>
                      {commAlert ? (
                        <div className={`fleet-inline-alert ${commAlert.level}`}>
                          {commAlert.label}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </button>

                {isExpanded ? (
                  <div className="fleet-row-details">
                    <div className="fleet-row-meta">
                      <div className="fleet-meta-item">
                        <div className="detail-label">Last Comm</div>
                        <div className="detail-value detail-value--compact">
                          {formatRelativeComm(vehicle?.telemetry?.last_comm)}
                        </div>
                      </div>

                      <div className="fleet-meta-item">
                        <div className="detail-label">Fuel</div>
                        <div className="detail-value detail-value--compact">
                          {fuelLabel || "—"}
                        </div>
                      </div>

                      <div className="fleet-meta-item">
                        <div className="detail-label">Battery</div>
                        <div className="detail-value detail-value--compact">
                          {getBatteryStatusLabel(vehicle)}
                        </div>
                      </div>

                      <div className="fleet-meta-item fleet-meta-item--full">
                        <div className="detail-label">Location</div>
                        <div className="detail-value detail-value--compact">
                          {renderLocationLink(vehicle)}
                        </div>
                      </div>

                      {batteryAlert ? (
                        <div className={`fleet-inline-alert ${batteryAlert.level}`}>
                          <span className="fleet-inline-alert-icon">{batteryAlert.icon}</span>
                          {batteryAlert.detail}
                        </div>
                      ) : null}

                      <div className="fleet-meta-item fleet-meta-item--full">
                        <div className="detail-label">Current trip</div>
                        <div className="detail-value detail-value--compact">
                          {(() => {
                            const currentTrip = trips.find(
                              (trip) => tripMatchesVehicle(vehicle, trip) && isActiveTrip(trip)
                            );
                            const nextTrip = trips
                              .filter(
                                (trip) =>
                                  tripMatchesVehicle(vehicle, trip) &&
                                  !isActiveTrip(trip) &&
                                  !isCanceledTrip(trip) &&
                                  getTripStartMs(trip) > Date.now()
                              )
                              .sort((a, b) => getTripStartMs(a) - getTripStartMs(b))[0];

                            if (currentTrip) {
                              return `On trip #${currentTrip.reservation_id || currentTrip.id} • ${
                                currentTrip.guest_name || "Unknown guest"
                              }`;
                            }

                            if (nextTrip) {
                              return `Next trip #${nextTrip.reservation_id || nextTrip.id} • ${formatDateShort(
                                nextTrip.trip_start
                              )}`;
                            }

                            return "No active trip";
                          })()}
                        </div>
                      </div>

                      <div className="fleet-meta-item fleet-meta-item--full">
                        <div className="detail-label">Service Due</div>
                        {hasServiceDue ? (
                          <div className={serviceDueBadgeClass}>
                            {serviceDueLabel}
                          </div>
                        ) : (
                          <div className="detail-value detail-value--compact detail-value--muted">
                            {serviceDueLabel}
                          </div>
                        )}
                      </div>

                      <div className="fleet-meta-item">
                        <div className="detail-label">Fuel</div>
                        <div className="detail-value detail-value--compact">
                          {fuelLabel || "—"}
                        </div>
                      </div>

                      <div className="fleet-meta-item">
                        <div className="detail-label">Battery</div>
                        <div className="detail-value detail-value--compact">
                          {getBatteryStatusLabel(vehicle)}
                        </div>
                      </div>

                      <div className="fleet-meta-item">
                        <div className="detail-label">Last Comm</div>
                        <div className="detail-value detail-value--compact">
                          {formatRelativeComm(vehicle?.telemetry?.last_comm)}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {!vehiclesLoading && !vehiclesError && vehicles.length === 0 ? (
            <div className="detail-card">
              <div className="detail-label">Fleet Snapshot</div>
              <div className="detail-value">No telemetry available</div>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
