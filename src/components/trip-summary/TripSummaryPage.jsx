import { useEffect, useMemo, useState } from "react";
import TripVehiclePanel from "./TripSummaryVehiclePanel";
import TripSummaryListPanel from "./TripSummaryListPanel";
import TripSummaryMetricsPanel from "./TripSummaryMetricsPanel";
import TripSummaryDrawer from "./TripSummaryDrawer";

const API_BASE = "http://localhost:5000";


function getTripDays(start, end) {
  if (!start || !end) return 0;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return (b - a) / (1000 * 60 * 60 * 24);
}

function isTripInProgress(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const status = String(trip?.status || "").toLowerCase();

  return (
    stage === "in_progress" ||
    status === "in_progress" ||
    status === "started" ||
    status === "trip_started"
  );
}

function findVehicleForTrip(trip, vehicles = []) {
  const tripVehicleName = String(
    trip?.vehicle_name || trip?.vehicle_nickname || ""
  )
    .trim()
    .toLowerCase();

  if (!tripVehicleName) return null;

  return (
    vehicles.find((vehicle) => {
      const nickname = String(vehicle?.nickname || "")
        .trim()
        .toLowerCase();

      const turoVehicleName = String(vehicle?.turo_vehicle_name || "")
        .trim()
        .toLowerCase();

      return nickname === tripVehicleName || turoVehicleName === tripVehicleName;
    }) || null
  );
}

function getMilesDriven(trip, vehicles = []) {
  const start = Number(trip?.starting_odometer);
  const end = Number(trip?.ending_odometer);

  if (!Number.isFinite(start)) return null;

  // finished trip with sane odometer values
  if (Number.isFinite(end) && end >= start) {
    return end - start;
  }

  // in-progress trip: fall back to live odometer from vehicle status
  if (isTripInProgress(trip)) {
    const vehicle = findVehicleForTrip(trip, vehicles);
    const currentOdometer = Number(vehicle?.telemetry?.odometer);

    if (Number.isFinite(currentOdometer) && currentOdometer >= start) {
      return currentOdometer - start;
    }
  }

  // never allow negative mileage
  return null;
}

function buildQuery(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    search.set(key, String(value));
  });
  return search.toString();
}

export default function TripSummaryPage() {
  const [vehicles, setVehicles] = useState([]);
  const [trips, setTrips] = useState([]);
    const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [selectedTrip, setSelectedTrip] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [filters, setFilters] = useState({
    startDate: "",
    endDate: "",
    search: "",
    tripHealth: "all",
  });

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  async function loadVehicles() {
    const res = await fetch(`${API_BASE}/api/vehicles/status`);
    if (!res.ok) throw new Error("Failed to load vehicles");
    const data = await res.json();
    setVehicles(Array.isArray(data) ? data : []);
  }

  async function loadTrips() {
    setLoading(true);
    setLoadError("");
    try {
      const query = buildQuery({
        vehicle_id: selectedVehicleId || "",
        start_date: filters.startDate,
        end_date: filters.endDate,
        search: filters.search,
      });

      const res = await fetch(`${API_BASE}/api/trip-summaries?${query}`);
      if (!res.ok) throw new Error("Failed to load trip summaries");
      const data = await res.json();
      setTrips(Array.isArray(data) ? data : []);
    } catch (err) {
      setLoadError(err.message || "Failed to load trip summaries");
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadVehicles();
  }, []);

  useEffect(() => {
    loadTrips();
  }, [selectedVehicleId, filters.startDate, filters.endDate, filters.search]);

    const displayTrips = useMemo(() => {
    return trips.filter((trip) => {
      switch (filters.tripHealth) {
        case "open_action_needed":
          return isOpenActionTrip(trip, vehicles);

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

    const totalRevenue = displayTrips.reduce(
      (sum, trip) => sum + Number(trip?.gross_income ?? trip?.amount ?? 0),
      0
    );

    const totalDays = displayTrips.reduce(
      (sum, trip) => sum + getTripDays(trip.trip_start, trip.trip_end),
      0
    );

    const tripMiles = displayTrips.map((trip) => getMilesDriven(trip, vehicles));
    const validTripMiles = tripMiles.filter(
      (miles) => Number.isFinite(miles) && miles >= 0
    );

    const totalMiles = validTripMiles.reduce((sum, miles) => sum + miles, 0);

    const incompleteCount = displayTrips.filter((trip) => {
      const miles = getMilesDriven(trip, vehicles);

      return (
        trip.gross_income == null ||
        trip.starting_odometer == null ||
        (!Number.isFinite(Number(trip.ending_odometer)) &&
          !Number.isFinite(miles)) ||
        !trip.trip_start ||
        !trip.trip_end
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

  function handleSelectTrip(trip) {
    setSelectedTrip(trip);
    setDrawerOpen(true);
  }

  async function handleSaveTrip(updatedTrip) {
  const res = await fetch(`${API_BASE}/api/trip-summaries/${updatedTrip.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updatedTrip),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    throw new Error(data?.detail || data?.error || "Failed to save trip");
  }

  const saved = data;

  setTrips((prev) => prev.map((trip) => (trip.id === saved.id ? saved : trip)));
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
      <TripVehiclePanel
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
        selectedTripId={selectedTrip?.id}
        onSelectTrip={handleSelectTrip}
        vehicleStatuses={vehicles}
        />

      <TripSummaryMetricsPanel
        metrics={metrics}
        selectedTrip={selectedTrip}
        vehicleStatuses={vehicles}
      />

      <TripSummaryDrawer
        open={drawerOpen}
        trip={selectedTrip}
        vehicles={vehicles}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSaveTrip}
        onDelete={handleDeleteTrip}
      />
    </div>
  );
}