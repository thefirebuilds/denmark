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

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTripLabel(item) {
  if (item?.reservation_id && item?.guest_name) {
    return `Reservation #${item.reservation_id} - ${item.guest_name}`;
  }
  if (item?.reservation_id) return `Reservation #${item.reservation_id}`;
  if (item?.guest_name) return item.guest_name;
  return "Unknown trip";
}

function formatVehicleLabel(item) {
  const nickname = item?.vehicle_nickname || item?.matched_vehicle_nickname;
  const plate = item?.license_plate || item?.matched_vehicle_plate;
  if (nickname && plate) return `${nickname} - ${plate}`;
  return nickname || plate || "Unknown vehicle";
}

export default function TollAuditDrawer({
  open,
  loading = false,
  error = null,
  detail = null,
  focus = "unattributed",
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

  const unattributed = detail?.unattributed || {};
  const outstanding = detail?.outstanding || {};

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="app-drawer app-drawer--right toll-audit-drawer">
        <div className="app-drawer-header">
          <div>
            <div className="app-drawer-title">Toll Audit Detail</div>
            <div className="app-drawer-subtitle">
              Inspect unmatched toll charges and trips still pending toll recovery.
            </div>
          </div>
          <button type="button" className="app-drawer-close" onClick={onClose}>
            x
          </button>
        </div>

        <div className="app-drawer-body toll-audit-drawer-body">
          {loading ? (
            <div className="metrics-financial-empty">Loading toll detail...</div>
          ) : error ? (
            <div className="metrics-financial-empty">Failed to load detail: {error}</div>
          ) : !detail ? (
            <div className="metrics-financial-empty">No toll detail available.</div>
          ) : (
            <>
              <section
                className={`toll-audit-section ${
                  focus === "outstanding" ? "is-focused" : ""
                }`}
              >
                <div className="toll-audit-section__header">
                  <div className="toll-audit-section__title">Outstanding</div>
                  <div className="toll-audit-section__meta">
                    {formatCurrency(outstanding.total_amount)} across{" "}
                    {Number(outstanding.count ?? 0)} trip
                    {Number(outstanding.count ?? 0) === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="toll-audit-list">
                  {(outstanding.trips || []).map((trip) => (
                    <article
                      key={trip.trip_id}
                      className="toll-audit-item"
                    >
                      <div className="toll-audit-item__top">
                        <div>
                          <div className="toll-audit-item__title">
                            {formatTripLabel(trip)}
                          </div>
                          <div className="toll-audit-item__meta">
                            {formatDateTime(trip.trip_start)} - {formatDateTime(trip.trip_end)}
                          </div>
                        </div>
                        <div className="toll-audit-item__amount">
                          {formatCurrency(trip.toll_total)}
                        </div>
                      </div>
                      <div className="toll-audit-item__details">
                        <span>Status: {trip.toll_review_status || "pending"}</span>
                        <span>Stage: {trip.workflow_stage || "--"}</span>
                        <span>Expenses: {trip.expense_status || "--"}</span>
                      </div>
                    </article>
                  ))}
                  {!outstanding.trips?.length ? (
                    <div className="metrics-financial-empty">No outstanding toll trips in this range.</div>
                  ) : null}
                </div>
              </section>

              <section
                className={`toll-audit-section ${
                  focus === "unattributed" ? "is-focused" : ""
                }`}
              >
                <div className="toll-audit-section__header">
                  <div className="toll-audit-section__title">Unattributed</div>
                  <div className="toll-audit-section__meta">
                    {formatCurrency(unattributed.total_amount)} across{" "}
                    {Number(unattributed.count ?? 0)} charge
                    {Number(unattributed.count ?? 0) === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="toll-audit-list">
                  {(unattributed.charges || []).map((charge) => (
                    <article
                      key={charge.toll_charge_id}
                      className="toll-audit-item"
                    >
                      <div className="toll-audit-item__top">
                        <div>
                          <div className="toll-audit-item__title">
                            {formatVehicleLabel(charge)}
                          </div>
                          <div className="toll-audit-item__meta">
                            {formatDateTime(charge.trxn_at)}
                            {charge.facility_name ? ` - ${charge.facility_name}` : ""}
                            {charge.plaza_name ? ` - ${charge.plaza_name}` : ""}
                          </div>
                        </div>
                        <div className="toll-audit-item__amount">
                          {formatCurrency(charge.amount)}
                        </div>
                      </div>
                      <div className="toll-audit-item__details">
                        <span>Plate: {charge.license_plate || "--"}</span>
                        <span>Match: {charge.match_status || "unmatched"}</span>
                        <span>Review: {charge.review_status || "pending"}</span>
                      </div>
                      {charge.candidate_trip ? (
                        <div className="toll-audit-item__hint">
                          Candidate trip: {formatTripLabel(charge.candidate_trip)}{" "}
                          ({formatDateTime(charge.candidate_trip.trip_start)} -{" "}
                          {formatDateTime(charge.candidate_trip.trip_end)})
                        </div>
                      ) : null}
                    </article>
                  ))}
                  {!unattributed.charges?.length ? (
                    <div className="metrics-financial-empty">No unattributed toll charges in this range.</div>
                  ) : null}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
