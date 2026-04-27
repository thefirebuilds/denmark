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

function getPlanningScore(item) {
  const blocks =
    item?.blocksRentalWhenOverdue ||
    item?.blocksGuestExportWhenOverdue ||
    item?.task?.blocks_rental ||
    item?.task?.blocks_guest_export;

  return (blocks ? 100 : 0) + getPriorityScore(item?.priority);
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

function buildFleetQueueItems(vehicleCard, summary, historyMap = {}) {
  const baseItems = buildQueueItemsFromSummary(summary, historyMap);

  return baseItems.map((item) => ({
    ...item,
    id: `fleet-${vehicleCard.vin}-${item.id}`,
    vehicleId: vehicleCard.id,
    vehicleVin: vehicleCard.vin,
    vehicleNickname: vehicleCard.nickname,
    vehicleLabel: `${vehicleCard.nickname} • ${vehicleCard.year} ${vehicleCard.make} ${vehicleCard.model}`,
    currentOdometerMiles: vehicleCard.currentOdometerMiles,
    nextAvailableDate: vehicleCard.nextAvailableDate,
    nextOffTrip: vehicleCard.nextOffTrip,
  }));
}

export default function MaintenanceQueuePanel({ selectedVehicleId }) {
  const [fleetVehicles, setFleetVehicles] = useState([]);
  const [maintenanceSummary, setMaintenanceSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingInspection, setSavingInspection] = useState(false);
  const [fleetPlanningItems, setFleetPlanningItems] = useState([]);
  const [fleetPlanningLoading, setFleetPlanningLoading] = useState(false);

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

  useEffect(() => {
    let cancelled = false;

    async function loadFleetVehicles() {
      try {
        const res = await fetch("http://localhost:5000/api/vehicles/live-status");
        if (!res.ok) throw new Error(`Vehicle status HTTP ${res.status}`);

        const vehicles = await res.json();

        if (!cancelled) {
          setFleetVehicles(Array.isArray(vehicles) ? vehicles : []);
        }
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
      `http://localhost:5000/api/vehicles/${encodeURIComponent(vin)}/maintenance-summary`
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

        const vehicleRes = await fetch("http://localhost:5000/api/vehicles/live-status");
        if (!vehicleRes.ok) throw new Error(`Vehicle status HTTP ${vehicleRes.status}`);

        const vehicleData = await vehicleRes.json();
        const vehicles = Array.isArray(vehicleData) ? vehicleData : [];

        const vehicleTripPairs = await Promise.all(
          vehicles.map(async (vehicle) => {
            const vehicleId = normalizeVehicleKey(
              vehicle.nickname ||
                vehicle.vin ||
                vehicle.id ||
                vehicle.dimo_token_id ||
                vehicle.bouncie_vehicle_id
            );

            try {
              const tripsRes = await fetch(
                `http://localhost:5000/api/trips/vehicle/${vehicleId}?mode=relevant`
              );

              if (!tripsRes.ok) throw new Error(`Trip status HTTP ${tripsRes.status}`);

              const tripData = await tripsRes.json();

              return {
                vehicle,
                trips: Array.isArray(tripData) ? tripData : [],
              };
            } catch (err) {
              console.error(`Failed to load trips for ${vehicleId}:`, err);
              return { vehicle, trips: [] };
            }
          })
        );

        const liveFleet = vehicleTripPairs
          .map(({ vehicle, trips }) => ({
            id: normalizeVehicleKey(vehicle.nickname || vehicle.vin || vehicle.id),
            vin: vehicle.vin || null,
            nickname: vehicle.nickname || "Unknown",
            year: vehicle.year || "—",
            make: vehicle.make || "",
            model: vehicle.model || "",
            currentOdometerMiles:
              vehicle.current_odometer_miles ?? vehicle.currentOdometerMiles ?? null,
            nextOffTrip: getEarliestAvailableLabel(trips),
            nextAvailableDate: getEarliestAvailableDate(trips),
          }))
          .filter((v) => v.vin);

        const summaryResults = await Promise.all(
          liveFleet.map(async (vehicleCard) => {
            try {
              const summaryRes = await fetch(
                `http://localhost:5000/api/vehicles/${encodeURIComponent(
                  vehicleCard.vin
                )}/maintenance-summary`
              );

              if (!summaryRes.ok) {
                throw new Error(`Maintenance summary HTTP ${summaryRes.status}`);
              }

              const summary = await summaryRes.json();
              const summaryHistoryMap = buildInspectionHistoryMap(summary);

              return buildFleetQueueItems(vehicleCard, summary, summaryHistoryMap);
            } catch (err) {
              console.error(
                `Failed to load maintenance summary for ${vehicleCard.nickname}:`,
                err
              );
              return [];
            }
          })
        );

        const flattened = sortFleetPlanningQueue(summaryResults.flat());

        if (!cancelled) setFleetPlanningItems(flattened);
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
  }, [selectedFleetVehicle?.vin, selectedVehicleId]);

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
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
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
        exteriorAirTempF: null,
      });
      setInspectionDrawerOpen(true);
    } catch (err) {
      console.error("Failed to open fleet inspection item:", err);
      window.alert(err.message || "Could not open maintenance item.");
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
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
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

  return (
    <aside className="panel detail-panel maintenance-queue-panel">
      <div className="panel-header">
        <h2>Maintenance Queue</h2>
        <span>{openItemCount} open items</span>
      </div>

      <div className="detail-body">
        {!selectedVehicleId ? (
          fleetPlanningLoading ? (
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
            <div className="maintenance-queue-list">
              {fleetPlanningItems.map((item) => (
                <div key={item.id} className="maintenance-queue-card">
                  <div className="maintenance-queue-card-head">
                    <div className="maintenance-queue-title">{item.title}</div>
                    <div
                      className={`maintenance-priority priority-${getPriorityScore(
                        item.priority
                      )}`}
                    >
                      {String(item.priority || "normal").toUpperCase()}
                    </div>
                  </div>

                  <div className="maintenance-queue-type">{item.type}</div>

                  <div className="maintenance-queue-notes">
                    <strong>{item.vehicleLabel}</strong>
                  </div>

                  <div className="maintenance-queue-notes">
                    Available for maintenance: {item.nextOffTrip || "Unknown"}
                  </div>

                  <div className="maintenance-queue-notes">
                    {getNextIntervalDueText(item, item.currentOdometerMiles)}
                  </div>

                  {item.notes ? (
                    <div className="maintenance-queue-notes">{item.notes}</div>
                  ) : null}

                  {item.linkedRuleCode ? (
                    <div className="message-actions">
                      <button
                        type="button"
                        className="message-action"
                        onClick={() => handleOpenFleetInspectionItem(item)}
                      >
                        Enter result
                      </button>
                    </div>
                  ) : (
                    <div className="maintenance-queue-notes">
                      No inspection action is mapped for this task yet.
                    </div>
                  )}
                </div>
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
            {queueItems.map((item) => (
              <div key={item.id} className="maintenance-queue-card">
                <div className="maintenance-queue-card-head">
                  <div className="maintenance-queue-title">{item.title}</div>
                  <div
                    className={`maintenance-priority priority-${getPriorityScore(
                      item.priority
                    )}`}
                  >
                    {String(item.priority || "normal").toUpperCase()}
                  </div>
                </div>

                <div className="maintenance-queue-type">{item.type}</div>

                <div className="maintenance-queue-notes">
                  {getNextIntervalDueText(
                    item,
                    selectedFleetVehicle?.current_odometer_miles ??
                      selectedFleetVehicle?.currentOdometerMiles ??
                      null
                  )}
                </div>

                {item.notes ? (
                  <div className="maintenance-queue-notes">{item.notes}</div>
                ) : null}

                {item.linkedRuleCode ? (
                  <div className="message-actions">
                    <button
                      type="button"
                      className="message-action"
                      onClick={() =>
                        handleOpenInspectionItemFromRuleCode(item.linkedRuleCode)
                      }
                    >
                      Enter result
                    </button>
                  </div>
                ) : (
                  <div className="maintenance-queue-notes">
                    No inspection action is mapped for this task yet.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
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
