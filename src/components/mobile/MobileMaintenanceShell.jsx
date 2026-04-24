import { useMemo, useState } from "react";
import FleetListPanel from "../maintenance/FleetListPanel";
import FleetMaintenancePanel from "../maintenance/FleetMaintenancePanel";
import MaintenanceQueuePanel from "../maintenance/MaintenanceQueuePanel";

function formatVehicleLabel(selectedVehicleId) {
  if (!selectedVehicleId) return "No vehicle selected";

  return String(selectedVehicleId)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export default function MobileMaintenanceShell({
  selectedVehicleId,
  onSelectVehicle,
}) {
  const [activeSection, setActiveSection] = useState("vehicle");

  const selectedVehicleLabel = useMemo(() => {
    return formatVehicleLabel(selectedVehicleId);
  }, [selectedVehicleId]);

  function handleSelectVehicle(vehicleId) {
    onSelectVehicle?.(vehicleId);
    setActiveSection("vehicle");
  }

  return (
    <section className="mobile-maintenance-shell panel">
      <div className="panel-header mobile-maintenance-shell-header">
        <div>
          <h2>Fleet Maintenance</h2>
          <span>Phone-friendly layout for inspections, queue work, and car-by-car review.</span>
        </div>

        <div className="mobile-maintenance-shell-current">
          <strong>{selectedVehicleLabel}</strong>
          <span>Current vehicle</span>
        </div>
      </div>

      <div className="mobile-maintenance-shell-tabs" role="tablist" aria-label="Maintenance views">
        {[
          { key: "fleet", label: "Fleet" },
          { key: "vehicle", label: "Vehicle" },
          { key: "queue", label: "Queue" },
        ].map((section) => (
          <button
            key={section.key}
            type="button"
            className={`mobile-maintenance-shell-tab ${
              activeSection === section.key ? "is-active" : ""
            }`}
            onClick={() => setActiveSection(section.key)}
          >
            {section.label}
          </button>
        ))}
      </div>

      <div className="mobile-maintenance-shell-body">
        {activeSection === "fleet" ? (
          <FleetListPanel
            selectedVehicleId={selectedVehicleId}
            onSelectVehicle={handleSelectVehicle}
          />
        ) : activeSection === "queue" ? (
          <MaintenanceQueuePanel selectedVehicleId={selectedVehicleId} />
        ) : (
          <FleetMaintenancePanel selectedVehicleId={selectedVehicleId} />
        )}
      </div>
    </section>
  );
}
