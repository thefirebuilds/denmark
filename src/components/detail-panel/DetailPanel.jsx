// ---------------------------------------------
// /src/components/DetailPanel.jsx
// The right-hand side detail panel that shows up when a trip is selected.
// This is where you can put all the nitty-gritty details and telemetry about the selected trip,
// without cluttering the main TripsPanel view. When no trip is selected, this panel can show a fleet-wide snapshot or other relevant info.
// ---------------------------------------------


import { useEffect, useMemo, useState } from "react";
import FleetSnapshotPanel from "./FleetSnapshotPanel";
import SelectedTripPanel from "./SelectedTripPanel";
import TripEditModal from "./TripEditModal";
import { getSelectedTripVehicle } from "./detailPanel.utils";
import { useVehicleStatus } from "./useVehicleStatus";

const API_BASE = "http://localhost:5000";

function sumOpenTaskCounts(openTaskCounts) {
  if (!openTaskCounts || typeof openTaskCounts !== "object") return 0;

  return (
    Number(openTaskCounts.urgent || 0) +
    Number(openTaskCounts.high || 0) +
    Number(openTaskCounts.medium || 0) +
    Number(openTaskCounts.low || 0)
  );
}

export default function DetailPanel({ selectedTrip, onTripUpdated, trips }) {
  const { vehicles, vehiclesLoading, vehiclesError, highlightedVehicles } =
    useVehicleStatus(60000);

  const [editingTripId, setEditingTripId] = useState(null);
  const [stageSaving, setStageSaving] = useState(false);
  const [closeoutSaving, setCloseoutSaving] = useState(false);
  const [closeoutError, setCloseoutError] = useState("");

  const [maintenanceSummary, setMaintenanceSummary] = useState(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState("");

  const selectedVehicleInfo = useMemo(() => {
    return getSelectedTripVehicle(selectedTrip, vehicles);
  }, [selectedTrip, vehicles]);

  const editingTrip = useMemo(() => {
    if (!editingTripId) return null;
    if (selectedTrip?.id === editingTripId) return selectedTrip;
    return null;
  }, [editingTripId, selectedTrip]);

  useEffect(() => {
    const vin = selectedVehicleInfo?.vehicle?.vin;

    if (!selectedTrip || !vin) {
      setMaintenanceSummary(null);
      setMaintenanceError("");
      setMaintenanceLoading(false);
      return;
    }

    let cancelled = false;

    async function loadMaintenanceSummary() {
      setMaintenanceLoading(true);
      setMaintenanceError("");

      try {
        const resp = await fetch(
          `${API_BASE}/api/vehicles/${encodeURIComponent(vin)}/maintenance-summary`
        );

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }

        const data = await resp.json();

        if (cancelled) return;

        setMaintenanceSummary({
          ...data,
          totalOpenTasks: sumOpenTaskCounts(data?.openTaskCounts),
        });
      } catch (err) {
        if (cancelled) return;
        setMaintenanceSummary(null);
        setMaintenanceError(err.message || "Failed to load maintenance summary");
      } finally {
        if (!cancelled) {
          setMaintenanceLoading(false);
        }
      }
    }

    loadMaintenanceSummary();

    return () => {
      cancelled = true;
    };
  }, [selectedTrip?.id, selectedVehicleInfo?.vehicle?.vin]);

  function handleEditTrip(trip) {
    if (!trip?.id) return;
    setEditingTripId(trip.id);
  }

  function handleCloseEditModal() {
    setEditingTripId(null);
  }

  function handleTripSaved(savedTrip) {
    onTripUpdated?.(savedTrip);
    setEditingTripId(null);
  }

  async function handleAdvanceStage(trip, nextStage) {
    if (!trip?.id || !nextStage) return;

    setStageSaving(true);
    try {
      const resp = await fetch(`${API_BASE}/api/trips/${trip.id}/stage`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow_stage: nextStage,
          force: false,
        }),
      });

      if (!resp.ok) {
        const maybeJson = await resp.json().catch(() => null);
        throw new Error(maybeJson?.error || `HTTP ${resp.status}`);
      }

      const savedTrip = await resp.json();
      onTripUpdated?.(savedTrip);
    } catch (err) {
      console.error("Failed to advance stage:", err);
    } finally {
      setStageSaving(false);
    }
  }

  async function handleCloseoutSave(trip, payload) {
    if (!trip?.id || !payload) return null;

    setCloseoutSaving(true);
    setCloseoutError("");

    try {
      const resp = await fetch(`${API_BASE}/api/trips/${trip.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const maybeJson = await resp.json().catch(() => null);
        throw new Error(maybeJson?.error || `HTTP ${resp.status}`);
      }

      const savedTrip = await resp.json();
      onTripUpdated?.(savedTrip);
      return savedTrip;
    } catch (err) {
      const message = err.message || "Failed to save closeout details";
      setCloseoutError(message);
      throw err;
    } finally {
      setCloseoutSaving(false);
    }
  }

  if (!selectedTrip) {
    return (
      <FleetSnapshotPanel
        vehicles={vehicles}
        vehiclesLoading={vehiclesLoading}
        vehiclesError={vehiclesError}
        highlightedVehicles={highlightedVehicles}
        trips={trips}
      />
    );
  }

  return (
    <>
      <SelectedTripPanel
        selectedTrip={selectedTrip}
        selectedVehicleInfo={selectedVehicleInfo}
        vehiclesLoading={vehiclesLoading}
        vehiclesError={vehiclesError}
        onEditTrip={handleEditTrip}
        onAdvanceStage={handleAdvanceStage}
        stageSaving={stageSaving}
        onCloseoutSave={handleCloseoutSave}
        closeoutSaving={closeoutSaving}
        closeoutError={closeoutError}
        maintenanceSummary={maintenanceSummary}
        maintenanceLoading={maintenanceLoading}
        maintenanceError={maintenanceError}
        trips={trips}
      />

      <TripEditModal
        trip={editingTrip}
        isOpen={Boolean(editingTripId && editingTrip)}
        onClose={handleCloseEditModal}
        onSaved={handleTripSaved}
        vehicles={vehicles}
      />
    </>
  );
}
