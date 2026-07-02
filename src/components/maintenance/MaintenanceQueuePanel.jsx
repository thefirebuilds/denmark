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
  getActiveTrip,
  getNextUpcomingTrip,
  getReadyForHandoffTrip,
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

function getVehicleNameKeys(vehicle) {
  return [vehicle?.nickname, vehicle?.turo_vehicle_name, vehicle?.vehicle_name]
    .concat(Array.isArray(vehicle?.aliases) ? vehicle.aliases : [])
    .map(normalizeMatchValue)
    .filter(Boolean);
}

function tripMatchesVehicle(vehicle, trip) {
  const vehicleTuroId = normalizeMatchValue(
    vehicle?.turo_vehicle_id ?? vehicle?.turoVehicleId
  );
  const tripTuroId = normalizeMatchValue(trip?.turo_vehicle_id);
  if (vehicleTuroId && tripTuroId) {
    return vehicleTuroId === tripTuroId;
  }

  const vehicleVin = normalizeMatchValue(vehicle?.vin);
  const tripVin = normalizeMatchValue(trip?.vehicle_vin ?? trip?.vehicleVin);
  if (vehicleVin && tripVin) {
    return vehicleVin === tripVin;
  }

  const vehicleNames = getVehicleNameKeys(vehicle);
  if (!vehicleNames.length) return false;

  const tripNames = [trip?.vehicle_nickname, trip?.vehicle_name]
    .map(normalizeMatchValue)
    .filter(Boolean);

  return tripNames.some((tripName) => vehicleNames.includes(tripName));
}

