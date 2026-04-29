// ------------------------------------------------------------
// /src/components/TripSummary.jsx
// Main page component for the trip ledger view. Owns vehicle
// status loading, trip loading, filter state, derived trip
// subsets, metrics, and drawer state.
// ------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import TripSummaryVehiclePanel, {
  UNASSIGNED_VEHICLE_FILTER,
} from "./trip-summary/TripSummaryVehiclePanel";
import TripSummaryListPanel from "./trip-summary/TripSummaryListPanel";
import TripSummaryMetricsPanel from "./trip-summary/TripSummaryMetricsPanel";
import TripSummaryDrawer from "./trip-summary/TripSummaryDrawer";

import {
  getMilesDriven,
  getTripDays,
  hasAssignedVehicle,
  hasDataIssues,
  isOpenActionTrip,
} from "../utils/tripUtils";

const API_BASE = "http://localhost:5000";
const TRIP_LEDGER_FOCUS_STORAGE_KEY = "denmark.tripLedgerFocus";

function readStoredTripLedgerFocus() {
  if (typeof window === "undefined") return null;

  const raw = window.sessionStorage.getItem(TRIP_LEDGER_FOCUS_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.reservationId ? parsed : null;
  } catch {
    return null;
  }
}

function clearStoredTripLedgerFocus() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(TRIP_LEDGER_FOCUS_STORAGE_KEY);
}

function hasOpenTollBilling(trip) {
  const tollTotal = Number(trip?.toll_total ?? 0);
  const tollStatus = String(trip?.toll_review_status || "")
    .trim()
    .toLowerCase();

  const tripEnd = trip?.trip_end ? new Date(trip.trip_end) : null;
  const now = Date.now();
  const bufferMs = 60 * 60 * 1000; // 1 hour

  const hasEnded =
    tripEnd instanceof Date &&
    !Number.isNaN(tripEnd.getTime()) &&
    tripEnd.getTime() < now - bufferMs;

  return tollTotal > 0 && tollStatus !== "billed" && hasEnded;
}

function buildQuery(params) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    search.set(key, String(value));
  });

  return search.toString();
}

