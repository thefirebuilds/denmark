import { useEffect } from "react";

function formatNumber(value, digits = 0) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTripReference(reservationId, guestName, emptyLabel) {
  if (!reservationId && !guestName) return emptyLabel;
  if (reservationId && guestName) {
    return `Reservation #${reservationId} - ${guestName}`;
  }
  if (reservationId) return `Reservation #${reservationId}`;
  return guestName;
}

export default function OffTripMilesDrawer({
  open,
  loading = false,
  error = null,
  audit = null,
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

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="app-drawer app-drawer--right metrics-audit-drawer">
        <div className="app-drawer-header">
          <div>
            <div className="app-drawer-title">Off-Trip Miles Audit</div>
            <div className="app-drawer-subtitle">
              Gap miles between a prior known trip odometer and the next trip start.
            </div>
          </div>

          <button type="button" className="app-drawer-close" onClick={onClose}>
            x
          </button>
        </div>

        <div className="app-drawer-body metrics-audit-drawer-body">
          {loading ? (
            <div className="metrics-audit-empty">Loading off-trip audit...</div>
          ) : error ? (
            <div className="metrics-audit-empty">Failed to load audit: {error}</div>
          ) : !audit?.segments?.length ? (
            <div className="metrics-audit-empty">No off-trip mileage segments in this range.</div>
          ) : (
            <>
              <section className="metrics-audit-summary">
                <div className="metrics-audit-summary-card">
                  <div className="metrics-audit-summary-label">Off-trip miles</div>
                  <div className="metrics-audit-summary-value">
                    {formatNumber(audit?.summary?.total_off_trip_miles, 1)} mi
                  </div>
                </div>

                <div className="metrics-audit-summary-card">
                  <div className="metrics-audit-summary-label">Segments</div>
                  <div className="metrics-audit-summary-value">
                    {formatNumber(audit?.summary?.segment_count)}
                  </div>
                </div>

                <div className="metrics-audit-summary-card">
                  <div className="metrics-audit-summary-label">Vehicles</div>
                  <div className="metrics-audit-summary-value">
                    {formatNumber(audit?.summary?.vehicle_count)}
                  </div>
                </div>
              </section>

              <section className="metrics-audit-section">
                <div className="metrics-audit-section-title">By vehicle</div>
                <div className="metrics-audit-vehicle-list">
                  {audit.vehicles.map((vehicle) => (
                    <div key={vehicle.vehicle_id} className="metrics-audit-vehicle-item">
                      <div>
                        <div className="metrics-audit-vehicle-name">{vehicle.nickname}</div>
                        <div className="metrics-audit-vehicle-meta">
                          {vehicle.label} - {formatNumber(vehicle.segment_count)} segments
                        </div>
                      </div>
                      <div className="metrics-audit-vehicle-miles">
                        {formatNumber(vehicle.off_trip_miles, 1)} mi
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <section className="metrics-audit-section">
                <div className="metrics-audit-section-title">Counted segments</div>
                <div className="metrics-audit-segment-list">
                  {audit.segments.map((segment) => (
                    <article
                      key={`${segment.vehicle_id}-${segment.previous_trip_id || "start"}-${segment.next_trip_id || "next"}`}
                      className="metrics-audit-segment"
                    >
                      <div className="metrics-audit-segment-top">
                        <div>
                          <div className="metrics-audit-segment-name">
                            {segment.nickname}
                          </div>
                          <div className="metrics-audit-segment-meta">
                            {segment.vehicle_label}
                          </div>
                        </div>

                        <div className="metrics-audit-segment-miles">
                          {formatNumber(segment.off_trip_miles, 1)} mi
                        </div>
                      </div>

                      <div className="metrics-audit-segment-grid">
                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Previous trip</div>
                          <div className="metrics-audit-value">
                            {formatTripReference(
                              segment.previous_reservation_id,
                              segment.previous_guest_name,
                              "No closed prior trip"
                            )}
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Prior trip end</div>
                          <div className="metrics-audit-value">
                            {formatDateTime(segment.previous_trip_end)}
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Prior odometer</div>
                          <div className="metrics-audit-value">
                            {formatNumber(segment.previous_ending_odometer)} mi
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Next trip</div>
                          <div className="metrics-audit-value">
                            {formatTripReference(
                              segment.next_reservation_id,
                              segment.next_guest_name,
                              "-"
                            )}
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Next trip start</div>
                          <div className="metrics-audit-value">
                            {formatDateTime(segment.next_trip_start)}
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Next start odometer</div>
                          <div className="metrics-audit-value">
                            {formatNumber(segment.next_starting_odometer)} mi
                          </div>
                        </div>

                        <div className="metrics-audit-field">
                          <div className="metrics-audit-label">Gap days</div>
                          <div className="metrics-audit-value">
                            {segment.gap_days == null
                              ? "-"
                              : `${formatNumber(segment.gap_days, 2)} days`}
                          </div>
                        </div>
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
