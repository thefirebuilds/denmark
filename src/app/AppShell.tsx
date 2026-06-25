// @ts-expect-error Legacy JSX component has no declaration file.
import Rail from "../components/Rail.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import TopBanner from "../components/TopBanner.jsx";
// @ts-expect-error Legacy JSX component has no declaration file.
import MobileMaintenanceShell from "../components/mobile/MobileMaintenanceShell.jsx";
import { renderActiveView } from "./viewRegistry";
import type { UnknownRecord } from "./appTypes";

type AppShellProps = UnknownRecord & {
  activeView: string;
  effectiveLayoutMode: string;
};

export function AppShell(props: AppShellProps) {
  const useMobileMaintenanceShell =
    props.activeView === "maintenance" &&
    props.effectiveLayoutMode === "mobile";

  return (
    <div
      className={`app ${
        useMobileMaintenanceShell ? "app--mobile-maintenance" : ""
      }`}
    >
      <Rail activeView={props.activeView} onChangeView={props.onChangeView} />

      <TopBanner
        stats={props.messageStats}
        mercuryBalance={props.mercuryBalance}
        loading={props.messageStatsLoading}
        refreshing={props.messageStatsRefreshing}
        authInfo={props.authInfo}
        layoutMode={props.layoutMode}
        effectiveLayoutMode={props.effectiveLayoutMode}
        onChangeLayoutMode={props.onChangeLayoutMode}
      />

      {useMobileMaintenanceShell ? (
        <MobileMaintenanceShell
          selectedVehicleId={props.selectedVehicleId}
          onSelectVehicle={props.onSelectMaintenanceVehicle}
        />
      ) : (
        renderActiveView(props)
      )}
    </div>
  );
}
