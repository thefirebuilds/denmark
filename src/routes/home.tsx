import { useCallback, useEffect, useState } from "react";
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
import type { EditTripRequest, TripLike } from "../app/appTypes";
import { useAuthStatus } from "../hooks/useAuthStatus";
import { useBackendAvailability } from "../hooks/useBackendAvailability";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { useMercuryBalance } from "../hooks/useMercuryBalance";
import { useMessageStats } from "../hooks/useMessageStats";
import { usePanelEvents } from "../hooks/usePanelEvents";
import { useStartup } from "../hooks/useStartup";

export default function Home() {
  const [selectedTrip, setSelectedTrip] = useState<TripLike | null>(null);
  const [editTripRequest, setEditTripRequest] =
    useState<EditTripRequest>(null);
  const [activeView, setActiveView] = useState("dispatch");
  const [messageMode, setMessageMode] = useState<"live" | "trip">("live");
  const [selectedVehicleId, setSelectedVehicleId] = useState("belle");
  const [maintenanceQueueScope, setMaintenanceQueueScope] = useState<
    "selected" | "all"
  >("selected");
  const [mapFocusVehicleId, setMapFocusVehicleId] = useState<string | null>(null);
  const [selectedExpenseVehicleId, setSelectedExpenseVehicleId] = useState<
    number | null
  >(null);
  const { effectiveLayoutMode, layoutMode, setLayoutMode } = useLayoutMode();
  const mercuryBalance = useMercuryBalance();

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

    setSelectedVehicleId(String(vehicleId).trim().toLowerCase().replace(/\s+/g, "_"));
    setMaintenanceQueueScope("selected");
    setActiveView("maintenance");
  }

  function handleSelectMaintenanceVehicle(vehicleId: string) {
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
