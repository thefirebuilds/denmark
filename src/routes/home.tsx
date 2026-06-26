import { useCallback, useEffect, useRef, useState } from "react";
import "../styles/styles.css";
import "../styles/trips.css";
import "../styles/maintenance.css";
import "../styles/expenses.css";
import "../styles/tripSummary.css";
import "../styles/inbox.css";
import "../styles/metrics.css";
import "../styles/marketplace.css";
import "../styles/fleet-map.css";
import "../styles/settings.css";

import { AppShell } from "../app/AppShell";
import { StartupScreen } from "../app/StartupScreen";
import type { EditTripRequest, TripLike, UnknownRecord } from "../app/appTypes";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useBackendAvailability } from "../hooks/useBackendAvailability";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { useMercuryBalance } from "../hooks/useMercuryBalance";
import { useMessageStats } from "../hooks/useMessageStats";
import { usePanelEvents } from "../hooks/usePanelEvents";
import { useStartup } from "../hooks/useStartup";

function normalizeVehicleMatchValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeVehicleRouteKey(value: unknown) {
  return normalizeVehicleMatchValue(value).replace(/\s+/g, "_");
}

function getVehicleRouteKey(vehicle: UnknownRecord) {
  return normalizeVehicleRouteKey(
    vehicle?.turo_vehicle_id ||
      vehicle?.nickname ||
      vehicle?.vin ||
      vehicle?.id ||
      vehicle?.dimo_token_id ||
      vehicle?.bouncie_vehicle_id
  );
}

function getVehicleNameKeys(vehicle: UnknownRecord) {
  return [
    vehicle?.nickname,
    vehicle?.turo_vehicle_name,
    vehicle?.vehicle_name,
  ]
    .concat(Array.isArray(vehicle?.aliases) ? vehicle.aliases : [])
    .map(normalizeVehicleMatchValue)
    .filter(Boolean);
}

function tripMatchesVehicle(vehicle: UnknownRecord, trip: TripLike) {
  const vehicleTuroId = normalizeVehicleMatchValue(
    vehicle?.turo_vehicle_id ?? vehicle?.turoVehicleId
  );
  const tripTuroId = normalizeVehicleMatchValue(trip?.turo_vehicle_id);
  if (vehicleTuroId && tripTuroId) {
    return vehicleTuroId === tripTuroId;
  }

  const vehicleVin = normalizeVehicleMatchValue(vehicle?.vin);
  const tripVin = normalizeVehicleMatchValue(trip?.vehicle_vin ?? trip?.vehicleVin);
  if (vehicleVin && tripVin) {
    return vehicleVin === tripVin;
  }

  const vehicleNames = getVehicleNameKeys(vehicle);
  if (!vehicleNames.length) return false;

  const tripNames = [trip?.vehicle_nickname, trip?.vehicle_name]
    .map(normalizeVehicleMatchValue)
    .filter(Boolean);

  return tripNames.some((tripName) => vehicleNames.includes(tripName));
}

