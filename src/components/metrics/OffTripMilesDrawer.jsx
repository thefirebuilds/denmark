import { useEffect, useMemo, useState } from "react";

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
  onSaveReview,
  onClose,
}) {
  const [drafts, setDrafts] = useState({});
  const [savingKey, setSavingKey] = useState("");
  const [saveError, setSaveError] = useState("");

  const reviewSeed = useMemo(() => {
    const next = {};
    for (const item of [...(audit?.segments || []), ...(audit?.skipped_trips || [])]) {
      if (!item?.audit_key) continue;
      next[item.audit_key] = {
        review_status: item.review_status || "",
        review_reason: item.review_reason || "",
        reconciled_off_trip_miles:
          item.reconciled_off_trip_miles == null
            ? ""
            : String(item.reconciled_off_trip_miles),
      };
    }
    return next;
  }, [audit]);

  useEffect(() => {
    setDrafts(reviewSeed);
    setSaveError("");
    setSavingKey("");
  }, [reviewSeed, open]);

  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  function getDraft(item) {
    return (
      drafts[item.audit_key] || {
        review_status: item.review_status || "",
        review_reason: item.review_reason || "",
        reconciled_off_trip_miles:
          item.reconciled_off_trip_miles == null
            ? ""
            : String(item.reconciled_off_trip_miles),
      }
    );
  }

  function updateDraft(auditKey, patch) {
    setDrafts((prev) => ({
      ...prev,
      [auditKey]: {
        ...(prev[auditKey] || {}),
        ...patch,
      },
    }));
  }

  async function handleSaveReview(item) {
    if (!onSaveReview || !item?.audit_key) return;
    const draft = getDraft(item);
    setSavingKey(item.audit_key);
    setSaveError("");

    try {
      await onSaveReview({
        audit_key: item.audit_key,
        review_status: draft.review_status || "",
        review_reason: draft.review_reason || "",
        reconciled_off_trip_miles: draft.reconciled_off_trip_miles || "",
      });
    } catch (err) {
      setSaveError(err.message || "Failed to save review");
    } finally {
      setSavingKey("");
    }
  }

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

                <div className="metrics-audit-summary-card">
                  <div className="metrics-audit-summary-label">Skipped trips</div>
                  <div className="metrics-audit-summary-value">
                    {formatNumber(audit?.summary?.skipped_trip_count)}
                  </div>
                </div>

                <div className="metrics-audit-summary-card">
                  <div className="metrics-audit-summary-label">Reviewed</div>
                  <div className="metrics-audit-summary-value">
                    {formatNumber(audit?.summary?.reviewed_count)}
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
                          {vehicle.skipped_trip_count
                            ? ` - ${formatNumber(vehicle.skipped_trip_count)} skipped`
                            : ""}
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

                      {segment.reconciled_off_trip_miles != null &&
                      Number(segment.reconciled_off_trip_miles) !==
                        Number(segment.raw_off_trip_miles) ? (
                        <div className="metrics-audit-segment-meta">
                          Raw stored gap: {formatNumber(segment.raw_off_trip_miles, 1)} mi
                        </div>
                      ) : null}

                      <div className="metrics-audit-review-row">
                        <select
                          className="metrics-audit-review-select"
                          value={getDraft(segment).review_status}
                          onChange={(event) =>
                            updateDraft(segment.audit_key, {
                              review_status: event.target.value,
                            })
                          }
                        >
                          <option value="">Needs audit</option>
                          <option value="validated">Validated</option>
                          <option value="reconciled">Reconciled</option>
                          <option value="ignored">Ignored</option>
                        </select>

                        <input
                          className="metrics-audit-review-input"
                          value={getDraft(segment).review_reason}
                          onChange={(event) =>
                            updateDraft(segment.audit_key, {
                              review_reason: event.target.value,
                            })
                          }
                          placeholder="Reason / audit note"
                        />

                        <input
                          className="metrics-audit-review-input"
                          value={getDraft(segment).reconciled_off_trip_miles}
                          onChange={(event) =>
                            updateDraft(segment.audit_key, {
                              reconciled_off_trip_miles: event.target.value,
                            })
                          }
                          placeholder="Actual miles"
                          inputMode="decimal"
                        />

                        <button
                          type="button"
                          className="metrics-audit-review-save"
                          disabled={savingKey === segment.audit_key}
                          onClick={() => handleSaveReview(segment)}
                        >
                          {savingKey === segment.audit_key ? "Saving..." : "Save"}
                        </button>
                      </div>

                      <div className="metrics-audit-segment-grid metrics-audit-segment-grid--paired">
                        <div className="metrics-audit-trip-card">
                          <div className="metrics-audit-label">Previous trip</div>
                          <div className="metrics-audit-value">
                            {formatTripReference(
                              segment.previous_reservation_id,
                              segment.previous_guest_name,
                              "No closed prior trip"
                            )}
                          </div>
                          <div className="metrics-audit-trip-card-meta">
                            <span>{formatDateTime(segment.previous_trip_end)}</span>
                            <span>
                              {formatNumber(segment.previous_ending_odometer)} mi
                            </span>
                          </div>
                        </div>

                        <div className="metrics-audit-trip-card">
                          <div className="metrics-audit-label">Next trip</div>
                          <div className="metrics-audit-value">
                            {formatTripReference(
                              segment.next_reservation_id,
                              segment.next_guest_name,
                              "-"
                            )}
                          </div>
                          <div className="metrics-audit-trip-card-meta">
                            <span>{formatDateTime(segment.next_trip_start)}</span>
                            <span>
                              {formatNumber(segment.next_starting_odometer)} mi
                            </span>
                          </div>
                        </div>

                        <div className="metrics-audit-gap-row">
                          <span className="metrics-audit-label">Gap days</span>
                          <span className="metrics-audit-value">
                            {segment.gap_days == null
                              ? "-"
                              : `${formatNumber(segment.gap_days, 2)} days`}
                          </span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              {audit.skipped_trips?.length ? (
                <section className="metrics-audit-section">
                  <div className="metrics-audit-section-title">Excluded trips</div>
                  <div className="metrics-audit-segment-list">
                    {audit.skipped_trips.map((trip) => (
                      <article
                        key={`skipped-${trip.vehicle_id}-${trip.trip_id || trip.reservation_id || trip.trip_start}`}
                        className="metrics-audit-segment"
                      >
                        <div className="metrics-audit-segment-top">
                          <div>
                            <div className="metrics-audit-segment-name">{trip.nickname}</div>
                            <div className="metrics-audit-segment-meta">
                              {trip.vehicle_label}
                            </div>
                          </div>

                        <div className="metrics-audit-segment-miles">
                          Excluded
                        </div>
                      </div>

                        <div className="metrics-audit-review-row">
                          <select
                            className="metrics-audit-review-select"
                            value={getDraft(trip).review_status}
                            onChange={(event) =>
                              updateDraft(trip.audit_key, {
                                review_status: event.target.value,
                              })
                            }
                          >
                            <option value="">Needs audit</option>
                            <option value="validated">Validated</option>
                            <option value="reconciled">Reconciled</option>
                            <option value="ignored">Ignored</option>
                          </select>

                          <input
                            className="metrics-audit-review-input"
                            value={getDraft(trip).review_reason}
                            onChange={(event) =>
                              updateDraft(trip.audit_key, {
                                review_reason: event.target.value,
                              })
                            }
                            placeholder="Reason / audit note"
                          />

                          <input
                            className="metrics-audit-review-input"
                            value={getDraft(trip).reconciled_off_trip_miles}
                            onChange={(event) =>
                              updateDraft(trip.audit_key, {
                                reconciled_off_trip_miles: event.target.value,
                              })
                            }
                            placeholder="Actual miles"
                            inputMode="decimal"
                          />

                          <button
                            type="button"
                            className="metrics-audit-review-save"
                            disabled={savingKey === trip.audit_key}
                            onClick={() => handleSaveReview(trip)}
                          >
                            {savingKey === trip.audit_key ? "Saving..." : "Save"}
                          </button>
                        </div>

                        <div className="metrics-audit-segment-grid">
                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Skipped trip</div>
                            <div className="metrics-audit-value">
                              {formatTripReference(
                                trip.reservation_id,
                                trip.guest_name,
                                "-"
                              )}
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Trip start</div>
                            <div className="metrics-audit-value">
                              {formatDateTime(trip.trip_start)}
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Trip end</div>
                            <div className="metrics-audit-value">
                              {formatDateTime(trip.trip_end)}
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Starting odometer</div>
                            <div className="metrics-audit-value">
                              {formatNumber(trip.starting_odometer)} mi
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Ending odometer</div>
                            <div className="metrics-audit-value">
                              {formatNumber(trip.ending_odometer)} mi
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Reason</div>
                            <div className="metrics-audit-value">{trip.reason || "-"}</div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Prior anchor</div>
                            <div className="metrics-audit-value">
                              {formatTripReference(
                                trip.anchor_previous_reservation_id,
                                trip.anchor_previous_guest_name,
                                "No prior anchor"
                              )}
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Prior anchor end</div>
                            <div className="metrics-audit-value">
                              {formatDateTime(trip.anchor_previous_trip_end)}
                            </div>
                          </div>

                          <div className="metrics-audit-field">
                            <div className="metrics-audit-label">Prior anchor odometer</div>
                            <div className="metrics-audit-value">
                              {formatNumber(trip.anchor_previous_ending_odometer)} mi
                            </div>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              {saveError ? <div className="panel-error">{saveError}</div> : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
