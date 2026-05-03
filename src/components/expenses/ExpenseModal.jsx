import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

const API_BASE = "http://localhost:5000";
const VEHICLES_API = `${API_BASE}/api/vehicles`;
const SUGGESTIONS_API = `${API_BASE}/api/expenses/suggestions`;
const DEFAULT_TAX_RATE = 0.0825;

const EMPTY_FORM = {
  vehicle_id: "",
  vendor: "",
  price: "",
  tax: "",
  is_capitalized: false,
  category: "",
  notes: "",
  date: new Date().toISOString().slice(0, 10),
  expense_scope: "shared",
  trip_id: "",
  tax_locked: false,
};

function buildVehicleLabel(vehicle) {
  if (vehicle?.nickname) return vehicle.nickname;
  const bits = [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean);
  return bits.length ? bits.join(" ") : `Vehicle ${vehicle?.id}`;
}

function getInitialForm(expense, selectedVehicleId) {
  if (!expense) {
    return {
      ...EMPTY_FORM,
      vehicle_id: selectedVehicleId ?? "",
      expense_scope: selectedVehicleId ? "direct" : "shared",
    };
  }

  return {
    vehicle_id: expense.vehicle_id ?? "",
    vendor: expense.vendor ?? "",
    price: expense.price ?? "",
    tax: expense.tax ?? "",
    is_capitalized: Boolean(expense.is_capitalized),
    category: expense.category ?? "",
    notes: expense.notes ?? "",
    date: expense.date ?? new Date().toISOString().slice(0, 10),
    expense_scope: expense.expense_scope ?? "direct",
    trip_id: expense.trip_id ?? "",
    tax_locked: true,
  };
}