function getTripTime(trip: TripLike, key: "start" | "end") {
  const value =
    key === "start"
      ? trip?.trip_start ?? trip?.start_date ?? trip?.startDate
      : trip?.trip_end ?? trip?.end_date ?? trip?.endDate;
  const time = value ? new Date(String(value)).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function isTripClosed(trip: TripLike) {
  const stage = normalizeVehicleMatchValue(trip?.workflow_stage);
  const status = normalizeVehicleMatchValue(trip?.status);
  return ["complete", "completed", "canceled", "cancelled"].includes(stage)
    || ["complete", "completed", "canceled", "cancelled"].includes(status);
}

function isTripActiveNow(trip: TripLike, now: number) {
  const bucket = normalizeVehicleMatchValue(trip?.queue_bucket);
  const stage = normalizeVehicleMatchValue(trip?.workflow_stage);
  const status = normalizeVehicleMatchValue(trip?.status);
  const start = getTripTime(trip, "start");
  const end = getTripTime(trip, "end");

  if (
    bucket === "in_progress" ||
    stage === "in_progress" ||
    ["active", "started", "trip_started", "in_progress"].includes(status)
  ) {
    return true;
  }

  return start != null && end != null && start <= now && end >= now;
}

function getNextUpcomingTripTime(trips: TripLike[], now: number) {
  const upcomingTimes = trips
    .filter((trip) => !isTripClosed(trip) && !isTripActiveNow(trip, now))
    .map((trip) => getTripTime(trip, "start"))
    .filter((time): time is number => time != null && time > now);

  return upcomingTimes.length ? Math.min(...upcomingTimes) : null;
}

function pickDefaultMaintenanceVehicleId(
  vehicles: UnknownRecord[],
  trips: TripLike[]
) {
  const now = Date.now();
  const candidates = vehicles
    .map((vehicle) => {
      const id = getVehicleRouteKey(vehicle);
      if (!id) return null;

      const vehicleTrips = trips.filter((trip) => tripMatchesVehicle(vehicle, trip));
      const activeTrip = vehicleTrips.find((trip) => isTripActiveNow(trip, now));
      if (activeTrip) return null;

      const nextTripAt = getNextUpcomingTripTime(vehicleTrips, now);
      if (nextTripAt == null) return null;

      return {
        id,
        nextTripAt,
        label: String(vehicle?.nickname || id),
      };
    })
    .filter((candidate): candidate is { id: string; nextTripAt: number; label: string } =>
      Boolean(candidate)
    )
    .sort((a, b) => {
      if (a.nextTripAt !== b.nextTripAt) return a.nextTripAt - b.nextTripAt;
      return a.label.localeCompare(b.label);
    });

  return candidates[0]?.id || null;
}

export default function Home() {
  const [selectedTrip, setSelectedTrip] = useState<TripLike | null>(null);
  const [editTripRequest, setEditTripRequest] =
    useState<EditTripRequest>(null);
  const [activeView, setActiveView] = useState("dispatch");
  const [messageMode, setMessageMode] = useState<"live" | "trip">("live");
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [maintenanceQueueScope, setMaintenanceQueueScope] = useState<
    "selected" | "all"
  >("selected");
  const [mapFocusVehicleId, setMapFocusVehicleId] = useState<string | null>(null);
  const [selectedExpenseVehicleId, setSelectedExpenseVehicleId] = useState<
    number | null
  >(null);
  const { effectiveLayoutMode, layoutMode, setLayoutMode } = useLayoutMode();
  const mercuryBalance = useMercuryBalance();
  const maintenanceVehicleTouchedRef = useRef(false);

  const handleStartupAuthRequired = useCallback(() => {}, []);

  const {
    authInfo,
    authRequired,
    markAuthenticated,
    markAuthRequired,
  } = useAuthStatus(handleStartupAuthRequired);

  const {
    dispatchSettings,
    returnToStartup,
    setDispatchSettings,
    setTrips,
    startup,
    startupMessages,
    startupVehicles,
    trips,
  } = useStartup({
    markAuthenticated,
    markAuthRequired,
    setSelectedTrip,
    setMessageMode,
  });

  const {
    messageStats,
    messageStatsLoading,
    messageStatsRefreshing,
    setMessageStatsLoading,
  } = useMessageStats({
    returnToStartup,
    startupReady: startup.ready,
  });

  const handleBackendUnavailable = useCallback(() => {
    returnToStartup("Waiting for backend");
  }, [returnToStartup]);

  useBackendAvailability(handleBackendUnavailable);

  useEffect(() => {
    if (!startup.ready || maintenanceVehicleTouchedRef.current) return;

    const defaultVehicleId = pickDefaultMaintenanceVehicleId(
      startupVehicles,
      trips
    );

    if (defaultVehicleId) {
      setSelectedVehicleId(defaultVehicleId);
      setMaintenanceQueueScope("selected");
    }
  }, [startup.ready, startupVehicles, trips]);

  useEffect(() => {
    if (!authRequired) return;
    returnToStartup("Sign in required");
    setMessageStatsLoading(false);
  }, [authRequired, returnToStartup, setMessageStatsLoading]);

  function openFleetMapForVehicle(vehicleId: string | number | null | undefined) {
    if (vehicleId == null || vehicleId === "") return;
    setMapFocusVehicleId(String(vehicleId));
    setActiveView("fleet-map");
  }

  usePanelEvents({
    setActiveView,
    setSelectedExpenseVehicleId,
  });

  function handleTripUpdated(savedTrip: TripLike) {
    setSelectedTrip((prev) =>
      prev?.id === savedTrip?.id ? savedTrip : prev
    );
    setTrips((prev) =>
      prev.map((trip) => (trip.id === savedTrip?.id ? savedTrip : trip))
    );
  }

  function handleTripFocused(trip: TripLike) {
    if (!trip?.id) return;

    setMessageMode("trip");
    setSelectedTrip(trip);
    setTrips((prev) =>
      prev.map((candidate) => (candidate.id === trip.id ? trip : candidate))
    );
  }

  function handleEditTripFromMessage(trip: TripLike) {
    if (!trip?.id) return;

    handleTripFocused(trip);
    setEditTripRequest({
      tripId: trip.id,
      requestedAt: Date.now(),
    });
  }

  function handleTripSelectedFromQueue(trip: TripLike | null) {
    setSelectedTrip(trip);
    setMessageMode(trip?.id ? "trip" : "live");
  }

  function handleClearSelectedTrip() {
    setSelectedTrip(null);
    setMessageMode("live");
  }

  function handleTripCompleted() {
    setSelectedTrip(null);
    setMessageMode("live");
  }

  function handleOpenMaintenanceVehicle(vehicleId: string | number | null) {
    if (!vehicleId) return;

    maintenanceVehicleTouchedRef.current = true;
    setSelectedVehicleId(String(vehicleId).trim().toLowerCase().replace(/\s+/g, "_"));
    setMaintenanceQueueScope("selected");
    setActiveView("maintenance");
  }

  function handleSelectMaintenanceVehicle(vehicleId: string | null) {
    maintenanceVehicleTouchedRef.current = true;
    setSelectedVehicleId(vehicleId);
    setMaintenanceQueueScope("selected");
  }

  const maintenanceQueueVehicleId =
    maintenanceQueueScope === "selected" ? selectedVehicleId : null;

  if (!startup.ready) {
    return (
      <StartupScreen
        authRequired={authRequired}
        error={startup.error}
        label={startup.label}
      />
    );
  }

  return (
    <AppShell
      activeView={activeView}
      authInfo={authInfo}
      dispatchSettings={dispatchSettings}
      editTripRequest={editTripRequest}
      effectiveLayoutMode={effectiveLayoutMode}
      initialLoadComplete={startup.ready}
      initialUnreadCount={messageStats.unread}
      layoutMode={layoutMode}
      maintenanceQueueVehicleId={maintenanceQueueVehicleId}
      mapFocusVehicleId={mapFocusVehicleId}
      mercuryBalance={mercuryBalance}
      messageMode={messageMode}
      messageStats={messageStats}
      messageStatsLoading={messageStatsLoading}
      messageStatsRefreshing={messageStatsRefreshing}
      onChangeLayoutMode={setLayoutMode}
      onChangeView={setActiveView}
      onClearSelectedTrip={handleClearSelectedTrip}
      onDispatchSettingsSaved={setDispatchSettings}
      onEditTripFromMessage={handleEditTripFromMessage}
      onOpenMaintenanceVehicle={handleOpenMaintenanceVehicle}
      onOpenVehicleMap={openFleetMapForVehicle}
      onSelectExpenseVehicle={setSelectedExpenseVehicleId}
      onSelectMaintenanceVehicle={handleSelectMaintenanceVehicle}
      onShowAllMaintenanceVehicles={() => setMaintenanceQueueScope("all")}
      onTripCompleted={handleTripCompleted}
      onTripFocused={handleTripFocused}
      onTripSelectedFromQueue={handleTripSelectedFromQueue}
      onTripUpdated={handleTripUpdated}
      selectedExpenseVehicleId={selectedExpenseVehicleId}
      selectedTrip={selectedTrip}
      selectedVehicleId={selectedVehicleId}
      setTrips={setTrips}
      startupMessages={startupMessages}
      startupVehicles={startupVehicles}
      trips={trips}
    />
  );
}
