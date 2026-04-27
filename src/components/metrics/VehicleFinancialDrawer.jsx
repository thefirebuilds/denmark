import { useEffect } from "react";

function formatCurrency(value) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTripLabel(item) {
  if (item?.reservation_id && item?.guest_name) {
    return `Reservation #${item.reservation_id} - ${item.guest_name}`;
  }
  if (item?.reservation_id) return `Reservation #${item.reservation_id}`;
  if (item?.guest_name) return item.guest_name;
  return "Unlinked item";
}

export default function VehicleFinancialDrawer({
  open,
  loading = false,
  error = null,
  detail = null,
  focus = "expenses",
  onClose,
}) {
  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const revenue = detail?.revenue || {};
  const expenses = detail?.expenses || {};

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="app-drawer app-drawer--right metrics-financial-drawer">
        <div className="app-drawer-header">
          <div>
            <div className="app-drawer-title">
              {detail?.vehicle?.nickname || "Vehicle"} Financial Detail
            </div>
            <div className="app-drawer-subtitle">
              Exact revenue drivers and allocated expense line items for the selected range.
            </div>
          </div>

          <button type="button" className="app-drawer-close" onClick={onClose}>
            x
          </button>
        </div>

        <div className="app-drawer-body metrics-financial-drawer-body">
          {loading ? (
            <div className="metrics-financial-empty">Loading financial detail...</div>
          ) : error ? (
            <div className="metrics-financial-empty">Failed to load detail: {error}</div>
          ) : !detail ? (
            <div className="metrics-financial-empty">No financial detail available.</div>
          ) : (
            <>
              <section className="metrics-financial-summary">
                <div className="metrics-financial-summary-card">
                  <div className="metrics-financial-label">Revenue</div>
                  <div className="metrics-financial-value">
                    {formatCurrency(revenue.total_revenue)}
                  </div>
                </div>
                <div className="metrics-financial-summary-card">
                  <div className="metrics-financial-label">Expenses</div>
                  <div className="metrics-financial-value">
                    {formatCurrency(expenses.total_expenses)}
                  </div>
                </div>
                <div className="metrics-financial-summary-card">
                  <div className="metrics-financial-label">Net</div>
                  <div className="metrics-financial-value">
                    {formatCurrency(
                      Number(revenue.total_revenue ?? 0) -
                        Number(expenses.total_expenses ?? 0)
                    )}
                  </div>
                </div>
              </section>

              <section
                className={`metrics-financial-section ${
                  focus === "revenue" ? "is-focused" : ""
                }`}
              >
                <div className="metrics-financial-section-title">Revenue makeup</div>
                <div className="metrics-financial-breakdown">
                  <div className="metrics-financial-breakdown-row">
                    <span>Trip payout</span>
                    <strong>{formatCurrency(revenue.trip_income)}</strong>
                  </div>
                  <div className="metrics-financial-breakdown-row">
                    <span>Fuel reimbursement</span>
                    <strong>{formatCurrency(revenue.fuel_reimbursement_income)}</strong>
                  </div>
                  <div className="metrics-financial-breakdown-row">
                    <span>Recognized toll recovery</span>
                    <strong>{formatCurrency(revenue.toll_revenue_income)}</strong>
                  </div>
                </div>

                <div className="metrics-financial-list">
                  {(revenue.trips || []).map((trip) => (
                    <article
                      key={trip.trip_id}
                      className="metrics-financial-line-item"
                    >
                      <div className="metrics-financial-line-top">
                        <div>
                          <div className="metrics-financial-line-title">
                            {formatTripLabel(trip)}
                          </div>
                          <div className="metrics-financial-line-meta">
                            {formatDate(trip.trip_start)} - {formatDate(trip.trip_end)}
                          </div>
                        </div>
                        <div className="metrics-financial-line-amount">
                          {formatCurrency(trip.total_revenue)}
                        </div>
                      </div>
                      <div className="metrics-financial-line-split">
                        <span>Trip {formatCurrency(trip.trip_income)}</span>
                        <span>Fuel {formatCurrency(trip.fuel_reimbursement_income)}</span>
                        <span>Tolls {formatCurrency(trip.toll_revenue_income)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section
                className={`metrics-financial-section ${
                  focus === "expenses" ? "is-focused" : ""
                }`}
              >
                <div className="metrics-financial-section-title">Expense makeup</div>
                <div className="metrics-financial-breakdown">
                  <div className="metrics-financial-breakdown-row">
                    <span>Direct</span>
                    <strong>{formatCurrency(expenses.direct_expenses)}</strong>
                  </div>
                  <div className="metrics-financial-breakdown-row">
                    <span>General</span>
                    <strong>{formatCurrency(expenses.general_expenses)}</strong>
                  </div>
                  <div className="metrics-financial-breakdown-row">
                    <span>Shared</span>
                    <strong>{formatCurrency(expenses.shared_expenses)}</strong>
                  </div>
                  <div className="metrics-financial-breakdown-row">
                    <span>Apportioned</span>
                    <strong>{formatCurrency(expenses.apportioned_expenses)}</strong>
                  </div>
                </div>

                <div className="metrics-financial-list">
                  {(expenses.line_items || []).map((item) => (
                    <article
                      key={item.expense_id}
                      className="metrics-financial-line-item"
                    >
                      <div className="metrics-financial-line-top">
                        <div>
                          <div className="metrics-financial-line-title">
                            {item.vendor || item.category || "Expense"}
                          </div>
                          <div className="metrics-financial-line-meta">
                            {formatDate(item.date)} · {item.category || "Uncategorized"} ·{" "}
                            {item.expense_scope || "direct"}
                            {item.reservation_id
                              ? ` · ${formatTripLabel(item)}`
                              : ""}
                          </div>
                        </div>
                        <div className="metrics-financial-line-amount">
                          {formatCurrency(item.allocated_amount)}
                        </div>
                      </div>
                      <div className="metrics-financial-line-split">
                        <span>Source {formatCurrency(item.total_amount)}</span>
                        <span>Allocated {formatCurrency(item.allocated_amount)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
