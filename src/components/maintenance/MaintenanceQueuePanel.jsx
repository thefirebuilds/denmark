// ------------------------------------------------------------
// /components/maintenance/MaintenanceQueuePanel.jsx
// Right-hand queue panel for selected vehicle or fleet-wide planning.
// ------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import InspectionItemDrawer from "./InspectionItemDrawer";
import {
  normalizeVehicleKey,
  findFleetVehicleBySelectedId,
  buildInspectionHistoryMap,
  mapRuleStatusToInspectionItem,
  buildQueueItemsFromSummary,
  getNextIntervalDueText,
  sortQueue,
  getPriorityScore,
  getEarliestAvailableDate,
  getEarliestAvailableLabel,
} from "../../utils/maintUtils";
import {
  MAINTENANCE_TASKS_UPDATED_EVENT,
  notifyMaintenanceTasksUpdated,
} from "../../utils/maintenanceEvents";

function getPlanningScore(item) {
  const blocks =
    item?.blocksRentalWhenOverdue ||
    item?.blocksGuestExportWhenOverdue ||
    item?.task?.blocks_rental ||
    item?.task?.blocks_guest_export;

  return (blocks ? 100 : 0) + getPriorityScore(item?.priority);
}

function normalizeMatchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function getVehicleTripKeys(vehicle) {
  return [
    vehicle?.turo_vehicle_id,
    vehicle?.vin,
    vehicle?.nickname,
    vehicle?.turo_vehicle_name,
    vehicle?.vehicle_name,
    ...(Array.isArray(vehicle?.aliases) ? vehicle.aliases : []),
  ]
    .map(normalizeMatchValue)
    .filter(Boolean);
}

function tripMatchesVehicle(vehicle, trip) {
  const vehicleKeys = getVehicleTripKeys(vehicle);
  if (!vehicleKeys.length) return false;

  const tripKeys = [
    trip?.turo_vehicle_id,
    trip?.vehicle_vin,
    trip?.vehicle_nickname,
    trip?.vehicle_name,
  ]
    .map(normalizeMatchValue)
    .filter(Boolean);

  return tripKeys.some((tripKey) => vehicleKeys.includes(tripKey));
}

function sortFleetPlanningQueue(items) {
  return [...items].sort((a, b) => {
    const aDate = new Date(a.nextAvailableDate || 0).getTime();
    const bDate = new Date(b.nextAvailableDate || 0).getTime();
    if (aDate !== bDate) return aDate - bDate;

    const planningDiff = getPlanningScore(b) - getPlanningScore(a);
    if (planningDiff !== 0) return planningDiff;

    return String(a.vehicleNickname || "").localeCompare(
      String(b.vehicleNickname || "")
    );
  });
}

function getAvailabilityDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

function getAvailabilitySortValue(value) {
  const date = getAvailabilityDate(value);
  if (date.getFullYear() >= 9000) return Number.NEGATIVE_INFINITY;
  return date.getTime();
}

