//----------------------------------------------
// /src/components/metrics/VehicleComparisonRow.jsx
//----------------------------------------------

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function getPayoffPaceTone(recoveryPct, timelinePct) {
  if (timelinePct == null) return "neutral";

  const delta = recoveryPct - timelinePct;

  if (delta >= 0.1) return "ahead";
  if (delta <= -0.1) return "behind";
  return "onpace";
}

function getTollRisk(vehicle) {
  const tollsPaid = Number(vehicle?.tolls_paid ?? 0);
  const recovered = Number(vehicle?.tolls_recovered ?? 0);
  const outstanding = Number(vehicle?.tolls_attributed_outstanding ?? 0);
  const unattributed = Number(vehicle?.tolls_unattributed ?? 0);

  const recoveryRate = tollsPaid > 0 ? recovered / tollsPaid : 1;
  const effectiveRecoveryRate =
    tollsPaid > 0 ? (recovered + outstanding) / tollsPaid : 1;
  const leakageShare = tollsPaid > 0 ? unattributed / tollsPaid : 0;

  if (tollsPaid <= 0 && unattributed <= 0) {
    return { label: "Low", tone: "positive" };
  }

  if (
    unattributed >= 75 ||
    leakageShare >= 0.35 ||
    effectiveRecoveryRate < 0.5
  ) {
    return { label: "High", tone: "negative" };
  }

  if (
    unattributed > 0 ||
    recoveryRate < 0.8 ||
    effectiveRecoveryRate < 0.9
  ) {
    return { label: "Watch", tone: "warning" };
  }

  return { label: "Low", tone: "positive" };
}

function getMileageConfidenceTone(confidence) {
  const value = String(confidence || "").toLowerCase();

  if (value === "high") return "positive";
  if (value === "medium") return "warning";
  if (value === "low") return "negative";
  return "default";
}

function getRecoveryPercentValue(vehicle) {
  if (vehicle?.capital_recovery_pct != null) {
    return Math.max(0, Math.min(1, Number(vehicle.capital_recovery_pct) / 100));
  }

  const basis = Number(vehicle?.capital_basis ?? 0);
  const recovered = Number(vehicle?.capital_recovered ?? 0);
  if (basis <= 0) return 0;

  return Math.max(0, Math.min(1, recovered / basis));
}

function formatRecoveryPercent(vehicle) {
  return `${Math.round(getRecoveryPercentValue(vehicle) * 100)}%`;
}

function formatShortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPayoffDays(days) {
  const num = Number(days);
  if (!Number.isFinite(num)) return "—";
  if (num <= 0) return "Paid off";

  if (num < 30) return `${Math.round(num)}d left`;

  const months = num / 30.4375;
  if (months < 12) return `${months.toFixed(1)} mo left`;

  const years = months / 12;
  return `${years.toFixed(1)} yr left`;
}

function getPayoffConfidenceTone(confidence) {
  const value = String(confidence || "").toLowerCase();
  if (value === "high") return "positive";
  if (value === "medium") return "warning";
  if (value === "low") return "negative";
  return "default";
}

function getProjectedStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "projected_recent") return "Recent pace";
  if (value === "projected_blended") return "Blended pace";
  if (value === "paid_off") return "Paid off";
  if (value === "insufficient_data") return "Insufficient data";
  return value ? value.replaceAll("_", " ") : "Unknown";
}

function getTimelineProgress(vehicle) {
  const onboarding = vehicle?.onboarding_date
    ? new Date(vehicle.onboarding_date)
    : null;
  const payoff = vehicle?.projected_payoff_date
    ? new Date(vehicle.projected_payoff_date)
    : null;
  const now = new Date();

  if (
    !onboarding ||
    !payoff ||
    Number.isNaN(onboarding.getTime()) ||
    Number.isNaN(payoff.getTime()) ||
    payoff <= onboarding
  ) {
    return null;
  }

  const total = payoff.getTime() - onboarding.getTime();
  const elapsed = now.getTime() - onboarding.getTime();
  const pct = Math.max(0, Math.min(1, elapsed / total));

  return pct;
}

