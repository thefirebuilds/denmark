import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

const TOLL_REVIEW_STATUS_OPTIONS = [
  { value: "", label: "— Select toll review status —" },
  { value: "none", label: "None" },
  { value: "pending", label: "Pending" },
  { value: "reviewed", label: "Reviewed" },
  { value: "billed", label: "Billed" },
  { value: "waived", label: "Waived" },
];

const WORKFLOW_STAGE_OPTIONS = [
  { value: "", label: "— Select workflow stage —" },
  { value: "booked_unconfirmed", label: "Booked - Needs Review" },
  { value: "updated_unconfirmed", label: "Updated - Needs Review" },
  { value: "booked", label: "Booked" },
  { value: "confirmed", label: "Confirmed" },
  { value: "ready_for_handoff", label: "Ready for Handoff" },
  { value: "in_progress", label: "In Progress" },
  { value: "turnaround", label: "Turnaround" },
  { value: "awaiting_expenses", label: "Awaiting Expenses" },
  { value: "complete", label: "Complete" },
  { value: "canceled", label: "Canceled" },
];

const EXPENSE_STATUS_OPTIONS = [
  { value: "", label: "— Select expense status —" },
  { value: "none", label: "None" },
  { value: "pending", label: "Pending" },
  { value: "submitted", label: "Submitted" },
  { value: "resolved", label: "Resolved" },
  { value: "waived", label: "Waived" },
];

const STATUS_OPTIONS = [
  { value: "", label: "— Select status —" },
  { value: "booked", label: "Booked" },
  { value: "confirmed", label: "Confirmed" },
  { value: "active", label: "Active" },
  { value: "complete", label: "Complete" },
  { value: "canceled", label: "Canceled" },
];

