// --------------------------------------------------------------------------
// ./src/components/detail-panel/SelectedTripPanel.jsx
// This component displays detailed information about the currently selected trip,
// including trip summary, vehicle telemetry, communication stats, and mileage/ops data.
// It also provides action buttons for editing the trip, sending messages, and opening the trip in Turo.
// -------------------------------------------------------------------------- 

import { useEffect, useMemo, useState } from "react";
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

function formatStageActionLabel(value) {
  if (value === "turnaround") return "Vehicle returned";
  return `Advance to ${value ? formatStageLabel(value) : "Next Stage"}`;
}

function formatTollReviewStatus(value, hasTollExposure = false) {
  const normalized = String(value || "").trim().toLowerCase();

  if (!normalized || normalized === "none") {
    return hasTollExposure ? "Needs audit" : "No tolls";
  }
  if (normalized === "pending") return "Pending review";
  if (normalized === "reviewed") return "Reviewed";
  if (normalized === "billed") return "Billed";
  if (normalized === "waived") return "Waived";

  return normalized
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatRpm(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  return `${Math.round(num).toLocaleString("en-US")} RPM`;
}

const EXPENSE_STATUS_OPTIONS = [
  { value: "none", label: "No Turo expense claim" },
  { value: "pending", label: "Needs Turo review" },
  { value: "submitted", label: "Submitted in Turo" },
  { value: "resolved", label: "Paid or resolved" },
  { value: "waived", label: "Waived" },
];

const TOLL_REVIEW_OPTIONS = [
  { value: "none", label: "No tolls" },
  { value: "pending", label: "Needs audit" },
  { value: "reviewed", label: "Audited" },
  { value: "billed", label: "Billed in Turo" },
  { value: "waived", label: "Waived" },
];

function toFieldValue(value) {
  return value == null ? "" : String(value);
}

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getNowIso() {
  return new Date().toISOString();
}

export default function SelectedTripPanel({
  selectedTrip,
  selectedVehicleInfo,
  vehiclesLoading,
  vehiclesError,
  onEditTrip,
  onAdvanceStage,
  stageSaving = false,
  onCloseoutSave,
  closeoutSaving = false,
  closeoutError = "",
  maintenanceSummary,
  maintenanceLoading = false,
  maintenanceError = "",
  trips = [],
}) {
  const [closeoutForm, setCloseoutForm] = useState({
    starting_odometer: "",
    ending_odometer: "",
    expense_status: "pending",
    fuel_reimbursement_total: "",
    has_tolls: false,
    toll_count: "",
    toll_total: "",
    toll_review_status: "none",
    closed_out: false,
  });
  const [closeoutSavedNotice, setCloseoutSavedNotice] = useState("");

  useEffect(() => {
    setCloseoutForm({
      starting_odometer: toFieldValue(
        selectedTrip?.starting_odometer ??
          selectedTrip?.start_odometer ??
          selectedTrip?.odometer_start
      ),
      ending_odometer: toFieldValue(
        selectedTrip?.ending_odometer ??
          selectedTrip?.end_odometer ??
          selectedTrip?.odometer_end
      ),
      expense_status: selectedTrip?.expense_status || "pending",
      fuel_reimbursement_total: toFieldValue(selectedTrip?.fuel_reimbursement_total),
      has_tolls: Boolean(selectedTrip?.has_tolls),
      toll_count: toFieldValue(selectedTrip?.toll_count),
      toll_total: toFieldValue(selectedTrip?.toll_total),
      toll_review_status: selectedTrip?.toll_review_status || "none",
      closed_out: Boolean(selectedTrip?.closed_out),
    });
    setCloseoutSavedNotice("");
  }, [selectedTrip?.id, selectedTrip?.updated_at]);

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

  const tollTotal = Number(selectedTrip?.toll_total ?? 0);
  const tollCount = Number(selectedTrip?.toll_count ?? 0);
  const tollStatus = String(selectedTrip?.toll_review_status || "none").toLowerCase();
  const fuelReimbursement = Number(selectedTrip?.fuel_reimbursement_total ?? 0);
  const tripEndMs = selectedTrip?.trip_end
    ? new Date(selectedTrip.trip_end).getTime()
    : NaN;
  const tripHasEnded = Number.isFinite(tripEndMs) && tripEndMs <= Date.now();
  const closeoutStages = new Set(["turnaround", "awaiting_expenses", "complete"]);
  const isCloseoutStage = closeoutStages.has(selectedTrip?.workflow_stage);
  const hasTollExposure =
    Boolean(selectedTrip?.has_tolls) || tollCount > 0 || tollTotal > 0;
  const hasOpenTolls =
    hasTollExposure && !["billed", "waived"].includes(tollStatus);
  const showTollFields = hasTollExposure || isCloseoutStage || tripHasEnded;

  const showFuelFields =
    selectedTrip?.workflow_stage === "awaiting_expenses" ||
    selectedTrip?.workflow_stage === "turnaround" ||
    selectedTrip?.workflow_stage === "complete";

  const tripTitle = `${vehicleLabel} • Trip #${
    selectedTrip.reservation_id || selectedTrip.id
  }`;

  const canShowCloseoutOps =
    tripHasEnded || isCloseoutStage || Boolean(selectedTrip?.closed_out);

  const closeoutChecks = useMemo(() => {
    const expenseStatus = String(closeoutForm.expense_status || "").toLowerCase();
    const tollReview = String(closeoutForm.toll_review_status || "").toLowerCase();
    const tollTotalValue = Number(closeoutForm.toll_total || 0);
    const tollCountValue = Number(closeoutForm.toll_count || 0);
    const hasTollsValue =
      Boolean(closeoutForm.has_tolls) || tollTotalValue > 0 || tollCountValue > 0;

    return [
      {
        key: "stage",
        label: "Workflow is ready",
        done: ["complete", "canceled"].includes(
          String(selectedTrip?.workflow_stage || "").toLowerCase()
        ),
      },
      {
        key: "start_odo",
        label: "Starting odometer recorded",
        done: toNullableNumber(closeoutForm.starting_odometer) != null,
      },
      {
        key: "end_odo",
        label: "Ending odometer recorded",
        done: toNullableNumber(closeoutForm.ending_odometer) != null,
      },
      {
        key: "expenses",
        label: "Turo expenses reconciled",
        done: ["none", "submitted", "resolved", "waived"].includes(expenseStatus),
      },
      {
        key: "tolls",
        label: "Tolls audited for Turo",
        done:
          !hasTollsValue ||
          ["billed", "waived", "none"].includes(tollReview),
      },
      {
        key: "closed",
        label: "Closeout flag set",
        done: Boolean(closeoutForm.closed_out),
      },
    ];
  }, [closeoutForm, selectedTrip?.workflow_stage]);

  const closeoutRemaining = closeoutChecks.filter((item) => !item.done).length;
  const closeoutBlockers = closeoutChecks.filter(
    (item) => item.key !== "closed" && !item.done
  );

  function updateCloseoutField(key, value) {
    setCloseoutSavedNotice("");
    setCloseoutForm((prev) => {
      const next = {
        ...prev,
        [key]: value,
      };

      if (key === "has_tolls" && !value) {
        next.toll_count = "";
        next.toll_total = "";
        next.toll_review_status = "none";
      }

      if ((key === "toll_count" || key === "toll_total") && Number(value) > 0) {
        next.has_tolls = true;
        if (!next.toll_review_status || next.toll_review_status === "none") {
          next.toll_review_status = "pending";
        }
      }

      if (key === "toll_review_status" && value !== "none") {
        next.has_tolls = true;
        if (!next.toll_count || Number(next.toll_count) < 1) {
          next.toll_count = "1";
        }
      }

      return next;
    });
  }

  function buildCloseoutPayload(overrides = {}) {
    const merged = {
      ...closeoutForm,
      ...overrides,
    };
    const hasTollsPayload =
      Boolean(merged.has_tolls) ||
      Number(merged.toll_count || 0) > 0 ||
      Number(merged.toll_total || 0) > 0;
    const closedOut = Boolean(merged.closed_out);

    return {
      starting_odometer: toNullableNumber(merged.starting_odometer),
      ending_odometer: toNullableNumber(merged.ending_odometer),
      expense_status: merged.expense_status || "pending",
      fuel_reimbursement_total: toNullableNumber(merged.fuel_reimbursement_total),
      has_tolls: hasTollsPayload,
      toll_count: hasTollsPayload ? toNullableNumber(merged.toll_count) ?? 0 : 0,
      toll_total: hasTollsPayload ? toNullableNumber(merged.toll_total) ?? 0 : 0,
      toll_review_status: hasTollsPayload
        ? merged.toll_review_status || "pending"
        : "none",
      closed_out: closedOut,
      closed_out_at: closedOut ? selectedTrip?.closed_out_at || getNowIso() : null,
      needs_review: false,
    };
  }

  async function saveCloseout(overrides = {}) {
    if (!onCloseoutSave) return;
    const optimisticForm = {
      ...closeoutForm,
      ...overrides,
    };
    const optimisticPayload = buildCloseoutPayload(overrides);

    const savedTrip = await onCloseoutSave(
      selectedTrip,
      optimisticPayload
    );

    if (savedTrip) {
      setCloseoutForm({
        starting_odometer: toFieldValue(
          savedTrip.starting_odometer ?? optimisticForm.starting_odometer
        ),
        ending_odometer: toFieldValue(
          savedTrip.ending_odometer ?? optimisticForm.ending_odometer
        ),
        expense_status:
          savedTrip.expense_status || optimisticForm.expense_status || "pending",
        fuel_reimbursement_total: toFieldValue(
          savedTrip.fuel_reimbursement_total ??
            optimisticForm.fuel_reimbursement_total
        ),
        has_tolls: Boolean(savedTrip.has_tolls ?? optimisticPayload.has_tolls),
        toll_count: toFieldValue(savedTrip.toll_count ?? optimisticPayload.toll_count),
        toll_total: toFieldValue(savedTrip.toll_total ?? optimisticPayload.toll_total),
        toll_review_status:
          savedTrip.toll_review_status ||
          optimisticPayload.toll_review_status ||
          "none",
        closed_out: Boolean(savedTrip.closed_out ?? optimisticPayload.closed_out),
      });
      setCloseoutSavedNotice("Saved to trip record");
    }
  }

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
            : formatStageActionLabel(nextStage)}
        </button>
      </div>

      <div className="detail-body">
        {canShowCloseoutOps ? (
          <div className="detail-closeout-panel">
            <div className="detail-closeout-head">
              <div>
                <div className="detail-label">Turo reconciliation</div>
                <div className="detail-closeout-title">
                  {closeoutRemaining
                    ? `${closeoutRemaining} item${closeoutRemaining === 1 ? "" : "s"} left`
                    : "Ready to close"}
                </div>
                <div className="detail-closeout-copy">
                  Audit HCTRA tolls, send tolls and incidentals through Turo,
                  then transcribe the result here.
                </div>
              </div>
              <button
                type="button"
                className="detail-action-button detail-action-button--edit"
                disabled={
                  closeoutSaving ||
                  Boolean(closeoutForm.closed_out) ||
                  closeoutBlockers.length > 0
                }
                onClick={() => saveCloseout({ closed_out: true })}
              >
                {closeoutSaving
                  ? "Saving..."
                  : closeoutForm.closed_out
                  ? "Closed out"
                  : "Close out trip"}
              </button>
            </div>

            <div className="detail-closeout-checks">
              {closeoutChecks.map((item) => (
                <div
                  key={item.key}
                  className={`detail-closeout-check ${
                    item.done ? "detail-closeout-check--done" : ""
                  }`}
                >
                  <span>{item.done ? "Done" : "Open"}</span>
                  <strong>{item.label}</strong>
                </div>
              ))}
            </div>

            <div className="detail-closeout-grid">
              <label className="detail-closeout-field">
                <span>Starting odometer</span>
                <input
                  type="number"
                  value={closeoutForm.starting_odometer}
                  onChange={(event) =>
                    updateCloseoutField("starting_odometer", event.target.value)
                  }
                />
              </label>

              <label className="detail-closeout-field">
                <span>Ending odometer</span>
                <input
                  type="number"
                  value={closeoutForm.ending_odometer}
                  onChange={(event) =>
                    updateCloseoutField("ending_odometer", event.target.value)
                  }
                />
              </label>

              <label className="detail-closeout-field">
                <span>Turo expense status</span>
                <select
                  value={closeoutForm.expense_status}
                  onChange={(event) =>
                    updateCloseoutField("expense_status", event.target.value)
                  }
                >
                  {EXPENSE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="detail-closeout-field">
                <span>Fuel reimbursement</span>
                <input
                  type="number"
                  step="0.01"
                  value={closeoutForm.fuel_reimbursement_total}
                  onChange={(event) =>
                    updateCloseoutField("fuel_reimbursement_total", event.target.value)
                  }
                />
              </label>

              <label className="detail-closeout-field detail-closeout-checkfield">
                <span>Has tolls</span>
                <input
                  type="checkbox"
                  checked={closeoutForm.has_tolls}
                  onChange={(event) =>
                    updateCloseoutField("has_tolls", event.target.checked)
                  }
                />
              </label>

              <label className="detail-closeout-field">
                <span>Toll count</span>
                <input
                  type="number"
                  min="0"
                  value={closeoutForm.toll_count}
                  onChange={(event) =>
                    updateCloseoutField("toll_count", event.target.value)
                  }
                  disabled={!closeoutForm.has_tolls}
                />
              </label>

              <label className="detail-closeout-field">
                <span>Toll total</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={closeoutForm.toll_total}
                  onChange={(event) =>
                    updateCloseoutField("toll_total", event.target.value)
                  }
                  disabled={!closeoutForm.has_tolls}
                />
              </label>

              <label className="detail-closeout-field">
                <span>Turo toll status</span>
                <select
                  value={closeoutForm.toll_review_status}
                  onChange={(event) =>
                    updateCloseoutField("toll_review_status", event.target.value)
                  }
                  disabled={!closeoutForm.has_tolls}
                >
                  {TOLL_REVIEW_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="detail-closeout-actions">
              <button
                type="button"
                className="detail-action-button secondary"
                disabled={closeoutSaving}
                onClick={() => saveCloseout({ expense_status: "resolved" })}
              >
                Expenses reconciled
              </button>
              <button
                type="button"
                className="detail-action-button secondary"
                disabled={closeoutSaving}
                onClick={() =>
                  saveCloseout({
                    has_tolls: false,
                    toll_count: "",
                    toll_total: "",
                    toll_review_status: "none",
                  })
                }
              >
                No tolls to bill
              </button>
              <button
                type="button"
                className="detail-action-button"
                disabled={closeoutSaving}
                onClick={() => saveCloseout()}
              >
                {closeoutSaving ? "Saving..." : "Save reconciliation"}
              </button>
            </div>

            {closeoutError ? (
              <div className="detail-closeout-error">{closeoutError}</div>
            ) : null}
            {closeoutSavedNotice ? (
              <div className="detail-closeout-saved">{closeoutSavedNotice}</div>
            ) : null}
          </div>
        ) : null}

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
                  <strong>
                    {hasTollExposure ? formatMoney(tollTotal) : "No tolls recorded"}
                  </strong>
                </div>

                <div className="detail-row">
                  <span>Toll status</span>
                  <strong>
                    {hasTollExposure
                      ? `${tollCount} toll${tollCount === 1 ? "" : "s"} • ${formatTollReviewStatus(
                          selectedTrip?.toll_review_status,
                          hasTollExposure
                        )}`
                      : "No tolls"}
                  </strong>
                </div>

                <div className="detail-row">
                  <span>Open tolls</span>
                  <strong>{hasOpenTolls ? "Yes - needs billing/review" : "No"}</strong>
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
              <span>Max observed RPM</span>
              <strong>{formatRpm(selectedTrip.max_engine_rpm)}</strong>
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
