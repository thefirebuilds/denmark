//----------------------------------------------
// /src/components/MetricsPanel.jsx
//----------------------------------------------

import { useEffect, useMemo, useState } from "react";
import MetricCard from "./metrics/MetricCard";
import OffTripMilesDrawer from "./metrics/OffTripMilesDrawer";
import TollStat from "./metrics/TollStat";
import VehicleComparisonRow from "./metrics/VehicleComparisonRow";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const RANGE_OPTIONS = [
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];

function safeDivide(numerator, denominator) {
  const num = Number(numerator ?? 0);
  const den = Number(denominator ?? 0);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function formatCurrency(value) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatCurrencyCompact(value) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatNumber(value, digits = 0) {
  const num = Number(value ?? 0);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value, digits = 0) {
  const num = Number(value ?? 0) * 100;
  return `${num.toFixed(digits)}%`;
}

function formatValueTrend(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount === 0) return "Flat";
  return `${amount > 0 ? "▲" : "▼"} ${formatCurrencyCompact(Math.abs(amount))}`;
}

function getVehicleTollRiskScore(vehicle) {
  const paid = Number(vehicle?.tolls_paid ?? 0);
  const recovered = Number(vehicle?.tolls_recovered ?? 0);
  const outstanding = Number(vehicle?.tolls_attributed_outstanding ?? 0);
  const unattributed = Number(vehicle?.tolls_unattributed ?? 0);

  const recoveryRate = paid > 0 ? recovered / paid : 1;
  const effectiveRecoveryRate = paid > 0 ? (recovered + outstanding) / paid : 1;
  const leakageShare = paid > 0 ? unattributed / paid : 0;

  if (paid <= 0 && unattributed <= 0) return 0;
  if (
    unattributed >= 75 ||
    leakageShare >= 0.35 ||
    effectiveRecoveryRate < 0.5
  ) {
    return 2;
  }
  if (
    unattributed > 0 ||
    recoveryRate < 0.8 ||
    effectiveRecoveryRate < 0.9
  ) {
    return 1;
  }
  return 0;
}

function getCapitalRecoveryPct(vehicle) {
  if (vehicle?.capital_recovery_pct != null) {
    return Number(vehicle.capital_recovery_pct) / 100;
  }

  const basis = Number(vehicle?.capital_basis ?? 0);
  const recovered = Number(vehicle?.capital_recovered ?? 0);

  if (basis <= 0) return 0;
  return recovered / basis;
}