function getAvailabilityDateKey(value) {
  const date = getAvailabilityDate(value);
  if (date.getFullYear() >= 9000) return "overdue";

  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getAvailabilityDateLabel(value) {
  const date = getAvailabilityDate(value);
  if (date.getFullYear() >= 9000) return "Overdue";

  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

function formatTaskHistoryDate(value) {
  if (!value) return "Date unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unknown";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getTaskHistoryStatusLabel(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "resolved") return "Done";
  if (value === "canceled") return "Canceled";
  return value ? value.replace(/_/g, " ") : "Updated";
}

function groupFleetItemsByAvailabilityDate(items) {
  const dateGroups = new Map();

  for (const item of items || []) {
    const dateKey = getAvailabilityDateKey(item.nextAvailableDate);

    if (!dateGroups.has(dateKey)) {
      dateGroups.set(dateKey, {
        key: dateKey,
        label: getAvailabilityDateLabel(item.nextAvailableDate),
        nextAvailableDate: item.nextAvailableDate,
        vehicles: new Map(),
      });
    }

    const dateGroup = dateGroups.get(dateKey);
    const vehicleKey =
      item.vehicleVin || item.vehicleId || item.vehicleNickname || "unknown";

    if (!dateGroup.vehicles.has(vehicleKey)) {
      dateGroup.vehicles.set(vehicleKey, {
        key: vehicleKey,
        label: item.vehicleNickname || "Unknown vehicle",
        availability: item.nextOffTrip || "Available now",
        nextAvailableDate: item.nextAvailableDate,
        items: [],
      });
    }

    dateGroup.vehicles.get(vehicleKey).items.push(item);
  }

  return Array.from(dateGroups.values())
    .sort((a, b) => {
      const dateDiff =
        getAvailabilitySortValue(a.nextAvailableDate) -
        getAvailabilitySortValue(b.nextAvailableDate);
      if (dateDiff !== 0) return dateDiff;
      return String(a.label).localeCompare(String(b.label));
    })
    .map((dateGroup) => ({
      ...dateGroup,
      vehicles: Array.from(dateGroup.vehicles.values())
        .sort((a, b) => {
          const dateDiff =
            getAvailabilitySortValue(a.nextAvailableDate) -
            getAvailabilitySortValue(b.nextAvailableDate);
          if (dateDiff !== 0) return dateDiff;
          return String(a.label).localeCompare(String(b.label));
        })
        .map((vehicleGroup) => ({
          ...vehicleGroup,
          items: [...vehicleGroup.items].sort((a, b) => {
            const scoreDiff = getPlanningScore(b) - getPlanningScore(a);
            if (scoreDiff !== 0) return scoreDiff;
            return String(a.title || "").localeCompare(String(b.title || ""));
          }),
        })),
    }));
}

function buildFleetQueueItems(vehicleCard, summary, historyMap = {}) {
  const baseItems = buildQueueItemsFromSummary(summary, historyMap);

  return baseItems.map((item) => ({
    ...item,
    id: `fleet-${vehicleCard.vin}-${item.id}`,
    vehicleId: vehicleCard.id,
    vehicleVin: vehicleCard.vin,
    vehicleNickname: vehicleCard.nickname,
    vehicleLabel: `${vehicleCard.nickname} • ${vehicleCard.year} ${vehicleCard.make} ${vehicleCard.model}`,
    currentOdometerMiles:
      summary?.currentOdometerMiles ?? vehicleCard.currentOdometerMiles,
    currentOdometerSource:
      summary?.currentOdometerSource ?? vehicleCard.currentOdometerSource ?? null,
    nextAvailableDate: vehicleCard.nextAvailableDate,
    nextOffTrip: vehicleCard.nextOffTrip,
  }));
}

export default function MaintenanceQueuePanel({
  selectedVehicleId,
  onShowAllVehicles,
}) {
  const [fleetVehicles, setFleetVehicles] = useState([]);
  const [maintenanceSummary, setMaintenanceSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingInspection, setSavingInspection] = useState(false);
  const [fleetPlanningItems, setFleetPlanningItems] = useState([]);
  const [fleetPlanningLoading, setFleetPlanningLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [selectedInspectionItem, setSelectedInspectionItem] = useState(null);
  const [inspectionDrawerOpen, setInspectionDrawerOpen] = useState(false);
  const [drawerVehicle, setDrawerVehicle] = useState(null);

  const selectedFleetVehicle = useMemo(() => {
    return findFleetVehicleBySelectedId(fleetVehicles, selectedVehicleId);
  }, [fleetVehicles, selectedVehicleId]);

  const historyMap = useMemo(() => {
    return buildInspectionHistoryMap(maintenanceSummary);
  }, [maintenanceSummary]);

  const inspectionItems = useMemo(() => {
    const rules = Array.isArray(maintenanceSummary?.ruleStatuses)
      ? maintenanceSummary.ruleStatuses
      : [];

    return rules.map((rule) => mapRuleStatusToInspectionItem(rule, historyMap));
  }, [maintenanceSummary, historyMap]);

  const queueItems = useMemo(() => {
    return sortQueue(buildQueueItemsFromSummary(maintenanceSummary, historyMap));
  }, [maintenanceSummary, historyMap]);

  const taskHistory = useMemo(() => {
    return Array.isArray(maintenanceSummary?.taskHistory)
      ? maintenanceSummary.taskHistory
      : [];
  }, [maintenanceSummary]);

  const fleetPlanningGroups = useMemo(
    () => groupFleetItemsByAvailabilityDate(fleetPlanningItems),
    [fleetPlanningItems]
  );

  useEffect(() => {
    function handleMaintenanceTasksUpdated() {
      setRefreshNonce((value) => value + 1);
    }

    window.addEventListener(
      MAINTENANCE_TASKS_UPDATED_EVENT,
      handleMaintenanceTasksUpdated
    );

    return () => {
      window.removeEventListener(
        MAINTENANCE_TASKS_UPDATED_EVENT,
        handleMaintenanceTasksUpdated
      );
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadFleetVehicles() {
      try {
        const res = await fetch("/api/vehicles");
        if (!res.ok) throw new Error(`Vehicle list HTTP ${res.status}`);

        const vehicles = await res.json();

        if (!cancelled) {
          setFleetVehicles(Array.isArray(vehicles) ? vehicles : []);
        }

        fetch("/api/vehicles/cached-status")
          .then((cachedRes) => (cachedRes.ok ? cachedRes.json() : []))
          .then((cachedVehicles) => {
            if (cancelled || !Array.isArray(cachedVehicles)) return;

            const cachedByVin = new Map(
              cachedVehicles
                .filter((vehicle) => vehicle?.vin)
                .map((vehicle) => [String(vehicle.vin).toLowerCase(), vehicle])
            );

            setFleetVehicles((current) =>
              (current || []).map((vehicle) => {
                const cached = cachedByVin.get(String(vehicle?.vin || "").toLowerCase());
                return cached ? { ...vehicle, ...cached } : vehicle;
              })
            );
          })
          .catch((err) => {
            console.warn("Cached fleet telemetry enrichment failed:", err);
          });
      } catch (err) {
        console.error("Failed to load fleet vehicles for queue panel:", err);
        if (!cancelled) setFleetVehicles([]);
      }
    }

    loadFleetVehicles();

    return () => {
      cancelled = true;
    };
  }, []);

  async function loadSummaryForSelectedVehicle(vin) {
    if (!vin) {
      setMaintenanceSummary(null);
      return;
    }

    const res = await fetch(
      `/api/vehicles/${encodeURIComponent(vin)}/maintenance-summary`
    );

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new Error(errorBody?.error || `HTTP ${res.status}`);
    }

    const summary = await res.json();
    setMaintenanceSummary(summary);
  }

  useEffect(() => {
    let cancelled = false;

    async function loadFleetPlanningQueue() {
      if (selectedVehicleId) {
        if (!cancelled) {
          setFleetPlanningItems([]);
          setFleetPlanningLoading(false);
        }
        return;
      }

      try {
        if (!cancelled) setFleetPlanningLoading(true);

        const vehicleRes = await fetch("/api/vehicles");
        if (!vehicleRes.ok) throw new Error(`Vehicle list HTTP ${vehicleRes.status}`);

        const vehicleData = await vehicleRes.json();
        const vehicles = Array.isArray(vehicleData) ? vehicleData : [];

        const tripsRes = await fetch("/api/trips?scope=open");
        const tripData = tripsRes.ok ? await tripsRes.json() : [];
        const relevantTrips = Array.isArray(tripData) ? tripData : [];

        if (!tripsRes.ok) {
          console.warn(`Open trip list HTTP ${tripsRes.status}`);
        }

        const liveFleet = vehicles
          .map((vehicle) => {
            const trips = relevantTrips.filter((trip) =>
              tripMatchesVehicle(vehicle, trip)
            );

            return {
            id: normalizeVehicleKey(vehicle.nickname || vehicle.vin || vehicle.id),
            vin: vehicle.vin || null,
            nickname: vehicle.nickname || "Unknown",
            year: vehicle.year || "—",
            make: vehicle.make || "",
            model: vehicle.model || "",
            currentOdometerMiles:
              vehicle.current_odometer_miles ?? vehicle.currentOdometerMiles ?? null,
            currentOdometerSource:
              vehicle.current_odometer_miles != null || vehicle.currentOdometerMiles != null
                ? "vehicle"
                : null,
            nextOffTrip: getEarliestAvailableLabel(trips),
            nextAvailableDate: getEarliestAvailableDate(trips),
            };
          })
          .filter((v) => v.vin);

        if (!cancelled) {
          setFleetPlanningItems([]);
        }

        await Promise.all(
          liveFleet.map(async (vehicleCard) => {
            try {
              const summaryRes = await fetch(
                `/api/vehicles/${encodeURIComponent(
                  vehicleCard.vin
                )}/maintenance-summary?refreshOdometer=0`
              );

              if (!summaryRes.ok) {
                throw new Error(`Maintenance summary HTTP ${summaryRes.status}`);
              }

              const summary = await summaryRes.json();
              const summaryHistoryMap = buildInspectionHistoryMap(summary);
              const items = buildFleetQueueItems(
                vehicleCard,
                summary,
                summaryHistoryMap
              );

              if (!cancelled) {
                setFleetPlanningItems((current) =>
                  sortFleetPlanningQueue([
                    ...current.filter((item) => item.vehicleVin !== vehicleCard.vin),
                    ...items,
                  ])
                );
              }
            } catch (err) {
              console.error(
                `Failed to load maintenance summary for ${vehicleCard.nickname}:`,
                err
              );
            }
          })
        );
      } catch (err) {
        console.error("Failed to load fleet-wide maintenance planning queue:", err);
        if (!cancelled) setFleetPlanningItems([]);
      } finally {
        if (!cancelled) setFleetPlanningLoading(false);
      }
    }

    async function run() {
      if (!selectedFleetVehicle?.vin) {
        if (!cancelled) setMaintenanceSummary(null);
        return;
      }

      try {
        if (!cancelled) setLoading(true);
        await loadSummaryForSelectedVehicle(selectedFleetVehicle.vin);
      } catch (err) {
        console.error("Failed to load maintenance queue summary:", err);
        if (!cancelled) setMaintenanceSummary(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    loadFleetPlanningQueue();

    return () => {
      cancelled = true;
    };
  }, [selectedFleetVehicle?.vin, selectedVehicleId, refreshNonce]);

  function handleOpenInspectionItemFromRuleCode(ruleCode) {
    const match = inspectionItems.find((item) => item.ruleCode === ruleCode);

    if (!match) {
      window.alert(`No inspection card found for rule ${ruleCode}.`);
      return;
    }

    setSelectedInspectionItem(match);
    setDrawerVehicle({
      nickname: selectedFleetVehicle?.nickname || "Unknown vehicle",
      year: selectedFleetVehicle?.year || "—",
      make: selectedFleetVehicle?.make || "",
      model: selectedFleetVehicle?.model || "",
      vin: selectedFleetVehicle?.vin || null,
      currentOdometerMiles:
        maintenanceSummary?.currentOdometerMiles ??
        selectedFleetVehicle?.telemetry?.odometer ??
        null,
      currentOdometerSource:
        maintenanceSummary?.currentOdometerSource ??
        (selectedFleetVehicle?.telemetry?.odometer != null ? "telemetry" : null),
      exteriorAirTempF:
        selectedFleetVehicle?.telemetry?.environment?.exterior_air_temp ??
        null,
    });
    setInspectionDrawerOpen(true);
  }

  async function handleOpenFleetInspectionItem(item) {
    if (!item?.vehicleVin || !item?.linkedRuleCode) {
      window.alert("This maintenance item is not linked to a specific inspection rule.");
      return;
    }

    try {
      const res = await fetch(
        `/api/vehicles/${encodeURIComponent(
          item.vehicleVin
        )}/maintenance-summary`
      );

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error(errorBody?.error || `HTTP ${res.status}`);
      }

      const summary = await res.json();
      const summaryHistoryMap = buildInspectionHistoryMap(summary);

      const rule = (Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : []).find(
        (r) => String(r?.ruleCode || "") === String(item.linkedRuleCode || "")
      );

      if (!rule) {
        throw new Error(`No inspection rule found for ${item.linkedRuleCode}.`);
      }

      const mappedItem = mapRuleStatusToInspectionItem(rule, summaryHistoryMap);

      setSelectedInspectionItem({
        ...mappedItem,
        id: item.id,
      });
      setDrawerVehicle({
        nickname: summary?.vehicle?.nickname || item.vehicleNickname || "Unknown vehicle",
        year: summary?.vehicle?.year || "—",
        make: summary?.vehicle?.make || "",
        model: summary?.vehicle?.model || "",
        vin: summary?.vehicle?.vin || item.vehicleVin,
        currentOdometerMiles:
          summary?.currentOdometerMiles ??
          summary?.vehicle?.currentOdometerMiles ??
          null,
        currentOdometerSource:
          summary?.currentOdometerSource ??
          summary?.vehicle?.currentOdometerSource ??
          null,
        exteriorAirTempF: null,
      });
      setInspectionDrawerOpen(true);
    } catch (err) {
      console.error("Failed to open fleet inspection item:", err);
      window.alert(err.message || "Could not open maintenance item.");
    }
  }

  async function handleResolveTask(item) {
    const taskId = item?.task?.id;
    if (!taskId) {
      window.alert("This queue item is not linked to a maintenance task.");
      return;
    }

    const taskTitle = item?.title || item?.task?.title || "this maintenance task";
    const vehicleLabel =
      item?.vehicleNickname || selectedFleetVehicle?.nickname || "this vehicle";
    const confirmed = window.confirm(
      `Mark "${taskTitle}" done for ${vehicleLabel}?`
    );

    if (!confirmed) return;

    try {
      const res = await fetch(`/api/maintenance-tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "resolved",
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      if (selectedVehicleId && selectedFleetVehicle?.vin) {
        await loadSummaryForSelectedVehicle(selectedFleetVehicle.vin);
      } else {
        setFleetPlanningItems((prev) =>
          prev.filter((entry) => entry.task?.id !== taskId)
        );
      }

      notifyMaintenanceTasksUpdated({
        task: body?.task || null,
        taskId,
        source: "maintenance_queue_resolve",
      });
    } catch (err) {
      console.error("Failed to resolve maintenance task:", err);
      window.alert(err.message || "Could not mark task done.");
    }
  }

  async function handleReopenTask(task) {
    const taskId = task?.id;
    if (!taskId) return;

    const confirmed = window.confirm(
      `Reopen "${task.title || "this maintenance task"}"?`
    );

    if (!confirmed) return;

    try {
      const res = await fetch(`/api/maintenance-tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "open",
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      if (selectedFleetVehicle?.vin) {
        await loadSummaryForSelectedVehicle(selectedFleetVehicle.vin);
      }

      notifyMaintenanceTasksUpdated({
        task: body?.task || null,
        taskId,
        source: "maintenance_queue_reopen",
      });
    } catch (err) {
      console.error("Failed to reopen maintenance task:", err);
      window.alert(err.message || "Could not reopen task.");
    }
  }

  function handleCloseInspectionDrawer() {
    if (savingInspection) return;
    setInspectionDrawerOpen(false);
    setSelectedInspectionItem(null);
    setDrawerVehicle(null);
  }

  async function handleSaveInspectionItem(payload) {
    try {
      const targetVin = drawerVehicle?.vin || selectedFleetVehicle?.vin;

      if (!targetVin) {
        throw new Error("Selected vehicle is not available in the live fleet feed.");
      }

      setSavingInspection(true);

      const saveRes = await fetch(
        `/api/vehicles/${encodeURIComponent(
          targetVin
        )}/maintenance-events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ruleId: payload.ruleId,
            ruleCode: payload.ruleCode,
            performedAt: payload.performedAt,
            odometerMiles: payload.odometerMiles,
            result: payload.result,
            notes: payload.notes,
            data: payload.data,
            performedBy: payload.performedBy,
            source: payload.source,
          }),
        }
      );

      if (!saveRes.ok) {
        const errorBody = await saveRes.json().catch(() => null);
        throw new Error(errorBody?.error || `Save failed: HTTP ${saveRes.status}`);
      }

      await saveRes.json();

      if (selectedFleetVehicle?.vin && targetVin === selectedFleetVehicle.vin) {
        await loadSummaryForSelectedVehicle(selectedFleetVehicle.vin);
      }

      if (!selectedVehicleId && selectedInspectionItem?.id) {
        setFleetPlanningItems((prev) =>
          prev.filter((entry) => entry.id !== selectedInspectionItem.id)
        );
      }

      handleCloseInspectionDrawer();
    } catch (err) {
      console.error("Failed to save inspection item from queue:", err);
      window.alert(err.message || "Could not save inspection item.");
    } finally {
      setSavingInspection(false);
    }
  }

  const openItemCount = selectedVehicleId
    ? queueItems.length
    : fleetPlanningItems.length;
  const selectedVehicleLabel =
    selectedFleetVehicle?.nickname ||
    (selectedVehicleId
      ? String(selectedVehicleId)
          .replace(/_/g, " ")
          .replace(/\b\w/g, (match) => match.toUpperCase())
      : "All vehicles");

  return (
    <aside className="panel detail-panel maintenance-queue-panel">
      <div className="panel-header maintenance-queue-panel-header">
        <div>
          <h2>Maintenance Queue</h2>
          {selectedVehicleId ? (
            <div className="maintenance-queue-scope">
              <span>
                Selected vehicle: <strong>{selectedVehicleLabel}</strong>
              </span>
              <button
                type="button"
                className="maintenance-queue-scope-action"
                onClick={onShowAllVehicles}
              >
                ✓ Show all vehicles
              </button>
            </div>
          ) : (
            <div className="maintenance-queue-scope maintenance-queue-scope--all">
              <span>Showing all vehicles</span>
            </div>
          )}
        </div>
        <span>{openItemCount} open items</span>
      </div>

      <div className="detail-body">
        {!selectedVehicleId ? (
          fleetPlanningLoading && fleetPlanningItems.length === 0 ? (
            <div className="detail-card">
              <div className="detail-label">Fleet planning</div>
              <div className="detail-value">Loading fleet maintenance queue…</div>
            </div>
          ) : fleetPlanningItems.length === 0 ? (
            <div className="detail-card">
              <div className="detail-label">Fleet planning</div>
              <div className="detail-value">No open maintenance items across the fleet.</div>
            </div>
          ) : (
            <div className="maintenance-queue-date-list">
              {fleetPlanningGroups.map((dateGroup) => (
                <section key={dateGroup.key} className="maintenance-queue-date-group">
                  <div className="maintenance-queue-date-title">{dateGroup.label}</div>
                  {dateGroup.vehicles.map((vehicleGroup) => (
                    <div key={vehicleGroup.key} className="maintenance-queue-vehicle-group">
                      <div className="maintenance-queue-vehicle-title">
                        <span>{vehicleGroup.label}</span>
                        <small>{vehicleGroup.availability || "Available now"}</small>
                      </div>
                      <ul className="maintenance-queue-task-list">
                        {vehicleGroup.items.map((item) => (
                          <li key={item.id} className="maintenance-queue-task">
                            {item.linkedRuleCode ? (
                              <button
                                type="button"
                                className="maintenance-queue-task-button"
                                onClick={() => handleOpenFleetInspectionItem(item)}
                              >
                                <span>{item.title}</span>
                                <small>
                                  {getNextIntervalDueText(
                                    item,
                                    item.currentOdometerMiles
                                  )}
                                </small>
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="maintenance-queue-task-button"
                                onClick={() => handleResolveTask(item)}
                              >
                                <span>{item.title}</span>
                                <small>Mark done</small>
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )
        ) : loading ? (
          <div className="detail-card">
            <div className="detail-label">Queue</div>
            <div className="detail-value">Loading queue…</div>
          </div>
        ) : queueItems.length === 0 ? (
          <div className="detail-card">
            <div className="detail-label">Queue</div>
            <div className="detail-value">No open issues</div>
          </div>
        ) : (
          <div className="maintenance-queue-list">
            <div className="maintenance-queue-vehicle-group">
              <div className="maintenance-queue-vehicle-title">
                {selectedFleetVehicle?.nickname || "Selected vehicle"}
              </div>
            </div>
            {queueItems.map((item) => (
              <div key={item.id} className="maintenance-queue-card maintenance-queue-card--compact">
                {item.linkedRuleCode ? (
                  <button
                    type="button"
                    className="maintenance-queue-task-button"
                    onClick={() =>
                      handleOpenInspectionItemFromRuleCode(item.linkedRuleCode)
                    }
                  >
                    <span>{item.title}</span>
                    <small>
                      {selectedFleetVehicle?.nickname || "Selected vehicle"} ·{" "}
                      {getNextIntervalDueText(
                        item,
                        maintenanceSummary?.currentOdometerMiles ??
                          selectedFleetVehicle?.current_odometer_miles ??
                          selectedFleetVehicle?.currentOdometerMiles ??
                          null
                      )}
                    </small>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="maintenance-queue-task-button"
                    onClick={() => handleResolveTask(item)}
                  >
                    <span>{item.title}</span>
                    <small>
                      {selectedFleetVehicle?.nickname || "Selected vehicle"} - Mark done
                    </small>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {selectedVehicleId && !loading ? (
          <section className="maintenance-task-history">
            <div className="maintenance-task-history-head">
              <span>Maintenance history</span>
              <small>{taskHistory.length} recent</small>
            </div>
            {taskHistory.length === 0 ? (
              <div className="maintenance-task-history-empty">
                No completed to-dos yet.
              </div>
            ) : (
              <div className="maintenance-task-history-list">
                {taskHistory.map((task) => (
                  <div key={task.id} className="maintenance-task-history-item">
                    <div className="maintenance-task-history-main">
                      <strong>{task.title || "Maintenance task"}</strong>
                      <span>
                        {getTaskHistoryStatusLabel(task.status)} -{" "}
                        {formatTaskHistoryDate(task.updated_at || task.updatedAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="maintenance-task-history-action"
                      onClick={() => handleReopenTask(task)}
                    >
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
      </div>

      <InspectionItemDrawer
        open={inspectionDrawerOpen}
        item={selectedInspectionItem}
        vehicle={drawerVehicle}
        onClose={handleCloseInspectionDrawer}
        onSave={handleSaveInspectionItem}
        saving={savingInspection}
      />
    </aside>
  );
}


