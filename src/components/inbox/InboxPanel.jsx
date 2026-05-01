// ------------------------------------------------------------
// /src/components/inbox/InboxPanel.jsx
// Expense processing view for Teller transaction reconciliation.
// Returns three sibling panels so it fits the app shell layout.
// ------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = "http://localhost:5000";
const VEHICLES_API = `${API_BASE}/api/vehicles`;

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function bucketLabel(key) {
  switch (key) {
    case "pending":
      return "Pending";
    case "matched":
      return "Matched";
    case "created":
      return "Created";
    case "dismissed":
      return "Dismissed";
    case "ignored":
      return "Ignored";
    case "all":
      return "All";
    default:
      return key;
  }
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return {
      pending: 0,
      matched: 0,
      created: 0,
      dismissed: 0,
      ignored: 0,
      all: 0,
    };
  }

  const pending = Number(summary.pending || 0);
  const matched = Number(summary.matched || 0);
  const created = Number(summary.created || 0);
  const dismissed = Number(summary.dismissed || 0);
  const ignored = Number(summary.ignored || 0);
  const all =
    Number(summary.all || 0) ||
    pending + matched + created + dismissed + ignored;

  return {
    pending,
    matched,
    created,
    dismissed,
    ignored,
    all,
  };
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.pending)) return payload.pending;
  if (Array.isArray(payload?.suggestions)) return payload.suggestions;
  return [];
}