export default function MetricsPanel() {
  const [selectedRange, setSelectedRange] = useState("30d");
  const [summary, setSummary] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expandedVehicleId, setExpandedVehicleId] = useState(null);
  const [sortBy, setSortBy] = useState("profit_desc");
  const [filterBy, setFilterBy] = useState("all");
  const [offTripAuditOpen, setOffTripAuditOpen] = useState(false);
  const [offTripAudit, setOffTripAudit] = useState(null);
  const [offTripAuditLoading, setOffTripAuditLoading] = useState(false);
  const [offTripAuditError, setOffTripAuditError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams({ range: selectedRange });

        const [summaryRes, vehiclesRes] = await Promise.all([
          fetch(`${API_BASE}/api/metrics/summary?${params.toString()}`, {
            headers: { Accept: "application/json" },
          }),
          fetch(`${API_BASE}/api/metrics/vehicles?${params.toString()}`, {
            headers: { Accept: "application/json" },
          }),
        ]);

        const summaryText = await summaryRes.text();
        const vehiclesText = await vehiclesRes.text();

        if (!summaryRes.ok) {
          throw new Error(
            `Summary request failed: ${summaryRes.status} ${summaryText}`
          );
        }

        if (!vehiclesRes.ok) {
          throw new Error(
            `Vehicles request failed: ${vehiclesRes.status} ${vehiclesText}`
          );
        }

        const summaryData = JSON.parse(summaryText);
        const vehiclesData = JSON.parse(vehiclesText);

        if (!cancelled) {
          setSummary(summaryData);
          setVehicles(
            Array.isArray(vehiclesData)
              ? vehiclesData
              : Array.isArray(vehiclesData?.vehicles)
              ? vehiclesData.vehicles
              : []
          );
          setExpandedVehicleId(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [selectedRange]);

  useEffect(() => {
    if (!offTripAuditOpen) return undefined;

    let cancelled = false;

    async function loadOffTripAudit() {
      try {
        setOffTripAuditLoading(true);
        setOffTripAuditError(null);

        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/off-trip-audit?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Off-trip audit request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setOffTripAudit(data);
        }
      } catch (err) {
        if (!cancelled) {
          setOffTripAuditError(err.message || "Failed to load off-trip audit");
        }
      } finally {
        if (!cancelled) {
          setOffTripAuditLoading(false);
        }
      }
    }

    loadOffTripAudit();

    return () => {
      cancelled = true;
    };
  }, [offTripAuditOpen, selectedRange]);

  async function handleSaveOffTripReview(payload) {
    const response = await fetch(`${API_BASE}/api/metrics/off-trip-audit/review`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;

    if (!response.ok) {
      throw new Error(data?.error || "Failed to save off-trip audit review");
    }

    const review = data?.review || null;

    setOffTripAudit((prev) => {
      if (!prev) return prev;

      function applyReview(items = []) {
        return items.map((item) =>
          item.audit_key === payload.audit_key
            ? {
                ...item,
                review_status: review?.review_status || null,
                review_reason: review?.review_reason || null,
                reconciled_off_trip_miles:
                  review?.reconciled_off_trip_miles == null
                    ? null
                    : Number(review.reconciled_off_trip_miles),
                reviewed_at: review?.reviewed_at || null,
                raw_off_trip_miles:
                  item.raw_off_trip_miles == null
                    ? Number(item.off_trip_miles ?? 0)
                    : item.raw_off_trip_miles,
                off_trip_miles:
                  review?.reconciled_off_trip_miles == null
                    ? item.raw_off_trip_miles == null
                      ? Number(item.off_trip_miles ?? 0)
                      : item.raw_off_trip_miles
                    : Number(review.reconciled_off_trip_miles),
                is_reviewed: Boolean(review?.review_status),
              }
            : item
        );
      }

      const segments = applyReview(prev.segments || []);
      const skippedTrips = applyReview(prev.skipped_trips || []);
      const reviewedCount =
        segments.filter((item) => item.is_reviewed).length +
        skippedTrips.filter((item) => item.is_reviewed).length;
      const vehicleTotals = new Map();
      for (const item of segments) {
        vehicleTotals.set(
          String(item.vehicle_id),
          (vehicleTotals.get(String(item.vehicle_id)) || 0) +
            Number(item.off_trip_miles ?? 0)
        );
      }

      segments.sort((a, b) => {
        if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
          return a.is_reviewed ? 1 : -1;
        }
        const milesDiff = Number(b?.off_trip_miles ?? 0) - Number(a?.off_trip_miles ?? 0);
        if (milesDiff !== 0) return milesDiff;
        const aStart = a.next_trip_start ? new Date(a.next_trip_start).getTime() : 0;
        const bStart = b.next_trip_start ? new Date(b.next_trip_start).getTime() : 0;
        return bStart - aStart;
      });

      skippedTrips.sort((a, b) => {
        if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
          return a.is_reviewed ? 1 : -1;
        }
        const aStart = a.trip_start ? new Date(a.trip_start).getTime() : 0;
        const bStart = b.trip_start ? new Date(b.trip_start).getTime() : 0;
        return bStart - aStart;
      });

      return {
        ...prev,
        summary: {
          ...(prev.summary || {}),
          reviewed_count: reviewedCount,
          total_off_trip_miles: segments.reduce(
            (sum, item) => sum + Number(item.off_trip_miles ?? 0),
            0
          ),
        },
        vehicles: (prev.vehicles || []).map((vehicle) => ({
          ...vehicle,
          off_trip_miles: vehicleTotals.get(String(vehicle.vehicle_id)) || 0,
        })),
        segments,
        skipped_trips: skippedTrips,
      };
    });

    return data;
  }

  const avgVehiclesBookedPerDay = useMemo(() => {
    if (!summary) return 0;
    const booked = Number(summary.booked_vehicle_days ?? 0);
    const days = Number(summary.calendar_days ?? 0);
    return days > 0 ? booked / days : 0;
  }, [summary]);

  const avgRevenuePerTrip = useMemo(() => {
    if (!summary) return 0;
    return Number(summary.revenue_per_overlapping_trip ?? 0);
  }, [summary]);

  const filteredAndSortedVehicles = useMemo(() => {
    const next = [...vehicles].filter((vehicle) => {
      const profit = Number(vehicle?.net_profit ?? 0);
      const bookedDays = Number(vehicle?.booked_vehicle_days ?? 0);
      const calendarDays = Number(summary?.calendar_days ?? 0);
      const occupancy = calendarDays > 0 ? bookedDays / calendarDays : 0;
      const tollRisk = getVehicleTollRiskScore(vehicle);

      const capitalBasis = Number(vehicle?.capital_basis ?? 0);
      const capitalRecovered = Number(vehicle?.capital_recovered ?? 0);
      const capitalRemaining = Number(vehicle?.capital_remaining ?? 0);
      const hasCapitalTracking =
        capitalBasis > 0 || capitalRecovered > 0 || capitalRemaining > 0;
      const recoveryPct = getCapitalRecoveryPct(vehicle);

      switch (filterBy) {
        case "profitable":
          return profit >= 0;
        case "losing":
          return profit < 0;
        case "toll_issues":
          return tollRisk >= 1;
        case "high_occupancy":
          return occupancy >= 0.75;
        case "low_occupancy":
          return occupancy < 0.5;
        case "payoff_in_progress":
          return hasCapitalTracking && recoveryPct < 1;
        default:
          return true;
      }
    });

    next.sort((a, b) => {
      const aProfit = Number(a?.net_profit ?? 0);
      const bProfit = Number(b?.net_profit ?? 0);
      const aRevenue = Number(a?.trip_income ?? 0);
      const bRevenue = Number(b?.trip_income ?? 0);
      const aRevDay = Number(a?.income_per_booked_day ?? 0);
      const bRevDay = Number(b?.income_per_booked_day ?? 0);
      const aTrips = Number(a?.trip_count_overlapping ?? 0);
      const bTrips = Number(b?.trip_count_overlapping ?? 0);
      const aValue = Number(a?.fmv_estimate_mid ?? 0);
      const bValue = Number(b?.fmv_estimate_mid ?? 0);

      const calendarDays = Number(summary?.calendar_days ?? 0);
      const aOccupancy =
        calendarDays > 0
          ? Number(a?.booked_vehicle_days ?? 0) / calendarDays
          : 0;
      const bOccupancy =
        calendarDays > 0
          ? Number(b?.booked_vehicle_days ?? 0) / calendarDays
          : 0;

      const aTollRisk = getVehicleTollRiskScore(a);
      const bTollRisk = getVehicleTollRiskScore(b);

      const aRecoveryPct = getCapitalRecoveryPct(a);
      const bRecoveryPct = getCapitalRecoveryPct(b);

      const aCapitalRemaining = Number(a?.capital_remaining ?? 0);
      const bCapitalRemaining = Number(b?.capital_remaining ?? 0);

      const aPayoffDate = a?.projected_payoff_date
        ? new Date(a.projected_payoff_date).getTime()
        : Number.POSITIVE_INFINITY;

        const bPayoffDate = b?.projected_payoff_date
        ? new Date(b.projected_payoff_date).getTime()
        : Number.POSITIVE_INFINITY;

      switch (sortBy) {
        case "profit_asc":
          return aProfit - bProfit;
        case "revenue_desc":
          return bRevenue - aRevenue;
        case "occupancy_desc":
          return bOccupancy - aOccupancy;
        case "rev_day_desc":
          return bRevDay - aRevDay;
        case "trips_desc":
          return bTrips - aTrips;
        case "value_desc":
          return bValue - aValue;
        case "toll_risk_desc":
          return bTollRisk - aTollRisk || bProfit - aProfit;
        case "recovery_desc":
          return bRecoveryPct - aRecoveryPct;
        case "capital_remaining_asc":
          return aCapitalRemaining - bCapitalRemaining;
        case "payoff_date_asc":
            return aPayoffDate - bPayoffDate || bRecoveryPct - aRecoveryPct;
        case "profit_desc":
        default:
          return bProfit - aProfit;
      }
    });

    return next;
  }, [vehicles, summary, sortBy, filterBy]);