export default function VehicleComparisonRow({
  vehicle,
  isExpanded,
  onToggle,
  formatCurrency,
  formatCurrencyCompact,
  formatNumber,
  formatValueTrend,
  calendarDays,
}) {
  const netProfit = Number(vehicle?.net_profit ?? 0);
  const bookedDays = Number(vehicle?.booked_vehicle_days ?? 0);
  const occupancy = calendarDays > 0 ? bookedDays / calendarDays : 0;
  const tollRisk = getTollRisk(vehicle);
  const mileageConfidence = String(vehicle?.mileage_confidence || "unknown");
  const mileageConfidenceTone = getMileageConfidenceTone(mileageConfidence);
  const capitalBasis = Number(vehicle?.capital_basis ?? 0);
  const hasCapitalTracking =
    capitalBasis > 0 ||
    Number(vehicle?.capital_recovered ?? 0) > 0 ||
    Number(vehicle?.capital_remaining ?? 0) > 0;

  const recoveryPercentValue = getRecoveryPercentValue(vehicle);
  const payoffTimelineProgress = getTimelineProgress(vehicle);
  const payoffPaceTone = getPayoffPaceTone(
    recoveryPercentValue,
    payoffTimelineProgress
  );

  const projectedPayoffDays = Number(vehicle?.projected_payoff_days ?? NaN);
  const projectedPayoffDate = vehicle?.projected_payoff_date;
  const payoffConfidence = String(vehicle?.payoff_confidence || "unknown");
  const payoffConfidenceTone = getPayoffConfidenceTone(payoffConfidence);
  const projectedPayoffStatus = getProjectedStatusLabel(
    vehicle?.projected_payoff_status
  );
  const fmvEstimateMid = Number(vehicle?.fmv_estimate_mid ?? 0);
  const fmvChange = Number(vehicle?.fmv_change ?? 0);
  const hasFmvEstimate = Number.isFinite(fmvEstimateMid) && fmvEstimateMid > 0;
  const fmvChangeTone =
    fmvChange > 0 ? "positive" : fmvChange < 0 ? "negative" : "warning";

  return (
    <div className={`vehicle-compare ${isExpanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        className="vehicle-compare__summary"
        onClick={onToggle}
      >
        <div className="vehicle-compare__cell vehicle-compare__cell--vehicle">
          <div className="vehicle-compare__name">
            {vehicle?.nickname || "Unnamed vehicle"}
          </div>
          <div className="vehicle-compare__meta">
            {vehicle?.vin || "No VIN"}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div
            className={`vehicle-compare__value ${
              netProfit >= 0
                ? "vehicle-compare__value--positive"
                : "vehicle-compare__value--negative"
            }`}
          >
            {formatCurrency(netProfit)}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div className="vehicle-compare__value">
            {formatCurrency(vehicle?.trip_income)}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div
            className={`vehicle-compare__value ${
              hasFmvEstimate ? "" : "vehicle-compare__value--muted"
            }`}
          >
            {hasFmvEstimate ? formatCurrency(fmvEstimateMid) : "No estimate"}
          </div>
          <div
            className={`vehicle-compare__label vehicle-compare__label--${fmvChangeTone}`}
          >
            {hasFmvEstimate ? formatValueTrend(fmvChange) : "Awaiting run"}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div
            className={`vehicle-compare__value ${
              occupancy >= 0.75
                ? "vehicle-compare__value--positive"
                : occupancy >= 0.5
                ? ""
                : "vehicle-compare__value--negative"
            }`}
          >
            {formatPercent(occupancy)}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div className="vehicle-compare__value">
            {formatCurrencyCompact(vehicle?.income_per_booked_day)}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div className="vehicle-compare__value">
            {formatNumber(vehicle?.trip_count_overlapping)}
          </div>
        </div>

        <div className="vehicle-compare__cell">
          <div
            className={`vehicle-compare__value vehicle-compare__value--${tollRisk.tone}`}
          >
            {tollRisk.label}
          </div>
        </div>

        <div className="vehicle-compare__chevron">
          {isExpanded ? "−" : "+"}
        </div>
      </button>

      {isExpanded ? (
        <div className="vehicle-compare__details-wrap">
          <div className="vehicle-compare__details-group">
            <div className="vehicle-compare__details-group-title">Financial</div>
            <div className="vehicle-compare__details">
              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Value</div>
                <div className="vehicle-compare__detail-value">
                  {hasFmvEstimate ? formatCurrency(fmvEstimateMid) : "No estimate"}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Value Change</div>
                <div
                  className={`vehicle-compare__detail-value vehicle-compare__detail-value--${fmvChangeTone}`}
                >
                  {hasFmvEstimate ? formatValueTrend(fmvChange) : "Awaiting prior estimate"}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Valued</div>
                <div className="vehicle-compare__detail-value">
                  {formatShortDate(vehicle?.fmv_estimated_at)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Expenses</div>
                <div className="vehicle-compare__detail-value">
                  {formatCurrency(vehicle?.total_expenses)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Rev / Trip</div>
                <div className="vehicle-compare__detail-value">
                  {formatCurrencyCompact(vehicle?.income_per_overlapping_trip)}
                </div>
              </div>
            </div>
          </div>

          <div className="vehicle-compare__details-group">
            <div className="vehicle-compare__details-group-title">Tolls</div>
            <div className="vehicle-compare__details">
              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Tolls Paid</div>
                <div className="vehicle-compare__detail-value">
                  {formatCurrencyCompact(vehicle?.tolls_paid)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Recovered</div>
                <div className="vehicle-compare__detail-value">
                  {formatCurrencyCompact(vehicle?.tolls_recovered)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Outstanding</div>
                <div className="vehicle-compare__detail-value">
                  {formatCurrencyCompact(vehicle?.tolls_attributed_outstanding)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Unattributed</div>
                <div className="vehicle-compare__detail-value vehicle-compare__detail-value--negative">
                  {formatCurrencyCompact(vehicle?.tolls_unattributed)}
                </div>
              </div>
            </div>
          </div>

          <div className="vehicle-compare__details-group">
            <div className="vehicle-compare__details-group-title">Mileage</div>
            <div className="vehicle-compare__details">
              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Total Miles</div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.total_miles)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Trip Miles</div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.trip_miles)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">
                  {vehicle?.has_open_trip_at_range_end ? "Off-Trip Miles*" : "Off-Trip Miles"}
                </div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.off_trip_miles)}
                </div>
              </div>

              {vehicle?.has_open_trip_at_range_end ? (
                <div className="vehicle-compare__detail-stat">
                  <div className="vehicle-compare__detail-label">Unallocated Miles</div>
                  <div className="vehicle-compare__detail-value">
                    {formatNumber(vehicle?.unallocated_miles)}
                  </div>
                </div>
              ) : null}

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Confidence</div>
                <div
                  className={`vehicle-compare__detail-value vehicle-compare__detail-value--${mileageConfidenceTone}`}
                >
                  {mileageConfidence}
                </div>
              </div>
            </div>
          </div>

          <div className="vehicle-compare__details-group">
            <div className="vehicle-compare__details-group-title">Operations</div>
            <div className="vehicle-compare__details">
              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Booked Days</div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.booked_vehicle_days)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Trips</div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.trip_count_overlapping)}
                </div>
              </div>

              <div className="vehicle-compare__detail-stat">
                <div className="vehicle-compare__detail-label">Effective Trips</div>
                <div className="vehicle-compare__detail-value">
                  {formatNumber(vehicle?.trip_count_prorated, 2)}
                </div>
              </div>
            </div>
          </div>

          <div className="vehicle-compare__details-group">
            <div className="vehicle-compare__details-group-title">Capital</div>
            {hasCapitalTracking ? (
              <>
                <div className="vehicle-compare__capital-progress vehicle-compare__capital-progress--payoff">
                  <div className="vehicle-compare__capital-progress-topline">
                    <span className="vehicle-compare__capital-progress-label">
                      Payoff Progress
                    </span>
                    <span className="vehicle-compare__capital-progress-value">
                      {formatRecoveryPercent(vehicle)}
                    </span>
                  </div>

                  <div className="vehicle-compare__payoff-hero">
                    <div className="vehicle-compare__payoff-hero-main">
                      {projectedPayoffDate ? formatShortDate(projectedPayoffDate) : "—"}
                    </div>
                    <div className="vehicle-compare__payoff-hero-sub">
                      {formatPayoffDays(projectedPayoffDays)}
                    </div>
                  </div>

                  <div className="vehicle-compare__payoff-track-wrap">
                    <div className={`vehicle-compare__payoff-track vehicle-compare__payoff-track--${payoffPaceTone}`}>
                      <div
                        className="vehicle-compare__payoff-track-fill"
                        style={{
                          width: `${Math.round(recoveryPercentValue * 100)}%`,
                        }}
                      />

                      {payoffTimelineProgress != null ? (
                        <div
                          className="vehicle-compare__payoff-track-marker"
                          style={{
                            left: `${Math.round(payoffTimelineProgress * 100)}%`,
                          }}
                          title="Today"
                        >
                          <span className="vehicle-compare__payoff-track-marker-dot" />
                          <span className="vehicle-compare__payoff-track-marker-label">
                            Today
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="vehicle-compare__payoff-axis">
                    <div className="vehicle-compare__payoff-axis-point">
                      <div className="vehicle-compare__payoff-axis-label">Onboarded</div>
                      <div className="vehicle-compare__payoff-axis-value">
                        {formatShortDate(vehicle?.onboarding_date)}
                      </div>
                    </div>

                    <div className="vehicle-compare__payoff-axis-point vehicle-compare__payoff-axis-point--end">
                      <div className="vehicle-compare__payoff-axis-label">
                        Projected Payoff
                      </div>
                      <div className="vehicle-compare__payoff-axis-value">
                        {formatShortDate(projectedPayoffDate)}
                      </div>
                    </div>
                  </div>

                  <div className="vehicle-compare__payoff-chips">
                    <div
                      className={`vehicle-compare__payoff-chip vehicle-compare__payoff-chip--${payoffConfidenceTone}`}
                    >
                      Confidence: {payoffConfidence || "unknown"}
                    </div>
                    <div className="vehicle-compare__payoff-chip">
                      {projectedPayoffStatus}
                    </div>
                    <div className="vehicle-compare__payoff-chip">
                      {formatCurrencyCompact(vehicle?.capital_recovery_rate_monthly)}/mo
                    </div>
                  </div>
                </div>

                <div className="vehicle-compare__details">
                  <div className="vehicle-compare__detail-stat">
                    <div className="vehicle-compare__detail-label">Capital Basis</div>
                    <div className="vehicle-compare__detail-value">
                      {formatCurrency(vehicle?.capital_basis)}
                    </div>
                  </div>

                  <div className="vehicle-compare__detail-stat">
                    <div className="vehicle-compare__detail-label">Recovered</div>
                    <div className="vehicle-compare__detail-value">
                      {formatCurrency(vehicle?.capital_recovered)}
                    </div>
                  </div>

                  <div className="vehicle-compare__detail-stat">
                    <div className="vehicle-compare__detail-label">Remaining</div>
                    <div className="vehicle-compare__detail-value">
                      {formatCurrency(vehicle?.capital_remaining)}
                    </div>
                  </div>

                  <div className="vehicle-compare__detail-stat">
                    <div className="vehicle-compare__detail-label">Recovery %</div>
                    <div className="vehicle-compare__detail-value">
                      {formatRecoveryPercent(vehicle)}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="vehicle-compare__empty-note">
                No capital basis or recovery data yet.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
