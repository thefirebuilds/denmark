import { useEffect, useState } from "react";

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
  assigningChargeId = null,
  onAssignTrip = null,
  onClose,
}) {
  const [selectedTripByCharge, setSelectedTripByCharge] = useState({});

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  function updateSelectedTrip(chargeId, tripId) {
    setSelectedTripByCharge((prev) => ({
      ...prev,
      [chargeId]: tripId,
    }));
  }

  async function handleAssignTrip(charge) {
    if (!onAssignTrip) return;
    const selectedValue = selectedTripByCharge[charge.toll_charge_id] || "";
    if (!selectedValue) return;
    await onAssignTrip(charge.toll_charge_id, selectedValue);
  }

  const unattributed = detail?.unattributed || {};
  const outstanding = detail?.outstanding || {};
  const discrepancies = detail?.discrepancies || {};

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
                      <div className="toll-audit-item__details toll-audit-item__details--financial">
                        <span>Charged: {trip.charged_toll_amount == null ? "--" : formatCurrency(trip.charged_toll_amount)}</span>
                        <span>Attributed: {formatCurrency(trip.attributed_toll_amount ?? trip.toll_total ?? 0)}</span>
                        <span>Delta: {trip.toll_delta == null ? "--" : formatCurrency(trip.toll_delta)}</span>
                      </div>
                    </article>
                  ))}
                  {!outstanding.trips?.length ? (
                    <div className="metrics-financial-empty">No outstanding toll trips in this range.</div>
                  ) : null}
                </div>
              </section>

              <section className="toll-audit-section">
                <div className="toll-audit-section__header">
                  <div className="toll-audit-section__title">Charge Discrepancies</div>
                  <div className="toll-audit-section__meta">
                    {formatCurrency(discrepancies.total_delta)} across{" "}
                    {Number(discrepancies.count ?? 0)} trip
                    {Number(discrepancies.count ?? 0) === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="toll-audit-list">
                  {(discrepancies.trips || []).map((trip) => (
                    <article key={`discrepancy-${trip.trip_id}`} className="toll-audit-item">
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
                          {formatCurrency(trip.toll_delta)}
                        </div>
                      </div>
                      <div className="toll-audit-item__details toll-audit-item__details--financial">
                        <span>Charged: {trip.charged_toll_amount == null ? "--" : formatCurrency(trip.charged_toll_amount)}</span>
                        <span>Attributed: {formatCurrency(trip.attributed_toll_amount ?? 0)}</span>
                        <span>Status: {trip.toll_review_status || "pending"}</span>
                      </div>
                    </article>
                  ))}
                  {!discrepancies.trips?.length ? (
                    <div className="metrics-financial-empty">No toll charge mismatches in this range.</div>
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
                      <div className="toll-audit-assign">
                        <label className="toll-audit-assign__label">
                          Likely trip
                          <select
                            className="toll-audit-assign__select"
                            value={selectedTripByCharge[charge.toll_charge_id] || ""}
                            onChange={(event) =>
                              updateSelectedTrip(charge.toll_charge_id, event.target.value)
                            }
                            disabled={assigningChargeId === charge.toll_charge_id}
                          >
                            <option value="">Select trip</option>
                            <option value="__off_trip__">Off trip / host use</option>
                            {(charge.candidate_trips || []).map((trip) => (
                              <option key={trip.trip_id} value={trip.trip_id}>
                                {formatTripLabel(trip)} - {formatDateTime(trip.trip_start)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="toll-audit-assign__button"
                          onClick={() => handleAssignTrip(charge)}
                          disabled={
                            assigningChargeId === charge.toll_charge_id ||
                            !selectedTripByCharge[charge.toll_charge_id]
                          }
                        >
                          {assigningChargeId === charge.toll_charge_id
                            ? "Assigning..."
                            : "Assign"}
                        </button>
                      </div>
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