function toInputDateTime(value) {
  if (!value) return "";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toNullableIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function formatStatusLabel(value) {
  const text = String(value || "")
    .trim()
    .replace(/[_-]+/g, " ");

  if (!text) return "—";

  return text.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVehicleOptionLabel(vehicle) {
  const nickname = String(vehicle?.nickname || "").trim();
  if (nickname) return nickname;

  const details = [vehicle?.year, vehicle?.make, vehicle?.model]
    .filter(Boolean)
    .join(" ");

  return details || `Vehicle ${vehicle?.id ?? ""}`.trim();
}

export default function TripSummaryDrawer({
  open,
  trip,
  vehicles = [],
  onClose,
  onSave,
  onDelete,
}) {
  const isNewTrip = !trip?.id;
  const [form, setForm] = useState({
    reservation_id: "",
    guest_name: "",
    vehicle_name: "",
    turo_vehicle_id: "",
    trip_start: "",
    trip_end: "",
    status: "",
    amount: "",
    needs_review: false,
    mileage_included: "",
    starting_odometer: "",
    ending_odometer: "",
    has_tolls: false,
    toll_count: "",
    toll_total: "",
    toll_review_status: "",
    fuel_reimbursement_total: "",
    closed_out: false,
    closed_out_at: "",
    workflow_stage: "",
    stage_updated_at: "",
    expense_status: "",
    completed_at: "",
    canceled_at: "",
    trip_details_url: "",
    guest_profile_url: "",
    message_count: "",
    unread_messages: "",
    last_message_at: "",
    last_unread_at: "",
    notes: "",
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");

  const sortedVehicles = useMemo(() => {
    return [...vehicles].sort((a, b) =>
      getVehicleOptionLabel(a).localeCompare(getVehicleOptionLabel(b), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  }, [vehicles]);

  useEffect(() => {
    if (!trip) return;

    setForm({
      reservation_id: trip.reservation_id ?? "",
      guest_name: trip.guest_name ?? "",
      vehicle_name: trip.vehicle_nickname ?? trip.vehicle_name ?? "",
      turo_vehicle_id: trip.turo_vehicle_id == null ? "" : String(trip.turo_vehicle_id),
      trip_start: toInputDateTime(trip.trip_start),
      trip_end: toInputDateTime(trip.trip_end),
      status: trip.status ?? "",
      amount: trip.amount ?? trip.gross_income ?? "",
      needs_review: Boolean(trip.needs_review),
      mileage_included: trip.mileage_included ?? "",
      starting_odometer: trip.starting_odometer ?? "",
      ending_odometer: trip.ending_odometer ?? "",
      has_tolls: Boolean(trip.has_tolls),
      toll_count: trip.toll_count ?? "",
      toll_total: trip.toll_total ?? "",
      toll_review_status: trip.toll_review_status ?? "",
      fuel_reimbursement_total: trip.fuel_reimbursement_total ?? "",
      closed_out: Boolean(trip.closed_out),
      closed_out_at: toInputDateTime(trip.closed_out_at),
      workflow_stage: trip.workflow_stage ?? "",
      stage_updated_at: toInputDateTime(trip.stage_updated_at),
      expense_status: trip.expense_status ?? "",
      completed_at: toInputDateTime(trip.completed_at),
      canceled_at: toInputDateTime(trip.canceled_at),
      trip_details_url: trip.trip_details_url ?? "",
      guest_profile_url: trip.guest_profile_url ?? "",
      message_count: trip.message_count ?? "",
      unread_messages: trip.unread_messages ?? "",
      last_message_at: toInputDateTime(trip.last_message_at),
      last_unread_at: toInputDateTime(trip.last_unread_at),
      notes: trip.notes ?? "",
    });
  }, [trip]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e) {
      if (e.key === "Escape") onClose();
    }

    document.addEventListener("keydown", handleKeyDown);
    document.body.classList.add("drawer-open");

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.classList.remove("drawer-open");
    };
  }, [open, onClose]);

  if (!open || !trip) return null;

function updateField(key, value) {
  setForm((prev) => {
    const next = {
      ...prev,
      [key]: value,
    };

    if (key === "toll_total") {
      const numericTotal =
        value === "" || value == null ? null : Number(value);

      if (Number.isFinite(numericTotal) && numericTotal > 0) {
        next.has_tolls = true;

        if (
          next.toll_count === "" ||
          next.toll_count == null ||
          Number(next.toll_count) < 1
        ) {
          next.toll_count = "1";
        }

        if (!next.toll_review_status || next.toll_review_status === "none") {
          next.toll_review_status = "pending";
        }
      }

      if (value === "" || Number(value) <= 0) {
        next.has_tolls = false;
      }
    }

    if (key === "toll_count") {
      const numericCount =
        value === "" || value == null ? null : Number(value);

      if (Number.isFinite(numericCount) && numericCount > 0) {
        next.has_tolls = true;

        if (!next.toll_review_status || next.toll_review_status === "none") {
          next.toll_review_status = "pending";
        }
      }
    }

    if (key === "toll_review_status") {
      if (value && value !== "none") {
        next.has_tolls = true;

        if (
          next.toll_count === "" ||
          next.toll_count == null ||
          Number(next.toll_count) < 1
        ) {
          next.toll_count = "1";
        }
      }
    }

    return next;
  });
}

function updateCheckbox(key, checked) {
  setForm((prev) => {
    const next = {
      ...prev,
      [key]: checked,
    };

    if (key === "has_tolls") {
      if (checked) {
        if (
          next.toll_count === "" ||
          next.toll_count == null ||
          Number(next.toll_count) < 1
        ) {
          next.toll_count = "1";
        }

        if (!next.toll_review_status || next.toll_review_status === "none") {
          next.toll_review_status = "pending";
        }
      } else {
        const tollTotal = Number(next.toll_total ?? 0);
        const tollCount = Number(next.toll_count ?? 0);

        if (tollTotal > 0 || tollCount > 0) {
          next.has_tolls = true;
        } else {
          next.toll_review_status = "none";
        }
      }
    }

    if (key === "closed_out") {
      if (checked) {
        if (!next.closed_out_at) {
          const now = new Date();
          const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
          next.closed_out_at = local.toISOString().slice(0, 16);
        }

        if (!next.completed_at && next.workflow_stage === "complete") {
          const now = new Date();
          const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
          next.completed_at = local.toISOString().slice(0, 16);
        }
      } else {
        next.closed_out_at = "";
      }
    }

    if (key === "needs_review") {
      if (checked && next.expense_status === "resolved") {
        next.expense_status = "pending";
      }
    }

    return next;
  });
}

  function handleVehicleChange(nextValue) {
    if (!nextValue) {
      setForm((prev) => ({
        ...prev,
        turo_vehicle_id: "",
        vehicle_name: "",
      }));
      return;
    }

    const selectedVehicle =
      sortedVehicles.find(
        (vehicle) => String(vehicle?.turo_vehicle_id ?? "") === String(nextValue)
      ) || null;

    setForm((prev) => ({
      ...prev,
      turo_vehicle_id: String(nextValue),
      vehicle_name: selectedVehicle?.nickname || "",
    }));
  }

async function handleSubmit(e) {
  e.preventDefault();
  setSaving(true);
  setError("");
  setSaveNotice("");

  try {
    const numericTollTotal = toNullableNumber(form.toll_total);
    const numericTollCount = toNullableNumber(form.toll_count);

    const hasMeaningfulTolls =
      (Number.isFinite(numericTollTotal) && numericTollTotal > 0) ||
      (Number.isFinite(numericTollCount) && numericTollCount > 0) ||
      Boolean(form.has_tolls) ||
      (form.toll_review_status &&
        form.toll_review_status !== "" &&
        form.toll_review_status !== "none");

    const normalizedHasTolls = hasMeaningfulTolls;
    const normalizedTollCount = hasMeaningfulTolls
      ? Math.max(1, Number.isFinite(numericTollCount) ? numericTollCount : 1)
      : 0;
    const normalizedTollReviewStatus = hasMeaningfulTolls
      ? form.toll_review_status && form.toll_review_status !== "none"
        ? form.toll_review_status
        : "pending"
      : "none";

    const payload = {
      id: trip.id,
      reservation_id: form.reservation_id || null,
      guest_name: form.guest_name || null,
      vehicle_name: form.vehicle_name || null,
      turo_vehicle_id:
        form.turo_vehicle_id === "" ? null : form.turo_vehicle_id,
      trip_start: toNullableIso(form.trip_start),
      trip_end: toNullableIso(form.trip_end),
      status: form.status || null,
      amount:
        form.amount === "" || form.amount == null
          ? null
          : Number(form.amount),
      needs_review: Boolean(form.needs_review),
      mileage_included: toNullableNumber(form.mileage_included),
      starting_odometer: toNullableNumber(form.starting_odometer),
      ending_odometer: toNullableNumber(form.ending_odometer),
      has_tolls: normalizedHasTolls,
      toll_count: normalizedTollCount,
      toll_total: numericTollTotal ?? 0,
      toll_review_status: normalizedTollReviewStatus,
      fuel_reimbursement_total: toNullableNumber(form.fuel_reimbursement_total),
      closed_out: Boolean(form.closed_out),
      closed_out_at: toNullableIso(form.closed_out_at),
      workflow_stage: form.workflow_stage || null,
      stage_updated_at: toNullableIso(form.stage_updated_at),
      expense_status: form.expense_status || null,
      completed_at: toNullableIso(form.completed_at),
      canceled_at: toNullableIso(form.canceled_at),
      trip_details_url: form.trip_details_url || null,
      guest_profile_url: form.guest_profile_url || null,
      message_count: toNullableNumber(form.message_count),
      unread_messages: toNullableNumber(form.unread_messages),
      last_message_at: toNullableIso(form.last_message_at),
      last_unread_at: toNullableIso(form.last_unread_at),
      notes: form.notes || null,
    };

    const saved = await onSave(payload);

    setForm((prev) => ({
      ...prev,
      has_tolls: Boolean(saved?.has_tolls ?? payload.has_tolls),
      toll_count: String(saved?.toll_count ?? payload.toll_count ?? ""),
      toll_total:
        saved?.toll_total != null
          ? String(saved.toll_total)
          : String(payload.toll_total ?? ""),
      toll_review_status:
        saved?.toll_review_status ?? payload.toll_review_status ?? "none",
      closed_out: Boolean(saved?.closed_out ?? payload.closed_out),
      closed_out_at: toInputDateTime(saved?.closed_out_at ?? payload.closed_out_at),
      updated_at: saved?.updated_at ?? prev.updated_at,
    }));

    setSaveNotice("Saved successfully.");
    return saved;
  } catch (err) {
    setError(err.message || "Failed to save trip");
  } finally {
    setSaving(false);
  }
}

  async function handleDelete() {
    const confirmed = window.confirm(
      `Delete trip for ${trip.guest_name || "this guest"}?`
    );
    if (!confirmed) return;

    setSaving(true);
    setError("");

    try {
      await onDelete(trip.id);
    } catch (err) {
      setError(err.message || "Failed to delete trip");
    } finally {
      setSaving(false);
    }
  }

  const startingOdometer = toNullableNumber(form.starting_odometer);
  const endingOdometer = toNullableNumber(form.ending_odometer);
  const usedMileage =
    startingOdometer != null && endingOdometer != null
      ? endingOdometer - startingOdometer
      : null;

  return createPortal(
    <div
      className="app-drawer-backdrop trip-summary-drawer-backdrop"
      onClick={onClose}
    >
      <div
        className="app-drawer trip-summary-drawer"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trip-summary-drawer-title"
      >
        <div className="app-drawer-header trip-summary-drawer-header">
          <div className="trip-summary-drawer-title-wrap">
            <h2 id="trip-summary-drawer-title">
              {isNewTrip ? "New Trip" : "Edit Trip"}
            </h2>
            <div className="trip-summary-drawer-subtitle">
              <span>{trip.vehicle_name || trip.vehicle_nickname || "Unknown Vehicle"}</span>
              <span> • </span>
              <span>{trip.guest_name || "Unknown Guest"}</span>
              <span> • </span>
              <span>{isNewTrip ? "Manual entry" : `Trip ID: ${trip.id ?? "new"}`}</span>
            </div>
          </div>

          <button
            type="button"
            className="trip-summary-drawer-close"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </div>

        <form className="app-drawer-body trip-summary-drawer-body" onSubmit={handleSubmit}>
          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Core Trip Info</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Trip ID</span>
                <input value={isNewTrip ? "New trip" : trip.id ?? ""} readOnly />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Reservation ID</span>
                <input
                  value={form.reservation_id}
                  onChange={(e) => updateField("reservation_id", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Guest Name</span>
                <input
                  value={form.guest_name}
                  onChange={(e) => updateField("guest_name", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Assigned Vehicle</span>
                <select
                  value={form.turo_vehicle_id}
                  onChange={(e) => handleVehicleChange(e.target.value)}
                >
                  <option value="">No vehicle assigned</option>
                  {sortedVehicles.map((vehicle) => (
                    <option
                      key={vehicle.id}
                      value={String(vehicle?.turo_vehicle_id ?? "")}
                    >
                      {getVehicleOptionLabel(vehicle)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Turo Vehicle ID</span>
                <input value={form.turo_vehicle_id} readOnly />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Status</span>
                <input
                  value={formatStatusLabel(
                    trip.display_status || trip.workflow_stage || trip.status
                  )}
                  readOnly
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Trip Start</span>
                <input
                  type="datetime-local"
                  value={form.trip_start}
                  onChange={(e) => updateField("trip_start", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Trip End</span>
                <input
                  type="datetime-local"
                  value={form.trip_end}
                  onChange={(e) => updateField("trip_end", e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Money / Mileage</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Amount</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => updateField("amount", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Fuel Reimbursement</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.fuel_reimbursement_total}
                  onChange={(e) =>
                    updateField("fuel_reimbursement_total", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Starting Odometer</span>
                <input
                  type="number"
                  value={form.starting_odometer}
                  onChange={(e) => updateField("starting_odometer", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Ending Odometer</span>
                <input
                  type="number"
                  value={form.ending_odometer}
                  onChange={(e) => updateField("ending_odometer", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Included Mileage</span>
                <input
                  type="number"
                  value={form.mileage_included}
                  onChange={(e) => updateField("mileage_included", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Used Mileage</span>
                <input
                  type="number"
                  value={usedMileage == null ? "" : usedMileage}
                  readOnly
                />
              </label>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Tolls / Review</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Toll Count</span>
                <input
                  type="number"
                  value={form.toll_count}
                  onChange={(e) => updateField("toll_count", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Toll Total</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.toll_total}
                  onChange={(e) => updateField("toll_total", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Toll Review Status</span>
                <select
                  value={form.toll_review_status}
                  onChange={(e) =>
                    updateField("toll_review_status", e.target.value)
                  }
                >
                  {TOLL_REVIEW_STATUS_OPTIONS.map((option) => (
                    <option key={option.value || "blank"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="trip-summary-drawer-field trip-summary-drawer-checkbox-field trip-summary-drawer-field-full">
  <span className="trip-summary-drawer-label">Flags</span>

  <div className="trip-summary-drawer-checkbox-stack">
    <label className="trip-summary-drawer-check">
      <input
        type="checkbox"
        checked={form.has_tolls}
        onChange={(e) => updateCheckbox("has_tolls", e.target.checked)}
      />
      <span>Has Tolls</span>
    </label>

    <label className="trip-summary-drawer-check">
      <input
        type="checkbox"
        checked={form.needs_review}
        onChange={(e) => updateCheckbox("needs_review", e.target.checked)}
      />
      <span>Needs Review</span>
    </label>

    <label className="trip-summary-drawer-check">
      <input
        type="checkbox"
        checked={form.closed_out}
        onChange={(e) => updateCheckbox("closed_out", e.target.checked)}
      />
      <span>Closed Out</span>
    </label>
  </div>
</div>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Workflow</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Workflow Stage</span>
                <select
                  value={form.workflow_stage}
                  onChange={(e) => updateField("workflow_stage", e.target.value)}
                >
                  {WORKFLOW_STAGE_OPTIONS.map((option) => (
                    <option key={option.value || "blank"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Expense Status</span>
                <select
                  value={form.expense_status}
                  onChange={(e) => updateField("expense_status", e.target.value)}
                >
                  {EXPENSE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value || "blank"} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Stage Updated At</span>
                <input
                  type="datetime-local"
                  value={form.stage_updated_at}
                  onChange={(e) =>
                    updateField("stage_updated_at", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Completed At</span>
                <input
                  type="datetime-local"
                  value={form.completed_at}
                  onChange={(e) => updateField("completed_at", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Canceled At</span>
                <input
                  type="datetime-local"
                  value={form.canceled_at}
                  onChange={(e) => updateField("canceled_at", e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Links / Message Tracking</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field trip-summary-drawer-field-full">
                <span className="trip-summary-drawer-label">Trip Details URL</span>
                <input
                  value={form.trip_details_url}
                  onChange={(e) =>
                    updateField("trip_details_url", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field trip-summary-drawer-field-full">
                <span className="trip-summary-drawer-label">Guest Profile URL</span>
                <input
                  value={form.guest_profile_url}
                  onChange={(e) =>
                    updateField("guest_profile_url", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Message Count</span>
                <input
                  type="number"
                  value={form.message_count}
                  onChange={(e) => updateField("message_count", e.target.value)}
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Unread Messages</span>
                <input
                  type="number"
                  value={form.unread_messages}
                  onChange={(e) =>
                    updateField("unread_messages", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Last Message At</span>
                <input
                  type="datetime-local"
                  value={form.last_message_at}
                  onChange={(e) =>
                    updateField("last_message_at", e.target.value)
                  }
                />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Last Unread At</span>
                <input
                  type="datetime-local"
                  value={form.last_unread_at}
                  onChange={(e) =>
                    updateField("last_unread_at", e.target.value)
                  }
                />
              </label>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">System Reference</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Created At</span>
                <input value={formatDateTime(trip.created_at)} readOnly />
              </label>

              <label className="trip-summary-drawer-field">
                <span className="trip-summary-drawer-label">Updated At</span>
                <input value={formatDateTime(trip.updated_at)} readOnly />
              </label>

              <label className="trip-summary-drawer-field trip-summary-drawer-field-full">
                <span className="trip-summary-drawer-label">Created From Message ID</span>
                <input value={trip.created_from_message_id ?? ""} readOnly />
              </label>

              <label className="trip-summary-drawer-field trip-summary-drawer-field-full">
                <span className="trip-summary-drawer-label">Last Message ID</span>
                <input value={trip.last_message_id ?? ""} readOnly />
              </label>
            </div>
          </section>

          <section className="trip-summary-drawer-section">
            <div className="trip-summary-drawer-section-title">Notes</div>

            <div className="trip-summary-drawer-grid">
              <label className="trip-summary-drawer-field trip-summary-drawer-field-full">
                <span className="trip-summary-drawer-label">Notes</span>
                <textarea
                  rows={6}
                  value={form.notes}
                  onChange={(e) => updateField("notes", e.target.value)}
                />
              </label>
            </div>
          </section>

          {error ? <div className="panel-error">{error}</div> : null}
          {saveNotice ? <div className="panel-success">{saveNotice}</div> : null}

          <div className="app-drawer-actions trip-summary-drawer-actions">
            <button
              type="button"
              className="danger-button trip-summary-drawer-delete"
              onClick={handleDelete}
              disabled={saving || isNewTrip}
            >
              Delete
            </button>

            <button
              type="submit"
              className="trip-summary-drawer-save"
              disabled={saving}
            >
              {saving ? "Saving..." : isNewTrip ? "Create Trip" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
