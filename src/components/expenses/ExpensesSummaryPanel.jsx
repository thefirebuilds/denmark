// ------------------------------------------------------------
// /src/components/expenses/ExpensesSummaryPanel.jsx
// Compact summary panel for expense totals and breakdowns.
// Designed as dense grouped boxes instead of stacked cards.
// ------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";

const API_BASE = "http://localhost:5000";

const RANGE_OPTIONS = [
  { key: "30d", label: "30 Days" },
  { key: "90d", label: "90 Days" },
  { key: "ytd", label: "YTD" },
  { key: "2025", label: "2025" },
  { key: "all", label: "All" },
];

function money(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function buildQuery(params) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    search.set(key, String(value));
  });

  return search.toString();
}

function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getRangeDates(rangeKey) {
  const today = new Date();
  const end = formatDateLocal(today);

  if (rangeKey === "all") {
    return {
      date_from: "",
      date_to: "",
      label: "All time",
    };
  }

  if (rangeKey === "ytd") {
    const start = new Date(today.getFullYear(), 0, 1);
    return {
      date_from: formatDateLocal(start),
      date_to: end,
      label: "Year to date",
    };
  }

  if (rangeKey === "2025") {
    return {
      date_from: "2025-01-01",
      date_to: "2025-12-31",
      label: "Calendar year 2025",
    };
  }

  if (rangeKey === "90d") {
    const start = new Date(today);
    start.setDate(start.getDate() - 89);
    return {
      date_from: formatDateLocal(start),
      date_to: end,
      label: "Last 90 days",
    };
  }

  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  return {
    date_from: formatDateLocal(start),
    date_to: end,
    label: "Last 30 days",
  };
}

function CompactStatBox({ rows }) {
  return (
    <div className="expenses-summary-box">
      <div className="expenses-summary-stat-grid">
        {rows.map((row) => (
          <div key={row.label} className="expenses-summary-stat">
            <div className="expenses-summary-stat-label">{row.label}</div>
            <div className="expenses-summary-stat-value">{row.value}</div>
            {row.sub ? (
              <div className="expenses-summary-stat-sub">{row.sub}</div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function CompactRowsBox({ title, rows, emptyText = "No data." }) {
  return (
    <div className="expenses-summary-box">
      <div className="expenses-summary-box-header">{title}</div>

      {!rows?.length ? (
        <div className="expenses-empty-state compact">{emptyText}</div>
      ) : (
        <div className="expenses-summary-rows">
          {rows.map((row) => (
            <div key={row.key} className="expenses-summary-row">
              <div className="expenses-summary-row-name" title={row.title}>
                {row.title}
              </div>
              <div className="expenses-summary-row-count">{row.sub}</div>
              <div className="expenses-summary-row-amount">{row.total}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExpensesSummaryPanel({ selectedVehicleId }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rangeKey, setRangeKey] = useState("30d");

  const range = useMemo(() => getRangeDates(rangeKey), [rangeKey]);

  const query = useMemo(() => {
    return buildQuery({
      vehicle_id: selectedVehicleId ?? "",
      date_from: range.date_from,
      date_to: range.date_to,
    });
  }, [selectedVehicleId, range]);

  useEffect(() => {
    let ignore = false;

    async function loadSummary() {
      setLoading(true);
      setLoadError("");

      try {
        const res = await fetch(`${API_BASE}/api/expenses/summary?${query}`);
        const json = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(json?.error || "Failed to load expense summary");
        }

        if (!ignore) {
          setSummary(json);
        }
      } catch (err) {
        if (!ignore) {
          setLoadError(err.message || "Failed to load expense summary");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    loadSummary();

    return () => {
      ignore = true;
    };
  }, [query]);

  const statRows = useMemo(() => {
    return [
      {
        label: "Rows",
        value: summary?.totals?.row_count || 0,
        sub: "records",
      },
      {
        label: "Subtotal",
        value: money(summary?.totals?.subtotal),
        sub: "pre-tax",
      },
      {
        label: "Tax",
        value: money(summary?.totals?.tax_total),
        sub: "tax",
      },
      {
        label: "Total",
        value: money(summary?.totals?.grand_total),
        sub: "all-in",
      },
      {
        label: "Capitalized",
        value: money(summary?.totals?.capitalized_total),
        sub: "capex",
      },
      {
        label: "Non-Cap",
        value: money(summary?.totals?.non_capitalized_total),
        sub: "opex",
      },
    ];
  }, [summary]);

  const categoryRows = useMemo(() => {
    return (summary?.by_category || []).map((row) => ({
      key: row.category || "uncategorized",
      title: row.category || "Uncategorized",
      sub: `${row.row_count || 0} item${Number(row.row_count) === 1 ? "" : "s"}`,
      total: money(row.total),
    }));
  }, [summary]);

  const scopeRows = useMemo(() => {
    return (summary?.by_scope || []).map((row) => ({
      key: row.expense_scope || "unknown",
      title: row.expense_scope || "—",
      sub: `${row.row_count || 0} item${Number(row.row_count) === 1 ? "" : "s"}`,
      total: money(row.total),
    }));
  }, [summary]);

  const vehicleRows = useMemo(() => {
    return (summary?.by_vehicle || []).map((row) => ({
      key: `${row.vehicle_id ?? "none"}-${row.vehicle_label || "no_vehicle"}`,
      title: row.vehicle_label || "No vehicle",
      sub: `${row.row_count || 0} item${Number(row.row_count) === 1 ? "" : "s"}`,
      total: money(row.total),
    }));
  }, [summary]);

  return (
    <section className="panel expenses-summary-panel">
      <div className="panel-header">
        <div>
          <h2>{selectedVehicleId ? "Vehicle Summary" : "Expense Summary"}</h2>
          <span>
            {selectedVehicleId ? "Selected vehicle only" : "Fleet-wide totals"} ·{" "}
            {range.label}
          </span>
        </div>
      </div>

      <div className="expenses-summary-range-bar">
        <div className="expenses-summary-range-toggle" role="tablist" aria-label="Summary range">
          {RANGE_OPTIONS.map((option) => {
            const isActive = rangeKey === option.key;

            return (
              <button
                key={option.key}
                type="button"
                className={`expenses-summary-range-btn ${
                  isActive ? "is-active" : ""
                }`}
                onClick={() => setRangeKey(option.key)}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="detail-body">
          <div className="message-empty">Loading summary…</div>
        </div>
      ) : loadError ? (
        <div className="detail-body">
          <div className="expenses-error-state">{loadError}</div>
        </div>
      ) : (
        <div className="detail-body expenses-summary-compact-layout">
          <CompactStatBox rows={statRows} />

          <CompactRowsBox
            title="Categories"
            rows={categoryRows}
            emptyText="No category data."
          />

          <CompactRowsBox
            title="Scope"
            rows={scopeRows}
            emptyText="No scope data."
          />

          {!selectedVehicleId ? (
            <CompactRowsBox
              title="Vehicles"
              rows={vehicleRows}
              emptyText="No vehicle data."
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