const mileageStats = useMemo(() => {
  const totalMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.total_miles ?? 0),
    0
  );

  const tripMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.trip_miles ?? 0),
    0
  );

  const offTripMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.off_trip_miles ?? 0),
    0
  );

  const revenue = Number(summary?.revenue ?? 0);
  const expenses = Number(summary?.expenses ?? 0);
  const netProfit = Number(summary?.net_profit ?? 0);
  const trips = Number(summary?.trip_count_overlapping ?? 0);

  return {
    totalMiles,
    tripMiles,
    offTripMiles,
    revenuePerTripMile: safeDivide(revenue, tripMiles),
    profitPerTripMile: safeDivide(netProfit, tripMiles),
    expensePerMile: safeDivide(expenses, totalMiles),
    expensePerTripMile: safeDivide(expenses, tripMiles),
    revenuePerTotalMile: safeDivide(revenue, totalMiles),
    profitPerTotalMile: safeDivide(netProfit, totalMiles),
    tripMileUtilization: safeDivide(tripMiles, totalMiles),
    offTripShare: safeDivide(offTripMiles, totalMiles),
    bookedMilesPerTrip: safeDivide(tripMiles, trips),
  };
}, [vehicles, summary]);

  return (
    <div className="metrics-panel">
      {loading && <div>Loading metrics…</div>}
      {error && <div>Failed to load metrics: {error}</div>}

      {!loading && !error && summary && (
        <>
          <div className="metrics-topbar">
            <div className="metrics-topbar__group">
              <div className="metrics-topbar__label">Range</div>
              <div className="metrics-range-chips">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`metrics-range-chip ${
                      selectedRange === option.value ? "is-active" : ""
                    }`}
                    onClick={() => setSelectedRange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="metrics-summary-row">
            <MetricCard
              label="Revenue"
              value={formatCurrency(summary.revenue)}
            />

            <MetricCard
              label="Net Profit"
              value={formatCurrency(summary.net_profit)}
              tone={Number(summary.net_profit) >= 0 ? "positive" : "negative"}
            />

            <MetricCard
              label="Expenses"
              value={formatCurrency(summary.expenses)}
            />

            <MetricCard
              label="Fleet Value"
              value={formatCurrency(summary.fleet_value)}
              subtitle={formatValueTrend(summary.fleet_value_change)}
              tone={
                Number(summary.fleet_value_change ?? 0) > 0
                  ? "positive"
                  : Number(summary.fleet_value_change ?? 0) < 0
                  ? "negative"
                  : undefined
              }
            />

            <MetricCard
              label="Rev / Calendar Day"
              value={formatCurrencyCompact(summary.revenue_per_calendar_day)}
            />

            <MetricCard
              label="Rev / Booked Day"
              value={formatCurrencyCompact(summary.revenue_per_booked_day)}
            />
          </div>

          <div className="metrics-ops-row">
            <MetricCard
              label="Trips"
              value={`${formatNumber(summary.trip_count_overlapping)} trips`}
              subtitle={`${formatNumber(summary.trip_count_prorated, 2)} effective trips`}
            />

            <MetricCard
              label="Avg Vehicles Booked / Day"
              value={formatNumber(avgVehiclesBookedPerDay, 1)}
              subtitle={`${formatNumber(summary.booked_vehicle_days)} booked days across ${formatNumber(summary.calendar_days)} calendar days`}
            />

            <MetricCard
              label="Cleaning / Trip"
              value={`${formatCurrencyCompact(summary.cleaning_cost_per_overlapping_trip)} actual`}
              subtitle={`${formatCurrencyCompact(summary.cleaning_cost_per_prorated_trip)} effective`}
            />

            <MetricCard
              label="Avg Rev / Trip"
              value={formatCurrencyCompact(avgRevenuePerTrip)}
              subtitle={`${formatNumber(summary.trip_count_overlapping)} overlapping trips`}
            />
          </div>

          <section className="metrics-mileage-row">
            <MetricCard
              label="Trip Miles"
              value={`${formatNumber(mileageStats.tripMiles)} mi`}
              subtitle={`${formatPercent(mileageStats.tripMileUtilization, 0)} of total miles`}
            />

            <MetricCard
              label="Off-Trip Miles"
              value={`${formatNumber(mileageStats.offTripMiles)} mi`}
              tone={
                mileageStats.offTripShare >= 0.35
                  ? "negative"
                  : mileageStats.offTripShare >= 0.2
                  ? "warning"
                  : "positive"
              }
              subtitle={`${formatPercent(mileageStats.offTripShare, 0)} of total miles`}
              onClick={() => setOffTripAuditOpen(true)}
            />

            <MetricCard
              label="Rev / Trip Mile"
              value={formatCurrencyCompact(mileageStats.revenuePerTripMile)}
              subtitle={`${formatCurrencyCompact(mileageStats.revenuePerTotalMile)} / total mile`}
            />

            <MetricCard
              label="Profit / Trip Mile"
              value={formatCurrencyCompact(mileageStats.profitPerTripMile)}
              tone={
                mileageStats.profitPerTripMile >= 0.25
                  ? "positive"
                  : mileageStats.profitPerTripMile >= 0.1
                  ? "warning"
                  : "negative"
              }
              subtitle={`${formatCurrencyCompact(mileageStats.profitPerTotalMile)} / total mile`}
            />

            <MetricCard
              label="Expense / Mile"
              value={formatCurrencyCompact(mileageStats.expensePerMile)}
              subtitle={`${formatCurrencyCompact(mileageStats.expensePerTripMile)} / trip mile`}
            />
          </section>

      <OffTripMilesDrawer
        open={offTripAuditOpen}
        loading={offTripAuditLoading}
        error={offTripAuditError}
        audit={offTripAudit}
        onSaveReview={handleSaveOffTripReview}
        onClose={() => setOffTripAuditOpen(false)}
      />

          <section className="toll-panel">
            <div className="toll-panel__header">
              <div className="toll-panel__title">Tolls</div>
              <div className="toll-panel__subtitle">
                Recovery and leakage across the selected range
              </div>
            </div>

            <div className="toll-panel__grid">
              <TollStat
                label="Paid"
                value={formatCurrencyCompact(summary.tolls_paid)}
              />

              <TollStat
                label="Recovered"
                value={formatCurrencyCompact(summary.tolls_recovered)}
                tone="positive"
              />

              <TollStat
                label="Outstanding"
                value={formatCurrencyCompact(summary.tolls_attributed_outstanding)}
                tone="warning"
              />

              <TollStat
                label="Unattributed"
                value={formatCurrencyCompact(summary.tolls_unattributed)}
                tone="negative"
                emphasis="strong"
              />
            </div>

            <div className="toll-panel__rates">
              <TollStat
                label="Recovery Rate"
                value={formatPercent(summary.toll_recovery_rate, 0)}
                tone={
                  Number(summary.toll_recovery_rate) >= 0.75
                    ? "positive"
                    : Number(summary.toll_recovery_rate) >= 0.5
                    ? "warning"
                    : "negative"
                }
              />

              <TollStat
                label="Effective Recovery Rate"
                value={formatPercent(summary.toll_effective_recovery_rate, 0)}
                tone={
                  Number(summary.toll_effective_recovery_rate) >= 0.85
                    ? "positive"
                    : Number(summary.toll_effective_recovery_rate) >= 0.65
                    ? "warning"
                    : "negative"
                }
              />
            </div>
          </section>

          <section className="metrics-vehicles-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Vehicles</div>
              <div className="metrics-section-subtitle">
                Compare fleet performance across the selected range
              </div>
            </div>

            <div className="metrics-toolbar">
              <div className="metrics-toolbar__group">
                <label className="metrics-toolbar__label" htmlFor="metrics-sort">
                  Sort
                </label>
                <select
                  id="metrics-sort"
                  className="metrics-toolbar__select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                >
                  <option value="profit_desc">Profit ↓</option>
                  <option value="profit_asc">Profit ↑</option>
                  <option value="revenue_desc">Revenue ↓</option>
                  <option value="value_desc">Value ↓</option>
                  <option value="occupancy_desc">Occupancy ↓</option>
                  <option value="rev_day_desc">Rev / Day ↓</option>
                  <option value="trips_desc">Trips ↓</option>
                  <option value="toll_risk_desc">Toll Risk ↓</option>
                  <option value="recovery_desc">Recovery % ↓</option>
                  <option value="capital_remaining_asc">Capital Remaining ↑</option>
                  <option value="payoff_date_asc">Payoff Soonest</option>
                </select>
              </div>

              <div className="metrics-filter-chips">
                {[
                  ["all", "All"],
                  ["profitable", "Profitable"],
                  ["losing", "Losing"],
                  ["toll_issues", "Toll Issues"],
                  ["high_occupancy", "High Occupancy"],
                  ["low_occupancy", "Low Occupancy"],
                  ["payoff_in_progress", "Payoff In Progress"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`metrics-filter-chip ${
                      filterBy === value ? "is-active" : ""
                    }`}
                    onClick={() => setFilterBy(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="vehicle-compare-header" aria-hidden="true">
              <div className="vehicle-compare-header__cell vehicle-compare-header__cell--vehicle">
                Vehicle
              </div>
              <div className="vehicle-compare-header__cell">Profit</div>
              <div className="vehicle-compare-header__cell">Revenue</div>
              <div className="vehicle-compare-header__cell">Value</div>
              <div className="vehicle-compare-header__cell">Occupancy</div>
              <div className="vehicle-compare-header__cell">Rev / Day</div>
              <div className="vehicle-compare-header__cell">Trips</div>
              <div className="vehicle-compare-header__cell">Toll Risk</div>
              <div className="vehicle-compare-header__cell"></div>
            </div>

            <div className="vehicle-compare-list">
              {filteredAndSortedVehicles.map((vehicle) => {
                const vehicleKey =
                  vehicle.vehicle_id || vehicle.vin || vehicle.nickname;

                return (
                  <VehicleComparisonRow
                    key={vehicleKey}
                    vehicle={vehicle}
                    isExpanded={expandedVehicleId === vehicleKey}
                    onToggle={() =>
                      setExpandedVehicleId((prev) =>
                        prev === vehicleKey ? null : vehicleKey
                      )
                    }
                    formatCurrency={formatCurrency}
                    formatCurrencyCompact={formatCurrencyCompact}
                    formatNumber={formatNumber}
                    formatValueTrend={formatValueTrend}
                    calendarDays={summary.calendar_days}
                  />
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
