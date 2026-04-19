// ------------------------------------------------------------
// src/components/trip-summary/TripSummaryMetricsPanel.jsx
// Right panel for the trip summary ledger. Displays aggregate metrics
// for the currently selected vehicle/date filter, and key stats for
// the currently selected trip.
// ------------------------------------------------------------

import { getMilesDriven } from "../../utils/tripUtils";

function money(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  });
}

function formatRpm(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  return `${Math.round(num).toLocaleString("en-US")} RPM`;
}

function isTripInProgress(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const status = String(trip?.status || "").toLowerCase();

  return (
    stage === "in_progress" ||
    status === "in_progress" ||
    status === "started" ||
    status === "trip_started"
  );
}

function findVehicleStatusForTrip(trip, vehicleStatuses = []) {
  const tripVehicleName = String(
    trip?.vehicle_name || trip?.vehicle_nickname || ""
  ).trim().toLowerCase();

  if (!tripVehicleName) return null;

  return (
    vehicleStatuses.find((vehicle) => {
      const nickname = String(vehicle?.nickname || "")
        .trim()
        .toLowerCase();
      const turoVehicleName = String(vehicle?.turo_vehicle_name || "")
        .trim()
        .toLowerCase();

      return nickname === tripVehicleName || turoVehicleName === tripVehicleName;
    }) || null
  );
}

export default function TripSummaryMetricsPanel({
  metrics = {
    totalTrips: 0,
    totalRevenue: 0,
    avgRevenue: 0,
    totalDays: 0,
    avgDays: 0,
    totalMiles: 0,
    avgMiles: 0,
    revenuePerDay: 0,
    revenuePerMile: 0,
    incompleteCount: 0,
  },
  selectedTrip = null,
  vehicleStatuses = [],
}) {
  const selectedMiles = getMilesDriven(selectedTrip, vehicleStatuses);
  const selectedGross = Number(
    selectedTrip?.gross_income ?? selectedTrip?.amount ?? 0
  );

  const selectedRevenuePerMile =
    Number.isFinite(selectedMiles) && selectedMiles > 0
      ? selectedGross / selectedMiles
      : 0;

  return (
    <aside className="panel trip-summary-metrics-panel">
      <div className="panel-header">
        <h2>Trip Metrics</h2>
        <span>filtered ledger totals</span>
      </div>

      <div className="detail-body">
        <div className="trip-summary-metrics-layout">
          <section className="trip-summary-box">
            <div className="trip-summary-box-header">Ledger Totals</div>

            <div className="trip-summary-stat-grid">
              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Total Trips</div>
                <div className="trip-summary-stat-value">
                  {metrics.totalTrips}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Total Revenue</div>
                <div className="trip-summary-stat-value">
                  {money(metrics.totalRevenue)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Avg Trip</div>
                <div className="trip-summary-stat-value">
                  {money(metrics.avgRevenue)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Total Days</div>
                <div className="trip-summary-stat-value">
                  {formatNumber(metrics.totalDays)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Avg Days</div>
                <div className="trip-summary-stat-value">
                  {formatNumber(metrics.avgDays)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Total Miles</div>
                <div className="trip-summary-stat-value">
                  {formatNumber(metrics.totalMiles)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Avg Miles</div>
                <div className="trip-summary-stat-value">
                  {formatNumber(metrics.avgMiles)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Rev / Day</div>
                <div className="trip-summary-stat-value">
                  {money(metrics.revenuePerDay)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Rev / Mile</div>
                <div className="trip-summary-stat-value">
                  {money(metrics.revenuePerMile)}
                </div>
              </div>

              <div className="trip-summary-stat">
                <div className="trip-summary-stat-label">Incomplete</div>
                <div className="trip-summary-stat-value">
                  {metrics.incompleteCount}
                </div>
              </div>
            </div>
          </section>

          <section className="trip-summary-box">
            <div className="trip-summary-box-header">Selected Trip</div>

            {!selectedTrip ? (
              <div className="trip-summary-empty-state">
                Select a trip to inspect details.
              </div>
            ) : (
              <div className="trip-summary-stat-grid">
                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Vehicle</div>
                  <div className="trip-summary-stat-value">
                    {selectedTrip.vehicle_name ||
                      selectedTrip.vehicle_nickname ||
                      "—"}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Guest</div>
                  <div className="trip-summary-stat-value">
                    {selectedTrip.guest_name || "—"}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Gross</div>
                  <div className="trip-summary-stat-value">
                    {money(selectedGross)}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Miles</div>
                  <div className="trip-summary-stat-value">
                    {selectedMiles != null ? formatNumber(selectedMiles) : "—"}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Included</div>
                  <div className="trip-summary-stat-value">
                    {selectedTrip.mileage_included ?? "—"}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Rev / Mile</div>
                  <div className="trip-summary-stat-value">
                    {money(selectedRevenuePerMile)}
                  </div>
                </div>

                <div className="trip-summary-stat">
                  <div className="trip-summary-stat-label">Max RPM</div>
                  <div className="trip-summary-stat-value">
                    {formatRpm(selectedTrip.max_engine_rpm)}
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </aside>
  );
}