function sortFleetPlanningQueue(items) {
  return [...items].sort((a, b) => {
    const aDate = new Date(a.nextAvailableDate || 0).getTime();
    const bDate = new Date(b.nextAvailableDate || 0).getTime();
    if (aDate !== bDate) return aDate - bDate;

    const aPlanningDate = getPlanningSortValue(a.nextPlanningDate);
    const bPlanningDate = getPlanningSortValue(b.nextPlanningDate);
    if (aPlanningDate !== bPlanningDate) return aPlanningDate - bPlanningDate;

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

function getPlanningSortValue(value) {
  if (!value) return Number.POSITIVE_INFINITY;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  if (date.getFullYear() >= 9000) return Number.NEGATIVE_INFINITY;
  return date.getTime();
}

function getQueueItemLaborHours(item) {
  const value =
    item?.task?.actual_labor_hours ??
    item?.task?.actualLaborHours ??
    item?.task?.estimated_labor_hours ??
    item?.task?.estimatedLaborHours ??
    item?.actual_labor_hours ??
    item?.actualLaborHours ??
    item?.estimated_labor_hours ??
    item?.estimatedLaborHours;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function getVehiclePlanningDate(trips, nextAvailableDate) {
  const activeTrip = getActiveTrip(trips);
  if (activeTrip?.trip_end) return activeTrip.trip_end;

  const nextUpcomingTrip = getNextUpcomingTrip(trips);
  if (nextUpcomingTrip?.trip_start) return nextUpcomingTrip.trip_start;

  return nextAvailableDate || null;
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

function formatQueueTaskDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanizeQueueValue(value) {
  return String(value || "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getQueueItemKey(item) {
  return String(item?.id || item?.task?.id || item?.linkedRuleCode || "");
}

function getQueueItemTaskId(item) {
  const taskId = Number(item?.task?.id);
  return Number.isInteger(taskId) && taskId > 0 ? taskId : null;
}

function getQueueItemTaskStatus(item) {
  return humanizeQueueValue(item?.task?.status || item?.status || item?.ruleStatus || "open");
}

function formatLaborHours(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return "Not set";
  if (num === 1) return "1 hr";
  return `${num.toFixed(num < 1 ? 2 : 1).replace(/\.0$/, "")} hrs`;
}

function getQueueItemNotes(item) {
  const task = item?.task || {};
  const context = task.trigger_context || {};

  return [
    task.description,
    item?.notes,
    context.notes,
    context.note,
    context.reportedBy ? `Reported by ${context.reportedBy}` : null,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function getQueueItemBlockers(item) {
  const blockers = [];

  if (item?.blocksRentalWhenOverdue || item?.task?.blocks_rental) {
    blockers.push("Blocks rentals");
  }

  if (item?.blocksGuestExportWhenOverdue || item?.task?.blocks_guest_export) {
    blockers.push("Blocks guest export");
  }

  return blockers;
}

function getQueueItemRelatedItems(item) {
  return Array.isArray(item?.mergedItems) && item.mergedItems.length > 1
    ? item.mergedItems
    : [];
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
        nextPlanningDate: item.nextPlanningDate,
        items: [],
      });
    }

    const vehicleGroup = dateGroup.vehicles.get(vehicleKey);
    if (
      getPlanningSortValue(item.nextPlanningDate) <
      getPlanningSortValue(vehicleGroup.nextPlanningDate)
    ) {
      vehicleGroup.nextPlanningDate = item.nextPlanningDate;
    }
    vehicleGroup.items.push(item);
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

          const planningDateDiff =
            getPlanningSortValue(a.nextPlanningDate) -
            getPlanningSortValue(b.nextPlanningDate);
          if (planningDateDiff !== 0) return planningDateDiff;

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
  if (vehicleCard.readyForHandoff) return [];

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
    nextPlanningDate: vehicleCard.nextPlanningDate,
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
  const [expandedQueueItems, setExpandedQueueItems] = useState(() => new Set());
  const [reassigningTaskId, setReassigningTaskId] = useState(null);
  const [reassignVehicleVin, setReassignVehicleVin] = useState("");
  const [updatingTaskId, setUpdatingTaskId] = useState(null);

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

  const vehicleOptions = useMemo(() => {
    return (fleetVehicles || [])
      .filter((vehicle) => vehicle?.vin)
      .map((vehicle) => ({
        vin: vehicle.vin,
        label:
          vehicle.nickname ||
          [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") ||
          vehicle.vin,
      }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }, [fleetVehicles]);

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

            const nextAvailableDate = getEarliestAvailableDate(trips);
            const readyForHandoff = Boolean(getReadyForHandoffTrip(trips));

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
              nextAvailableDate,
              nextPlanningDate: getVehiclePlanningDate(trips, nextAvailableDate),
              readyForHandoff,
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

  function toggleQueueItem(item) {
    const key = getQueueItemKey(item);
    if (!key) return;

    setExpandedQueueItems((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleStartReassignTask(item) {
    const taskId = getQueueItemTaskId(item);
    if (!taskId) return;

    setReassigningTaskId(taskId);
    setReassignVehicleVin(
      item?.task?.vehicle_vin ||
        item?.vehicleVin ||
        selectedFleetVehicle?.vin ||
        ""
    );
  }

  function handleCancelReassignTask() {
    setReassigningTaskId(null);
    setReassignVehicleVin("");
  }

  async function handleReassignTask(item) {
    const taskId = getQueueItemTaskId(item);
    const targetVin = String(reassignVehicleVin || "").trim();

    if (!taskId || !targetVin) {
      window.alert("Choose a vehicle before reassigning this task.");
      return;
    }

    try {
      setUpdatingTaskId(taskId);

      const res = await fetch(`/api/maintenance-tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          vehicle_vin: targetVin,
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      handleCancelReassignTask();

      if (selectedVehicleId && selectedFleetVehicle?.vin) {
        await loadSummaryForSelectedVehicle(selectedFleetVehicle.vin);
      } else {
        setRefreshNonce((value) => value + 1);
      }

      notifyMaintenanceTasksUpdated({
        task: body?.task || null,
        taskId,
        source: "maintenance_queue_reassign",
      });
    } catch (err) {
      console.error("Failed to reassign maintenance task:", err);
      window.alert(err.message || "Could not reassign task.");
    } finally {
      setUpdatingTaskId(null);
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

    const defaultHours = getQueueItemLaborHours(item);
    const enteredHours = window.prompt(
      `Actual labor hours for "${taskTitle}"?`,
      defaultHours == null ? "" : String(defaultHours)
    );

    if (enteredHours === null) return;

    const trimmedHours = String(enteredHours || "").trim();
    const actualLaborHours = trimmedHours === "" ? null : Number(trimmedHours);

    if (
      actualLaborHours != null &&
      (!Number.isFinite(actualLaborHours) || actualLaborHours < 0)
    ) {
      window.alert("Enter labor hours as a positive number, or leave it blank.");
      return;
    }

    try {
      setUpdatingTaskId(taskId);

      const res = await fetch(`/api/maintenance-tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: "resolved",
          actualLaborHours,
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
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handleDeleteTask(item) {
    const taskId = getQueueItemTaskId(item);
    if (!taskId) {
      window.alert("This queue item is not linked to a maintenance task.");
      return;
    }

    const taskTitle = item?.title || item?.task?.title || "this maintenance task";
    const vehicleLabel =
      item?.vehicleNickname || selectedFleetVehicle?.nickname || "this vehicle";
    const confirmed = window.confirm(
      `Delete "${taskTitle}" from ${vehicleLabel}? This removes the to-do entirely.`
    );

    if (!confirmed) return;

    try {
      setUpdatingTaskId(taskId);

      const res = await fetch(`/api/maintenance-tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      setExpandedQueueItems((current) => {
        const next = new Set(current);
        next.delete(getQueueItemKey(item));
        return next;
      });

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
        source: "maintenance_queue_delete",
      });
    } catch (err) {
      console.error("Failed to delete maintenance task:", err);
      window.alert(err.message || "Could not delete task.");
    } finally {
      setUpdatingTaskId(null);
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

  function renderQueueItemDetails(item, options = {}) {
    const taskId = getQueueItemTaskId(item);
    const task = item?.task || {};
    const blockers = getQueueItemBlockers(item);
    const notes = getQueueItemNotes(item);
    const relatedItems = getQueueItemRelatedItems(item);
    const createdAt = formatQueueTaskDate(task.created_at || task.createdAt);
    const updatedAt = formatQueueTaskDate(task.updated_at || task.updatedAt);
    const estimatedLabor = getQueueItemLaborHours({
      ...item,
      task: {
        ...task,
        actual_labor_hours: null,
      },
    });
    const actualLabor =
      task.actual_labor_hours ?? task.actualLaborHours ?? item?.actual_labor_hours;
    const triggerContext = task.trigger_context || {};
    const canReassign = Boolean(taskId && vehicleOptions.length);
    const isReassigning = taskId && reassigningTaskId === taskId;
    const isUpdating = taskId && updatingTaskId === taskId;
    const currentVin =
      task.vehicle_vin ||
      item?.vehicleVin ||
      selectedFleetVehicle?.vin ||
      "";

    return (
      <div className="maintenance-queue-task-details">
        <div className="maintenance-queue-task-chip-row">
          <span className="maintenance-queue-task-chip">
            {getQueueItemTaskStatus(item)}
          </span>
          <span className="maintenance-queue-task-chip">
            {humanizeQueueValue(item?.priority || task.priority || "medium")}
          </span>
          <span className="maintenance-queue-task-chip">
            {humanizeQueueValue(task.source || item?.source || "maintenance")}
          </span>
        </div>

        <div className="maintenance-queue-task-detail-grid">
          <div>
            <span>Type</span>
            <strong>{humanizeQueueValue(task.task_type || item?.type || "maintenance")}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>{createdAt || "Unknown"}</strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>{updatedAt || "No updates"}</strong>
          </div>
          <div>
            <span>Blockers</span>
            <strong>{blockers.length ? blockers.join(", ") : "None"}</strong>
          </div>
          <div>
            <span>Labor</span>
            <strong>
              {actualLabor == null
                ? `Est. ${formatLaborHours(estimatedLabor)}`
                : `${formatLaborHours(actualLabor)} actual`}
            </strong>
          </div>
        </div>

        {notes.length ? (
          <div className="maintenance-queue-task-notes">
            {notes.map((note, index) => (
              <p key={`${getQueueItemKey(item)}-note-${index}`}>{note}</p>
            ))}
          </div>
        ) : (
          <div className="maintenance-queue-task-empty">No notes on this task yet.</div>
        )}

        {triggerContext.createdFrom || triggerContext.noteSource ? (
          <div className="maintenance-queue-task-context">
            {[triggerContext.createdFrom, triggerContext.noteSource]
              .filter(Boolean)
              .map(humanizeQueueValue)
              .join(" - ")}
          </div>
        ) : null}

        {relatedItems.length ? (
          <div className="maintenance-queue-related">
            <span>Consolidated items</span>
            <ul>
              {relatedItems.map((related, index) => (
                <li key={`${getQueueItemKey(item)}-related-${index}`}>
                  {related.title || related.task?.title || "Maintenance item"}
                  {related.task?.status ? ` - ${humanizeQueueValue(related.task.status)}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {isReassigning ? (
          <div className="maintenance-queue-reassign">
            <label>
              <span>Move to vehicle</span>
              <select
                value={reassignVehicleVin}
                onChange={(event) => setReassignVehicleVin(event.target.value)}
                disabled={isUpdating}
              >
                <option value="">Choose vehicle</option>
                {vehicleOptions.map((vehicle) => (
                  <option key={vehicle.vin} value={vehicle.vin}>
                    {vehicle.label}
                    {vehicle.vin === currentVin ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="maintenance-queue-task-actions">
              <button
                type="button"
                className="maintenance-queue-action maintenance-queue-action--primary"
                onClick={() => handleReassignTask(item)}
                disabled={isUpdating || !reassignVehicleVin}
              >
                Save move
              </button>
              <button
                type="button"
                className="maintenance-queue-action"
                onClick={handleCancelReassignTask}
                disabled={isUpdating}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="maintenance-queue-task-actions">
            {item.linkedRuleCode ? (
              <button
                type="button"
                className="maintenance-queue-action"
                onClick={() =>
                  options.fleet
                    ? handleOpenFleetInspectionItem(item)
                    : handleOpenInspectionItemFromRuleCode(item.linkedRuleCode)
                }
              >
                Open inspection
              </button>
            ) : null}
            {taskId ? (
              <>
                <button
                  type="button"
                  className="maintenance-queue-action maintenance-queue-action--primary"
                  onClick={() => handleResolveTask(item)}
                  disabled={isUpdating}
                >
                  {isUpdating ? "Closing..." : "Close task"}
                </button>
                <button
                  type="button"
                  className="maintenance-queue-action"
                  onClick={() => handleStartReassignTask(item)}
                  disabled={!canReassign || isUpdating}
                >
                  Reassign
                </button>
                <button
                  type="button"
                  className="maintenance-queue-action maintenance-queue-action--danger"
                  onClick={() => handleDeleteTask(item)}
                  disabled={isUpdating}
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  function renderQueueItemButton(item, options = {}) {
    const key = getQueueItemKey(item);
    const expanded = expandedQueueItems.has(key);
    const currentMiles =
      options.currentOdometerMiles ??
      item.currentOdometerMiles ??
      maintenanceSummary?.currentOdometerMiles ??
      selectedFleetVehicle?.current_odometer_miles ??
      selectedFleetVehicle?.currentOdometerMiles ??
      null;
    const subText = item.linkedRuleCode
      ? getNextIntervalDueText(item, currentMiles)
      : `${getQueueItemTaskStatus(item)} - View details`;

    return (
      <>
        <button
          type="button"
          className="maintenance-queue-task-button"
          onClick={() => toggleQueueItem(item)}
          aria-expanded={expanded}
        >
          <span>{item.title}</span>
          <small>
            {options.vehicleLabel ? `${options.vehicleLabel} - ` : ""}
            {subText}
          </small>
        </button>
        {expanded ? renderQueueItemDetails(item, options) : null}
      </>
    );
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
                            {renderQueueItemButton(item, {
                              fleet: true,
                              currentOdometerMiles: item.currentOdometerMiles,
                            })}
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
                    onClick={() => toggleQueueItem(item)}
                    aria-expanded={expandedQueueItems.has(getQueueItemKey(item))}
                  >
                    <span>{item.title}</span>
                    <small>
                      {selectedFleetVehicle?.nickname || "Selected vehicle"} - View details
                    </small>
                  </button>
                )}
                {expandedQueueItems.has(getQueueItemKey(item))
                  ? renderQueueItemDetails(item, {
                      vehicleLabel: selectedFleetVehicle?.nickname || "Selected vehicle",
                      currentOdometerMiles:
                        maintenanceSummary?.currentOdometerMiles ??
                        selectedFleetVehicle?.current_odometer_miles ??
                        selectedFleetVehicle?.currentOdometerMiles ??
                        null,
                    })
                  : null}
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