export default function ExpenseModal({
  open,
  expense,
  selectedVehicleId,
  onClose,
  onSaved,
}) {
  const [vehicles, setVehicles] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [vendorSuggestions, setVendorSuggestions] = useState([]);
  const [categorySuggestions, setCategorySuggestions] = useState([]);

  function calculateTaxFromPrice(priceValue, rate = DEFAULT_TAX_RATE) {
    const price = Number(priceValue);
    if (!Number.isFinite(price)) return "";
    return (Math.round(price * rate * 100) / 100).toFixed(2);
  }

  useEffect(() => {
    if (!open) return;
    setForm(getInitialForm(expense, selectedVehicleId));
    setError("");
  }, [open, expense, selectedVehicleId]);

  useEffect(() => {
    if (!open) return;

    let ignore = false;

    async function loadSuggestions() {
      try {
        const res = await fetch(SUGGESTIONS_API);
        if (!res.ok) {
          throw new Error(`Failed to load expense suggestions (${res.status})`);
        }

        const data = await res.json();

        if (!ignore) {
          setVendorSuggestions(Array.isArray(data?.vendors) ? data.vendors : []);
          setCategorySuggestions(
            Array.isArray(data?.categories) ? data.categories : []
          );
        }
      } catch (err) {
        if (!ignore) {
          setVendorSuggestions([]);
          setCategorySuggestions([]);
        }
      }
    }

    loadSuggestions();

    return () => {
      ignore = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (form.tax_locked) return;

    setForm((prev) => ({
      ...prev,
      tax: calculateTaxFromPrice(prev.price),
    }));
  }, [form.price, form.tax_locked, open]);

  function handlePriceChange(e) {
    const value = e.target.value;

    setForm((prev) => ({
      ...prev,
      price: value,
      tax: prev.tax_locked ? prev.tax : calculateTaxFromPrice(value),
    }));
  }

  function handleTaxChange(e) {
    const value = e.target.value;

    setForm((prev) => ({
      ...prev,
      tax: value,
      tax_locked: value !== "",
    }));
  }

  function handleVehicleChange(e) {
    const nextVehicleId = e.target.value;

    setForm((prev) => ({
      ...prev,
      vehicle_id: nextVehicleId,
      expense_scope: nextVehicleId ? "direct" : "shared",
    }));
  }

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e) {
      if (e.key === "Escape") {
        onClose?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;

    let ignore = false;

    async function loadVehicles() {
      try {
        const res = await fetch(VEHICLES_API);
        if (!res.ok) throw new Error(`Failed to load vehicles (${res.status})`);
        const data = await res.json();
        const rows = Array.isArray(data) ? data : data?.data || [];
        if (!ignore) setVehicles(rows);
      } catch (err) {
        if (!ignore) {
          setError(err.message || "Failed to load vehicles");
        }
      }
    }

    loadVehicles();

    return () => {
      ignore = true;
    };
  }, [open]);

  const drawerTitle = useMemo(() => {
    return expense?.id ? `Edit Expense #${expense.id}` : "Add Expense";
  }, [expense]);

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");

    try {
      const payload = {
        vehicle_id: form.vehicle_id === "" ? null : Number(form.vehicle_id),
        vendor: form.vendor,
        price: form.price,
        tax: form.tax === "" ? 0 : form.tax,
        is_capitalized: Boolean(form.is_capitalized),
        category: form.category,
        notes: form.notes,
        date: form.date,
        expense_scope: form.expense_scope,
        trip_id: form.trip_id === "" ? null : Number(form.trip_id),
      };

      const url = expense?.id
        ? `${API_BASE}/api/expenses/${expense.id}`
        : `${API_BASE}/api/expenses`;

      const method = expense?.id ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save expense");
      }

      onSaved?.(json);
      onClose?.();
    } catch (err) {
      setError(err.message || "Failed to save expense");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="expense-drawer-shell">
      <button
        type="button"
        className="expense-drawer-backdrop"
        aria-label="Close expense drawer"
        onClick={onClose}
      />

      <aside
        className="expense-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="expense-drawer-title"
      >
        <div className="expense-drawer-header">
          <div className="expense-drawer-header-copy">
            <h3 id="expense-drawer-title">{drawerTitle}</h3>
            <span>
              {expense?.id
                ? "Update this expense record"
                : "Create a new expense record"}
            </span>
          </div>

          <button
            type="button"
            className="expense-drawer-close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <form className="expense-form expense-drawer-form" onSubmit={handleSubmit}>
          <div className="expense-drawer-body">
            <label>
              <span>Vehicle</span>
              <select
                value={form.vehicle_id}
                onChange={handleVehicleChange}
              >
                <option value="">No vehicle</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {buildVehicleLabel(vehicle)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Vendor</span>
              <input
                list="expense-vendor-suggestions"
                value={form.vendor}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, vendor: e.target.value }))
                }
                placeholder="Discount Tire"
              />
              <datalist id="expense-vendor-suggestions">
                {vendorSuggestions.map((vendor) => (
                  <option key={vendor} value={vendor} />
                ))}
              </datalist>
            </label>

            <div className="expense-form-grid">
              <label>
                <span>Price</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.price}
                  onChange={handlePriceChange}
                  required
                />
              </label>

              <label>
                <span>Tax</span>
                <input
                  type="number"
                  step="0.01"
                  value={form.tax}
                  onChange={handleTaxChange}
                  placeholder="Auto-calculated"
                />
                <div className="expense-form-help">
                  Auto-calculated at 8.25% by default. You can override it.
                </div>
              </label>
            </div>

            <div className="expense-form-grid">
              <label>
                <span>Date</span>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, date: e.target.value }))
                  }
                  required
                />
              </label>

              <label>
                <span>Trip ID</span>
                <input
                  type="number"
                  value={form.trip_id}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, trip_id: e.target.value }))
                  }
                  placeholder="Optional"
                />
              </label>
            </div>

            <div className="expense-form-grid">
              <label>
                <span>Category</span>
                <input
                  list="expense-category-suggestions"
                  value={form.category}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, category: e.target.value }))
                  }
                  placeholder="Tires, Registration, Cleaning"
                />
                <datalist id="expense-category-suggestions">
                  {categorySuggestions.map((category) => (
                    <option key={category} value={category} />
                  ))}
                </datalist>
              </label>

              <label>
                <span>Scope</span>
                <select
                  value={form.expense_scope}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, expense_scope: e.target.value }))
                  }
                >
                  <option value="direct">direct</option>
                  <option value="general">general</option>
                  <option value="shared">shared</option>
                  <option value="apportioned">apportioned</option>
                </select>
              </label>
            </div>

            <label className="expense-checkbox-row">
              <input
                type="checkbox"
                checked={form.is_capitalized}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    is_capitalized: e.target.checked,
                  }))
                }
              />
              <span>Capitalized expense</span>
            </label>

            <label>
              <span>Notes</span>
              <textarea
                rows={4}
                value={form.notes}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, notes: e.target.value }))
                }
                placeholder="Optional notes"
              />
            </label>

            {error ? <div className="expenses-error-state">{error}</div> : null}
          </div>

          <div className="expense-drawer-actions">
            <button type="button" className="secondary-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-btn" disabled={saving}>
              {saving ? "Saving…" : "Save expense"}
            </button>
          </div>
        </form>
      </aside>
    </div>,
    document.body
  );
}
