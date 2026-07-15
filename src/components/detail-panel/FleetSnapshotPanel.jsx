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
  getTelemetrySourceLabel,
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
import {
  buildInspectionHistoryMap,
  buildQueueItemsFromSummary,
  getNextServiceDue,
} from "../../utils/maintUtils";
import TripPathMap from "../trip-summary/TripPathMap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const UTILIZATION_WINDOW_DAYS = 7;

function coerceCoordinate(value, maxAbs) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (Math.abs(number) <= maxAbs) return number;

  for (let scale = 10; scale <= 1e16; scale *= 10) {
    const scaled = number / scale;
    if (Math.abs(scaled) <= maxAbs) return scaled;
  }

  return number;
}

function distanceMiles(a, b) {
  const lat1 = Number(a?.lat);
  const lon1 = Number(a?.lon);
  const lat2 = Number(b?.lat);
  const lon2 = Number(b?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

  const radiusMiles = 3958.7613;
  const toRadians = (value) => (value * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;

  return 2 * radiusMiles * Math.asin(Math.sqrt(h));
}

function normalizeGeoLocation(location) {
  const rawLat = location?.latitude ?? location?.lat;
  const rawLon = location?.longitude ?? location?.lon ?? location?.lng;
  if (rawLat == null || rawLat === "" || rawLon == null || rawLon === "") {
    return null;
  }

  const lat = coerceCoordinate(rawLat, 90);
  const lon = coerceCoordinate(rawLon, 180);
  const radiusMiles = Number(location?.radiusMiles ?? location?.radius_miles);
  if (lat == null || lon == null) return null;
  if (lat === 0 && lon === 0) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) return null;
  if (location?.enabled === false) return null;

  return {
    id: String(location?.id || location?.label || `${lat},${lon}`),
    label: String(location?.label || location?.name || "Location"),
    lat,
    lon,
    radiusMiles,
  };
}

function getVehicleTelemetryPoint(vehicle) {
  const location = vehicle?.telemetry?.location;
  const lat = Number(location?.lat);
  const lon = Number(location?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function getContainingGeoLocation(vehicle, geoLocations) {
  const point = getVehicleTelemetryPoint(vehicle);
  if (!point) return null;
  return (
    geoLocations.find(
      (location) => distanceMiles(point, location) <= location.radiusMiles
    ) || null
  );
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workerCount = Math.max(1, Math.min(Number(limit) || 1, queue.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    })
  );
}

function getLocalDayStartMs(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getLocalDayKey(dayStartMs) {
  const date = new Date(dayStartMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTripBookedDayKeys(trip, windowStartMs, windowEndMs) {
  const startMs = getTripStartMs(trip);
  const rawEndMs = getTripEndMs(trip);

  if (!Number.isFinite(startMs)) return [];

  const endMs =
    Number.isFinite(rawEndMs) && rawEndMs >= startMs ? rawEndMs : startMs;
  const overlapStartMs = Math.max(startMs, windowStartMs);
  const overlapEndMs = Math.min(endMs, windowEndMs - 1);

  if (overlapEndMs < windowStartMs || overlapStartMs >= windowEndMs) {
    return [];
  }

  const keys = [];
  for (
    let dayMs = getLocalDayStartMs(overlapStartMs);
    dayMs <= getLocalDayStartMs(overlapEndMs);
    dayMs += 24 * 60 * 60 * 1000
  ) {
    keys.push(getLocalDayKey(dayMs));
  }

  return keys;
}

function isTripEligibleVehicle(vehicle) {
  return (
    vehicle?.is_active !== false &&
    vehicle?.isActive !== false &&
    vehicle?.in_service !== false &&
    vehicle?.inService !== false &&
    vehicle?.trip_eligible !== false &&
    vehicle?.tripEligible !== false
  );
}

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
  onOpenVehicleMap,
}) {
  const [expandedVehicles, setExpandedVehicles] = useState({});
  const [geoLocations, setGeoLocations] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function loadGeoLocations() {
      try {
        const resp = await fetch(`${API_BASE}/api/settings/locations.tracking`);
        if (!resp.ok) return;
        const json = await resp.json();
        const nextLocations = Array.isArray(json?.value?.locations)
          ? json.value.locations.map(normalizeGeoLocation).filter(Boolean)
          : [];
        if (!cancelled) setGeoLocations(nextLocations);
      } catch (err) {
        if (!cancelled) setGeoLocations([]);
      }
    }

    loadGeoLocations();

    return () => {
      cancelled = true;
    };
  }, []);

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
    const workflowStage = String(trip?.workflow_stage || "").toLowerCase();
    const displayStatus = String(trip?.display_status || "").toLowerCase();

    if (
      [
        "turnaround",
        "awaiting_expenses",
        "complete",
        "completed",
        "closed",
        "canceled",
        "cancelled",
      ].includes(workflowStage)
    ) {
      return false;
    }

    return (
      isTripInProgress(trip) ||
      displayStatus === "active" ||
      displayStatus === "ending_today"
    );
  }

  function tripMatchesVehicle(vehicle, trip) {
    const vehicleTuroId = normalizeValue(vehicle?.turo_vehicle_id);
    const tripTuroId = normalizeValue(trip?.turo_vehicle_id);

    if (tripTuroId && vehicleTuroId) {
      return tripTuroId === vehicleTuroId;
    }

    const vehicleVin = normalizeValue(vehicle?.vin);
    const tripVin = normalizeValue(trip?.vehicle_vin);

    if (tripVin && vehicleVin) {
      return tripVin === vehicleVin;
    }

    const vehicleKeys = [
      vehicleTuroId,
      normalizeValue(vehicle?.bouncie_vehicle_id),
      normalizeValue(vehicle?.dimo_token_id),
      normalizeValue(vehicle?.imei),
      normalizeValue(vehicle?.nickname),
      normalizeValue(vehicle?.turo_vehicle_name),
      normalizeValue(vehicle?.vehicle_name),
    ].filter(Boolean);

    const tripKeys = [
      normalizeValue(trip?.vehicle_nickname),
      normalizeValue(trip?.vehicle_name),
    ].filter(Boolean);

    return tripKeys.some((tripKey) => vehicleKeys.includes(tripKey));
  }

  const [serviceDueByVin, setServiceDueByVin] = useState({});

  function buildServiceDueMeta(summary) {
    const historyMap = buildInspectionHistoryMap(summary);
    const queueItems = buildQueueItemsFromSummary(summary, historyMap);

    return {
      nextServiceDue: getNextServiceDue(summary),
      dueTaskText: queueItems.length
        ? queueItems
            .slice(0, 3)
            .map((item) => item?.title)
            .filter(Boolean)
            .join(" • ")
        : null,
    };
  }

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

      await runWithConcurrency(
        pendingVins,
        2,
        async (vin) => {
          try {
            const resp = await fetch(
              `${API_BASE}/api/vehicles/${encodeURIComponent(vin)}/maintenance-summary`
            );
            if (!resp.ok) return;
            const summary = await resp.json();
            if (!cancelled) {
              nextServiceDueMap[vin] = buildServiceDueMeta(summary);
            }
          } catch (err) {
            // ignore individual failures
          }
        }
      );

      if (cancelled) return;
      setServiceDueByVin((prev) => ({
        ...prev,
        ...nextServiceDueMap,
      }));
    }

    const timerId = window.setTimeout(loadServiceDue, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [vehicleVins.join(","), serviceDueByVin]);

  function getServiceDueText(vehicle) {
    const serviceDueMeta = serviceDueByVin[vehicle?.vin];
    const nextServiceDue =
      vehicle?.next_service_due || serviceDueMeta?.nextServiceDue;

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

  function getServiceDueDetailText(vehicle) {
    const serviceDueMeta = serviceDueByVin[vehicle?.vin];
    const nextServiceDue =
      vehicle?.next_service_due || serviceDueMeta?.nextServiceDue;
    const dueTiming = nextServiceDue?.text
      ? String(nextServiceDue.text).trim()
      : "";

    if (serviceDueMeta?.dueTaskText) {
      return [serviceDueMeta.dueTaskText, dueTiming]
        .filter((part) => part && part !== "Unknown")
        .join(" • ");
    }

    return getServiceDueText(vehicle);
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

  function getPostTripForVehicle(vehicle) {
    return trips
      .filter((trip) => {
        if (!tripMatchesVehicle(vehicle, trip) || isCanceledTrip(trip)) return false;
        const workflowStage = String(trip?.workflow_stage || "").toLowerCase();
        return workflowStage === "awaiting_expenses" || workflowStage === "turnaround";
      })
      .sort((a, b) => getTripEndMs(b) - getTripEndMs(a))[0];
  }

  function getPostTripLabel(trip) {
    const workflowStage = String(trip?.workflow_stage || "").toLowerCase();
    return workflowStage === "turnaround" ? "Turnaround" : "Awaiting expenses";
  }

  function getVehicleDisplayOdometer(vehicle) {
    const liveOdometer = Number(vehicle?.telemetry?.odometer);
    if (Number.isFinite(liveOdometer) && liveOdometer > 0) {
      return liveOdometer;
    }

    const storedOdometer = Number(vehicle?.current_odometer_miles);
    if (Number.isFinite(storedOdometer) && storedOdometer > 0) {
      return storedOdometer;
    }

    return null;
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
        const postTrip = currentTrip ? null : getPostTripForVehicle(vehicle);
        const nextTrip = currentTrip ? null : getNextTripForVehicle(vehicle);
        const nextActionMs = currentTrip
          ? getTripEndMs(currentTrip)
          : postTrip
          ? getTripEndMs(postTrip)
          : nextTrip
          ? getTripStartMs(nextTrip)
          : Number.POSITIVE_INFINITY;
        const name = normalizeValue(
          vehicle?.nickname || vehicle?.vehicle_name || vehicle?.vin || ""
        );

        return {
          vehicle,
          currentTrip,
          postTrip,
          nextTrip,
          sortGroup: Number.isFinite(nextActionMs) ? 0 : 1,
          sortTime: nextActionMs,
          name,
        };
      })
      .sort((a, b) => {
        if (a.sortGroup !== b.sortGroup) return a.sortGroup - b.sortGroup;
        if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
        return a.name.localeCompare(b.name);
      });
  }, [vehicles, trips]);

  const sevenDayUtilization = useMemo(() => {
    const windowStartMs = getLocalDayStartMs();
    const windowEndMs =
      windowStartMs + UTILIZATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const bookedVehicleDays = new Set();
    const rentalVehicles = vehicles.filter(isTripEligibleVehicle);

    for (const vehicle of rentalVehicles) {
      const vehicleKey = getVehicleKey(vehicle);
      if (!vehicleKey) continue;

      for (const trip of trips) {
        if (isCanceledTrip(trip) || !tripMatchesVehicle(vehicle, trip)) {
          continue;
        }

        for (const dayKey of getTripBookedDayKeys(
          trip,
          windowStartMs,
          windowEndMs
        )) {
          bookedVehicleDays.add(`${vehicleKey}:${dayKey}`);
        }
      }
    }

    const capacityDays = rentalVehicles.length * UTILIZATION_WINDOW_DAYS;
    const bookedDays = bookedVehicleDays.size;
    const percent = capacityDays > 0 ? bookedDays / capacityDays : 0;

    return {
      bookedDays,
      capacityDays,
      percent,
      percentLabel: `${Math.round(percent * 100)}%`,
      widthPercent: Math.round(Math.max(0, Math.min(1, percent)) * 100),
    };
  }, [vehicles, trips]);

  function renderLocationLink(vehicle) {
  const { label, url, title, clickable } = getVehicleLocationLinkData(vehicle);

  if (
    label &&
    label !== "—" &&
    typeof onOpenVehicleMap === "function" &&
    vehicle?.id != null
  ) {
    return (
      <button
        type="button"
        className="detail-inline-link detail-inline-button"
        title="Open in Fleet Map"
        onClick={(event) => {
          event.stopPropagation();
          onOpenVehicleMap(vehicle.id);
        }}
      >
        {label}
      </button>
    );
  }

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

        <section className="fleet-utilization-card" aria-label="7 day utilization">
          <div className="fleet-utilization-card__header">
            <div>
              <div className="detail-label">7 Day Utilization</div>
              <div className="fleet-utilization-card__title">
                {sevenDayUtilization.bookedDays.toLocaleString("en-US")} /{" "}
                {sevenDayUtilization.capacityDays.toLocaleString("en-US")} booked days
              </div>
            </div>
            <div className="fleet-utilization-card__percent">
              {sevenDayUtilization.percentLabel}
            </div>
          </div>
          <div className="fleet-utilization-card__track">
            <div
              className="fleet-utilization-card__fill"
              style={{ width: `${sevenDayUtilization.widthPercent}%` }}
            />
          </div>
        </section>

        <div className="fleet-list">
          {sortedVehicleRows.map(({ vehicle, currentTrip, postTrip, nextTrip }) => {
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
              : postTrip
              ? `${getPostTripLabel(postTrip)} • Trip #${
                  postTrip.reservation_id || postTrip.id
                }`
              : nextTrip
              ? `Booked • ${formatDateShort(nextTrip.trip_start)}`
              : "Available";

            const serviceDueLabel = getServiceDueText(vehicle);
            const hasServiceDue = serviceDueLabel && serviceDueLabel !== "No service due";
            const serviceDueBadgeClass = hasServiceDue
              ? "fleet-maintenance-badge fleet-maintenance-badge--info"
              : "";

            const isExpanded = expandedVehicles[vehicleKey] || false;
            const containingGeoLocation = getContainingGeoLocation(
              vehicle,
              geoLocations
            );

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
                        <div
                          className={`fleet-status-pill ${statusTone} ${
                            containingGeoLocation ? "in-geo-location" : ""
                          }`}
                        >
                          {containingGeoLocation?.label || getVehicleStatusLabel(vehicle)}
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
                        {formatOdometer(getVehicleDisplayOdometer(vehicle))}
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
                        <div className="detail-label">Source</div>
                        <div className="detail-value detail-value--compact">
                          {getTelemetrySourceLabel(vehicle)}
                        </div>
                      </div>

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

                      {containingGeoLocation ? (
                        <div className="fleet-meta-item fleet-meta-item--full">
                          <div className="detail-label">Geo Location</div>
                          <div className="detail-value detail-value--compact">
                            Inside {containingGeoLocation.label}
                          </div>
                        </div>
                      ) : null}

                      {batteryAlert ? (
                        <div className={`fleet-inline-alert ${batteryAlert.level}`}>
                          <span className="fleet-inline-alert-icon">{batteryAlert.icon}</span>
                          {batteryAlert.detail}
                        </div>
                      ) : null}

                      <div className="fleet-meta-item fleet-meta-item--full">
                        <div className="detail-label">Trip status</div>
                        <div className="detail-value detail-value--compact">
                          {(() => {
                            if (currentTrip) {
                              return `On trip #${currentTrip.reservation_id || currentTrip.id} • ${
                                currentTrip.guest_name || "Unknown guest"
                              }`;
                            }

                            if (postTrip) {
                              return `${getPostTripLabel(postTrip)} for trip #${
                                postTrip.reservation_id || postTrip.id
                              } • ${postTrip.guest_name || "Unknown guest"}`;
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
                            {getServiceDueDetailText(vehicle)}
                          </div>
                        ) : (
                          <div className="detail-value detail-value--compact detail-value--muted">
                            {getServiceDueDetailText(vehicle)}
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

                    {currentTrip?.id ? (
                      <TripPathMap
                        tripId={currentTrip.id}
                        compact
                        title="Current Trip Path"
                      />
                    ) : null}
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


