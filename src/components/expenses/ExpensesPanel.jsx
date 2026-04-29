import { useCallback, useEffect, useMemo, useState } from "react";
import ExpenseModal from "./ExpenseModal";

const API_BASE = "http://localhost:5000";
const EXPENSE_LEDGER_FOCUS_STORAGE_KEY = "denmark.expenseLedgerFocus";
const EXPENSES_UPDATED_EVENT = "denmark:expenses-updated";

const DEFAULT_FILTERS = {
  q: "",
  amount: "",
  category: "",
  vendor: "",
  expense_scope: "",
  is_capitalized: "",
  date_from: "",
  date_to: "",
  sort: "date",
  direction: "desc",
  page: 1,
  limit: 50,
};

function getDefaultFilters() {
  return { ...DEFAULT_FILTERS };
}

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function fmtDate(value) {
  if (!value) return "—";
  return value;
}

function buildQuery(params) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    search.set(key, String(value));
  });

  return search.toString();
}

function readStoredExpenseLedgerFocus() {
  if (typeof window === "undefined") return null;

  const raw = window.sessionStorage.getItem(EXPENSE_LEDGER_FOCUS_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return parsed && (parsed.expenseId || parsed.filters) ? parsed : null;
  } catch {
    return null;
  }
}

function clearStoredExpenseLedgerFocus() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(EXPENSE_LEDGER_FOCUS_STORAGE_KEY);
}

function notifyExpensesUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EXPENSES_UPDATED_EVENT));
}

async function fetchExpenseById(expenseId) {
  const res = await fetch(`${API_BASE}/api/expenses/${expenseId}`);
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json?.error || "Failed to load expense");
  }

  return json;
}

function ExpenseMetricCard({ label, value, sub }) {
  return (
    <div className="detail-card">
      <div className="detail-label">{label}</div>
      <div className="detail-value">{value}</div>
      {sub ? <div className="detail-sub">{sub}</div> : null}
    </div>
  );
}

function getScopePillClass(scope) {
  if (scope === "direct") return "running";
  if (scope === "apportioned") return "warning";
  if (scope === "shared") return "parked";
  return "parked";
}

function getVendorFilterValue(vendor) {
  const cleaned = String(vendor || "").trim();
  return cleaned ? cleaned : "__unknown__";
}

