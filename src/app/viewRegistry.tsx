// @ts-expect-error Legacy JSX component has no declaration file.
import TripsPanel from "../components/TripsPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import MessagesPanel from "../components/MessagesPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import FleetListPanel from "../components/maintenance/FleetListPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import FleetMaintenancePanel from "../components/maintenance/FleetMaintenancePanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import DetailPanel from "../components/detail-panel/DetailPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import MaintenanceQueuePanel from "../components/maintenance/MaintenanceQueuePanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import ExpensesVehicleListPanel from "../components/expenses/ExpensesVehicleListPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import ExpensesPanel from "../components/expenses/ExpensesPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import ExpensesSummaryPanel from "../components/expenses/ExpensesSummaryPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import TripSummary from "../components/TripSummary.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import InboxPanel from "../components/inbox/InboxPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import MetricsPanel from "../components/MetricsPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import DailyBriefPanel from "../components/DailyBriefPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import MarketplacePanel from "../components/MarketplacePanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import FleetMapPanel from "../components/FleetMapPanel.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import SettingsPanel from "../components/settings/SettingsPanel.jsx";
import type { UnknownRecord } from "./appTypes";

type ViewContext = UnknownRecord & {
  activeView: string;
};

export function renderActiveView(ctx: ViewContext) {
  if (ctx.activeView === "maintenance") {
    return (
      <>
        <FleetListPanel
          selectedVehicleId={ctx.selectedVehicleId}
          onSelectVehicle={ctx.onSelectMaintenanceVehicle}
        />

        <FleetMaintenancePanel
          selectedVehicleId={ctx.selectedVehicleId}
          onOpenVehicleMap={ctx.onOpenVehicleMap}
        />

        <MaintenanceQueuePanel
          selectedVehicleId={ctx.maintenanceQueueVehicleId}
          onShowAllVehicles={ctx.onShowAllMaintenanceVehicles}
        />
      </>
    );
  }

  if (ctx.activeView === "expenses") {
    return (
      <>
        <ExpensesVehicleListPanel
          selectedVehicleId={ctx.selectedExpenseVehicleId}
          onSelectVehicle={ctx.onSelectExpenseVehicle}
        />

        <ExpensesPanel selectedVehicleId={ctx.selectedExpenseVehicleId} />

        <ExpensesSummaryPanel selectedVehicleId={ctx.selectedExpenseVehicleId} />
      </>
    );
  }

  if (ctx.activeView === "ledger") {
    return (
      <div className="ledger-view-shell">
        <TripSummary />
      </div>
    );
  }

  if (ctx.activeView === "inbox") return <InboxPanel />;
  if (ctx.activeView === "metrics") return <MetricsPanel />;
  if (ctx.activeView === "daily-brief") return <DailyBriefPanel />;

  if (ctx.activeView === "marketplace") {
    return (
      <div className="marketplace-view-shell">
        <MarketplacePanel />
      </div>
    );
  }

  if (ctx.activeView === "fleet-map") {
    return <FleetMapPanel focusVehicleId={ctx.mapFocusVehicleId} />;
  }

  if (ctx.activeView === "settings") {
    return (
      <SettingsPanel
        dispatchSettings={ctx.dispatchSettings}
        onDispatchSettingsSaved={ctx.onDispatchSettingsSaved}
      />
    );
  }

  return (
    <>
      <TripsPanel
        selectedTrip={ctx.selectedTrip}
        onSelectTrip={ctx.onTripSelectedFromQueue}
        trips={ctx.trips}
        setTrips={ctx.setTrips}
        dispatchSettings={ctx.dispatchSettings}
        initialVehicles={ctx.startupVehicles}
        initialLoadComplete={ctx.initialLoadComplete}
      />

      <MessagesPanel
        selectedTrip={ctx.selectedTrip}
        messageMode={ctx.messageMode}
        onClearSelectedTrip={ctx.onClearSelectedTrip}
        onSelectTrip={ctx.onTripFocused}
        onEditTrip={ctx.onEditTripFromMessage}
        onOpenMaintenanceVehicle={ctx.onOpenMaintenanceVehicle}
        initialMessages={ctx.startupMessages}
        initialUnreadCount={ctx.initialUnreadCount}
        initialLoadComplete={ctx.initialLoadComplete}
      />

      <DetailPanel
        selectedTrip={ctx.selectedTrip}
        editTripRequest={ctx.editTripRequest}
        onTripUpdated={ctx.onTripUpdated}
        onTripCompleted={ctx.onTripCompleted}
        trips={ctx.trips}
        initialVehicles={ctx.startupVehicles}
        onOpenVehicleMap={ctx.onOpenVehicleMap}
      />
    </>
  );
}
