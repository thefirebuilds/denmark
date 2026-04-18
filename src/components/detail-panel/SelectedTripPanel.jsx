// --------------------------------------------------------------------------
// ./src/components/detail-panel/SelectedTripPanel.jsx
// This component displays detailed information about the currently selected trip,
// including trip summary, vehicle telemetry, communication stats, and mileage/ops data.
// It also provides action buttons for editing the trip, sending messages, and opening the trip in Turo.
// -------------------------------------------------------------------------- 



import "../../styles/selected-trip.css";
import {
  buildBouncieVehicleDetailsUrl,
  buildReplyUrl,
  buildTripUrl,
  deriveReturnEta,
  deriveStatusLabel,
  deriveTripWindow,
  formatDateShort,
  formatDateTime,
  formatMoney,
  formatMoneyPrecise,
  formatOdometer,
  formatRelativeComm,
  getBatteryAlert,
  getBatteryStatusLabel,
  getCommAlert,
  getMileageStats,
  getNextWorkflowStage,
  getRevenuePerDay,
  getTripProgressPercent,
  getTripVehicleLabel,
  getVehicleLocationLinkData,
  getVehicleStatusLabel,
  openUrl,
} from "./detailPanel.utils";

function formatStageLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatTollReviewStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized || normalized === "none") return "No tolls";
  if (normalized === "pending") return "Pending review";
  if (normalized === "reviewed") return "Reviewed";
  if (normalized === "submitted") return "Submitted";
  if (normalized === "resolved") return "Resolved";

  return normalized
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export default function SelectedTripPanel({
  selectedTrip,
  selectedVehicleInfo,
  vehiclesLoading,
  vehiclesError,
  onEditTrip,
  onAdvanceStage,
  stageSaving = false,
  maintenanceSummary,
  maintenanceLoading = false,
  maintenanceError = "",
  trips = [],
}) {
  const tripUrl = buildTripUrl(selectedTrip);
  const replyUrl = buildReplyUrl(selectedTrip);
  const progressPercent = getTripProgressPercent(selectedTrip);
  const revenuePerDay = getRevenuePerDay(selectedTrip);
  const selectedVehicle =
    selectedVehicleInfo?.vehicle || selectedVehicleInfo || null;

  console.log("SelectedTripPanel resolved vehicle", {
    tripId: selectedTrip?.id,
    reservationId: selectedTrip?.reservation_id,
    workflowStage: selectedTrip?.workflow_stage,
    selectedVehicleInfo,
    selectedVehicle,
    telemetry: selectedVehicle?.telemetry,
  });
  const selectedVehicleCommAlert = getCommAlert(selectedVehicle);
  const selectedVehicleBatteryAlert = getBatteryAlert(selectedVehicle);
  const mileageStats = getMileageStats(selectedTrip, selectedVehicle);
  const vehicleLabel = getTripVehicleLabel(selectedTrip, selectedVehicleInfo);
  const nextStage = getNextWorkflowStage(selectedTrip);

  const unbilledTolls = Number(selectedTrip?.toll_total ?? 0);
  const tollCount = Number(selectedTrip?.toll_count ?? 0);
  const fuelReimbursement = Number(selectedTrip?.fuel_reimbursement_total ?? 0);

  const tollVisibleStages = new Set([
    "in_progress",
    "awaiting_expenses",
    "turnaround",
    "completed",
  ]);

  const showTollFields = tollVisibleStages.has(selectedTrip?.workflow_stage);
  const hasTollExposure =
    Boolean(selectedTrip?.has_tolls) || tollCount > 0 || unbilledTolls > 0;

  const showFuelFields =
    selectedTrip?.workflow_stage === "awaiting_expenses" ||
    selectedTrip?.workflow_stage === "turnaround" ||
    selectedTrip?.workflow_stage === "completed";

  const tripTitle = `${vehicleLabel} • Trip #${
    selectedTrip.reservation_id || selectedTrip.id
  }`;

  // Determine trip assignment status for the selected vehicle
  const getVehicleAssignment = () => {
    if (!selectedVehicle || !trips.length) return null;

    const vehicleId = selectedVehicle.id;
    const now = new Date();

    // Find active trips for this vehicle
    const activeTrips = trips.filter(trip => {
      if (trip.vehicle_id !== vehicleId) return false;
      // Check if trip is active (not completed, canceled, etc.)
      const stage = trip.workflow_stage?.toLowerCase();
      const status = trip.status?.toLowerCase();
      return !(
        stage === 'completed' ||
        stage === 'canceled' ||
        status === 'completed' ||
        status === 'canceled' ||
        trip.closed_out
      );
    });

    if (activeTrips.length === 0) return { status: 'idle' };

    // If current selected trip is active for this vehicle, show it
    const currentTrip = activeTrips.find(t => t.id === selectedTrip.id);
    if (currentTrip) {
      return { status: 'current', trip: currentTrip };
    }

    // Find the next upcoming trip
    const upcomingTrips = activeTrips
      .filter(t => new Date(t.start_date) > now)
      .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

    if (upcomingTrips.length > 0) {
      return { status: 'next', trip: upcomingTrips[0] };
    }

    // If there are active trips but none upcoming, show the earliest active one
    const sortedActive = activeTrips.sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
    return { status: 'current', trip: sortedActive[0] };
  };

  const vehicleAssignment = getVehicleAssignment();

function renderLocationLink(vehicle) {
  const { label, url, title, clickable } = getVehicleLocationLinkData(vehicle);

    console.log(
  "renderLocationLink direct",
  vehicle?.nickname,
  "bouncie_vehicle_id=",
  vehicle?.bouncie_vehicle_id,
  "bouncie_url=",
  vehicle?.bouncie_url,
  "keys=",
  Object.keys(vehicle || {})
);


  if (!clickable) {
    return <span>{label}</span>;
  }

  return (
    <a
      className="detail-inline-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

  return (
    <aside className="panel detail-panel">
      <div className="panel-header detail-panel-header">
        <div className="detail-panel-header-main">
          <h2>Selected Trip Intelligence</h2>

          <div className="detail-panel-title-row">
            {tripUrl ? (
              <button
                type="button"
                className="detail-link-button"
                onClick={() => openUrl(tripUrl)}
              >
                {tripTitle}
              </button>
            ) : (
              <span className="detail-panel-title-text">{tripTitle}</span>
            )}
          </div>

          <div className="detail-panel-meta">
            <span>{selectedTrip.guest_name || "Unknown guest"}</span>
            <span>•</span>
            <span>{deriveStatusLabel(selectedTrip)}</span>
            <span>•</span>
            <span>{formatMoney(selectedTrip.amount)}</span>
          </div>
        </div>
      </div>

      <div className="detail-actions detail-actions--sticky">
        <button
          type="button"
          className="detail-action-button detail-action-button--edit"
          onClick={() => onEditTrip?.(selectedTrip)}
        >
          Edit trip
        </button>

        <button
          type="button"
          className="detail-action-button"
          onClick={() => openUrl(replyUrl)}
          disabled={!replyUrl}
        >
          Send message
        </button>

        <button
          type="button"
          className="detail-action-button secondary"
          onClick={() => openUrl(tripUrl)}
          disabled={!tripUrl}
        >
          Open in Turo
        </button>

        <button
          type="button"
          className="detail-action-button"
          disabled={!nextStage || stageSaving}
          onClick={() => onAdvanceStage?.(selectedTrip, nextStage)}
        >
          {stageSaving
            ? "Advancing…"
            : `Advance to ${nextStage ? formatStageLabel(nextStage) : "Next Stage"}`}
        </button>
      </div>

      <div className="detail-body">
        <div className="detail-progress-card">
          <div className="detail-progress-head">
            <div className="detail-label">Trip progress</div>
            <div className="detail-value">{Math.round(progressPercent)}%</div>
          </div>

          <div className="detail-progress-bar">
            <div
              className="detail-progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div className="detail-progress-sub">{deriveTripWindow(selectedTrip)}</div>
        </div>

        {vehiclesError ? (
          <div className="detail-card">
            <div className="detail-label">Telemetry</div>
            <div className="detail-value">{vehiclesError}</div>
          </div>
        ) : null}

        <div className="detail-grid">
          <div className="detail-card detail-card--section">
            <div className="detail-label">Trip Summary</div>

            <div className="detail-value">{selectedTrip.guest_name || "—"}</div>
            <div className="detail-subvalue">Guest</div>

            <hr className="detail-divider" />

            <div className="detail-row">
              <span>Vehicle</span>
              <strong>{vehicleLabel}</strong>
            </div>

            <div className="detail-row">
              <span>Status</span>
              <strong>{deriveStatusLabel(selectedTrip)}</strong>
            </div>

            <div className="detail-row">
              <span>Revenue</span>
              <strong>{formatMoney(selectedTrip.amount)}</strong>
            </div>

            <div className="detail-row">
              <span>/ Day</span>
              <strong>
                {revenuePerDay != null ? formatMoneyPrecise(revenuePerDay) : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Return ETA</span>
              <strong>{deriveReturnEta(selectedTrip)}</strong>
            </div>

            {showTollFields ? (
              <>
                <div className="detail-row">
                  <span>Tolls</span>
                  <strong>{hasTollExposure ? formatMoney(unbilledTolls) : "—"}</strong>
                </div>

                <div className="detail-row">
                  <span>Toll status</span>
                  <strong>
                    {hasTollExposure
                      ? `${tollCount} toll${tollCount === 1 ? "" : "s"} • ${formatTollReviewStatus(
                          selectedTrip?.toll_review_status
                        )}`
                      : "No tolls"}
                  </strong>
                </div>
              </>
            ) : null}

            {showFuelFields ? (
              <div className="detail-row">
                <span>Fuel reimbursement</span>
                <strong>{fuelReimbursement > 0 ? formatMoney(fuelReimbursement) : "—"}</strong>
              </div>
            ) : null}
          </div>

          <div className="detail-card detail-card--section">
            <div className="detail-label">Vehicle & Telemetry</div>

            <div className="detail-row">
              <span>Vehicle status</span>
              <strong>
                {selectedVehicle
                  ? getVehicleStatusLabel(selectedVehicle)
                  : vehiclesLoading
                  ? "Loading telemetry…"
                  : "Awaiting telemetry"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Current location</span>
              <strong>
                {selectedVehicle
                  ? renderLocationLink(selectedVehicle)
                  : vehiclesLoading
                  ? "Loading telemetry…"
                  : "Awaiting telemetry"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Last GPS communication</span>
              <strong>
                {selectedVehicle
                  ? formatRelativeComm(selectedVehicle?.telemetry?.last_comm)
                  : vehiclesLoading
                  ? "Loading telemetry…"
                  : "Awaiting telemetry"}
              </strong>
            </div>

            {selectedVehicleCommAlert ? (
              <div className={`fleet-inline-alert ${selectedVehicleCommAlert.level}`}>
                {selectedVehicleCommAlert.label}
              </div>
            ) : null}

            <div className="detail-row">
              <span>Battery status</span>
              <strong>
                {selectedVehicle
                  ? getBatteryStatusLabel(selectedVehicle)
                  : vehiclesLoading
                  ? "Loading telemetry…"
                  : "Awaiting telemetry"}
              </strong>
            </div>

            {selectedVehicleBatteryAlert ? (
              <div className={`fleet-inline-alert ${selectedVehicleBatteryAlert.level}`}>
                <span className="fleet-inline-alert-icon">
                  {selectedVehicleBatteryAlert.icon}
                </span>
                {selectedVehicleBatteryAlert.detail}
              </div>
            ) : null}

            <div className="detail-row">
              <span>Speed</span>
              <strong>
                {selectedVehicle?.telemetry?.speed != null
                  ? `${Math.round(Number(selectedVehicle.telemetry.speed))} mph`
                  : "—"}
              </strong>
            </div>

            <hr className="detail-divider" />

            <div className="detail-row">
              <span>Assignment status</span>
              <strong>
                {vehicleAssignment ? (
                  vehicleAssignment.status === 'idle' ? (
                    'Idle'
                  ) : vehicleAssignment.status === 'current' ? (
                    `Current: Trip #${vehicleAssignment.trip.reservation_id || vehicleAssignment.trip.id}`
                  ) : (
                    `Next: Trip #${vehicleAssignment.trip.reservation_id || vehicleAssignment.trip.id} (${formatDateShort(vehicleAssignment.trip.start_date)})`
                  )
                ) : (
                  '—'
                )}
              </strong>
            </div>
          </div>

          <div className="detail-card detail-card--section">
            <div className="detail-label">Communication</div>

            <div className="detail-row">
              <span>Messages</span>
              <strong>{selectedTrip.message_count ?? 0}</strong>
            </div>

            <div className="detail-row">
              <span>Unread</span>
              <strong>{selectedTrip.unread_messages ?? 0}</strong>
            </div>

            <div className="detail-row">
              <span>Last activity</span>
              <strong>{formatDateTime(selectedTrip.last_message_at)}</strong>
            </div>
          </div>

                    <div className="detail-card detail-card--section">
            <div className="detail-label">Mileage & Ops</div>

            <div className="detail-row">
              <span>Current odometer</span>
              <strong>
                {mileageStats.current != null ? formatOdometer(mileageStats.current) : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Starting odometer</span>
              <strong>
                {mileageStats.starting != null ? formatOdometer(mileageStats.starting) : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Ending odometer</span>
              <strong>
                {mileageStats.ending != null ? formatOdometer(mileageStats.ending) : "—"}
              </strong>
            </div>

            <hr className="detail-divider" />

            <div className="detail-row">
              <span>Allowed mileage</span>
              <strong>
                {mileageStats.allowed != null
                  ? `${Math.round(mileageStats.allowed).toLocaleString("en-US")} mi`
                  : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Used mileage</span>
              <strong>
                {mileageStats.used != null
                  ? `${Math.round(mileageStats.used).toLocaleString("en-US")} mi`
                  : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Remaining mileage</span>
              <strong>
                {mileageStats.remaining != null
                  ? `${Math.round(mileageStats.remaining).toLocaleString("en-US")} mi`
                  : "—"}
              </strong>
            </div>

            <div className="detail-row">
              <span>Maintenance</span>
              <strong>
                {maintenanceLoading
                  ? "Loading…"
                  : maintenanceError
                  ? "Unavailable"
                  : maintenanceSummary?.totalOpenTasks != null
                  ? maintenanceSummary.totalOpenTasks > 0
                    ? `${maintenanceSummary.totalOpenTasks} open item(s)`
                    : "No open items"
                  : "—"}
              </strong>
            </div>

            {maintenanceSummary?.totalOpenTasks > 0 ? (
              <div className="detail-subvalue">
                {[
                  maintenanceSummary?.openTaskCounts?.urgent
                    ? `${maintenanceSummary.openTaskCounts.urgent} urgent`
                    : null,
                  maintenanceSummary?.openTaskCounts?.high
                    ? `${maintenanceSummary.openTaskCounts.high} high`
                    : null,
                  maintenanceSummary?.openTaskCounts?.medium
                    ? `${maintenanceSummary.openTaskCounts.medium} medium`
                    : null,
                  maintenanceSummary?.openTaskCounts?.low
                    ? `${maintenanceSummary.openTaskCounts.low} low`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" • ")}
              </div>
            ) : null}

            <div className="detail-row">
              <span>Rental block</span>
              <strong>
                {maintenanceLoading
                  ? "Loading…"
                  : maintenanceSummary?.blocksRental === true
                  ? "Blocked"
                  : "Not blocked"}
              </strong>
            </div>

          </div>

        </div>
      </div>
    </aside>
  );
}