export default function TripSummary() {
  const [trips, setTrips] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [filters, setFilters] = useState({
    startDate: "",
    endDate: "",
    search: "",
    tripHealth: "all",
  });
  const [pendingLedgerFocus, setPendingLedgerFocus] = useState(
    readStoredTripLedgerFocus
  );

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  function buildNewTripDraft() {
    const selectedVehicle =
      vehicles.find(
        (vehicle) =>
          selectedVehicleId &&
          selectedVehicleId !== UNASSIGNED_VEHICLE_FILTER &&
          String(vehicle?.turo_vehicle_id ?? "") === String(selectedVehicleId)
      ) || null;

    return {
      id: null,
      is_new: true,
      reservation_id: "",
      guest_name: "",
      vehicle_name: selectedVehicle?.nickname || "",
      vehicle_nickname: selectedVehicle?.nickname || "",
      turo_vehicle_id:
        selectedVehicle?.turo_vehicle_id == null
          ? ""
          : String(selectedVehicle.turo_vehicle_id),
      trip_start: "",
      trip_end: "",
      status: "booked_unconfirmed",
      workflow_stage: "booked",
      needs_review: true,
      mileage_included: "",
      gross_income: "",
      amount: "",
      has_tolls: false,
      toll_count: 0,
      toll_total: 0,
      toll_review_status: "none",
      expense_status: "",
      notes: "",
    };
  }

  useEffect(() => {
    let ignore = false;

    async function loadVehicles() {
      try {
        const res = await fetch(`${API_BASE}/api/vehicles/status`);

        if (!res.ok) {
          throw new Error(`Failed to load vehicle status: ${res.status}`);
        }

        const data = await res.json();

        if (!ignore) {
          setVehicles(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!ignore) {
          console.error("Failed to load vehicle status", err);
          setVehicles([]);
        }
      }
    }

    loadVehicles();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    function handleOpenTripLedger(event) {
      const detail = event?.detail || readStoredTripLedgerFocus();
      if (!detail?.reservationId) return;

      setPendingLedgerFocus(detail);
      setFilters((current) => ({
        ...current,
        search: String(detail.reservationId),
        tripHealth: "all",
      }));
    }

    window.addEventListener("denmark:open-trip-ledger", handleOpenTripLedger);

    if (pendingLedgerFocus?.reservationId) {
      setFilters((current) => ({
        ...current,
        search: String(pendingLedgerFocus.reservationId),
        tripHealth: "all",
      }));
    }

    return () => {
      window.removeEventListener("denmark:open-trip-ledger", handleOpenTripLedger);
    };
  }, [pendingLedgerFocus]);

  useEffect(() => {
    let ignore = false;

    async function loadTrips() {
      setLoading(true);
      setLoadError("");

      try {
        const query = buildQuery({
          vehicle_id:
            selectedVehicleId === UNASSIGNED_VEHICLE_FILTER
              ? "unassigned"
              : selectedVehicleId,
          start_date: filters.startDate,
          end_date: filters.endDate,
          search: filters.search,
          include_canceled: true,
        });

        const res = await fetch(`${API_BASE}/api/trip-summaries?${query}`);

        if (!res.ok) {
          throw new Error(`Failed to load trip summaries: ${res.status}`);
        }

        const data = await res.json();

        if (ignore) return;

        const nextTrips = Array.isArray(data) ? data : [];
        setTrips(nextTrips);

        if (
          selectedTrip?.id &&
          !nextTrips.some((trip) => trip.id === selectedTrip.id)
        ) {
          setSelectedTrip(null);
          setDrawerOpen(false);
        }
      } catch (err) {
        if (ignore) return;
        setLoadError(err.message || "Failed to load trip summaries");
        setTrips([]);
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadTrips();

    return () => {
      ignore = true;
    };
  }, [
    selectedVehicleId,
    filters.startDate,
    filters.endDate,
    filters.search,
    selectedTrip?.id,
  ]);

  useEffect(() => {
    if (!pendingLedgerFocus?.reservationId || loading) return;

    const match = trips.find((trip) => {
      if (
        pendingLedgerFocus.tripId != null &&
        String(trip?.id ?? "") === String(pendingLedgerFocus.tripId)
      ) {
        return true;
      }

      return (
        String(trip?.reservation_id ?? "") ===
        String(pendingLedgerFocus.reservationId)
      );
    });

    if (match) {
      handleSelectTrip(match);
      clearStoredTripLedgerFocus();
      setPendingLedgerFocus(null);
      return;
    }

    if (
      filters.search &&
      String(filters.search) === String(pendingLedgerFocus.reservationId)
    ) {
      clearStoredTripLedgerFocus();
      setPendingLedgerFocus(null);
    }
  }, [pendingLedgerFocus, loading, trips, filters.search]);

const displayTrips = useMemo(() => {
  return trips.filter((trip) => {
    switch (filters.tripHealth) {
      case "open_action_needed":
        return isOpenActionTrip(trip, vehicles);

      case "open_tolls":
        return hasOpenTollBilling(trip);

      case "no_vehicle_assigned":
        return !hasAssignedVehicle(trip);

      case "data_issues":
        return hasDataIssues(trip, vehicles);

      case "all":
      default:
        return true;
    }
  });
}, [trips, vehicles, filters.tripHealth]);

  const metrics = useMemo(() => {
    const totalTrips = displayTrips.length;

    const totalRevenue = displayTrips.reduce((sum, trip) => {
      return sum + Number(trip?.gross_income ?? trip?.amount ?? 0);
    }, 0);

    const totalDays = displayTrips.reduce((sum, trip) => {
      return sum + getTripDays(trip?.trip_start, trip?.trip_end);
    }, 0);

    const validTripMiles = displayTrips
      .map((trip) => getMilesDriven(trip, vehicles))
      .filter((miles) => Number.isFinite(miles) && miles >= 0);

    const totalMiles = validTripMiles.reduce((sum, miles) => {
      return sum + miles;
    }, 0);

    const incompleteCount = displayTrips.filter((trip) => {
      const miles = getMilesDriven(trip, vehicles);

      return (
        (trip?.gross_income == null && trip?.amount == null) ||
        trip?.starting_odometer == null ||
        (!Number.isFinite(Number(trip?.ending_odometer)) &&
          !Number.isFinite(miles)) ||
        !trip?.trip_start ||
        !trip?.trip_end
      );
    }).length;

    return {
      totalTrips,
      totalRevenue,
      avgRevenue: totalTrips ? totalRevenue / totalTrips : 0,
      totalDays,
      avgDays: totalTrips ? totalDays / totalTrips : 0,
      totalMiles,
      avgMiles: validTripMiles.length ? totalMiles / validTripMiles.length : 0,
      revenuePerDay: totalDays ? totalRevenue / totalDays : 0,
      revenuePerMile: totalMiles ? totalRevenue / totalMiles : 0,
      incompleteCount,
    };
  }, [displayTrips, vehicles]);

async function handleSelectTrip(trip) {
  if (!trip?.id) {
    setSelectedTrip(null);
    setDrawerOpen(false);
    return;
  }

  setDrawerOpen(true);

  try {
    const res = await fetch(`${API_BASE}/api/trip-summaries/${trip.id}`);

    if (!res.ok) {
      throw new Error(`Failed to load trip detail: ${res.status}`);
    }

    const fullTrip = await res.json();
    setSelectedTrip(fullTrip);
  } catch (err) {
    console.error("Failed to load trip detail", err);
    setSelectedTrip(trip);
  }
}

  function handleCreateTrip() {
    setSelectedTrip(buildNewTripDraft());
    setDrawerOpen(true);
  }

  async function handleSaveTrip(updatedTrip) {
    const isNewTrip = !updatedTrip.id;
    const url = isNewTrip
      ? `${API_BASE}/api/trip-summaries`
      : `${API_BASE}/api/trip-summaries/${updatedTrip.id}`;

    const res = await fetch(url, {
      method: isNewTrip ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedTrip),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || "Failed to save trip");
    }

    const saved = await res.json();

    setTrips((prev) => {
      if (isNewTrip) {
        return [saved, ...prev];
      }

      return prev.map((trip) => (trip.id === saved.id ? saved : trip));
    });
    setSelectedTrip(saved);

    return saved;
  }

  async function handleDeleteTrip(tripId) {
    const res = await fetch(`${API_BASE}/api/trip-summaries/${tripId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      throw new Error("Failed to delete trip");
    }

    setTrips((prev) => prev.filter((trip) => trip.id !== tripId));

    if (selectedTrip?.id === tripId) {
      setSelectedTrip(null);
      setDrawerOpen(false);
    }
  }

  return (
    <div className="trip-summary-layout">
      <TripSummaryVehiclePanel
        vehicles={vehicles}
        trips={trips}
        selectedVehicleId={selectedVehicleId}
        onSelectVehicle={setSelectedVehicleId}
      />

      <TripSummaryListPanel
        trips={displayTrips}
        loading={loading}
        loadError={loadError}
        filters={filters}
        onFiltersChange={setFilters}
        selectedTripId={selectedTrip?.id ?? null}
        onSelectTrip={handleSelectTrip}
        onCreateTrip={handleCreateTrip}
        vehicleStatuses={vehicles}
      />

      <TripSummaryMetricsPanel
        metrics={metrics}
        selectedTrip={selectedTrip}
        vehicleStatuses={vehicles}
      />

      {drawerOpen && selectedTrip ? (
        <TripSummaryDrawer
          open={drawerOpen}
          trip={selectedTrip}
          vehicles={vehicles}
          onClose={() => {
            setDrawerOpen(false);
            setSelectedTrip(null);
          }}
          onSave={handleSaveTrip}
          onDelete={handleDeleteTrip}
        />
      ) : null}
    </div>
  );
}
