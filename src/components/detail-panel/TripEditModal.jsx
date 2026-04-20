// ------------------------------
// TripEditModal.jsx
// Edit trip details and manage workflow stage.
// Supports both normal stage advancement and direct stage override
// for historical cleanup / backfilled trips.
// ------------------------------

import { useEffect, useMemo, useState } from "react";
import "../../styles/trip-edit.css";

const API_BASE = "http://localhost:5000";

const STAGE_ORDER = [
  "booked",
  "confirmed",
  "ready_for_handoff",
  "in_progress",
  "turnaround",
  "awaiting_expenses",
  "complete",
  "canceled",
];

const TOLL_REVIEW_STATUS_OPTIONS = [
  { value: "none", label: "No tolls" },
  { value: "pending", label: "Pending review" },
  { value: "reviewed", label: "Reviewed" },
  { value: "billed", label: "Billed" },
  { value: "waived", label: "Waived" },
];

const EXPENSE_STATUS_OPTIONS = [
  { value: "none", label: "No expense claim" },
  { value: "pending", label: "Pending review" },
  { value: "submitted", label: "Submitted" },
  { value: "resolved", label: "Resolved" },
  { value: "waived", label: "Waived" },
];

function normalizeTollReviewStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "submitted" || normalized === "resolved") {
    return "billed";
  }

  if (TOLL_REVIEW_STATUS_OPTIONS.some((option) => option.value === normalized)) {
    return normalized;
  }

  return "none";
}

function resolveVehicleSelection(trip, vehiclesList) {
  const tripVehicleId = String(trip?.turo_vehicle_id ?? "").trim();
  const tripNames = [trip?.vehicle_name, trip?.vehicle_nickname]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  if (tripVehicleId) {
    const byId = vehiclesList.find((vehicle) => {
      const vehicleId = String(vehicle?.turo_vehicle_id ?? "").trim();
      return vehicleId && vehicleId === tripVehicleId;
    });

    if (byId) {
      const nickname = String(
        byId?.nickname ?? byId?.vehicle_name ?? byId?.turo_vehicle_name ?? ""
      ).trim();

      return {
        turo_vehicle_id: String(byId?.turo_vehicle_id ?? "").trim(),
        vehicle_name: nickname,
      };
    }
  }

  if (tripNames.length) {
    const byName = vehiclesList.find((vehicle) => {
      const candidates = [
        vehicle?.nickname,
        vehicle?.vehicle_name,
        vehicle?.turo_vehicle_name,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());

      return tripNames.some((name) => candidates.includes(name));
    });

    if (byName) {
      const nickname = String(
        byName?.nickname ?? byName?.vehicle_name ?? byName?.turo_vehicle_name ?? ""
      ).trim();

      return {
        turo_vehicle_id: String(byName?.turo_vehicle_id ?? "").trim(),
        vehicle_name: nickname,
      };
    }
  }

  return {
    turo_vehicle_id: "",
    vehicle_name: "",
  };
}

