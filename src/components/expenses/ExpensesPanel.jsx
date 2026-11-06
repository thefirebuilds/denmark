import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import ExpenseModal from "./ExpenseModal";
import { DEFAULT_EXPENSE_FILTERS, expenseReviewFilters, validExpenseAmount } from '../../utils/expenseFilters';

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const EXPENSE_LEDGER_FOCUS_STORAGE_KEY = "denmark.expenseLedgerFocus";
const EXPENSES_UPDATED_EVENT = "denmark:expenses-updated";

const DEFAULT_FILTERS = DEFAULT_EXPENSE_FILTERS;

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
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1].slice(-2)}`;
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
  const [expandedExpenseId, setExpandedExpenseId] = useState(null);
  const [pendingExpenseFocus, setPendingExpenseFocus] = useState(
    readStoredExpenseLedgerFocus
  );

  const scopedFilters = useMemo(() => {
    return {
      ...filters,
      vehicle_id: selectedVehicleId ?? "",
    };
  }, [filters, selectedVehicleId]);

  const loadExpenses = useCallback(async (signal) => {
    setLoading(true);
    setLoadError("");

    if (!validExpenseAmount(scopedFilters.amount)) {
      setLoadError('Enter a valid amount or expense ID.');
      setLoading(false);
      return;
    }

    try {
      const query = buildQuery(scopedFilters);
      const res = await fetch(`${API_BASE}/api/expenses?${query}`, { signal });
      const json = await res.json().catch(() => ({}));
      if (signal.aborted) return;

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
      if (!signal.aborted) setLoadError(err.message || "Failed to load expenses");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [scopedFilters]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => loadExpenses(controller.signal), 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadExpenses, refreshToken]);

  useEffect(() => {
    setFilters(prev => expenseReviewFilters({ date_from: prev.date_from, date_to: prev.date_to }));
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

    setFilters(expenseReviewFilters(pendingExpenseFocus.filters));

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
    setFilters(prev => expenseReviewFilters({ vendor: getVendorFilterValue(vendor), date_from: prev.date_from, date_to: prev.date_to }));
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
          <dl className="expenses-statement-totals" aria-label="Filtered expense totals">
            <div><dt>Transactions</dt><dd>{totals.row_count || 0}</dd></div>
            <div><dt>Subtotal</dt><dd>{money(totals.subtotal)}</dd></div>
            <div><dt>Tax</dt><dd>{money(totals.tax_total)}</dd></div>
            <div className="expenses-statement-total"><dt>Total</dt><dd>{money(totals.grand_total)}</dd></div>
          </dl>
          {loading ? (
            <div className="message-empty">Loading expenses…</div>
          ) : loadError ? (
            <div className="expenses-error-state">{loadError}</div>
          ) : !expenses.length ? (
            <div className="message-empty">No expenses found.</div>
          ) : (
            <div className="expenses-statement-scroll" role="region" aria-label="Expense transactions" tabIndex={0}>
              <table className="expenses-statement">
                <caption className="expenses-sr-only">Expenses matching the selected filters. Amounts include tax; negative amounts are refunds.</caption>
                <colgroup>
                  <col className="expense-col-date" /><col className="expense-col-description" />
                  <col className="expense-col-vehicle" /><col className="expense-col-category" />
                  <col className="expense-col-amount" /><col className="expense-col-actions" />
                </colgroup>
                <thead><tr>
                  <th scope="col">Date</th><th scope="col">Description</th><th scope="col">Vehicle</th>
                  <th scope="col">Category</th><th scope="col" className="expense-number">Amount</th>
                  <th scope="col"><span className="expenses-sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {expenses.map(expense => {
                    const expanded = expandedExpenseId === expense.id;
                    return <Fragment key={expense.id}>
                      <tr className={expanded ? 'expense-row-expanded' : ''}>
                        <td className="expense-date"><time dateTime={expense.date} title={expense.date}>{fmtDate(expense.date)}</time></td>
                        <td className="expense-description">
                          <button type="button" className="expenses-vendor-link expense-cell-link" title={`Show expenses from ${expense.vendor || 'Unknown vendor'}`} onClick={() => handleVendorFilter(expense.vendor)}>{expense.vendor || 'Unknown vendor'}</button>
                          {expense.notes && <span className="expense-note-preview" title={expense.notes}>{expense.notes}</span>}
                        </td>
                        <td><button type="button" className="expenses-vendor-link expense-cell-link" title={`Show expenses for ${expense.vehicle_nickname || 'No vehicle'}`} onClick={() => window.dispatchEvent(new CustomEvent('denmark:open-expense-ledger', { detail: {
                          vehicleId: expense.vehicle_id ?? null,
                          filters: { date_from: filters.date_from, date_to: filters.date_to, ...(expense.vehicle_id == null ? { vehicle_unassigned: true } : {}) },
                        } }))}>{expense.vehicle_nickname || 'No vehicle'}</button></td>
                        <td><button type="button" className="expenses-vendor-link expense-cell-link expense-category" title={expense.category || 'Uncategorized'} onClick={() => setFilters(expenseReviewFilters({ category: expense.category || 'Uncategorized', date_from: filters.date_from, date_to: filters.date_to }))}>{expense.category || 'Uncategorized'}</button></td>
                        <td className={`expense-number expense-amount ${Number(expense.total_cost) < 0 ? 'expense-refund' : ''}`}>{money(expense.total_cost)}</td>
                        <td className="expense-row-actions">
                          <button type="button" className="expense-row-action" aria-label={`${expanded ? 'Hide' : 'Show'} details for expense ${expense.id}`} aria-expanded={expanded} aria-controls={`expense-details-${expense.id}`} onClick={() => setExpandedExpenseId(expanded ? null : expense.id)}>{expanded ? 'Hide' : 'Details'}</button>
                          <button type="button" className="expense-row-action" aria-label={`Edit expense ${expense.id}`} onClick={() => handleOpenEdit(expense)}>Edit</button>
                        </td>
                      </tr>
                      {expanded && <tr className="expense-details-row" id={`expense-details-${expense.id}`}><td colSpan={6}>
                        <div className="expense-expanded-details">
                          <dl>
                            <div><dt>Expense</dt><dd>#{expense.id}</dd></div>
                            <div><dt>Vehicle</dt><dd>{expense.vehicle_nickname || 'No vehicle'}</dd></div>
                            <div><dt>Category</dt><dd>{expense.category || 'Uncategorized'}</dd></div>
                            <div><dt>Subtotal</dt><dd>{money(expense.price)}</dd></div>
                            <div><dt>Tax</dt><dd>{money(expense.tax)}</dd></div>
                            <div><dt>Scope</dt><dd>{expense.expense_scope || 'Not specified'}</dd></div>
                            <div><dt>Treatment</dt><dd>{expense.is_capitalized ? 'Capitalized' : 'Non-capitalized'}</dd></div>
                            {expense.trip_id && <div><dt>Trip</dt><dd>#{expense.trip_id}</dd></div>}
                          </dl>
                          {expense.notes && <p>{expense.notes}</p>}
                          <button type="button" className="expense-row-action" onClick={() => handleOpenEdit(expense)}>Edit expense</button>
                          <button type="button" className="expense-row-action expense-delete" disabled={deletingId === expense.id} onClick={() => handleDelete(expense)}>{deletingId === expense.id ? 'Deleting...' : 'Delete expense'}</button>
                        </div>
                      </td></tr>}
                    </Fragment>;
                  })}
                </tbody>
              </table>
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