export default function ExpensesPanel({ selectedVehicleId }) {
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [expenses, setExpenses] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0 });
  const [totals, setTotals] = useState({
    row_count: 0,
    subtotal: "0.00",
    tax_total: "0.00",
    grand_total: "0.00",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [pendingExpenseFocus, setPendingExpenseFocus] = useState(
    readStoredExpenseLedgerFocus
  );

  const scopedFilters = useMemo(() => {
    return {
      ...filters,
      vehicle_id: selectedVehicleId ?? "",
    };
  }, [filters, selectedVehicleId]);

  const loadExpenses = useCallback(async () => {
    setLoading(true);
    setLoadError("");

    try {
      const query = buildQuery(scopedFilters);
      const res = await fetch(`${API_BASE}/api/expenses?${query}`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load expenses");
      }

      setExpenses(Array.isArray(json?.data) ? json.data : []);
      setPagination(json?.pagination || { page: 1, limit: 50, total: 0 });
      setTotals(
        json?.totals || {
          row_count: 0,
          subtotal: "0.00",
          tax_total: "0.00",
          grand_total: "0.00",
        }
      );
    } catch (err) {
      setLoadError(err.message || "Failed to load expenses");
    } finally {
      setLoading(false);
    }
  }, [scopedFilters]);

  useEffect(() => {
    loadExpenses();
  }, [loadExpenses, refreshToken]);

  useEffect(() => {
    setFilters((prev) => ({ ...prev, page: 1 }));
  }, [selectedVehicleId]);

  useEffect(() => {
    function handleOpenExpenseLedger(event) {
      const detail = event?.detail || readStoredExpenseLedgerFocus();
      if (!detail?.expenseId && !detail?.filters) return;

      setPendingExpenseFocus(detail);
    }

    window.addEventListener("denmark:open-expense-ledger", handleOpenExpenseLedger);

    return () => {
      window.removeEventListener(
        "denmark:open-expense-ledger",
        handleOpenExpenseLedger
      );
    };
  }, []);

  useEffect(() => {
    if (!pendingExpenseFocus?.expenseId) return;

    let ignore = false;

    async function loadFocusedExpense() {
      try {
        const expense = await fetchExpenseById(pendingExpenseFocus.expenseId);
        if (ignore) return;

        setEditingExpense(expense);
        setModalOpen(true);
      } catch (err) {
        if (!ignore) {
          window.alert(err.message || "Failed to load expense");
        }
      } finally {
        if (!ignore) {
          clearStoredExpenseLedgerFocus();
          setPendingExpenseFocus(null);
        }
      }
    }

    loadFocusedExpense();

    return () => {
      ignore = true;
    };
  }, [pendingExpenseFocus]);

  useEffect(() => {
    if (!pendingExpenseFocus?.filters || pendingExpenseFocus?.expenseId) return;

    setFilters((prev) => ({
      ...prev,
      ...pendingExpenseFocus.filters,
      page: 1,
    }));

    clearStoredExpenseLedgerFocus();
    setPendingExpenseFocus(null);
  }, [pendingExpenseFocus]);

  function updateFilter(key, value) {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
      page: key === "page" ? value : 1,
    }));
  }

  function handleOpenCreate() {
    setEditingExpense(null);
    setModalOpen(true);
  }

  function handleOpenEdit(expense) {
    setEditingExpense(expense);
    setModalOpen(true);
  }

  function handleVendorFilter(vendor) {
    updateFilter("vendor", getVendorFilterValue(vendor));
  }

  async function handleDelete(expense) {
    const ok = window.confirm(
      `Delete expense #${expense.id} for ${expense.vendor || "Unknown vendor"}?`
    );
    if (!ok) return;

    setDeletingId(expense.id);

    try {
      const res = await fetch(`${API_BASE}/api/expenses/${expense.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to delete expense");
      }

      setRefreshToken((x) => x + 1);
      notifyExpensesUpdated();
    } catch (err) {
      window.alert(err.message || "Failed to delete expense");
    } finally {
      setDeletingId(null);
    }
  }

  const totalPages = Math.max(
    1,
    Math.ceil((pagination?.total || 0) / (pagination?.limit || 50))
  );

  return (
    <>
      <section className="panel expenses-panel">
<div className="panel-header">
  <div>
    <h2>{selectedVehicleId ? "Vehicle Expenses" : "All Expenses"}</h2>
    <span>
      {selectedVehicleId
        ? "Filtered to selected vehicle"
        : "Fleet-wide expense ledger"}
    </span>
  </div>

  <div className="panel-header-actions">
    <button
      type="button"
      className="message-action expenses-add-btn"
      onClick={handleOpenCreate}
    >
      Add Expense
    </button>
  </div>
</div>

        <div className="panel-subbar expenses-subbar">
          <input
            className="chip search expenses-filter-input expenses-search"
            value={filters.q}
            onChange={(e) => updateFilter("q", e.target.value)}
            placeholder="Search vendor, category, notes"
          />

          <input
            className="chip expenses-filter-input"
            value={filters.amount}
            onChange={(e) => updateFilter("amount", e.target.value)}
            placeholder="Amount or ID"
          />

          <select
            className="chip expenses-filter-input"
            value={filters.expense_scope}
            onChange={(e) => updateFilter("expense_scope", e.target.value)}
          >
            <option value="">All scopes</option>
            <option value="direct">direct</option>
            <option value="general">general</option>
            <option value="shared">shared</option>
            <option value="apportioned">apportioned</option>
          </select>

          <select
            className="chip expenses-filter-input"
            value={filters.is_capitalized}
            onChange={(e) => updateFilter("is_capitalized", e.target.value)}
          >
            <option value="">Cap status</option>
            <option value="true">Capitalized</option>
            <option value="false">Non-capitalized</option>
          </select>

          <input
            className="chip expenses-filter-input"
            type="date"
            value={filters.date_from}
            onChange={(e) => updateFilter("date_from", e.target.value)}
          />

          <input
            className="chip expenses-filter-input"
            type="date"
            value={filters.date_to}
            onChange={(e) => updateFilter("date_to", e.target.value)}
          />

          <select
            className="chip expenses-filter-input"
            value={filters.sort}
            onChange={(e) => updateFilter("sort", e.target.value)}
          >
            <option value="date">Date</option>
            <option value="created_at">Created</option>
            <option value="updated_at">Updated</option>
            <option value="price">Price</option>
            <option value="tax">Tax</option>
            <option value="vendor">Vendor</option>
            <option value="category">Category</option>
            <option value="id">ID</option>
          </select>

          <select
            className="chip expenses-filter-input"
            value={filters.direction}
            onChange={(e) => updateFilter("direction", e.target.value)}
          >
            <option value="desc">Desc</option>
            <option value="asc">Asc</option>
          </select>

          <button
            type="button"
            className="message-action"
            onClick={() => setFilters(getDefaultFilters())}
          >
            Reset
          </button>
        </div>

        <div className="detail-body expenses-body">
          <div className="detail-grid">
            <ExpenseMetricCard
              label="Rows"
              value={totals.row_count || 0}
              sub="Expense records in view"
            />
            <ExpenseMetricCard
              label="Subtotal"
              value={money(totals.subtotal)}
              sub="Before tax"
            />
            <ExpenseMetricCard
              label="Tax"
              value={money(totals.tax_total)}
              sub="Recorded tax"
            />
            <ExpenseMetricCard
              label="Grand Total"
              value={money(totals.grand_total)}
              sub="Total spend in view"
            />
          </div>

          {loading ? (
            <div className="message-empty">Loading expenses…</div>
          ) : loadError ? (
            <div className="expenses-error-state">{loadError}</div>
          ) : !expenses.length ? (
            <div className="message-empty">No expenses found.</div>
          ) : (
            <div className="list expenses-card-list">
              {expenses.map((expense) => (
                <div key={expense.id} className="trip-card expenses-card">
                  <div className="trip-top">
                    <div>
                      <div className="trip-title">
                        <button
                          type="button"
                          className="expenses-vendor-link"
                          onClick={() => handleVendorFilter(expense.vendor)}
                        >
                          {expense.vendor || "Unknown vendor"}
                        </button>
                      </div>
                      <div className="trip-sub">
                        {expense.vehicle_nickname || "No vehicle"} · {fmtDate(expense.date)}
                      </div>
                    </div>

                    <div className="alert-badge">
                      {money(expense.total_cost)}
                    </div>
                  </div>

                  <div className="message-tags">
                    <div className={`fleet-status-pill ${getScopePillClass(expense.expense_scope)}`}>
                      {expense.expense_scope || "—"}
                    </div>

                    <div className="tag">
                      {expense.category || "Uncategorized"}
                    </div>

                    <div className="tag">
                      {expense.is_capitalized ? "Capitalized" : "Non-capitalized"}
                    </div>

                    {expense.trip_id ? (
                      <div className="tag">Trip #{expense.trip_id}</div>
                    ) : null}
                  </div>

                  <div className="trip-meta">
                    <div>
                      <div className="meta-label">Price</div>
                      <div className="meta-value">{money(expense.price)}</div>
                    </div>

                    <div>
                      <div className="meta-label">Tax</div>
                      <div className="meta-value">{money(expense.tax)}</div>
                    </div>

                    <div>
                      <div className="meta-label">Total</div>
                      <div className="meta-value">{money(expense.total_cost)}</div>
                    </div>

                    <div>
                      <div className="meta-label">Expense ID</div>
                      <div className="meta-value">#{expense.id}</div>
                    </div>
                  </div>

                  {expense.notes ? (
                    <>
                      <div className="trip-section-divider" />
                      <div>
                        <div className="trip-section-label">Notes</div>
                        <div className="message-body">{expense.notes}</div>
                      </div>
                    </>
                  ) : null}

                  <div className="message-actions">
                    <button
                      type="button"
                      className="message-action"
                      onClick={() => handleOpenEdit(expense)}
                    >
                      Edit
                    </button>

                    <button
                      type="button"
                      className="message-action"
                      disabled={deletingId === expense.id}
                      onClick={() => handleDelete(expense)}
                    >
                      {deletingId === expense.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="expenses-pagination-inline">
            <button
              type="button"
              className="message-action"
              disabled={(pagination.page || 1) <= 1}
              onClick={() => updateFilter("page", Math.max(1, (pagination.page || 1) - 1))}
            >
              Prev
            </button>

            <div className="detail-sub expenses-page-status">
              Page {pagination.page || 1} of {totalPages} · {pagination.total || 0} total
            </div>

            <button
              type="button"
              className="message-action"
              disabled={(pagination.page || 1) >= totalPages}
              onClick={() =>
                updateFilter("page", Math.min(totalPages, (pagination.page || 1) + 1))
              }
            >
              Next
            </button>
          </div>
        </div>
      </section>

      <ExpenseModal
        open={modalOpen}
        expense={editingExpense}
        selectedVehicleId={selectedVehicleId}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          setRefreshToken((x) => x + 1);
          notifyExpensesUpdated();
        }}
      />
    </>
  );
}