function buildVehicleLabel(vehicle) {
  const parts = [
    vehicle?.nickname,
    vehicle?.year,
    vehicle?.make,
    vehicle?.model,
  ].filter(Boolean);

  return parts.length ? parts.join(" ") : `Vehicle ${vehicle?.id}`;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function getConfidencePercent(input, fallback = 0) {
  if (typeof input === "number" && Number.isFinite(input)) {
    return clampPercent(input);
  }

  if (typeof input === "string") {
    const trimmed = input.trim().toLowerCase();

    if (!trimmed) return clampPercent(fallback);

    const numeric = Number(trimmed.replace("%", ""));
    if (Number.isFinite(numeric)) {
      return clampPercent(numeric);
    }

    if (trimmed === "strong") return 95;
    if (trimmed === "high") return 90;
    if (trimmed === "medium") return 70;
    if (trimmed === "likely") return 70;
    if (trimmed === "low") return 35;
    if (trimmed === "weak") return 25;
  }

  return clampPercent(fallback);
}

function getMatchToneClass(score) {
  if (score < 50) return "low";
  if (score <= 90) return "medium";
  return "high";
}

function formatMatchLabel(score, suggestionCount = 0) {
  const parts = [`${score}% match`];

  if (suggestionCount > 1) {
    parts.push(`${suggestionCount} suggestions`);
  }

  return parts.join(" · ");
}

function getTransactionSourceLabel(txn) {
  const source = txn?.transaction_source_label || "Imported";
  const account = txn?.source_account_label;

  if (!account || account === source) return source;
  return `${source} / ${account}`;
}

function isTuroIncomeTransaction(txn) {
  const text = `${txn?.counterparty_name || ""} ${txn?.description || ""}`.toLowerCase();
  return text.includes("turo") && Number(txn?.amount || 0) > 0;
}

function ExpenseProcessingBucketPanel({ summary, activeBucket, onChange }) {
  const items = ["pending", "matched", "created", "dismissed", "ignored", "all"];

  return (
    <div className="panel inbox-buckets-panel">
      <div className="panel-header">
        <h2>Expense Processing</h2>
      </div>

      <div className="inbox-bucket-list">
        {items.map((key) => (
          <button
            key={key}
            type="button"
            className={`inbox-bucket-btn ${activeBucket === key ? "is-active" : ""}`}
            onClick={() => onChange(key)}
          >
            <span>{bucketLabel(key)}</span>
            <strong>{summary[key] ?? 0}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

function ExpenseProcessingListPanel({
  activeBucket,
  transactions,
  ignoredGroups,
  selectedId,
  selectedVendorKey,
  onSelect,
  onSelectIgnoredGroup,
  loading,
  error,
  page,
  totalPages,
  total,
  onPreviousPage,
  onNextPage,
}) {
  const rowRefs = useRef({});

  useEffect(() => {
    if (activeBucket === "ignored") return;
    if (!selectedId) return;

    const node = rowRefs.current[String(selectedId)];
    if (!node) return;

    node.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }, [activeBucket, selectedId, transactions]);

  return (
    <div className="panel inbox-list-panel">
      <div className="panel-header">
        <h2>{activeBucket === "ignored" ? "Ignored Vendors" : "Imported Transactions"}</h2>
      </div>

      <div className="list inbox-transaction-list">
        {loading ? (
          <div className="inbox-state">Loading transactions…</div>
        ) : error ? (
          <div className="inbox-state inbox-state-error">{error}</div>
        ) : activeBucket === "ignored" ? (
          ignoredGroups.length === 0 ? (
            <div className="inbox-state">No ignored vendors found.</div>
          ) : (
            ignoredGroups.map((group) => {
              const isSelected =
                String(selectedVendorKey) === String(group.vendor_key);

              return (
                <button
                  key={group.vendor_key}
                  type="button"
                  className={`inbox-transaction-row ${isSelected ? "is-selected" : ""}`}
                  onClick={() => onSelectIgnoredGroup(group)}
                >
                  <div className="inbox-transaction-row-top">
                    <strong className="inbox-transaction-description">
                      {group.vendor_key || "Unknown Vendor"}
                    </strong>
                    <span className="inbox-pill">
                      {group.transaction_count} ignored
                    </span>
                  </div>

                  <div className="inbox-transaction-meta">
                    <span>Latest: {formatDate(group.latest_transaction_date)}</span>
                    <span>Earliest: {formatDate(group.earliest_transaction_date)}</span>
                  </div>

                  <div className="inbox-transaction-meta">
                    <span>{group.sample_description || "No sample description"}</span>
                    {group.sample_ignore_reason ? (
                      <span className="inbox-pill">{group.sample_ignore_reason}</span>
                    ) : null}
                  </div>
                </button>
              );
            })
          )
        ) : transactions.length === 0 ? (
          <div className="inbox-state">No transactions in this bucket.</div>
        ) : (
          transactions.map((txn) => {
            const id = txn.id;
            const suggestionCount = Number(txn.suggestion_count || 0);
            const bestMatchScore = getConfidencePercent(
              txn.best_match_score,
              txn.match_score
            );
            const isSelected = String(selectedId) === String(id);
            const hasLikelyMatch = bestMatchScore > 0;
            const matchTone = hasLikelyMatch
              ? getMatchToneClass(bestMatchScore)
              : "";

            return (
              <button
                key={id}
                ref={(node) => {
                  if (node) {
                    rowRefs.current[String(id)] = node;
                  } else {
                    delete rowRefs.current[String(id)];
                  }
                }}
                type="button"
                className={`inbox-transaction-row ${
                  isSelected ? "is-selected" : ""
                } ${
                  matchTone ? `has-likely-match has-likely-match--${matchTone}` : ""
                }`}
                onClick={() => onSelect(txn)}
              >
                <div className="inbox-transaction-row-top">
                  <span className="inbox-transaction-date">
                    {formatDate(txn.transaction_date)}
                  </span>
                  <strong className="inbox-transaction-amount">
                    {money(txn.amount)}
                  </strong>
                </div>

                <div className="inbox-transaction-description">
                  {txn.description || "No description"}
                </div>

                <div className="inbox-transaction-meta">
                  <span>{txn.counterparty_name || "Unknown merchant"}</span>
                  <span>{getTransactionSourceLabel(txn)}</span>
                  <span>{txn.category || "uncategorized"}</span>
                  {hasLikelyMatch ? (
                    <span
                      className={`inbox-pill inbox-pill-match inbox-pill-match--${matchTone}`}
                    >
                      {formatMatchLabel(bestMatchScore, suggestionCount)}
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })
        )}
      </div>

      <div className="inbox-list-pagination">
        <button
          type="button"
          className="inbox-action-btn"
          onClick={onPreviousPage}
          disabled={loading || page <= 1}
        >
          Previous Page
        </button>

        <div className="inbox-pagination-status">
          Page {page} of {Math.max(totalPages || 1, 1)} · {total || 0} total
        </div>

        <button
          type="button"
          className="inbox-action-btn"
          onClick={onNextPage}
          disabled={loading || page >= Math.max(totalPages || 1, 1)}
        >
          Next Page
        </button>
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion, onMatch, matching }) {
  const expense = suggestion?.expense || suggestion || {};
  const confidence = getConfidencePercent(
    suggestion?.confidence ?? suggestion?.score ?? suggestion?.match_score,
    0
  );
  const toneClass = getMatchToneClass(confidence);

  return (
    <div className={`inbox-suggestion-card inbox-suggestion-card--${toneClass}`}>
      <div className="inbox-suggestion-top">
        <strong>{expense.vehicle_nickname || "General Expense"}</strong>
        <span className={`inbox-pill inbox-pill-match inbox-pill-match--${toneClass}`}>
          {confidence > 0 ? `${confidence}% match` : "Suggestion"}
        </span>
      </div>

      <div className="inbox-suggestion-body">
        <div>
          <strong>Category:</strong> {expense.category || "—"}
        </div>
        <div>
          <strong>Total:</strong> {money(expense.total_cost)}
        </div>
        <div>
          <strong>Date:</strong> {formatDate(expense.date)}
        </div>
        <div>
          <strong>Reason:</strong> {suggestion?.reason || "Possible match"}
        </div>
        <div>
          <strong>Notes:</strong> {expense.notes || "—"}
        </div>
      </div>

      <div className="inbox-suggestion-actions">
        <button
          type="button"
          className="inbox-action-btn"
          onClick={() => onMatch(suggestion?.expense_id || expense?.id)}
          disabled={!(suggestion?.expense_id || expense?.id) || matching}
        >
          {matching ? "Matching…" : "Match"}
        </button>
      </div>
    </div>
  );
}

function ExpenseProcessingDetailPanel({
  activeBucket,
  transaction,
  ignoredGroup,
  ignoredGroupTransactions,
  suggestions,
  loading,
  error,
  actionError,
  onMatch,
  onDismiss,
  onIgnore,
  onIgnoreSimilar,
  onCreateExpense,
  onCreateIncome,
  onNext,
  onPrevious,
  canGoNext,
  canGoPrevious,
  matchingExpenseId,
  acting,
  draftLoading,
}) {
  const actionLocked = acting !== "" || draftLoading;
  const showIncomeAction = isTuroIncomeTransaction(transaction);

  return (
    <div className="panel inbox-detail-panel">
      <div className="panel-header">
        <h2>Transaction Details</h2>
      </div>

      {activeBucket === "ignored" ? (
        ignoredGroup ? (
          <div className="inbox-detail-actions">
            <button
              type="button"
              className="inbox-action-btn ignore-similar"
              title="Create a rule to suppress similar transactions from this vendor."
              onClick={() => onIgnoreSimilar(ignoredGroup)}
              disabled={actionLocked}
            >
              {acting === "ignore-similar" ? "Ignoring Similar…" : "Ignore Similar"}
            </button>
          </div>
        ) : null
      ) : transaction ? (
        <div className="inbox-detail-actions">
          <button
            type="button"
            className="inbox-action-btn"
            onClick={onPrevious}
            disabled={!canGoPrevious || actionLocked}
          >
            Previous
          </button>

          <button
            type="button"
            className="inbox-action-btn"
            onClick={onNext}
            disabled={!canGoNext || actionLocked}
          >
            Next
          </button>

          <button
            type="button"
            className="inbox-action-btn"
            onClick={() => onCreateExpense(transaction.id)}
            disabled={actionLocked}
          >
            {draftLoading ? "Loading Draft…" : acting === "create" ? "Adding…" : "Add Expense"}
          </button>

          {showIncomeAction ? (
            <button
              type="button"
              className="inbox-action-btn"
              onClick={() => onCreateIncome(transaction.id)}
              disabled={actionLocked}
            >
              {draftLoading ? "Loading Draftâ€¦" : acting === "income" ? "Addingâ€¦" : "Add Income"}
            </button>
          ) : null}

          <button
            type="button"
            className="inbox-action-btn"
            title="Non Business Expense"
            onClick={() => onDismiss(transaction.id)}
            disabled={actionLocked}
          >
            {acting === "dismiss" ? "Dismissing…" : "Dismiss"}
          </button>

          <button
            type="button"
            className="inbox-action-btn ignore"
            title="Suppress from feed"
            onClick={() => onIgnore(transaction.id)}
            disabled={actionLocked}
          >
            {acting === "ignore" ? "Ignoring…" : "Ignore"}
          </button>
        </div>
      ) : null}

      <div className="detail-body inbox-detail-body">
        {actionError ? (
          <div className="inbox-state inbox-state-error">{actionError}</div>
        ) : null}

        {activeBucket === "ignored" ? (
          !ignoredGroup ? (
            <div className="inbox-state">Select an ignored vendor group.</div>
          ) : (
            <>
              <div className="inbox-detail-card">
                <div className="inbox-detail-amount">{ignoredGroup.vendor_key}</div>
                <div className="inbox-detail-description">
                  {ignoredGroup.transaction_count} ignored transaction
                  {ignoredGroup.transaction_count === 1 ? "" : "s"}
                </div>

                <div className="inbox-detail-grid">
                  <div>
                    <span>Latest</span>
                    <strong>{formatDate(ignoredGroup.latest_transaction_date)}</strong>
                  </div>
                  <div>
                    <span>Earliest</span>
                    <strong>{formatDate(ignoredGroup.earliest_transaction_date)}</strong>
                  </div>
                  <div>
                    <span>Sample Description</span>
                    <strong>{ignoredGroup.sample_description || "—"}</strong>
                  </div>
                  <div>
                    <span>Ignore Reason</span>
                    <strong>{ignoredGroup.sample_ignore_reason || "—"}</strong>
                  </div>
                </div>
              </div>

              <div className="inbox-suggestions-section">
                <div className="inbox-section-title">Ignored Transactions in Group</div>

                {loading ? (
                  <div className="inbox-state">Loading ignored transactions…</div>
                ) : error ? (
                  <div className="inbox-state inbox-state-error">{error}</div>
                ) : ignoredGroupTransactions.length === 0 ? (
                  <div className="inbox-state">
                    No ignored transactions found for this vendor.
                  </div>
                ) : (
                  <div className="inbox-suggestion-list">
                    {ignoredGroupTransactions.map((txn) => (
                      <div key={txn.id} className="inbox-suggestion-card">
                        <div className="inbox-suggestion-top">
                          <strong>{money(txn.amount)}</strong>
                          <span>{formatDate(txn.transaction_date)}</span>
                        </div>
                        <div className="inbox-suggestion-body">
                          <div>
                            <strong>Description:</strong> {txn.description || "—"}
                          </div>
                          <div>
                            <strong>Counterparty:</strong> {txn.counterparty_name || "—"}
                          </div>
                          <div>
                            <strong>Ignore Reason:</strong> {txn.ignore_reason || "—"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )
        ) : !transaction ? (
          <div className="inbox-state">Select a transaction to review.</div>
        ) : (
          <>
            <div className="inbox-detail-card">
              <div className="inbox-detail-amount">{money(transaction.amount)}</div>
              <div className="inbox-detail-description">
                {transaction.description || "No description"}
              </div>

              <div className="inbox-detail-grid">
                <div>
                  <span>Date</span>
                  <strong>{formatDate(transaction.transaction_date)}</strong>
                </div>
                <div>
                  <span>Counterparty</span>
                  <strong>{transaction.counterparty_name || "—"}</strong>
                </div>
                <div>
                  <span>Source</span>
                  <strong>{transaction.transaction_source_label || "Imported"}</strong>
                </div>
                <div>
                  <span>Account</span>
                  <strong>{transaction.source_account_label || "N/A"}</strong>
                </div>
                <div>
                  <span>Type</span>
                  <strong>{transaction.transaction_type || "—"}</strong>
                </div>
                <div>
                  <span>Category</span>
                  <strong>{transaction.category || "—"}</strong>
                </div>
                <div>
                  <span>Status</span>
                  <strong>{transaction.review_status || "pending"}</strong>
                </div>
                <div>
                  <span>Processing</span>
                  <strong>{transaction.processing_status || "—"}</strong>
                </div>
              </div>
            </div>

            <div className="inbox-suggestions-section">
              <div className="inbox-section-title">Suggested Expense Matches</div>

              {loading ? (
                <div className="inbox-state">Loading suggestions…</div>
              ) : error ? (
                <div className="inbox-state inbox-state-error">{error}</div>
              ) : suggestions.length === 0 ? (
                <div className="inbox-state">No suggestions found.</div>
              ) : (
                <div className="inbox-suggestion-list">
                  {suggestions.map((suggestion, index) => {
                    const expense = suggestion?.expense || suggestion || {};
                    return (
                      <SuggestionCard
                        key={expense?.id || suggestion?.id || index}
                        suggestion={suggestion}
                        onMatch={onMatch}
                        matching={
                          String(matchingExpenseId) ===
                          String(suggestion?.expense_id || expense?.id)
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ExpenseDraftModal({
  open,
  draft,
  categories = [],
  vehicles = [],
  vehiclesLoading = false,
  vehiclesError = "",
  categoryMessage = "",
  saving,
  onClose,
  onChange,
  onAddCategory,
  onSubmit,
}) {
  if (!open || !draft) return null;

  const topSuggestion = draft.category_options?.[0] || null;

  return (
    <div className="inbox-draft-overlay">
        <div className="inbox-draft-modal">
          <div className="panel-header">
            <h2>Create Expense</h2>
          </div>

          <div className="inbox-draft-form">
            {draft.refund_signal_detected ? (
              <div className="inbox-draft-suggestion-summary">
                Refund signal detected. This draft defaults to a negative amount
                so the credit reduces expense instead of adding a second cost.
              </div>
            ) : null}

            <label className="inbox-draft-field">
              <span>Vendor</span>
              <input
                type="text"
                value={draft.vendor || ""}
              onChange={(e) => onChange("vendor", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Amount</span>
            <input
              type="number"
              step="0.01"
              value={draft.price ?? ""}
              onChange={(e) => onChange("price", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Date</span>
            <input
              type="date"
              value={draft.date || ""}
              onChange={(e) => onChange("date", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Category</span>
            <select
              value={draft.category || ""}
              onChange={(e) => onChange("category", e.target.value)}
            >
              <option value="">Select category</option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>

          <div className="inbox-draft-inline-add">
            <input
              type="text"
              value={draft.new_category || ""}
              onChange={(e) => onChange("new_category", e.target.value)}
              placeholder="New category"
            />
            <button
              type="button"
              className="inbox-action-btn"
              onClick={() => onAddCategory?.(draft.new_category)}
              disabled={!String(draft.new_category || "").trim()}
            >
              Add Category
            </button>
          </div>

          <label className="inbox-draft-field">
            <span>Vehicle</span>
            <select
              value={draft.vehicle_id ?? ""}
              onChange={(e) => onChange("vehicle_id", e.target.value)}
              disabled={vehiclesLoading}
            >
              <option value="">
                {vehiclesLoading ? "Loading vehicles..." : "No vehicle"}
              </option>
              {vehicles.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id}>
                  {buildVehicleLabel(vehicle)}
                </option>
              ))}
            </select>
          </label>

          <label className="inbox-draft-field">
            <span>Scope</span>
            <select
              value={draft.expense_scope || "direct"}
              onChange={(e) => onChange("expense_scope", e.target.value)}
            >
              <option value="direct">direct</option>
              <option value="general">general</option>
              <option value="shared">shared</option>
              <option value="apportioned">apportioned</option>
            </select>
          </label>

          {vehiclesError ? (
            <div className="inbox-inline-error">{vehiclesError}</div>
          ) : null}

          {categoryMessage ? (
            <div className="inbox-draft-suggestion-summary">{categoryMessage}</div>
          ) : null}

          {draft.category_options?.length ? (
            <div className="inbox-draft-suggestions">
              <div className="inbox-section-title">Suggested Categories</div>

              {topSuggestion ? (
                <div className="inbox-draft-suggestion-summary">
                  Suggested: <strong>{topSuggestion.category}</strong>
                  {" · "}
                  based on {topSuggestion.usage_count} similar expense
                  {topSuggestion.usage_count === 1 ? "" : "s"}
                </div>
              ) : null}

              <div className="inbox-draft-chip-row">
                {draft.category_options.map((option) => {
                  const optionConfidence = getConfidencePercent(option.confidence, 0);

                  return (
                    <button
                      key={option.category}
                      type="button"
                      className={`inbox-draft-chip ${
                        draft.category === option.category ? "is-active" : ""
                      }`}
                      onClick={() => onChange("category", option.category)}
                    >
                      {option.category}
                      {optionConfidence > 0 ? ` · ${optionConfidence}%` : ""}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <label className="inbox-draft-field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={draft.notes || ""}
              onChange={(e) => onChange("notes", e.target.value)}
            />
          </label>
        </div>

        <div className="inbox-draft-actions">
          <button
            type="button"
            className="inbox-action-btn"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>

          <button
            type="button"
            className="inbox-action-btn"
            onClick={onSubmit}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save Expense"}
          </button>
        </div>
      </div>
    </div>
  );
}

function IncomeDraftModal({
  open,
  draft,
  saving,
  onClose,
  onChange,
  onSubmit,
}) {
  if (!open || !draft) return null;

  return (
    <div className="inbox-draft-overlay">
      <div className="inbox-draft-modal">
        <div className="panel-header">
          <h2>Add Income</h2>
        </div>

        <div className="inbox-draft-form">
          <label className="inbox-draft-field">
            <span>Payer</span>
            <input
              type="text"
              value={draft.payer || ""}
              onChange={(e) => onChange("payer", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Amount</span>
            <input
              type="number"
              step="0.01"
              value={draft.amount ?? ""}
              onChange={(e) => onChange("amount", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Date</span>
            <input
              type="date"
              value={draft.income_date || ""}
              onChange={(e) => onChange("income_date", e.target.value)}
            />
          </label>

          <label className="inbox-draft-field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={draft.notes || ""}
              onChange={(e) => onChange("notes", e.target.value)}
            />
          </label>
        </div>

        <div className="inbox-draft-actions">
          <button
            type="button"
            className="inbox-action-btn"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>

          <button
            type="button"
            className="inbox-action-btn"
            onClick={onSubmit}
            disabled={saving}
          >
            {saving ? "Savingâ€¦" : "Save Income"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function InboxPanel() {
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    total_pages: 1,
  });

  const [summary, setSummary] = useState({});
  const [activeBucket, setActiveBucket] = useState("pending");
  const [transactions, setTransactions] = useState([]);
  const [selectedTransaction, setSelectedTransaction] = useState(null);
  const [transactionDetail, setTransactionDetail] = useState(null);
  const [suggestions, setSuggestions] = useState([]);

  const [summaryError, setSummaryError] = useState("");
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [matchingExpenseId, setMatchingExpenseId] = useState(null);
  const [acting, setActing] = useState("");

  const [ignoredGroups, setIgnoredGroups] = useState([]);
  const [selectedIgnoredGroup, setSelectedIgnoredGroup] = useState(null);
  const [ignoredGroupTransactions, setIgnoredGroupTransactions] = useState([]);

  const [expenseDraft, setExpenseDraft] = useState(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftTransactionId, setDraftTransactionId] = useState(null);
  const [incomeDraft, setIncomeDraft] = useState(null);
  const [incomeDraftOpen, setIncomeDraftOpen] = useState(false);
  const [incomeDraftTransactionId, setIncomeDraftTransactionId] = useState(null);
  const [expenseCategories, setExpenseCategories] = useState([]);
  const [categoryMessage, setCategoryMessage] = useState("");
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);
  const [vehiclesError, setVehiclesError] = useState("");

  const safeSummary = useMemo(() => normalizeSummary(summary), [summary]);

  const selectedIndex = useMemo(() => {
    if (!selectedTransaction?.id) return -1;
    return transactions.findIndex(
      (row) => String(row.id) === String(selectedTransaction.id)
    );
  }, [transactions, selectedTransaction?.id]);

  const canGoPrevious = selectedIndex > 0;
  const canGoNext = selectedIndex >= 0 && selectedIndex < transactions.length - 1;

  const loadSummary = useCallback(async (signalCancelled = () => false) => {
    try {
      setSummaryError("");
      const res = await fetch(`${API_BASE}/api/teller/summary`);
      if (!res.ok) throw new Error(`Summary request failed: ${res.status}`);
      const data = await res.json();
      if (!signalCancelled()) setSummary(data);
    } catch (err) {
      if (!signalCancelled()) {
        setSummaryError(err.message || "Failed to load summary.");
        setSummary({});
      }
    }
  }, []);

  const loadExpenseCategories = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/expenses/suggestions`);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to load expense categories");
      }

      setExpenseCategories(Array.isArray(json.categories) ? json.categories : []);
    } catch (err) {
      setCategoryMessage(err.message || "Failed to load expense categories");
    }
  }, []);

  const loadVehicles = useCallback(async (signalCancelled = () => false) => {
    try {
      setVehiclesLoading(true);
      setVehiclesError("");

      const res = await fetch(VEHICLES_API);
      if (!res.ok) {
        throw new Error(`Vehicle request failed: ${res.status}`);
      }

      const payload = await res.json();
      const rows = extractRows(payload)
        .filter((vehicle) => vehicle?.id != null)
        .sort((a, b) =>
          buildVehicleLabel(a).localeCompare(buildVehicleLabel(b), undefined, {
            sensitivity: "base",
          })
        );

      if (!signalCancelled()) {
        setVehicles(rows);
      }
    } catch (err) {
      if (!signalCancelled()) {
        setVehicles([]);
        setVehiclesError(err.message || "Failed to load vehicles.");
      }
    } finally {
      if (!signalCancelled()) {
        setVehiclesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!draftOpen) return;

    let cancelled = false;
    loadVehicles(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [draftOpen, loadVehicles]);

  const loadTransactions = useCallback(
    async (signalCancelled = () => false, preferredSelectedId = null) => {
      try {
        setLoadingList(true);
        setListError("");

        const params = new URLSearchParams({
          page: String(page),
          limit: String(limit),
        });

        const endpoint =
          activeBucket === "pending"
            ? `${API_BASE}/api/teller/pending?${params.toString()}`
            : activeBucket === "ignored"
              ? `${API_BASE}/api/teller/ignored-groups?${params.toString()}`
              : activeBucket === "all"
                ? `${API_BASE}/api/teller?${params.toString()}`
                : `${API_BASE}/api/teller?review_status=${encodeURIComponent(activeBucket)}&${params.toString()}`;

        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`Transaction request failed: ${res.status}`);

        const payload = await res.json();
        const rows = extractRows(payload);
        const nextPagination = payload?.pagination || {
          page,
          limit,
          total: rows.length,
          total_pages: 1,
        };

        if (!signalCancelled()) {
          setPagination(nextPagination);

          if (activeBucket === "ignored") {
            setIgnoredGroups(rows);
            setTransactions([]);
            setIgnoredGroupTransactions([]);
            const preferred =
              preferredSelectedId != null
                ? rows.find(
                    (row) => String(row.vendor_key) === String(preferredSelectedId)
                  )
                : null;

            setSelectedIgnoredGroup(preferred || rows[0] || null);
            setSelectedTransaction(null);
            setTransactionDetail(null);
          } else {
            setTransactions(rows);
            setIgnoredGroups([]);
            setIgnoredGroupTransactions([]);
            setSelectedIgnoredGroup(null);

            const preferred =
              preferredSelectedId != null
                ? rows.find((row) => String(row.id) === String(preferredSelectedId))
                : null;

            setSelectedTransaction(preferred || rows[0] || null);
            setTransactionDetail(null);
          }
        }
      } catch (err) {
        if (!signalCancelled()) {
          setListError(err.message || "Failed to load transactions.");
          setTransactions([]);
          setIgnoredGroups([]);
          setIgnoredGroupTransactions([]);
          setSelectedTransaction(null);
          setSelectedIgnoredGroup(null);
          setTransactionDetail(null);
          setPagination({
            page: 1,
            limit,
            total: 0,
            total_pages: 1,
          });
        }
      } finally {
        if (!signalCancelled()) setLoadingList(false);
      }
    },
    [activeBucket, page, limit]
  );

  const loadIgnoredGroupDetail = useCallback(
    async (vendorKey, signalCancelled = () => false) => {
      if (!vendorKey) {
        if (!signalCancelled()) {
          setIgnoredGroupTransactions([]);
        }
        return;
      }

      try {
        setLoadingSuggestions(true);
        setDetailError("");

        const res = await fetch(
          `${API_BASE}/api/teller/ignored-groups/${encodeURIComponent(vendorKey)}`
        );

        if (!res.ok) {
          throw new Error(`Ignored group request failed: ${res.status}`);
        }

        const payload = await res.json();

        if (!signalCancelled()) {
          setIgnoredGroupTransactions(payload?.transactions || []);
          setTransactionDetail(null);
          setSuggestions([]);
        }
      } catch (err) {
        if (!signalCancelled()) {
          setDetailError(err.message || "Failed to load ignored vendor group.");
          setIgnoredGroupTransactions([]);
        }
      } finally {
        if (!signalCancelled()) setLoadingSuggestions(false);
      }
    },
    []
  );

  const loadTransactionDetail = useCallback(
    async (transactionId, signalCancelled = () => false) => {
      if (!transactionId) {
        if (!signalCancelled()) {
          setTransactionDetail(null);
          setSuggestions([]);
        }
        return;
      }

      try {
        setLoadingSuggestions(true);
        setDetailError("");

        const [detailRes, suggestionsRes] = await Promise.all([
          fetch(`${API_BASE}/api/teller/${transactionId}`),
          fetch(`${API_BASE}/api/teller/${transactionId}/suggestions`),
        ]);

        if (!detailRes.ok) {
          throw new Error(`Detail request failed: ${detailRes.status}`);
        }

        if (!suggestionsRes.ok) {
          throw new Error(`Suggestions request failed: ${suggestionsRes.status}`);
        }

        const detailData = await detailRes.json();
        const suggestionsPayload = await suggestionsRes.json();
        const suggestionRows = extractRows(suggestionsPayload);

        if (!signalCancelled()) {
          setTransactionDetail(detailData || null);
          setSuggestions(suggestionRows);
        }
      } catch (err) {
        if (!signalCancelled()) {
          setDetailError(err.message || "Failed to load transaction details.");
          setTransactionDetail(null);
          setSuggestions([]);
        }
      } finally {
        if (!signalCancelled()) setLoadingSuggestions(false);
      }
    },
    []
  );

  useEffect(() => {
    setPage(1);
  }, [activeBucket]);

  useEffect(() => {
    let cancelled = false;
    loadSummary(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadSummary]);

  useEffect(() => {
    loadExpenseCategories();
  }, [loadExpenseCategories]);

  useEffect(() => {
    let cancelled = false;
    loadTransactions(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTransactions]);

  useEffect(() => {
    let cancelled = false;

    if (activeBucket === "ignored") {
      loadIgnoredGroupDetail(selectedIgnoredGroup?.vendor_key, () => cancelled);
    } else {
      loadTransactionDetail(selectedTransaction?.id, () => cancelled);
    }

    return () => {
      cancelled = true;
    };
  }, [
    activeBucket,
    selectedIgnoredGroup?.vendor_key,
    selectedTransaction?.id,
    loadIgnoredGroupDetail,
    loadTransactionDetail,
  ]);

  function handleNext() {
    if (!canGoNext) return;
    const nextRow = transactions[selectedIndex + 1];
    if (nextRow) {
      setSelectedTransaction(nextRow);
      setActionError("");
    }
  }

  function handlePrevious() {
    if (!canGoPrevious) return;
    const previousRow = transactions[selectedIndex - 1];
    if (previousRow) {
      setSelectedTransaction(previousRow);
      setActionError("");
    }
  }

  function closeDraftModal() {
    if (draftLoading || acting === "create") return;
    setDraftOpen(false);
    setExpenseDraft(null);
    setDraftTransactionId(null);
  }

  function closeIncomeDraftModal() {
    if (draftLoading || acting === "income") return;
    setIncomeDraftOpen(false);
    setIncomeDraft(null);
    setIncomeDraftTransactionId(null);
  }

  async function handleOpenExpenseDraft(transactionId) {
    if (!transactionId) return;

    try {
      setActionError("");
      setDraftLoading(true);
      setDraftTransactionId(transactionId);

      const res = await fetch(`${API_BASE}/api/teller/${transactionId}/expense-draft`);
      if (!res.ok) {
        let message = `Expense draft request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      const draft = await res.json();
      setExpenseDraft(draft);
      setDraftOpen(true);
    } catch (err) {
      setActionError(err.message || "Failed to load expense draft.");
      setDraftTransactionId(null);
    } finally {
      setDraftLoading(false);
    }
  }

  function handleDraftChange(field, value) {
    setExpenseDraft((current) => {
      if (!current) return current;

      return {
        ...current,
        [field]: value,
      };
    });
  }

  async function handleAddExpenseCategory(rawCategory) {
    const category = String(rawCategory || "").trim();
    if (!category) return;

    const nextCategories = Array.from(
      new Set([...expenseCategories, category])
    ).sort((a, b) => a.localeCompare(b));

    try {
      setCategoryMessage("Saving category...");

      const res = await fetch(`${API_BASE}/api/settings/expenses.categories`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: { categories: nextCategories } }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json?.error || "Failed to save category");
      }

      const savedCategories = Array.isArray(json.value?.categories)
        ? json.value.categories
        : nextCategories;
      setExpenseCategories(savedCategories);
      setCategoryMessage("Category saved");
      setExpenseDraft((current) =>
        current
          ? {
              ...current,
              category,
              new_category: "",
            }
          : current
      );
    } catch (err) {
      setCategoryMessage(err.message || "Failed to save category");
    }
  }

  function handleIncomeDraftChange(field, value) {
    setIncomeDraft((current) => {
      if (!current) return current;

      return {
        ...current,
        [field]: value,
      };
    });
  }

  async function handleOpenIncomeDraft(transactionId) {
    if (!transactionId) return;

    try {
      setActionError("");
      setDraftLoading(true);
      setIncomeDraftTransactionId(transactionId);

      const res = await fetch(`${API_BASE}/api/teller/${transactionId}/income-draft`);
      if (!res.ok) {
        let message = `Income draft request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      const draft = await res.json();
      setIncomeDraft(draft);
      setIncomeDraftOpen(true);
    } catch (err) {
      setActionError(err.message || "Failed to load income draft.");
      setIncomeDraftTransactionId(null);
    } finally {
      setDraftLoading(false);
    }
  }

  async function handleIgnoreSimilar(group) {
    if (!group?.vendor_key) return;

    try {
      setActionError("");
      setActing("ignore-similar");

      const rawMatchValue = String(group.vendor_key || "").trim();

      if (!rawMatchValue) {
        throw new Error("Could not determine a vendor value to ignore.");
      }

      const res = await fetch(`${API_BASE}/api/teller/ignore-rules`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          create_rule: true,
          match_type: "contains",
          match_value: rawMatchValue,
          reason: `Ignored similar transactions for ${rawMatchValue}`,
        }),
      });

      if (!res.ok) {
        let message = `Ignore similar request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      await loadSummary();
      await loadTransactions(() => false, rawMatchValue);
    } catch (err) {
      setActionError(err.message || "Failed to ignore similar transactions.");
    } finally {
      setActing("");
    }
  }

  async function refreshAfterAction(indexHint) {
    await loadSummary();

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });

    const endpoint =
      activeBucket === "pending"
        ? `${API_BASE}/api/teller/pending?${params.toString()}`
        : activeBucket === "all"
          ? `${API_BASE}/api/teller?${params.toString()}`
          : `${API_BASE}/api/teller?review_status=${encodeURIComponent(activeBucket)}&${params.toString()}`;

    const listRes = await fetch(endpoint);
    if (!listRes.ok) {
      throw new Error(`Transaction request failed: ${listRes.status}`);
    }

    const payload = await listRes.json();
    const rows = extractRows(payload);
    const nextPagination = payload?.pagination || {
      page,
      limit,
      total: rows.length,
      total_pages: 1,
    };

    setTransactions(rows);
    setPagination(nextPagination);

    const nextSelection =
      rows[indexHint] ||
      rows[indexHint - 1] ||
      rows[0] ||
      null;

    setSelectedTransaction(nextSelection);
    setTransactionDetail(null);

    if (nextSelection?.id) {
      await loadTransactionDetail(nextSelection.id);
    } else {
      setSuggestions([]);
    }
  }

  async function handleMatch(expenseId) {
    if (!selectedTransaction?.id || !expenseId) return;

    try {
      setActionError("");
      setMatchingExpenseId(expenseId);

      const indexHint = selectedIndex;
      const currentId = selectedTransaction.id;

      const res = await fetch(`${API_BASE}/api/teller/${currentId}/match`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expense_id: expenseId,
        }),
      });

      if (!res.ok) {
        let message = `Match request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      await refreshAfterAction(indexHint);
    } catch (err) {
      setActionError(err.message || "Failed to match transaction.");
    } finally {
      setMatchingExpenseId(null);
    }
  }

  async function handleDismiss(transactionId) {
    if (!transactionId) return;

    try {
      setActionError("");
      setActing("dismiss");

      const indexHint = selectedIndex;

      const res = await fetch(`${API_BASE}/api/teller/${transactionId}/dismiss`, {
        method: "POST",
      });

      if (!res.ok) {
        let message = `Dismiss request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      await refreshAfterAction(indexHint);
    } catch (err) {
      setActionError(err.message || "Failed to dismiss transaction.");
    } finally {
      setActing("");
    }
  }

  async function handleIgnore(transactionId) {
    if (!transactionId) return;

    try {
      setActionError("");
      setActing("ignore");

      const indexHint = selectedIndex;

      const res = await fetch(`${API_BASE}/api/teller/${transactionId}/ignore`, {
        method: "POST",
      });

      if (!res.ok) {
        let message = `Ignore request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      await refreshAfterAction(indexHint);
    } catch (err) {
      setActionError(err.message || "Failed to ignore transaction.");
    } finally {
      setActing("");
    }
  }

  async function handleCreateExpense() {
    if (!draftTransactionId || !expenseDraft) return;

    try {
      setActionError("");
      setActing("create");

      const indexHint = selectedIndex;

      const payload = {
        ...expenseDraft,
        new_category: undefined,
        vehicle_id:
          expenseDraft.vehicle_id === "" || expenseDraft.vehicle_id == null
            ? null
            : Number(expenseDraft.vehicle_id),
        price:
          expenseDraft.price === "" || expenseDraft.price == null
            ? null
            : Number(expenseDraft.price),
        tax:
          expenseDraft.tax === "" || expenseDraft.tax == null
            ? 0
            : Number(expenseDraft.tax),
      };

      const res = await fetch(`${API_BASE}/api/teller/${draftTransactionId}/create-expense`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = `Create expense request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      setDraftOpen(false);
      setExpenseDraft(null);
      setDraftTransactionId(null);

      await refreshAfterAction(indexHint);
    } catch (err) {
      setActionError(err.message || "Failed to create expense.");
    } finally {
      setActing("");
    }
  }

  async function handleCreateIncome() {
    if (!incomeDraftTransactionId || !incomeDraft) return;

    try {
      setActionError("");
      setActing("income");

      const indexHint = selectedIndex;
      const payload = {
        ...incomeDraft,
        trip_id: null,
        amount:
          incomeDraft.amount === "" || incomeDraft.amount == null
            ? null
            : Number(incomeDraft.amount),
      };

      const res = await fetch(`${API_BASE}/api/teller/${incomeDraftTransactionId}/create-income`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = `Create income request failed: ${res.status}`;
        try {
          const errData = await res.json();
          message = errData?.error || errData?.message || message;
        } catch {
          // ignore parse failure
        }
        throw new Error(message);
      }

      setIncomeDraftOpen(false);
      setIncomeDraft(null);
      setIncomeDraftTransactionId(null);

      await refreshAfterAction(indexHint);
    } catch (err) {
      setActionError(err.message || "Failed to create income.");
    } finally {
      setActing("");
    }
  }

  return (
    <>
      <ExpenseProcessingBucketPanel
        summary={safeSummary}
        activeBucket={activeBucket}
        onChange={setActiveBucket}
      />

      <ExpenseProcessingListPanel
        activeBucket={activeBucket}
        transactions={transactions}
        ignoredGroups={ignoredGroups}
        selectedId={selectedTransaction?.id}
        selectedVendorKey={selectedIgnoredGroup?.vendor_key}
        onSelect={setSelectedTransaction}
        onSelectIgnoredGroup={setSelectedIgnoredGroup}
        loading={loadingList}
        error={listError || summaryError}
        page={pagination.page}
        totalPages={pagination.total_pages}
        total={pagination.total}
        onPreviousPage={() => setPage((p) => Math.max(1, p - 1))}
        onNextPage={() =>
          setPage((p) => Math.min(pagination.total_pages || 1, p + 1))
        }
      />

      <ExpenseProcessingDetailPanel
        activeBucket={activeBucket}
        transaction={transactionDetail || selectedTransaction}
        ignoredGroup={selectedIgnoredGroup}
        ignoredGroupTransactions={ignoredGroupTransactions}
        suggestions={suggestions}
        loading={loadingSuggestions}
        error={detailError}
        actionError={actionError}
        onMatch={handleMatch}
        onDismiss={handleDismiss}
        onIgnore={handleIgnore}
        onIgnoreSimilar={handleIgnoreSimilar}
        onCreateExpense={handleOpenExpenseDraft}
        onCreateIncome={handleOpenIncomeDraft}
        onNext={handleNext}
        onPrevious={handlePrevious}
        canGoNext={canGoNext}
        canGoPrevious={canGoPrevious}
        matchingExpenseId={matchingExpenseId}
        acting={acting}
        draftLoading={draftLoading}
      />

      <ExpenseDraftModal
        open={draftOpen}
        draft={expenseDraft}
        categories={expenseCategories}
        vehicles={vehicles}
        vehiclesLoading={vehiclesLoading}
        vehiclesError={vehiclesError}
        categoryMessage={categoryMessage}
        saving={acting === "create"}
        onClose={closeDraftModal}
        onChange={handleDraftChange}
        onAddCategory={handleAddExpenseCategory}
        onSubmit={handleCreateExpense}
      />

      <IncomeDraftModal
        open={incomeDraftOpen}
        draft={incomeDraft}
        saving={acting === "income"}
        onClose={closeIncomeDraftModal}
        onChange={handleIncomeDraftChange}
        onSubmit={handleCreateIncome}
      />
    </>
  );
}