function toLocalInputValue(value) {
  if (!value) return "";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function toNullableIso(value) {
  if (!value) return null;

  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;

  const [year, month, day] = datePart.split("-").map(Number);
  const [hours, minutes] = timePart.split(":").map(Number);

  const d = new Date(year, month - 1, day, hours, minutes, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getNowLocalInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatStageLabel(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getDefaultNextStage(trip) {
  const allowed = Array.isArray(trip?.allowed_next_stages)
    ? trip.allowed_next_stages
    : [];

  if (!trip?.workflow_stage || !allowed.length) return "";

  const currentIndex = STAGE_ORDER.indexOf(trip.workflow_stage);

  for (let i = currentIndex + 1; i < STAGE_ORDER.length; i += 1) {
    if (allowed.includes(STAGE_ORDER[i])) {
      return STAGE_ORDER[i];
    }
  }

  return allowed[0] || "";
}

function tripHasEnded(trip) {
  if (!trip?.trip_end) return false;
  const endMs = new Date(trip.trip_end).getTime();
  return Number.isFinite(endMs) && endMs <= Date.now();
}

export default function TripEditModal({
  trip,
  isOpen,
  onClose,
  onSaved,
  vehicles = [],
}) {
  const [form, setForm] = useState({
    guest_name: "",
    vehicle_name: "",
    turo_vehicle_id: "",
    trip_start: "",
    trip_end: "",
    amount: "",
    mileage_included: "",
    starting_odometer: "",
    ending_odometer: "",
    has_tolls: false,
    toll_count: "",
    toll_total: "",
    toll_review_status: "pending",
    fuel_reimbursement_total: "",
    expense_status: "pending",
    closed_out: false,
    closed_out_at: "",
    notes: "",
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [stageSaving, setStageSaving] = useState(false);
  const [stageError, setStageError] = useState("");
  const [overrideStage, setOverrideStage] = useState("");

  const allowedNextStages = useMemo(
    () =>
      Array.isArray(trip?.allowed_next_stages) ? trip.allowed_next_stages : [],
    [trip]
  );

  const defaultNextStage = useMemo(() => getDefaultNextStage(trip), [trip]);

  const selectableVehicles = useMemo(() => {
    return vehicles
      .map((vehicle) => {
        const nickname = String(
          vehicle?.nickname ??
            vehicle?.vehicle_name ??
            vehicle?.turo_vehicle_name ??
            ""
        ).trim();

        const turoVehicleId = String(vehicle?.turo_vehicle_id ?? "").trim();

        const value = turoVehicleId || nickname;

        if (!value || !nickname) {
          return null;
        }

        const detail = [vehicle?.year, vehicle?.make, vehicle?.model]
          .filter(Boolean)
          .join(" ");

        return {
          value,
          turo_vehicle_id: turoVehicleId,
          vehicle_name: nickname,
          label: detail ? `${nickname} — ${detail}` : nickname,
          raw: vehicle,
        };
      })
      .filter(Boolean);
  }, [vehicles]);

  useEffect(() => {
    if (!trip || !isOpen) return;

    const vehicleSelection = resolveVehicleSelection(trip, vehicles);

    setForm({
      guest_name: trip.guest_name || "",
      vehicle_name: vehicleSelection.vehicle_name,
      turo_vehicle_id: String(vehicleSelection.turo_vehicle_id || ""),
      trip_start: toLocalInputValue(trip.trip_start),
      trip_end: toLocalInputValue(trip.trip_end),
      amount: trip.amount ?? "",
      mileage_included:
        trip.mileage_included ??
        trip.allowed_miles ??
        trip.trip_miles_included ??
        "",
      starting_odometer:
        trip.starting_odometer ??
        trip.start_odometer ??
        trip.odometer_start ??
        "",
      ending_odometer:
        trip.ending_odometer ??
        trip.end_odometer ??
        trip.odometer_end ??
        "",
      has_tolls: Boolean(trip.has_tolls),
      toll_count: trip.toll_count ?? "",
      toll_total: trip.toll_total ?? "",
      toll_review_status: normalizeTollReviewStatus(trip.toll_review_status),
      fuel_reimbursement_total: trip.fuel_reimbursement_total ?? "",
      expense_status: trip.expense_status || "pending",
      closed_out: Boolean(trip.closed_out),
      closed_out_at: toLocalInputValue(trip.closed_out_at),
      notes: trip.notes ?? "",
    });

    setError("");
    setStageError("");
    setOverrideStage("");
  }, [trip?.id, isOpen, vehicles]);

  useEffect(() => {
    if (!trip || !isOpen) return;
    if (!selectableVehicles.length) return;

    setForm((prev) => {
      if (String(prev.turo_vehicle_id || "").trim()) {
        return prev;
      }

      const vehicleSelection = resolveVehicleSelection(
        trip,
        selectableVehicles.map((item) => item.raw)
      );

      if (!String(vehicleSelection.turo_vehicle_id || "").trim()) {
        return prev;
      }

      return {
        ...prev,
        turo_vehicle_id: String(vehicleSelection.turo_vehicle_id || ""),
        vehicle_name: vehicleSelection.vehicle_name || "",
      };
    });
  }, [trip?.id, isOpen, selectableVehicles]);

  function handleChange(event) {
    const { name, value, type, checked } = event.target;
    const nextValue = type === "checkbox" ? checked : value;

    setForm((prev) => {
      if (name === "has_tolls" && !checked) {
        return {
          ...prev,
          has_tolls: false,
          toll_count: "",
          toll_total: "",
          toll_review_status: "none",
        };
      }

      if (name === "has_tolls" && checked) {
        return {
          ...prev,
          has_tolls: true,
          toll_count:
            prev.toll_count === "" || prev.toll_count == null || Number(prev.toll_count) < 1
              ? "1"
              : prev.toll_count,
          toll_review_status:
            prev.toll_review_status && prev.toll_review_status !== "none"
              ? prev.toll_review_status
              : "pending",
        };
      }

      if (name === "toll_total") {
        const numericTotal = Number(value);
        const hasTollTotal = Number.isFinite(numericTotal) && numericTotal > 0;
        return {
          ...prev,
          toll_total: value,
          has_tolls: hasTollTotal ? true : prev.has_tolls,
          toll_count:
            hasTollTotal &&
            (prev.toll_count === "" ||
              prev.toll_count == null ||
              Number(prev.toll_count) < 1)
              ? "1"
              : prev.toll_count,
          toll_review_status:
            hasTollTotal &&
            (!prev.toll_review_status || prev.toll_review_status === "none")
              ? "pending"
              : prev.toll_review_status,
        };
      }

      if (name === "toll_count") {
        const numericCount = Number(value);
        const hasTollCount = Number.isFinite(numericCount) && numericCount > 0;
        return {
          ...prev,
          toll_count: value,
          has_tolls: hasTollCount ? true : prev.has_tolls,
          toll_review_status:
            hasTollCount &&
            (!prev.toll_review_status || prev.toll_review_status === "none")
              ? "pending"
              : prev.toll_review_status,
        };
      }

      if (name === "toll_review_status") {
        const normalizedStatus = normalizeTollReviewStatus(value);
        const hasTollStatus = normalizedStatus !== "none";
        return {
          ...prev,
          toll_review_status: normalizedStatus,
          has_tolls: hasTollStatus ? true : prev.has_tolls,
          toll_count:
            hasTollStatus &&
            (prev.toll_count === "" ||
              prev.toll_count == null ||
              Number(prev.toll_count) < 1)
              ? "1"
              : prev.toll_count,
        };
      }

      if (name === "closed_out" && checked) {
        return {
          ...prev,
          closed_out: true,
          closed_out_at: prev.closed_out_at || getNowLocalInputValue(),
        };
      }

      if (name === "closed_out" && !checked) {
        return {
          ...prev,
          closed_out: false,
          closed_out_at: "",
        };
      }

      return {
        ...prev,
        [name]: nextValue,
      };
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!trip?.id) return;

    setSaving(true);
    setError("");

    try {
      const payload = {
        guest_name: form.guest_name || null,
        vehicle_name: form.vehicle_name || null,
        turo_vehicle_id: form.turo_vehicle_id || null,
        trip_start: toNullableIso(form.trip_start),
        trip_end: toNullableIso(form.trip_end),
        amount: form.amount === "" ? null : String(form.amount),
        mileage_included: toNullableNumber(form.mileage_included),
        starting_odometer: toNullableNumber(form.starting_odometer),
        ending_odometer: toNullableNumber(form.ending_odometer),
        has_tolls: Boolean(form.has_tolls),
        toll_count: toNullableNumber(form.toll_count) ?? 0,
        toll_total: form.toll_total === "" ? null : String(form.toll_total),
        toll_review_status: form.has_tolls
          ? form.toll_review_status || "pending"
          : "none",
        fuel_reimbursement_total: toNullableNumber(
          form.fuel_reimbursement_total
        ),
        expense_status: form.expense_status || null,
        closed_out: Boolean(form.closed_out),
        closed_out_at: form.closed_out ? toNullableIso(form.closed_out_at) : null,
        notes: form.notes || null,
        needs_review: false,
      };

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
      onSaved?.(savedTrip);
      onClose?.();
    } catch (err) {
      setError(err.message || "Failed to save trip");
    } finally {
      setSaving(false);
    }
  }

  async function handleStageChange(nextStage, force = false) {
    if (!trip?.id || !nextStage) return;

    setStageSaving(true);
    setStageError("");

    try {
      const resp = await fetch(`${API_BASE}/api/trips/${trip.id}/stage`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflow_stage: nextStage,
          force,
        }),
      });

      if (!resp.ok) {
        const maybeJson = await resp.json().catch(() => null);
        throw new Error(maybeJson?.error || `HTTP ${resp.status}`);
      }

      const savedTrip = await resp.json();
      onSaved?.(savedTrip);
      setOverrideStage("");
    } catch (err) {
      setStageError(err.message || "Failed to update workflow stage");
    } finally {
      setStageSaving(false);
    }
  }

  if (!isOpen || !trip) return null;

  const tollTotal = Number(form.toll_total || 0);
  const tollCount = Number(form.toll_count || 0);
  const hasTollExposure = Boolean(form.has_tolls) || tollTotal > 0 || tollCount > 0;
  const closeoutStages = new Set(["turnaround", "awaiting_expenses", "complete"]);
  const showTollFields =
    hasTollExposure || closeoutStages.has(trip.workflow_stage) || tripHasEnded(trip);

  return (
    <div className="trip-edit-overlay" onClick={onClose}>
      <aside
        className="trip-edit-drawer"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="trip-edit-header">
          <div>
            <h3>Edit Trip</h3>
            <div className="trip-edit-subtitle">
              {form.vehicle_name || trip.vehicle_name || "Unknown vehicle"} •{" "}
              Trip #{trip.reservation_id || trip.id}
            </div>
          </div>

          <button
            type="button"
            className="modal-close-button"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="trip-workflow-panel">
          <h4>Workflow</h4>

          <div className="trip-workflow-row">
            <div className="trip-workflow-item">
              <div className="trip-workflow-label">Current Stage</div>
              <div
                className={`trip-stage-badge stage-${
                  trip.workflow_stage || "unknown"
                }`}
              >
                {formatStageLabel(trip.workflow_stage || "unknown")}
              </div>
            </div>

            <div className="trip-workflow-item">
              <div className="trip-workflow-label">Stage Updated</div>
              <div className="trip-workflow-value">
                {trip.stage_updated_at
                  ? new Date(trip.stage_updated_at).toLocaleString()
                  : "—"}
              </div>
            </div>
          </div>

          <div className="trip-workflow-row">
            <div className="trip-workflow-item trip-workflow-item-wide">
              <div className="trip-workflow-label">Allowed Next Stages</div>
              <div className="trip-workflow-value">
                {allowedNextStages.length
                  ? allowedNextStages.map(formatStageLabel).join(", ")
                  : "None"}
              </div>
            </div>
          </div>

          <div className="trip-workflow-actions">
            <button
              type="button"
              className="detail-action-button"
              disabled={stageSaving || !defaultNextStage}
              onClick={() => handleStageChange(defaultNextStage, false)}
            >
              {stageSaving
                ? "Advancing…"
                : `Advance to ${
                    defaultNextStage
                      ? formatStageLabel(defaultNextStage)
                      : "Next Stage"
                  }`}
            </button>
          </div>

          <div className="trip-workflow-override">
            <div className="trip-workflow-label">Override Stage</div>
            <div className="trip-workflow-override-row">
              <select
                value={overrideStage}
                onChange={(event) => setOverrideStage(event.target.value)}
                disabled={stageSaving}
              >
                <option value="">Set stage directly</option>
                {STAGE_ORDER.map((stage) => (
                  <option key={stage} value={stage}>
                    {formatStageLabel(stage)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="detail-action-button secondary"
                disabled={stageSaving || !overrideStage}
                onClick={() => handleStageChange(overrideStage, true)}
              >
                Force Set Stage
              </button>
            </div>

            <div className="trip-workflow-help">
              Use override for historical cleanup, corrections, or backfilled trips.
            </div>
          </div>

          {stageError ? <div className="form-error">{stageError}</div> : null}
        </div>

        <form onSubmit={handleSubmit} className="trip-edit-form">
          <label>
            Guest Name
            <input
              name="guest_name"
              value={form.guest_name}
              onChange={handleChange}
            />
          </label>

          <label>
            Vehicle
            <select
              name="vehicle_selector"
              value={String(form.turo_vehicle_id || form.vehicle_name || "")}
              onChange={(event) => {
                const selectedValue = String(event.target.value || "");

                const selectedVehicle = selectableVehicles.find(
                  (vehicle) => vehicle.value === selectedValue
                );

                setForm((prev) => ({
                  ...prev,
                  turo_vehicle_id: selectedVehicle?.turo_vehicle_id || "",
                  vehicle_name: selectedVehicle?.vehicle_name || "",
                }));
              }}
            >
              <option value="">Select vehicle</option>

              {selectableVehicles.map((vehicle) => (
                <option key={vehicle.value} value={vehicle.value}>
                  {vehicle.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Trip Start
            <input
              type="datetime-local"
              name="trip_start"
              value={form.trip_start}
              onChange={handleChange}
            />
          </label>

          <label>
            Trip End
            <input
              type="datetime-local"
              name="trip_end"
              value={form.trip_end}
              onChange={handleChange}
            />
          </label>

          <label>
            Amount
            <input
              type="number"
              step="0.01"
              name="amount"
              value={form.amount}
              onChange={handleChange}
            />
          </label>

          <label>
            Mileage Included
            <input
              type="number"
              name="mileage_included"
              value={form.mileage_included}
              onChange={handleChange}
            />
          </label>

          <label>
            Starting Odometer
            <input
              type="number"
              name="starting_odometer"
              value={form.starting_odometer}
              onChange={handleChange}
            />
          </label>

          <label>
            Ending Odometer
            <input
              type="number"
              name="ending_odometer"
              value={form.ending_odometer}
              onChange={handleChange}
            />
          </label>

          {showTollFields ? (
            <>
              <label className="trip-edit-checkbox">
                <span>Has Tolls</span>
                <input
                  type="checkbox"
                  name="has_tolls"
                  checked={form.has_tolls}
                  onChange={handleChange}
                />
              </label>

              <label>
                Toll Count
                <input
                  type="number"
                  min="0"
                  name="toll_count"
                  value={form.toll_count}
                  onChange={handleChange}
                />
              </label>

              <label>
                Toll Total
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  name="toll_total"
                  value={form.toll_total}
                  onChange={handleChange}
                />
              </label>

              <label>
                Toll Review Status
                <select
                  name="toll_review_status"
                  value={form.toll_review_status}
                  onChange={handleChange}
                  disabled={!form.has_tolls}
                >
                  {TOLL_REVIEW_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}

          {trip?.workflow_stage === "awaiting_expenses" ||
          trip?.workflow_stage === "turnaround" ||
          trip?.workflow_stage === "complete" ? (
            <>
              <label>
                Fuel Reimbursement
                <input
                  type="number"
                  step="0.01"
                  name="fuel_reimbursement_total"
                  value={form.fuel_reimbursement_total}
                  onChange={handleChange}
                />
              </label>

              <label>
                Expense Status
                <select
                  name="expense_status"
                  value={form.expense_status}
                  onChange={handleChange}
                >
                  {EXPENSE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}

          {trip?.trip_end && new Date(trip.trip_end).getTime() <= Date.now() ? (
            <>
              <label className="trip-edit-checkbox">
                <span>Closed Out</span>
                <input
                  type="checkbox"
                  name="closed_out"
                  checked={form.closed_out}
                  onChange={handleChange}
                />
              </label>

              <label>
                Closed Out At
                <input
                  type="datetime-local"
                  name="closed_out_at"
                  value={form.closed_out_at}
                  onChange={handleChange}
                  disabled={!form.closed_out}
                />
              </label>
            </>
          ) : null}

          <label>
            Correction Notes
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={4}
            />
          </label>

          {error ? <div className="form-error">{error}</div> : null}

          <div className="trip-edit-actions">
            <button
              type="button"
              className="detail-action-button secondary"
              onClick={onClose}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="detail-action-button"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save Trip"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
