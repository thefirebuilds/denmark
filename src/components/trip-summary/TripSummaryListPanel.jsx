// ------------------------------------------------------------
// /src/components/trip-summary/TripSummaryListPanel.jsx
// Center panel for the trip summary ledger. Renders filters,
// trip rows, and audit flags for the currently filtered trips.
// Data loading is owned by the parent page component.
// ------------------------------------------------------------

import { useMemo } from "react";
import {
  getMilesDriven,
  isTripInProgress,
  hasDataIssues,
} from "../../utils/tripUtils";

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

function formatDateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAuditFlags(trip, vehicleStatuses = []) {
  const flags = [];

  const start = Number(trip?.starting_odometer);
  const end = Number(trip?.ending_odometer);
  const explicitMiles = Number(trip?.miles_driven);
  const miles = getMilesDriven(trip, vehicleStatuses);

  const startTime = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;
  const endTime = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;

  if (!trip?.trip_start || !trip?.trip_end) {
    flags.push("missing dates");
  }

  if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime < startTime) {
    flags.push("backwards dates");
  }

  if (!Number.isFinite(start)) {
    flags.push("missing start odometer");
  }

  if (!Number.isFinite(end) && !isTripInProgress(trip)) {
    flags.push("missing end odometer");
  }

  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    flags.push("end before start");
  }

  if (trip?.gross_income == null && trip?.amount == null) {
    flags.push("missing income");
  }

  if (Number.isFinite(explicitMiles) && explicitMiles < 0) {
    flags.push("bad miles value");
  }

  if (hasDataIssues(trip, vehicleStatuses)) {
    flags.push("data issue");
  }

  if (!trip?.reservation_id) {
    flags.push("missing reservation");
  }

  if (
    isTripInProgress(trip) &&
    Number.isFinite(start) &&
    !Number.isFinite(miles)
  ) {
    flags.push("missing live mileage");
  }

  return [...new Set(flags)];
}

export default function TripSummaryListPanel({
  selectedTripId = null,
  onSelectTrip,
  onCreateTrip,
  filters = {
    startDate: "",
    endDate: "",
    search: "",
    tripHealth: "all",
  },
  onFiltersChange,
  trips = [],
  loading = false,
  loadError = "",
  vehicleStatuses = [],
}) {
  const sortedTrips = useMemo(() => {
    return [...trips].sort((a, b) => {
      const aStart = a?.trip_start
        ? new Date(a.trip_start).getTime()
        : Number.NEGATIVE_INFINITY;

      const bStart = b?.trip_start
        ? new Date(b.trip_start).getTime()
        : Number.NEGATIVE_INFINITY;

      return bStart - aStart;
    });
  }, [trips]);

  return (
    <section className="panel trip-summary-list-panel">
      <div className="panel-header">
        <div>
          <h2>Trip Ledger</h2>
          <span>historical record and audit log</span>
        </div>
        <button
          type="button"
          className="trip-summary-new-button"
          onClick={onCreateTrip}
        >
          New Trip
        </button>
      </div>

      <div className="panel-subbar trip-summary-toolbar">
        <input
          type="date"
          value={filters.startDate || ""}
          onChange={(e) =>
            onFiltersChange?.((prev) => ({
              ...prev,
              startDate: e.target.value,
            }))
          }
        />

        <input
          type="date"
          value={filters.endDate || ""}
          onChange={(e) =>
            onFiltersChange?.((prev) => ({
              ...prev,
              endDate: e.target.value,
            }))
          }
        />

        <input
          type="text"
          placeholder="Search guest, reservation, notes..."
          value={filters.search || ""}
          onChange={(e) =>
            onFiltersChange?.((prev) => ({
              ...prev,
              search: e.target.value,
            }))
          }
        />

        <div className="trip-summary-toolbar-group">
          <select
            value={filters.tripHealth || "all"}
            onChange={(e) =>
              onFiltersChange?.((prev) => ({
                ...prev,
                tripHealth: e.target.value,
              }))
            }
          >
            <option value="all">All trips</option>
            <option value="open_action_needed">Open / incomplete / active</option>
            <option value="open_tolls">Open toll billing</option>
            <option value="no_vehicle_assigned">No car assigned</option>
            <option value="data_issues">Weird metrics / bad data</option>
          </select>
        </div>
      </div>

      <div className="panel-subbar">
        <div className="chip">{sortedTrips.length} trips</div>
      </div>

      <div className="list">
        {loading ? (
          <article className="trip-card">
            <div className="trip-title">Loading trip summaries...</div>
          </article>
        ) : null}

        {!loading && loadError ? (
          <article className="trip-card risk">
            <div className="trip-title">Failed to load trip summaries</div>
            <div className="trip-sub">{loadError}</div>
          </article>
        ) : null}

        {!loading && !loadError && !sortedTrips.length ? (
          <article className="trip-card">
            <div className="trip-title">No trips found</div>
            <div className="trip-sub">
              Try changing the date filter, vehicle selection, search text, or trip filter.
            </div>
          </article>
        ) : null}

        {!loading &&
          !loadError &&
          sortedTrips.map((trip) => {
            const selected = trip.id === selectedTripId;
            const miles = getMilesDriven(trip, vehicleStatuses);
            const flags = getAuditFlags(trip, vehicleStatuses);

            return (
              <article
                key={trip.id}
                className={`trip-card ${selected ? "selected" : ""}`}
                onClick={() =>
                  onSelectTrip?.(selected ? null : trip)
                }
              >
                <div className="trip-top">
                  <div className="trip-title">
                    {trip.guest_name || "Unknown guest"} •{" "}
                    {trip.vehicle_name || trip.vehicle_nickname || "Unknown car"}
                  </div>

                  <div className="trip-sub">
                    {trip.vehicle_year || trip.vehicle_make || trip.vehicle_model
                      ? [trip.vehicle_year, trip.vehicle_make, trip.vehicle_model]
                          .filter(Boolean)
                          .join(" ")
                      : "Vehicle details unavailable"}
                  </div>

                  <div className="trip-sub">
                    Reservation #{trip.reservation_id || "—"}
                  </div>

                  <div className="chip">
                    {trip.display_status || trip.status || "unknown"}
                  </div>
                </div>

                <div className="trip-meta">
                  <div>
                    <div className="meta-label">Trip window</div>
                    <div className="meta-value">
                      {formatDate(trip.trip_start)} → {formatDate(trip.trip_end)}
                    </div>
                  </div>

                  <div>
                    <div className="meta-label">Gross income</div>
                    <div className="meta-value">
                      {money(trip.gross_income ?? trip.amount)}
                    </div>
                  </div>

                  <div className="trip-meta-stacked">
                    <div className="meta-label">Miles driven</div>
                    <div className="meta-value">
                      {Number.isFinite(miles) ? miles.toLocaleString("en-US") : "—"}
                    </div>
                  </div>
                        <div>
                          <div className="meta-label">Tolls</div>
                          <div className="meta-value">
                            {money(trip.toll_total)} · {trip.toll_review_status || "none"}
                          </div>
                        </div>

                  <div>
                    <div className="meta-label">Updated</div>
                    <div className="meta-value">
                      {formatDateTime(trip.updated_at)}
                    </div>
                  </div>
                </div>

                {!!flags.length && (
                  <div className="panel-subbar">
                    {flags.map((flag) => (
                      <div key={flag} className="chip">
                        {flag}
                      </div>
                    ))}
                  </div>
                )}

                <div className="trip-sub" style={{ marginTop: 8 }}>
                  {trip.notes?.trim() || "No notes recorded."}
                </div>
              </article>
            );
          })}
      </div>
    </section>
  );
}
