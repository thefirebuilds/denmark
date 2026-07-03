//----------------------------------------------
// /src/components/MetricsPanel.jsx
//----------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import ExpenseModal from "./expenses/ExpenseModal";
import MetricCard from "./metrics/MetricCard";
import OffTripMilesDrawer from "./metrics/OffTripMilesDrawer";
import TollStat from "./metrics/TollStat";
import TollAuditDrawer from "./metrics/TollAuditDrawer";
import VehicleComparisonRow from "./metrics/VehicleComparisonRow";
import VehicleFinancialDrawer from "./metrics/VehicleFinancialDrawer";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "";

const RANGE_OPTIONS = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "ytd", label: "YTD" },
  { value: "all", label: "All" },
];
const TRIP_LEDGER_FOCUS_STORAGE_KEY = "denmark.tripLedgerFocus";

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

function formatSignedCurrency(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return formatCurrencyCompact(0);
  return `${num > 0 ? "+" : "-"}${formatCurrencyCompact(Math.abs(num))}`;
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

function formatSignedPercentPoints(value, digits = 1) {
  const num = Number(value ?? 0) * 100;
  if (!Number.isFinite(num) || num === 0) return `0.${"0".repeat(digits)} pts`;
  return `${num > 0 ? "+" : "-"}${Math.abs(num).toFixed(digits)} pts`;
}

function formatOccupancyTrend(value) {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return "Flat vs previous period";
  return `${num > 0 ? "▲" : "▼"} ${formatSignedPercentPoints(num)} vs previous period`;
}

function formatValueTrend(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount === 0) return "Flat";
  return `${amount > 0 ? "▲" : "▼"} ${formatCurrencyCompact(Math.abs(amount))}`;
}

function formatCurrencyTrend(value, label = "vs previous period") {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount === 0) return `Flat ${label}`;
  return `${amount > 0 ? "▲" : "▼"} ${formatSignedCurrency(amount)} ${label}`;
}

function formatUpdatedLabel(value) {
  if (!value) return "Updated: --";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Updated: --";
  return `Updated: ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function formatShortDate(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatMetricDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMonthLabel(value) {
  if (!value) return "--";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

function parseCustomRange(range) {
  const match = String(range || "").match(
    /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/
  );
  if (!match) return null;
  return {
    start: match[1],
    end: match[2],
  };
}

function formatRangeLabel(range) {
  const option = RANGE_OPTIONS.find((item) => item.value === range);
  if (option) return option.label;

  const custom = parseCustomRange(range);
  if (!custom) return "Period";

  return `${formatShortDate(custom.start)} to ${formatShortDate(custom.end)}`;
}

function getInclusiveDateDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const first = start <= end ? start : end;
  const last = start <= end ? end : start;
  return Math.max(1, Math.floor((last.getTime() - first.getTime()) / 86400000) + 1);
}

function buildSparklinePath(points, key, width, height, maxValue) {
  if (!Array.isArray(points) || points.length === 0) return "";

  const safeMax = Math.max(Number(maxValue || 0), 1);
  const lastIndex = Math.max(points.length - 1, 1);

  return points
    .map((point, index) => {
      const x = (index / lastIndex) * width;
      const raw = Number(point?.[key] ?? 0);
      const y = height - (Math.max(raw, 0) / safeMax) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function RevenueExpenseSparkline({ trends, summary }) {
  const points = Array.isArray(trends?.points) ? trends.points : [];

  if (!points.length) {
    return null;
  }

  const width = 960;
  const height = 118;
  const padding = 10;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  const maxValue = points.reduce(
    (max, point) =>
      Math.max(max, Number(point.revenue ?? 0), Number(point.expenses ?? 0)),
    0
  );
  const revenuePath = buildSparklinePath(points, "revenue", chartWidth, chartHeight, maxValue);
  const expensePath = buildSparklinePath(points, "expenses", chartWidth, chartHeight, maxValue);
  const latest = points[points.length - 1] || {};
  const firstLabel = formatShortDate(points[0]?.label);
  const lastLabel = formatShortDate(latest.label);

  return (
    <section className="metrics-trend-strip">
      <div className="metrics-trend-strip__header">
        <div>
          <div className="metrics-section-title">Daily Flow</div>
          <div className="metrics-section-subtitle">
            Revenue and expenses across this range
          </div>
        </div>
        <div className="metrics-trend-strip__legend">
          <span className="metrics-trend-strip__legend-item revenue">
            Revenue {formatCurrencyCompact(summary?.revenue)}
          </span>
          <span className="metrics-trend-strip__legend-item expense">
            Expenses {formatCurrencyCompact(summary?.expenses)}
          </span>
        </div>
      </div>

      <div className="metrics-trend-strip__chart" aria-label="Daily revenue and expense line graph">
        <svg viewBox={`0 0 ${width} ${height}`} role="img">
          <defs>
            <linearGradient id="metricsRevenueGlow" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#54f0b0" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#7dd3fc" stopOpacity="0.95" />
            </linearGradient>
            <linearGradient id="metricsExpenseGlow" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#fb7185" stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <g transform={`translate(${padding} ${padding})`}>
            <line
              x1="0"
              x2={chartWidth}
              y1={chartHeight}
              y2={chartHeight}
              className="metrics-trend-strip__baseline"
            />
            <path className="metrics-trend-strip__path expense" d={expensePath} />
            <path className="metrics-trend-strip__path revenue" d={revenuePath} />
          </g>
        </svg>
        <div className="metrics-trend-strip__axis">
          <span>{firstLabel}</span>
          <span>
            Latest: {formatCurrencyCompact(latest.revenue)} rev /{" "}
            {formatCurrencyCompact(latest.expenses)} exp
          </span>
          <span>{lastLabel}</span>
        </div>
      </div>
    </section>
  );
}

function MonthlyProfitLossChart({ trends }) {
  const points = Array.isArray(trends?.monthly_profit_loss?.points)
    ? trends.monthly_profit_loss.points
    : [];

  if (!points.length) return null;

  const summary = trends?.monthly_profit_loss?.summary || {};
  const maxAbsProfit = Math.max(
    ...points.map((point) => Math.abs(Number(point?.profit ?? 0))),
    1
  );

  return (
    <section className="metrics-pnl-chart">
      <div className="metrics-pnl-chart__header">
        <div>
          <div className="metrics-section-title">12 Month P&amp;L</div>
          <div className="metrics-section-subtitle">
            Calendar-month profit and loss, recognized revenue less expenses
          </div>
        </div>
        <div className="metrics-pnl-chart__summary">
          <span>
            <strong>{formatCurrencyCompact(summary.revenue)}</strong>
            Revenue
          </span>
          <span>
            <strong>{formatCurrencyCompact(summary.expenses)}</strong>
            Expenses
          </span>
          <span className={Number(summary.profit ?? 0) >= 0 ? "positive" : "negative"}>
            <strong>{formatSignedCurrency(summary.profit)}</strong>
            Net
          </span>
        </div>
      </div>

      <div className="metrics-pnl-chart__plot" aria-label="Monthly profit and loss bar graph">
        {points.map((point) => {
          const profit = Number(point?.profit ?? 0);
          const magnitude = Math.max(2, (Math.abs(profit) / maxAbsProfit) * 100);

          return (
            <div
              key={point.label}
              className={`metrics-pnl-chart__month ${
                profit >= 0 ? "is-profit" : "is-loss"
              }`}
              title={`${formatMonthLabel(point.label)}: ${formatSignedCurrency(
                profit
              )} net (${formatCurrencyCompact(point.revenue)} revenue / ${formatCurrencyCompact(
                point.expenses
              )} expenses)`}
            >
              <div className="metrics-pnl-chart__bar-track">
                <span
                  className="metrics-pnl-chart__bar"
                  style={{ height: `${magnitude}%` }}
                  aria-hidden="true"
                />
              </div>
              <strong>{formatSignedCurrency(profit)}</strong>
              <span>{formatMonthLabel(point.label)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TripLengthDistributionPanel({ distribution }) {
  const buckets = Array.isArray(distribution?.buckets)
    ? distribution.buckets
    : [];
  const totalTrips = Number(distribution?.total_trips ?? 0);

  if (!buckets.length || totalTrips <= 0) return null;

  return (
    <article className="trip-length-panel">
      <div className="trip-length-panel__header">
        <div>
          <div className="metrics-business-card__title">Trip Length Mix</div>
          <div className="metrics-business-profile__meta">
            {formatNumber(totalTrips)} trips / avg{" "}
            {formatNumber(distribution?.average_days ?? 0, 1)} days
          </div>
        </div>
      </div>
      <div className="trip-length-panel__stack" aria-label="Trip length distribution">
        {buckets
          .filter((bucket) => Number(bucket?.trip_count ?? 0) > 0)
          .map((bucket, index) => {
            const pct = Number(bucket?.percentage ?? 0);
            return (
              <span
                key={bucket.key || bucket.label}
                className={`trip-length-panel__stack-segment trip-length-panel__stack-segment--${
                  index % 8
                }`}
                style={{ width: `${Math.max(2, pct * 100)}%` }}
                title={`${bucket.label}: ${formatPercent(pct, 1)}`}
              />
            );
          })}
      </div>
      <div className="trip-length-panel__rows">
        {buckets.map((bucket, index) => {
          const pct = Number(bucket?.percentage ?? 0);
          return (
            <div className="trip-length-row" key={bucket.key || bucket.label}>
              <div className="trip-length-row__topline">
                <span className="trip-length-row__label">
                  <i
                    className={`trip-length-row__dot trip-length-panel__stack-segment--${
                      index % 8
                    }`}
                    aria-hidden="true"
                  />
                  {bucket.label}
                </span>
                <span className="trip-length-row__bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, pct * 100)}%` }} />
                </span>
                <strong>
                  {formatPercent(pct, 1)}
                  <em>{formatNumber(bucket.trip_count)}</em>
                </strong>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ValuableTripLengthsPanel({ distribution }) {
  const buckets = Array.isArray(distribution?.top_income_buckets)
    ? distribution.top_income_buckets
    : [];

  if (!buckets.length) return null;

  return (
    <article className="trip-length-panel trip-length-panel--value">
      <div className="trip-length-panel__header">
        <div>
          <div className="metrics-business-card__title">Most Valuable Lengths</div>
          <div className="metrics-business-profile__meta">
            Ranked by income per booked day
          </div>
        </div>
      </div>
      <div className="trip-value-list">
        {buckets.map((bucket, index) => (
          <div className="trip-value-row" key={bucket.key || bucket.label}>
            <div className="trip-value-row__rank">{index + 1}</div>
            <div className="trip-value-row__body">
              <div className="trip-value-row__topline">
                <span>{bucket.label}</span>
                <strong>{formatCurrencyCompact(bucket.income_per_day)}/day</strong>
              </div>
              <div className="trip-value-row__meta">
                {formatNumber(bucket.trip_count)} trips /{" "}
                {formatCurrencyCompact(bucket.income_per_mile)} per mile /{" "}
                {formatCurrencyCompact(bucket.average_trip_income)} avg trip /{" "}
                {formatCurrencyCompact(bucket.trip_income)} total
              </div>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function formatConfidenceLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Confidence: --";
  return `Confidence: ${text}`;
}

function formatInputValue(value) {
  return value == null ? "" : String(value);
}

function normalizeDateInputValue(value) {
  if (!value) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function buildYearMakeModel(profile) {
  return [profile?.year, profile?.make, profile?.model].filter(Boolean).join(" ");
}

function normalizeVehicleProfileForForm(profile) {
  return {
    ...profile,
    purchase_date: normalizeDateInputValue(profile?.purchase_date),
    placed_in_service_date: normalizeDateInputValue(
      profile?.placed_in_service_date
    ),
  };
}

function formatBusinessInputDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatFlagTitle(flag) {
  const expenseVendor = String(flag?.expense_vendor || "").trim();
  const expenseCategory = String(flag?.expense_category || "").trim();
  const guestName = String(flag?.guest_name || "").trim();
  const vehicleName = String(flag?.vehicle_name || "").trim();
  const reservationId = flag?.reservation_id;

  if (expenseVendor && flag?.expense_id) {
    return `${expenseVendor} · Expense #${flag.expense_id}`;
  }
  if (expenseCategory && flag?.expense_id) {
    return `${expenseCategory} · Expense #${flag.expense_id}`;
  }
  if (guestName && vehicleName) {
    return `${guestName} · ${vehicleName}`;
  }
  if (guestName && reservationId) {
    return `${guestName} · Reservation #${reservationId}`;
  }
  if (vehicleName && reservationId) {
    return `${vehicleName} · Reservation #${reservationId}`;
  }
  if (reservationId) {
    return `Reservation #${reservationId}`;
  }
  return String(flag?.flag_code || "")
    .replaceAll("_", " ")
    .trim();
}

function formatFlagMeta(flag) {
  const parts = [];
  if (flag?.expense_id) {
    parts.push(`Expense #${flag.expense_id}`);
  }
  if (flag?.reservation_id) {
    parts.push(`Reservation #${flag.reservation_id}`);
  }
  if (Array.isArray(flag?.missing_fields) && flag.missing_fields.length) {
    parts.push(`Missing ${flag.missing_fields.join(" + ")}`);
  }
  return parts.join(" · ");
}

function formatPerMileYoYSubtitle(delta, lastYearValue) {
  if (delta == null || lastYearValue == null) {
    return "No same-range last-year comp";
  }

  return `${formatCurrencyTrend(delta, "vs same range last year")} · LY ${formatCurrencyCompact(
    lastYearValue
  )}`;
}

function formatPreviousComp(delta, previousValue, formatter = formatCurrencyCompact) {
  if (delta == null || previousValue == null) return "No previous-period comp";
  return `${formatCurrencyTrend(delta)} / prev ${formatter(previousValue)}`;
}

function getMoneyTone(value, favorable = "higher") {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return "neutral";
  const good = favorable === "lower" ? num < 0 : num > 0;
  return good ? "positive" : "warning";
}

function HeartbeatMetric({ label, value, comp, tone = "neutral", size = "normal" }) {
  return (
    <div className={`heartbeat-metric heartbeat-metric--${tone} heartbeat-metric--${size}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {comp ? <em>{comp}</em> : null}
    </div>
  );
}

function HeartbeatRow({ label, children }) {
  return (
    <div className="heartbeat-row">
      <div className="heartbeat-row__label">{label}</div>
      <div className="heartbeat-row__metrics">{children}</div>
    </div>
  );
}

function BusinessHeartbeat({ summary, businessSummary, parkingSummary }) {
  const margin = safeDivide(summary?.net_profit, summary?.revenue);
  const tollLeakage =
    Number(summary?.tolls_unattributed ?? 0) +
    Number(summary?.tolls_attributed_outstanding ?? 0);
  const parkingNet = Number(parkingSummary?.passNetValue ?? 0);

  return (
    <section className="business-heartbeat">
      <div className="business-heartbeat__header">
        <div>
          <div className="metrics-section-title">Corporate Heartbeat</div>
          <div className="metrics-section-subtitle">
            Dollars, unit economics, pace, and margin leaks for the selected range
          </div>
        </div>
        <div className="business-heartbeat__range">
          {formatNumber(summary?.trip_count_overlapping)} trips /{" "}
          {formatNumber(summary?.trip_miles)} trip miles
        </div>
      </div>

      <HeartbeatRow label="Money">
        <HeartbeatMetric
          label="Revenue"
          value={formatCurrency(summary?.revenue)}
          comp={formatCurrencyTrend(summary?.revenue_delta)}
          tone={getMoneyTone(summary?.revenue_delta)}
          size="large"
        />
        <HeartbeatMetric
          label="Net Profit"
          value={formatCurrency(summary?.net_profit)}
          comp={formatCurrencyTrend(summary?.net_profit_delta)}
          tone={
            Number(summary?.net_profit ?? 0) < 0
              ? "negative"
              : getMoneyTone(summary?.net_profit_delta)
          }
          size="large"
        />
        <HeartbeatMetric
          label="Expenses"
          value={formatCurrency(summary?.expenses)}
          comp={formatCurrencyTrend(summary?.expenses_delta)}
          tone={getMoneyTone(summary?.expenses_delta, "lower")}
          size="large"
        />
        <HeartbeatMetric
          label="Margin"
          value={formatPercent(margin, 1)}
          comp="Net profit / revenue"
          tone={margin >= 0.25 ? "positive" : margin >= 0.1 ? "warning" : "negative"}
        />
      </HeartbeatRow>

      <HeartbeatRow label="Per Mile">
        <HeartbeatMetric
          label="Revenue / Mile"
          value={formatCurrencyCompact(summary?.revenue_per_trip_mile)}
          comp={formatPreviousComp(
            summary?.revenue_per_trip_mile_delta,
            summary?.previous_revenue_per_trip_mile
          )}
          tone={getMoneyTone(summary?.revenue_per_trip_mile_delta)}
        />
        <HeartbeatMetric
          label="Profit / Mile"
          value={formatCurrencyCompact(summary?.profit_per_trip_mile)}
          comp={formatPreviousComp(
            summary?.profit_per_trip_mile_delta,
            summary?.previous_profit_per_trip_mile
          )}
          tone={
            Number(summary?.profit_per_trip_mile ?? 0) < 0
              ? "negative"
              : getMoneyTone(summary?.profit_per_trip_mile_delta)
          }
        />
        <HeartbeatMetric
          label="Expenses / Mile"
          value={formatCurrencyCompact(summary?.expense_per_trip_mile)}
          comp={formatPreviousComp(
            summary?.expense_per_trip_mile_delta,
            summary?.previous_expense_per_trip_mile
          )}
          tone={getMoneyTone(summary?.expense_per_trip_mile_delta, "lower")}
        />
      </HeartbeatRow>

      <HeartbeatRow label="Yield + Pace">
        <HeartbeatMetric
          label="Run Rate"
          value={`${formatCurrencyCompact(
            summary?.vehicle_run_rate?.operating_run_rate_daily
          )}/day`}
          comp={formatCurrencyTrend(
            summary?.vehicle_run_rate?.operating_run_rate_daily_delta
          )}
          tone={getMoneyTone(
            summary?.vehicle_run_rate?.operating_run_rate_daily_delta,
            "lower"
          )}
        />
        <HeartbeatMetric
          label="Revenue / Booked Day"
          value={formatCurrencyCompact(summary?.revenue_per_booked_day)}
          comp={formatCurrencyTrend(summary?.revenue_per_booked_day_delta)}
          tone={getMoneyTone(summary?.revenue_per_booked_day_delta)}
        />
        <HeartbeatMetric
          label="Occupancy"
          value={formatPercent(summary?.occupancy_rate, 1)}
          comp={formatOccupancyTrend(summary?.occupancy_rate_delta)}
          tone={getMoneyTone(summary?.occupancy_rate_delta)}
        />
      </HeartbeatRow>

      <HeartbeatRow label="Margin Leaks">
        <HeartbeatMetric
          label="Toll Exposure"
          value={formatCurrencyCompact(tollLeakage)}
          comp={`${formatCurrencyCompact(summary?.tolls_unattributed)} unattributed / ${formatCurrencyCompact(
            summary?.tolls_attributed_outstanding
          )} outstanding`}
          tone={tollLeakage > 0 ? "warning" : "positive"}
        />
        <HeartbeatMetric
          label="Parking Net"
          value={parkingSummary?.passNetValue == null ? "--" : formatSignedCurrency(parkingNet)}
          comp="Modeled parking value after fixed cost"
          tone={parkingNet >= 0 ? "positive" : "warning"}
        />
        <HeartbeatMetric
          label="After Owner Labor"
          value={
            businessSummary?.net_profit_after_owner_labor == null
              ? "--"
              : formatCurrency(businessSummary.net_profit_after_owner_labor)
          }
          comp={`${formatNumber(businessSummary?.estimated_owner_hours, 1)} owner hrs`}
          tone={
            Number(businessSummary?.net_profit_after_owner_labor ?? 0) >= 0
              ? "positive"
              : "negative"
          }
        />
      </HeartbeatRow>
    </section>
  );
}

function CompactLedger({ title, subtitle, children, action = null }) {
  return (
    <section className="compact-ledger">
      <div className="compact-ledger__header">
        <div>
          <div className="metrics-section-title">{title}</div>
          {subtitle ? <div className="metrics-section-subtitle">{subtitle}</div> : null}
        </div>
        {action}
      </div>
      <div className="compact-ledger__body">{children}</div>
    </section>
  );
}

function LedgerLine({ label, value, detail = null, tone = "neutral", onClick = null }) {
  const clickable = typeof onClick === "function";
  const Tag = clickable ? "button" : "div";
  return (
    <Tag
      {...(clickable ? { type: "button", onClick } : {})}
      className={`ledger-line ledger-line--${tone} ${clickable ? "ledger-line--clickable" : ""}`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <em>{detail}</em> : null}
    </Tag>
  );
}

function getVehicleTollRiskScore(vehicle) {
  const unresolvedTotal = Number(vehicle?.unresolved_toll_charge_total ?? 0);
  const unresolvedCount = Number(vehicle?.unresolved_toll_charge_count ?? 0);
  const tollChargeTotal = Number(vehicle?.toll_charge_total ?? 0);

  if (unresolvedTotal > 0 || unresolvedCount > 0) {
    const unresolvedShare =
      tollChargeTotal > 0 ? unresolvedTotal / tollChargeTotal : 1;

    if (unresolvedTotal >= 75 || unresolvedShare >= 0.35) return 2;
    return 1;
  }

  const paid = Number(vehicle?.tolls_paid ?? 0);
  const recovered = Number(vehicle?.tolls_recovered ?? 0);
  const outstanding = Number(vehicle?.tolls_attributed_outstanding ?? 0);
  const unattributed = Number(vehicle?.tolls_unattributed ?? 0);

  const recoveryRate = paid > 0 ? recovered / paid : 1;
  const effectiveRecoveryRate = paid > 0 ? (recovered + outstanding) / paid : 1;
  const leakageShare = paid > 0 ? unattributed / paid : 0;

  if (outstanding <= 0) return 0;
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

function getRangeRecoveryFactor(range) {
  const value = String(range || "").toLowerCase();
  if (value === "7d") return 7 / 30.4375;
  if (value === "30d") return 1;
  if (value === "90d") return 3;
  const custom = parseCustomRange(value);
  if (custom) {
    const days = getInclusiveDateDays(custom.start, custom.end);
    return days == null ? null : days / 30.4375;
  }
  if (value === "ytd") {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const days = Math.max(1, (now.getTime() - start.getTime()) / 86400000 + 1);
    return days / 30.4375;
  }
  return null;
}

function formatBreakEvenDate(value) {
  if (!value) return "--";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function CapitalBasisProgress({ stats, selectedRange }) {
  const basis = Number(stats?.basis ?? 0);
  const recovered = Number(stats?.recovered ?? 0);
  const remaining = Number(stats?.remaining ?? 0);
  const monthlyRecovery = Number(stats?.monthlyRecovery ?? 0);
  const vehicleCount = Number(stats?.vehicleCount ?? 0);
  const progress = basis > 0 ? Math.max(0, Math.min(1, recovered / basis)) : 0;
  const progressPct = Math.round(progress * 100);
  const displayRemaining = remaining > 0 ? remaining : Math.max(0, basis - recovered);
  const hasBasis = basis > 0 || recovered > 0 || remaining > 0;
  const monthsToBreakEven =
    displayRemaining > 0 && monthlyRecovery > 0
      ? displayRemaining / monthlyRecovery
      : null;
  const breakEvenDate =
    displayRemaining <= 0 && hasBasis
      ? "paid-off"
      : monthsToBreakEven != null
      ? new Date(Date.now() + monthsToBreakEven * 30.4375 * 86400000)
      : null;
  const rangeFactor = getRangeRecoveryFactor(selectedRange);
  const rangeRecovery =
    rangeFactor != null && monthlyRecovery > 0 ? monthlyRecovery * rangeFactor : null;
  const rangeLabel =
    selectedRange === "7d"
      ? "7D pace"
      : selectedRange === "30d"
      ? "30D pace"
      : selectedRange === "90d"
      ? "90D pace"
      : selectedRange === "ytd"
      ? "YTD pace"
      : `${formatRangeLabel(selectedRange)} pace`;

  return (
    <section className="capital-basis-progress" aria-label="Capital basis recovery progress">
      <div className="capital-basis-progress__header">
        <div>
          <div className="capital-basis-progress__eyebrow">Capital Basis</div>
          <div className="capital-basis-progress__title">
            {hasBasis
              ? `${formatCurrency(recovered)} recovered of ${formatCurrency(basis)} spent`
              : "No capital basis tracked yet"}
          </div>
        </div>
        <div className="capital-basis-progress__percent">
          {hasBasis ? `${progressPct}%` : "--"}
        </div>
      </div>

      <div className="capital-basis-progress__track">
        <div
          className="capital-basis-progress__fill"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <div className="capital-basis-progress__footer">
        <span>
          <strong>{formatCurrency(recovered)}</strong>
          Recovered
        </span>
        <span>
          <strong>{formatCurrency(displayRemaining)}</strong>
          Remaining
        </span>
        <span>
          <strong>{formatNumber(vehicleCount)}</strong>
          Vehicles tracked
        </span>
      </div>

      <div className="capital-basis-progress__ticker">
        <span>
          <strong>
            {breakEvenDate === "paid-off"
              ? "Paid off"
              : breakEvenDate
              ? formatBreakEvenDate(breakEvenDate)
              : "Need pace"}
          </strong>
          Expected break even
        </span>
        <span>
          <strong>{formatCurrencyCompact(monthlyRecovery)}</strong>
          Monthly pace
        </span>
        <span>
          <strong>
            {rangeRecovery == null ? "--" : formatCurrencyCompact(rangeRecovery)}
          </strong>
          {rangeLabel}
        </span>
      </div>
    </section>
  );
}

export default function MetricsPanel() {
  const metricsLoadSeq = useRef(0);
  const [selectedRange, setSelectedRange] = useState("30d");
  const initialCustomRange = useMemo(() => parseCustomRange(selectedRange), []);
  const [customStartDate, setCustomStartDate] = useState(
    initialCustomRange?.start || ""
  );
  const [customEndDate, setCustomEndDate] = useState(
    initialCustomRange?.end || ""
  );
  const [customRangeError, setCustomRangeError] = useState("");
  const [summary, setSummary] = useState(null);
  const [businessMetrics, setBusinessMetrics] = useState(null);
  const [parkingMetrics, setParkingMetrics] = useState(null);
  const [parkingTransfers, setParkingTransfers] = useState(null);
  const [trends, setTrends] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fmvRefreshing, setFmvRefreshing] = useState(false);
  const [fmvRefreshStatus, setFmvRefreshStatus] = useState("");

  const [expandedVehicleId, setExpandedVehicleId] = useState(null);
  const [sortBy, setSortBy] = useState("profit_desc");
  const [filterBy, setFilterBy] = useState("all");
  const [offTripAuditOpen, setOffTripAuditOpen] = useState(false);
  const [offTripAudit, setOffTripAudit] = useState(null);
  const [offTripAuditLoading, setOffTripAuditLoading] = useState(false);
  const [offTripAuditError, setOffTripAuditError] = useState(null);
  const [tollAuditOpen, setTollAuditOpen] = useState(false);
  const [tollAuditFocus, setTollAuditFocus] = useState("unattributed");
  const [tollAudit, setTollAudit] = useState(null);
  const [tollAuditLoading, setTollAuditLoading] = useState(false);
  const [tollAuditError, setTollAuditError] = useState(null);
  const [assigningTollChargeId, setAssigningTollChargeId] = useState(null);
  const [financialDetailOpen, setFinancialDetailOpen] = useState(false);
  const [financialDetailVehicle, setFinancialDetailVehicle] = useState(null);
  const [financialDetailFocus, setFinancialDetailFocus] = useState("expenses");
  const [financialDetail, setFinancialDetail] = useState(null);
  const [financialDetailLoading, setFinancialDetailLoading] = useState(false);
  const [financialDetailError, setFinancialDetailError] = useState(null);
  const [editingExpense, setEditingExpense] = useState(null);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [loadingExpenseId, setLoadingExpenseId] = useState(null);
  const [businessSettings, setBusinessSettings] = useState(null);
  const [vehicleProfiles, setVehicleProfiles] = useState([]);
  const [businessInputsLoading, setBusinessInputsLoading] = useState(true);
  const [businessInputsError, setBusinessInputsError] = useState("");
  const [businessInputsStatus, setBusinessInputsStatus] = useState("");
  const [savingBusinessSettings, setSavingBusinessSettings] = useState(false);
  const [savingVehicleId, setSavingVehicleId] = useState(null);
  const [businessInputsSectionOpen, setBusinessInputsSectionOpen] = useState(false);
  const [businessSettingsOpen, setBusinessSettingsOpen] = useState(false);
  const [expandedBusinessProfiles, setExpandedBusinessProfiles] = useState({});
  const [laborRemediationOpen, setLaborRemediationOpen] = useState(false);
  const [laborRemediation, setLaborRemediation] = useState(null);
  const [laborRemediationLoading, setLaborRemediationLoading] = useState(false);
  const [laborRemediationError, setLaborRemediationError] = useState("");
  const [laborRemediationDrafts, setLaborRemediationDrafts] = useState({});
  const [savingLaborItemKey, setSavingLaborItemKey] = useState(null);

  function selectPresetRange(range) {
    setCustomRangeError("");
    setSelectedRange(range);
  }

  function applyCustomRange() {
    if (!customStartDate || !customEndDate) {
      setCustomRangeError("Choose a start and end date.");
      return;
    }

    const days = getInclusiveDateDays(customStartDate, customEndDate);
    if (days == null) {
      setCustomRangeError("Use valid calendar dates.");
      return;
    }

    const start =
      customStartDate <= customEndDate ? customStartDate : customEndDate;
    const end =
      customStartDate <= customEndDate ? customEndDate : customStartDate;

    setCustomRangeError("");
    setCustomStartDate(start);
    setCustomEndDate(end);
    setSelectedRange(`custom:${start}:${end}`);
  }

  async function loadMetrics(
    range,
    { resetExpanded = true, showPageLoading = true } = {}
  ) {
    const loadSeq = metricsLoadSeq.current + 1;
    metricsLoadSeq.current = loadSeq;

    if (showPageLoading) {
      setLoading(true);
    }
    setError(null);

    const params = new URLSearchParams({ range });
    const fetchMetricJson = async (label, path) => {
      const response = await fetch(`${API_BASE}${path}?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const text = await response.text();

      if (!response.ok) {
        throw new Error(`${label} request failed: ${response.status} ${text}`);
      }

      return text ? JSON.parse(text) : null;
    };

    const summaryData = await fetchMetricJson("Summary", "/api/metrics/summary");
    const vehiclesData = await fetchMetricJson("Vehicles", "/api/metrics/vehicles");
    const trendsData = await fetchMetricJson("Trends", "/api/metrics/trends");

    if (metricsLoadSeq.current !== loadSeq) return;

    setSummary({
      ...(summaryData || {}),
      vehicle_run_rate: vehiclesData?.summary || null,
    });
    setTrends(trendsData);
    setVehicles(
      Array.isArray(vehiclesData)
        ? vehiclesData
        : Array.isArray(vehiclesData?.vehicles)
        ? vehiclesData.vehicles
        : []
    );

    if (resetExpanded) {
      setExpandedVehicleId(null);
    }

    setBusinessMetrics(null);
    setParkingMetrics(null);
    setParkingTransfers(null);

    void (async () => {
      const secondaryLoads = [
        {
          label: "Business metrics",
          path: "/api/metrics/business/current",
          apply: setBusinessMetrics,
        },
        {
          label: "Parking metrics",
          path: "/api/metrics/parking",
          apply: setParkingMetrics,
        },
        {
          label: "Parking transfer metrics",
          path: "/api/metrics/parking/home-transfers",
          apply: setParkingTransfers,
        },
      ];

      for (const item of secondaryLoads) {
        if (metricsLoadSeq.current !== loadSeq) return;

        try {
          const data = await fetchMetricJson(item.label, item.path);
          if (metricsLoadSeq.current === loadSeq) {
            item.apply(data);
          }
        } catch (err) {
          console.warn(`${item.label} loaded after primary metrics failed:`, err);
          if (metricsLoadSeq.current === loadSeq) {
            item.apply(null);
          }
        }
      }
    })();
  }

  function toggleBusinessProfile(vehicleId) {
    setExpandedBusinessProfiles((current) => ({
      ...current,
      [vehicleId]: !current[vehicleId],
    }));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        await loadMetrics(selectedRange, { showPageLoading: true });
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

  async function loadBusinessInputs() {
    setBusinessInputsLoading(true);
    setBusinessInputsError("");

    try {
      const [settingsRes, profilesRes] = await Promise.all([
        fetch(`${API_BASE}/api/metrics/business/settings`, {
          headers: { Accept: "application/json" },
        }),
        fetch(`${API_BASE}/api/metrics/business/vehicle-profiles`, {
          headers: { Accept: "application/json" },
        }),
      ]);

      const settingsText = await settingsRes.text();
      const profilesText = await profilesRes.text();

      if (!settingsRes.ok) {
        throw new Error(
          `Business settings request failed: ${settingsRes.status} ${settingsText}`
        );
      }

      if (!profilesRes.ok) {
        throw new Error(
          `Vehicle profiles request failed: ${profilesRes.status} ${profilesText}`
        );
      }

      const settingsData = settingsText ? JSON.parse(settingsText) : {};
      const profilesData = profilesText ? JSON.parse(profilesText) : {};

      setBusinessSettings(settingsData || {});
      setVehicleProfiles(
        Array.isArray(profilesData?.profiles)
          ? profilesData.profiles.map(normalizeVehicleProfileForForm)
          : []
      );
    } finally {
      setBusinessInputsLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadInputs() {
      try {
        await loadBusinessInputs();
      } catch (err) {
        if (!cancelled) {
          setBusinessInputsError(
            err.message || "Failed to load business input settings"
          );
          setBusinessInputsLoading(false);
        }
      }
    }

    loadInputs();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefreshFmvNow() {
    try {
      setFmvRefreshing(true);
      setFmvRefreshStatus("");

      const response = await fetch(`${API_BASE}/api/vehicles/fmv-estimates/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to refresh fleet values");
      }

      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });

      const results = Array.isArray(data?.results) ? data.results : [];
      const succeeded = results.filter((item) => item?.ok).length;
      const failed = results.filter((item) => !item?.ok).length;
      setFmvRefreshStatus(
        results.length
          ? `Refreshed ${succeeded} vehicle${succeeded === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`
          : "Fleet values refreshed."
      );
    } catch (err) {
      setFmvRefreshStatus(err.message || "Failed to refresh fleet values.");
    } finally {
      setFmvRefreshing(false);
    }
  }

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

  useEffect(() => {
    if (!tollAuditOpen) return undefined;

    let cancelled = false;

    async function loadTollAudit() {
      try {
        setTollAuditLoading(true);
        setTollAuditError(null);

        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/tolls/detail?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Toll detail request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setTollAudit(data);
        }
      } catch (err) {
        if (!cancelled) {
          setTollAuditError(err.message || "Failed to load toll detail");
        }
      } finally {
        if (!cancelled) {
          setTollAuditLoading(false);
        }
      }
    }

    loadTollAudit();

    return () => {
      cancelled = true;
    };
  }, [tollAuditOpen, selectedRange]);

  async function reloadTollAuditDetail(range = selectedRange) {
    const params = new URLSearchParams({ range });
    const response = await fetch(
      `${API_BASE}/api/metrics/tolls/detail?${params.toString()}`,
      {
        headers: { Accept: "application/json" },
      }
    );

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Toll detail request failed: ${response.status} ${text}`);
    }

    const data = JSON.parse(text);
    setTollAudit(data);
    return data;
  }

  async function handleAssignTollTrip(tollChargeId, selectedValue) {
    try {
      setAssigningTollChargeId(tollChargeId);
      setTollAuditError(null);

      const isOffTrip = selectedValue === "__off_trip__";
      const body = isOffTrip
        ? { disposition: "off_trip", trip_id: "__off_trip__" }
        : { trip_id: Number(selectedValue) };

      const response = await fetch(
        `${API_BASE}/api/metrics/tolls/charges/${tollChargeId}/assign-trip`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to assign toll charge");
      }

      await Promise.all([
        loadMetrics(selectedRange, {
          resetExpanded: false,
          showPageLoading: false,
        }),
        reloadTollAuditDetail(selectedRange),
      ]);
    } catch (err) {
      setTollAuditError(err.message || "Failed to assign toll charge");
    } finally {
      setAssigningTollChargeId(null);
    }
  }

  useEffect(() => {
    if (!financialDetailOpen || !financialDetailVehicle?.vehicle_id) {
      return undefined;
    }

    let cancelled = false;

    async function loadFinancialDetail() {
      try {
        setFinancialDetailLoading(true);
        setFinancialDetailError(null);
        const params = new URLSearchParams({ range: selectedRange });
        const response = await fetch(
          `${API_BASE}/api/metrics/vehicles/${financialDetailVehicle.vehicle_id}/financial-detail?${params.toString()}`,
          {
            headers: { Accept: "application/json" },
          }
        );

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`Financial detail request failed: ${response.status} ${text}`);
        }

        const data = JSON.parse(text);
        if (!cancelled) {
          setFinancialDetail(data);
        }
      } catch (err) {
        if (!cancelled) {
          setFinancialDetailError(err.message || "Failed to load financial detail");
        }
      } finally {
        if (!cancelled) {
          setFinancialDetailLoading(false);
        }
      }
    }

    loadFinancialDetail();

    return () => {
      cancelled = true;
    };
  }, [financialDetailOpen, financialDetailVehicle, selectedRange]);

  function openFinancialDetail(vehicle, focus = "expenses") {
    setFinancialDetailVehicle(vehicle);
    setFinancialDetailFocus(focus);
    setFinancialDetail(null);
    setFinancialDetailError(null);
    setFinancialDetailOpen(true);
  }

  function closeFinancialDetail() {
    setFinancialDetailOpen(false);
    setFinancialDetailVehicle(null);
    setFinancialDetail(null);
    setFinancialDetailError(null);
    setFinancialDetailLoading(false);
  }

  function openTollAudit(focus = "unattributed") {
    setTollAuditFocus(focus);
    setTollAuditOpen(true);
    setTollAuditError(null);
  }

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

  const filteredAndSortedVehicles = useMemo(() => {
    const next = [...vehicles].filter((vehicle) => {
      const profit = Number(vehicle?.net_profit ?? 0);
      const bookedDays = Number(vehicle?.booked_vehicle_days ?? 0);
      const calendarDays = Number(
        vehicle?.calendar_days_available ?? summary?.calendar_days ?? 0
      );
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
      const aRevenue = Number(a?.revenue_total ?? a?.trip_income ?? 0);
      const bRevenue = Number(b?.revenue_total ?? b?.trip_income ?? 0);
      const aRevDay = Number(a?.revenue_per_booked_day ?? a?.income_per_booked_day ?? 0);
      const bRevDay = Number(b?.revenue_per_booked_day ?? b?.income_per_booked_day ?? 0);
      const aRevMile = Number(a?.revenue_per_mile ?? 0);
      const bRevMile = Number(b?.revenue_per_mile ?? 0);
      const aTrips = Number(a?.trip_count_overlapping ?? 0);
      const bTrips = Number(b?.trip_count_overlapping ?? 0);
      const aValue = Number(a?.fmv_estimate_mid ?? 0);
      const bValue = Number(b?.fmv_estimate_mid ?? 0);
      const aOccupancy =
        Number(a?.calendar_days_available ?? summary?.calendar_days ?? 0) > 0
          ? Number(a?.booked_vehicle_days ?? 0) /
            Number(a?.calendar_days_available ?? summary?.calendar_days ?? 0)
          : 0;
      const bOccupancy =
        Number(b?.calendar_days_available ?? summary?.calendar_days ?? 0) > 0
          ? Number(b?.booked_vehicle_days ?? 0) /
            Number(b?.calendar_days_available ?? summary?.calendar_days ?? 0)
          : 0;

      const aRunRate = Number(a?.operating_run_rate_daily ?? 0);
      const bRunRate = Number(b?.operating_run_rate_daily ?? 0);

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
        case "rev_mile_desc":
          return bRevMile - aRevMile;
        case "trips_desc":
          return bTrips - aTrips;
        case "value_desc":
          return bValue - aValue;
        case "run_rate_desc":
          return bRunRate - aRunRate || bProfit - aProfit;
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

  const capitalBasisStats = useMemo(() => {
    return vehicles.reduce(
      (totals, vehicle) => {
        const basis = Number(vehicle?.capital_basis ?? 0);
        const recovered = Number(vehicle?.capital_recovered ?? 0);
        const remaining = Number(vehicle?.capital_remaining ?? 0);

        if (basis > 0 || recovered > 0 || remaining > 0) {
          totals.vehicleCount += 1;
        }

        totals.basis += Number.isFinite(basis) ? basis : 0;
        totals.recovered += Number.isFinite(recovered) ? recovered : 0;
        totals.remaining += Number.isFinite(remaining) ? remaining : 0;
        totals.monthlyRecovery += Number.isFinite(
          Number(vehicle?.capital_recovery_rate_monthly ?? 0)
        )
          ? Number(vehicle?.capital_recovery_rate_monthly ?? 0)
          : 0;

        return totals;
      },
      {
        basis: 0,
        recovered: 0,
        remaining: 0,
        monthlyRecovery: 0,
        vehicleCount: 0,
      }
    );
  }, [vehicles]);

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
  const accountedOffTripMiles = vehicles.reduce(
    (sum, vehicle) => sum + Number(vehicle?.accounted_off_trip_miles ?? 0),
    0
  );
  const hasExplicitUnaccountedMiles = vehicles.some(
    (vehicle) =>
      vehicle?.unaccounted_miles != null || vehicle?.unallocated_miles != null
  );
  const explicitUnaccountedMiles = vehicles.reduce(
    (sum, vehicle) =>
      sum +
      Number(vehicle?.unaccounted_miles ?? vehicle?.unallocated_miles ?? 0),
    0
  );
  const unaccountedMiles = hasExplicitUnaccountedMiles
    ? Math.max(0, explicitUnaccountedMiles)
    : Math.max(0, totalMiles - tripMiles - accountedOffTripMiles);

  const trips = Number(summary?.trip_count_overlapping ?? 0);

  return {
    totalMiles,
    tripMiles,
    offTripMiles,
    accountedOffTripMiles,
    unaccountedMiles,
    tripMileUtilization: safeDivide(tripMiles, totalMiles),
    offTripShare: safeDivide(offTripMiles, totalMiles),
    unaccountedShare: safeDivide(unaccountedMiles, totalMiles),
    bookedMilesPerTrip: safeDivide(tripMiles, trips),
  };
}, [vehicles, summary]);

  const businessFlagPreview = useMemo(() => {
    const flags = Array.isArray(businessMetrics?.flags) ? businessMetrics.flags : [];
    return flags.slice(0, 4);
  }, [businessMetrics]);

  const laborHoursBreakdown = useMemo(() => {
    const summary = businessMetrics?.fleet_summary || {};
    const breakdown = summary.labor_hours_breakdown || {};
    return {
      total: Number(summary.estimated_owner_hours ?? 0),
      cleaning: Number(
        breakdown.cleaning ?? summary.estimated_cleaning_hours ?? 0
      ),
      maintenance: Number(
        breakdown.maintenance ?? summary.estimated_maintenance_labor_hours ?? 0
      ),
      admin: Number(breakdown.admin ?? summary.estimated_admin_hours ?? 0),
      delivery: Number(
        breakdown.delivery ?? summary.estimated_delivery_hours ?? 0
      ),
      airportService: Number(
        breakdown.airportService ?? summary.estimated_airport_service_hours ?? 0
      ),
      airportTurnovers: Number(summary.airport_service_turnover_count ?? 0),
      airportMiles: Number(summary.airport_service_miles ?? 0),
      airportFuelCost: Number(summary.airport_service_fuel_cost ?? 0),
      airportAssumptions: summary.airport_service_assumptions || {},
      missing: Number(summary.maintenance_labor_missing_count ?? 0),
    };
  }, [businessMetrics]);

  function isMissingLaborFlag(flag) {
    return flag?.flag_code === "missing_maintenance_labor_hours";
  }

  const parkingRecommendationGroups = useMemo(() => {
    const rows = Array.isArray(parkingMetrics?.vehicles) ? parkingMetrics.vehicles : [];
    const visibleRows = rows.filter(
      (vehicle) =>
        Number(vehicle?.parkingDays ?? 0) > 0 ||
        vehicle?.actualPlan === "unlimited" ||
        vehicle?.actualPlan === "resident"
    );

    return {
      keep: visibleRows.filter((vehicle) => vehicle.recommendedPlan === "unlimited"),
      drop: visibleRows.filter((vehicle) => vehicle.recommendedPlan === "pay_per_day"),
      resident: visibleRows.filter(
        (vehicle) => vehicle.recommendedPlan === "resident_unlimited"
      ),
    };
  }, [parkingMetrics]);

  const derivedStartupTaxTotal = useMemo(
    () =>
      vehicleProfiles.reduce(
        (sum, profile) => sum + Number(profile?.derived_startup_tax_total ?? 0),
        0
      ),
    [vehicleProfiles]
  );

  function handleOpenTripFlag(flag) {
    if (typeof window === "undefined" || !flag?.reservation_id) return;

    const payload = {
      tripId: flag?.trip_id ?? null,
      reservationId: String(flag.reservation_id),
    };

    window.sessionStorage.setItem(
      TRIP_LEDGER_FOCUS_STORAGE_KEY,
      JSON.stringify(payload)
    );
    window.dispatchEvent(
      new CustomEvent("denmark:open-trip-ledger", { detail: payload })
    );
  }

  async function handleOpenExpenseFlag(flag) {
    if (!flag?.expense_id) return;

    try {
      setLoadingExpenseId(Number(flag.expense_id));

      const response = await fetch(`${API_BASE}/api/expenses/${flag.expense_id}`, {
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to load expense");
      }

      setEditingExpense(data);
      setExpenseModalOpen(true);
    } catch (err) {
      window.alert(err.message || "Failed to load expense");
    } finally {
      setLoadingExpenseId(null);
    }
  }

  function closeExpenseModal() {
    setExpenseModalOpen(false);
    setEditingExpense(null);
  }

  async function handleExpenseSaved() {
    await loadMetrics(selectedRange, {
      resetExpanded: false,
      showPageLoading: false,
    });
  }

  async function handleOpenMissingLaborFlag(flag) {
    const vehicleId = Number(flag?.vehicle_id || flag?.entity_id);
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) return;

    setLaborRemediationOpen(true);
    setLaborRemediation(null);
    setLaborRemediationError("");
    setLaborRemediationDrafts({});
    setLaborRemediationLoading(true);

    try {
      const response = await fetch(
        `${API_BASE}/api/metrics/business/maintenance-labor-missing/${vehicleId}`,
        { headers: { Accept: "application/json" } }
      );
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to load missing labor items");
      }

      const items = Array.isArray(data?.items) ? data.items : [];
      const drafts = {};
      for (const item of items) {
        const key = `${item.kind}:${item.id}`;
        drafts[key] =
          item.suggestedHours == null || item.suggestedHours === ""
            ? ""
            : String(item.suggestedHours);
      }

      setLaborRemediation(data);
      setLaborRemediationDrafts(drafts);
    } catch (err) {
      setLaborRemediationError(err.message || "Failed to load missing labor items");
    } finally {
      setLaborRemediationLoading(false);
    }
  }

  function updateLaborDraft(item, value) {
    const key = `${item.kind}:${item.id}`;
    setLaborRemediationDrafts((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function handleSaveMissingLabor(item) {
    const key = `${item.kind}:${item.id}`;
    const value = laborRemediationDrafts[key];
    const hours = Number(value);

    if (!Number.isFinite(hours) || hours < 0) {
      setLaborRemediationError("Enter labor hours as a positive number.");
      return;
    }

    setSavingLaborItemKey(key);
    setLaborRemediationError("");

    try {
      const response = await fetch(
        `${API_BASE}/api/metrics/business/maintenance-labor/${item.kind}/${item.id}`,
        {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ hours }),
        }
      );
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(data?.error || "Failed to save labor hours");
      }

      setLaborRemediation((current) => {
        if (!current) return current;
        return {
          ...current,
          items: (current.items || []).filter(
            (existing) => `${existing.kind}:${existing.id}` !== key
          ),
        };
      });

      setLaborRemediationDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });

      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });
    } catch (err) {
      setLaborRemediationError(err.message || "Failed to save labor hours");
    } finally {
      setSavingLaborItemKey(null);
    }
  }

  function updateBusinessSetting(key, value) {
    setBusinessSettings((current) => ({
      ...(current || {}),
      [key]: value,
    }));
  }

  function updateVehicleProfile(vehicleId, key, value) {
    setVehicleProfiles((current) =>
      current.map((profile) =>
        Number(profile.vehicle_id) === Number(vehicleId)
          ? {
              ...profile,
              [key]: value,
            }
          : profile
      )
    );
  }

  async function handleSaveBusinessSettings() {
    try {
      setSavingBusinessSettings(true);
      setBusinessInputsError("");

      const response = await fetch(`${API_BASE}/api/metrics/business/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(businessSettings || {}),
      });

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to save business settings");
      }

      setBusinessSettings(data || {});
      setBusinessInputsStatus("Business settings saved.");
      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });
    } catch (err) {
      setBusinessInputsError(err.message || "Failed to save business settings");
    } finally {
      setSavingBusinessSettings(false);
    }
  }

  async function handleSaveVehicleProfile(profile) {
    try {
      setSavingVehicleId(Number(profile.vehicle_id));
      setBusinessInputsError("");

      const payload = {
        purchase_price: profile.purchase_price,
        purchase_date: profile.purchase_date,
        placed_in_service_date: profile.placed_in_service_date,
        mileage_at_purchase: profile.mileage_at_purchase,
        loan_balance: profile.loan_balance,
        monthly_payment: profile.monthly_payment,
        interest_rate: profile.interest_rate,
        insurance_monthly: profile.insurance_monthly,
        tracker_monthly: profile.tracker_monthly,
        registration_annual: profile.registration_annual,
        inspection_annual: profile.inspection_annual,
        target_min_daily_rate: profile.target_min_daily_rate,
        target_utilization: profile.target_utilization,
        owner_hourly_rate_override: profile.owner_hourly_rate_override,
        notes: profile.notes,
      };

      const response = await fetch(
        `${API_BASE}/api/metrics/business/vehicle-profiles/${profile.vehicle_id}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(data?.error || "Failed to save vehicle profile");
      }

      setVehicleProfiles((current) =>
        current.map((item) =>
          Number(item.vehicle_id) === Number(profile.vehicle_id)
            ? {
                ...item,
                ...normalizeVehicleProfileForForm(data),
              }
            : item
        )
      );

      setBusinessInputsStatus(`Saved ${profile.vehicle_name || "vehicle"} profile.`);
      await loadMetrics(selectedRange, {
        resetExpanded: false,
        showPageLoading: false,
      });
    } catch (err) {
      setBusinessInputsError(err.message || "Failed to save vehicle profile");
    } finally {
      setSavingVehicleId(null);
    }
  }

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
                    onClick={() => selectPresetRange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                <span
                  className={`metrics-range-chip metrics-range-chip--custom ${
                    parseCustomRange(selectedRange) ? "is-active" : ""
                  }`}
                >
                  {parseCustomRange(selectedRange)
                    ? formatRangeLabel(selectedRange)
                    : "Custom"}
                </span>
              </div>
              <div className="metrics-custom-range">
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(event) => {
                    setCustomRangeError("");
                    setCustomStartDate(event.target.value);
                  }}
                  aria-label="Metrics range start date"
                />
                <span>to</span>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(event) => {
                    setCustomRangeError("");
                    setCustomEndDate(event.target.value);
                  }}
                  aria-label="Metrics range end date"
                />
                <button
                  type="button"
                  className="metrics-topbar__button"
                  onClick={applyCustomRange}
                >
                  Apply
                </button>
              </div>
              {customRangeError ? (
                <div className="metrics-custom-range__error">
                  {customRangeError}
                </div>
              ) : null}
            </div>
          </div>

          <RevenueExpenseSparkline trends={trends} summary={summary} />
          <MonthlyProfitLossChart trends={trends} />

          <BusinessHeartbeat
            summary={summary}
            businessSummary={businessMetrics?.fleet_summary}
            parkingSummary={parkingMetrics?.summary}
          />

          <div className="metrics-ledger-grid">
            <CompactLedger
              title="Capital + Fleet Value"
              subtitle="Cash recovery, equity coverage, and market value in one pass"
              action={
                <button
                  type="button"
                  className="metrics-inline-button"
                  onClick={handleRefreshFmvNow}
                  disabled={fmvRefreshing}
                >
                  {fmvRefreshing ? "Refreshing..." : "Refresh values"}
                </button>
              }
            >
              <LedgerLine
                label="Fleet Value"
                value={formatCurrency(summary.fleet_value)}
                detail={`${formatValueTrend(summary.fleet_value_change)} / ${formatUpdatedLabel(
                  summary.fleet_value_updated_at
                )}`}
                tone={Number(summary.fleet_value_change ?? 0) >= 0 ? "positive" : "negative"}
              />
              <LedgerLine
                label="Owner Cash In"
                value={
                  Number(
                    businessMetrics?.fleet_summary?.owner_cash_invested ??
                      businessMetrics?.settings?.owner_cash_invested ??
                      0
                  ) > 0
                    ? formatCurrency(
                        businessMetrics?.fleet_summary?.owner_cash_invested ??
                          businessMetrics?.settings?.owner_cash_invested
                      )
                    : "--"
                }
                detail="Total owner capital basis"
              />
              <LedgerLine
                label="Cash Back"
                value={formatCurrency(businessMetrics?.fleet_summary?.total_cash_returned)}
                detail={
                  businessMetrics?.fleet_summary?.cash_recovered_pct != null
                    ? `${formatPercent(
                        businessMetrics.fleet_summary.cash_recovered_pct,
                        0
                      )} recovered`
                    : "Set owner cash for recovery %"
                }
                tone="positive"
              />
              <LedgerLine
                label="Unrecovered Cash"
                value={formatCurrency(businessMetrics?.fleet_summary?.unrecovered_owner_cash)}
                detail="Owner cash in minus cash back"
                tone={
                  Number(businessMetrics?.fleet_summary?.unrecovered_owner_cash ?? 0) <= 0
                    ? "positive"
                    : "warning"
                }
              />
              <LedgerLine
                label="Capital Coverage"
                value={
                  businessMetrics?.fleet_summary?.owner_capital_coverage_pct != null
                    ? formatPercent(
                        businessMetrics.fleet_summary.owner_capital_coverage_pct,
                        0
                      )
                    : "--"
                }
                detail="Cash back plus fleet equity vs owner cash"
                tone={
                  Number(businessMetrics?.fleet_summary?.owner_capital_coverage_pct ?? 0) >= 1
                    ? "positive"
                    : "warning"
                }
              />
            </CompactLedger>

            <CompactLedger
              title="Labor + Profit Quality"
              subtitle="Whether profit survives debt, owner time, and data confidence"
            >
              <LedgerLine
                label="Operating Profit"
                value={formatCurrency(businessMetrics?.fleet_summary?.net_operating_profit)}
                detail={formatConfidenceLabel(businessMetrics?.fleet_summary?.data_confidence)}
                tone={
                  Number(businessMetrics?.fleet_summary?.net_operating_profit ?? 0) >= 0
                    ? "positive"
                    : "negative"
                }
              />
              <LedgerLine
                label="After Debt Service"
                value={formatCurrency(
                  businessMetrics?.fleet_summary?.net_profit_after_debt_service
                )}
                detail="Operating profit after vehicle debt"
                tone={
                  Number(
                    businessMetrics?.fleet_summary?.net_profit_after_debt_service ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />
              <LedgerLine
                label="After Owner Labor"
                value={formatCurrency(
                  businessMetrics?.fleet_summary?.net_profit_after_owner_labor
                )}
                detail={`${formatNumber(laborHoursBreakdown.total, 1)}h owner time / ${formatCurrencyCompact(
                  businessMetrics?.fleet_summary?.avg_profit_per_owner_hour
                )}/hr`}
                tone={
                  Number(
                    businessMetrics?.fleet_summary?.net_profit_after_owner_labor ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />
              <LedgerLine
                label="Labor Mix"
                value={`${formatNumber(laborHoursBreakdown.total, 1)}h`}
                detail={`Clean ${formatNumber(laborHoursBreakdown.cleaning, 1)}h / Maint ${formatNumber(
                  laborHoursBreakdown.maintenance,
                  1
                )}h / Admin ${formatNumber(laborHoursBreakdown.admin, 1)}h`}
                tone={laborHoursBreakdown.missing > 0 ? "warning" : "positive"}
              />
              <LedgerLine
                label="Airport Deadhead"
                value={`${formatNumber(laborHoursBreakdown.airportTurnovers)} turns`}
                detail={`${formatNumber(laborHoursBreakdown.airportMiles, 0)} mi / ${formatCurrencyCompact(
                  laborHoursBreakdown.airportFuelCost
                )} fuel / ${formatNumber(laborHoursBreakdown.airportService, 1)}h`}
              />
              <LedgerLine
                label="Data Flags"
                value={`${formatNumber(
                  Number(businessMetrics?.fleet_summary?.flag_counts?.high ?? 0) +
                    Number(businessMetrics?.fleet_summary?.flag_counts?.medium ?? 0) +
                    Number(businessMetrics?.fleet_summary?.flag_counts?.low ?? 0)
                )} flags`}
                detail={`High ${formatNumber(
                  businessMetrics?.fleet_summary?.flag_counts?.high ?? 0
                )} / Med ${formatNumber(
                  businessMetrics?.fleet_summary?.flag_counts?.medium ?? 0
                )}`}
                tone={
                  Number(businessMetrics?.fleet_summary?.flag_counts?.high ?? 0) > 0
                    ? "negative"
                    : Number(businessMetrics?.fleet_summary?.flag_counts?.medium ?? 0) > 0
                    ? "warning"
                    : "positive"
                }
              />
            </CompactLedger>
          </div>

          {false ? (
          <>
          <section className="metrics-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Financial Performance</div>
              <div className="metrics-section-subtitle">
                Gross revenue, margin, and earning pace for this range
              </div>
            </div>
            <div className="metrics-summary-row">
              <MetricCard
                label="Revenue"
                value={formatCurrency(summary.revenue)}
                subtitle={formatCurrencyTrend(summary.revenue_delta)}
                tone={
                  Number(summary.revenue_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.revenue_delta ?? 0) < 0
                    ? "warning"
                    : undefined
                }
              />

              <MetricCard
                label="Net Profit"
                value={formatCurrency(summary.net_profit)}
                subtitle={formatCurrencyTrend(summary.net_profit_delta)}
                tone={
                  Number(summary.net_profit_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.net_profit_delta ?? 0) < 0
                    ? "warning"
                    : Number(summary.net_profit) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="Expenses"
                value={formatCurrency(summary.expenses)}
                subtitle={formatCurrencyTrend(summary.expenses_delta)}
                tone={
                  Number(summary.expenses_delta ?? 0) > 0
                    ? "warning"
                    : Number(summary.expenses_delta ?? 0) < 0
                    ? "positive"
                    : undefined
                }
              />

              <MetricCard
                label="Run Rate"
                value={`${formatCurrencyCompact(
                  summary.vehicle_run_rate?.operating_run_rate_daily
                )}/day`}
                subtitle={formatCurrencyTrend(
                  summary.vehicle_run_rate?.operating_run_rate_daily_delta
                )}
                tone={
                  Number(
                    summary.vehicle_run_rate?.operating_run_rate_daily_delta ?? 0
                  ) > 0
                    ? "warning"
                    : Number(
                        summary.vehicle_run_rate?.operating_run_rate_daily_delta ?? 0
                      ) < 0
                    ? "positive"
                    : undefined
                }
              />

              <MetricCard
                label="Revenue / Trip Mile"
                value={formatCurrencyCompact(summary.revenue_per_trip_mile)}
                subtitle={formatPerMileYoYSubtitle(
                  summary.revenue_per_trip_mile_yoy_delta,
                  summary.last_year_revenue_per_trip_mile
                )}
                tone={
                  Number(summary.revenue_per_trip_mile_yoy_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.revenue_per_trip_mile_yoy_delta ?? 0) < 0
                    ? "warning"
                    : undefined
                }
              />

              <MetricCard
                label="Profit / Trip Mile"
                value={formatCurrencyCompact(summary.profit_per_trip_mile)}
                subtitle={formatPerMileYoYSubtitle(
                  summary.profit_per_trip_mile_yoy_delta,
                  summary.last_year_profit_per_trip_mile
                )}
                tone={
                  Number(summary.profit_per_trip_mile_yoy_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.profit_per_trip_mile_yoy_delta ?? 0) < 0
                    ? "warning"
                    : Number(summary.profit_per_trip_mile ?? 0) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="Expense / Trip Mile"
                value={formatCurrencyCompact(summary.expense_per_trip_mile)}
                subtitle={formatPerMileYoYSubtitle(
                  summary.expense_per_trip_mile_yoy_delta,
                  summary.last_year_expense_per_trip_mile
                )}
                tone={
                  Number(summary.expense_per_trip_mile_yoy_delta ?? 0) > 0
                    ? "warning"
                    : Number(summary.expense_per_trip_mile_yoy_delta ?? 0) < 0
                    ? "positive"
                    : undefined
                }
              />

              <MetricCard
                label="Revenue / Booked Day"
                value={formatCurrencyCompact(summary.revenue_per_booked_day)}
                subtitle={formatCurrencyTrend(
                  summary.revenue_per_booked_day_delta
                )}
                tone={
                  Number(summary.revenue_per_booked_day_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.revenue_per_booked_day_delta ?? 0) < 0
                    ? "warning"
                    : undefined
                }
              />
            </div>
          </section>

          <section className="metrics-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Fleet Value</div>
              <div className="metrics-section-subtitle">
                Market value movement and capital recovery context
              </div>
            </div>
            <div className="metrics-ops-row">
              <MetricCard
                label="Fleet Value"
                value={formatCurrency(summary.fleet_value)}
                subtitle={
                  <div className="fleet-value-card__meta">
                    <div>{formatValueTrend(summary.fleet_value_change)}</div>
                    <div>{formatUpdatedLabel(summary.fleet_value_updated_at)}</div>
                    {fmvRefreshStatus ? (
                      <div className="fleet-value-card__status">
                        {fmvRefreshStatus}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="fleet-value-card__refresh"
                      onClick={handleRefreshFmvNow}
                      disabled={fmvRefreshing}
                    >
                      {fmvRefreshing ? "Refreshing..." : "Refresh values now"}
                    </button>
                  </div>
                }
                tone={
                  Number(summary.fleet_value_change ?? 0) > 0
                    ? "positive"
                    : Number(summary.fleet_value_change ?? 0) < 0
                    ? "negative"
                    : undefined
                }
              />
            </div>
          </section>

          {businessMetrics?.fleet_summary ? (
            <section className="metrics-ops-row">
              <MetricCard
                label="Owner Cash In"
                value={
                  Number(
                    businessMetrics.fleet_summary?.owner_cash_invested ??
                      businessMetrics?.settings?.owner_cash_invested ??
                      0
                  ) > 0
                    ? formatCurrency(
                        businessMetrics.fleet_summary?.owner_cash_invested ??
                          businessMetrics?.settings?.owner_cash_invested
                      )
                    : "--"
                }
              />

              <MetricCard
                label="Cash Back"
                value={formatCurrency(
                  businessMetrics.fleet_summary.total_cash_returned
                )}
                subtitle={
                  businessMetrics.fleet_summary.cash_recovered_pct != null
                    ? `${formatPercent(
                        businessMetrics.fleet_summary.cash_recovered_pct,
                        0
                      )} recovered`
                    : "Set owner cash in for recovery %"
                }
                tone="positive"
              />

              <MetricCard
                label="Unrecovered Cash"
                value={formatCurrency(
                  businessMetrics.fleet_summary.unrecovered_owner_cash
                )}
                subtitle="Owner cash in minus cash back"
                tone={
                  Number(
                    businessMetrics.fleet_summary.unrecovered_owner_cash ?? 0
                  ) <= 0
                    ? "positive"
                    : "warning"
                }
              />

              <MetricCard
                label="Fleet Market Value"
                value={formatCurrency(
                  businessMetrics.fleet_summary.current_fleet_market_value
                )}
                subtitle={formatConfidenceLabel(
                  businessMetrics.fleet_summary.data_confidence
                )}
              />

              <MetricCard
                label="Capital Coverage"
                value={
                  businessMetrics.fleet_summary.owner_capital_coverage_pct != null
                    ? formatPercent(
                        businessMetrics.fleet_summary.owner_capital_coverage_pct,
                        0
                      )
                    : "--"
                }
                subtitle="Cash back plus fleet equity vs owner cash in"
                tone={
                  Number(
                    businessMetrics.fleet_summary.owner_capital_coverage_pct ?? 0
                  ) >= 1
                    ? "positive"
                    : "warning"
                }
              />
            </section>
          ) : null}

          {businessMetrics?.fleet_summary ? (
            <section className="metrics-ops-row">
              <MetricCard
                label="Operating Profit"
                value={formatCurrency(businessMetrics.fleet_summary.net_operating_profit)}
                subtitle={formatConfidenceLabel(businessMetrics.fleet_summary.data_confidence)}
                tone={
                  Number(businessMetrics.fleet_summary.net_operating_profit ?? 0) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="After Debt Service"
                value={formatCurrency(
                  businessMetrics.fleet_summary.net_profit_after_debt_service
                )}
                tone={
                  Number(
                    businessMetrics.fleet_summary.net_profit_after_debt_service ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="After Owner Labor"
                value={formatCurrency(
                  businessMetrics.fleet_summary.net_profit_after_owner_labor
                )}
                subtitle={`${formatNumber(
                  businessMetrics.fleet_summary.estimated_owner_hours,
                  1
                )} owner hrs${
                  Number(
                    businessMetrics.fleet_summary.maintenance_labor_missing_count ?? 0
                  ) > 0
                    ? ` - ${formatNumber(
                        businessMetrics.fleet_summary
                          .maintenance_labor_missing_count
                      )} labor missing`
                    : ""
                }`}
                tone={
                  Number(
                    businessMetrics.fleet_summary.net_profit_after_owner_labor ?? 0
                  ) >= 0
                    ? "positive"
                    : "negative"
                }
              />

              <MetricCard
                label="Profit / Owner Hour"
                value={formatCurrencyCompact(
                  businessMetrics.fleet_summary.avg_profit_per_owner_hour
                )}
              />

              <MetricCard
                label="Data Flags"
                value={`${formatNumber(
                  Number(businessMetrics.fleet_summary.flag_counts?.high ?? 0) +
                    Number(businessMetrics.fleet_summary.flag_counts?.medium ?? 0) +
                    Number(businessMetrics.fleet_summary.flag_counts?.low ?? 0)
                )} flags`}
                subtitle={`High ${formatNumber(
                  businessMetrics.fleet_summary.flag_counts?.high ?? 0
                )} · Med ${formatNumber(
                  businessMetrics.fleet_summary.flag_counts?.medium ?? 0
                )}`}
                tone={
                  Number(businessMetrics.fleet_summary.flag_counts?.high ?? 0) > 0
                    ? "negative"
                    : Number(businessMetrics.fleet_summary.flag_counts?.medium ?? 0) > 0
                    ? "warning"
                    : "positive"
                }
              />
            </section>
          ) : null}

          {businessMetrics?.fleet_summary ? (
            <section className="toll-panel labor-hours-panel">
              <div className="toll-panel__header">
                <div className="toll-panel__title">Labor Hours</div>
                <div className="toll-panel__subtitle">
                  Owner time included in profit after labor for the selected period
                </div>
              </div>
              <div className="labor-hours-summary">
                <div className="labor-hours-total">
                  <span>Total</span>
                  <strong>{formatNumber(laborHoursBreakdown.total, 1)}h</strong>
                  <em>
                    {laborHoursBreakdown.missing > 0
                      ? `${formatNumber(laborHoursBreakdown.missing)} missing`
                      : "complete"}
                  </em>
                </div>
                <div className="labor-hours-breakdown">
                  {[
                    ["Cleaning", laborHoursBreakdown.cleaning],
                    ["Maintenance", laborHoursBreakdown.maintenance],
                    ["Admin", laborHoursBreakdown.admin],
                    ["Handoff", laborHoursBreakdown.delivery],
                    ["Airport service", laborHoursBreakdown.airportService],
                  ].map(([label, hours]) => (
                    <div key={label} className="labor-hours-row">
                      <span>{label}</span>
                      <strong>{formatNumber(hours, 1)}h</strong>
                    </div>
                  ))}
                </div>
                <div className="labor-hours-airport">
                  <span>Airport deadhead</span>
                  <strong>
                    {formatNumber(laborHoursBreakdown.airportTurnovers)} turn
                    {laborHoursBreakdown.airportTurnovers === 1 ? "" : "s"} ·{" "}
                    {formatNumber(laborHoursBreakdown.airportMiles, 0)} mi ·{" "}
                    {formatCurrencyCompact(laborHoursBreakdown.airportFuelCost)} fuel
                  </strong>
                  <em>
                    {formatNumber(
                      laborHoursBreakdown.airportAssumptions?.minutes_per_turnover,
                      0
                    )}{" "}
                    min /{" "}
                    {formatNumber(
                      laborHoursBreakdown.airportAssumptions?.miles_per_turnover,
                      0
                    )}{" "}
                    mi per airport turnover
                  </em>
                </div>
              </div>
            </section>
          ) : null}
          </>
          ) : null}

          {parkingMetrics?.summary ? (
            <CompactLedger
              title="Parking Economics"
              subtitle="Pass value, actual expense, and positioning-transfer drag"
            >
              <LedgerLine
                label="Parking Value"
                value={formatCurrency(parkingMetrics.summary.parkingValue)}
                detail={`${formatNumber(
                  parkingMetrics.summary.fleetVehicleDays
                )} vehicle-days at ${formatCurrencyCompact(
                  parkingMetrics.assumptions?.dayRate
                )}/day`}
                tone="positive"
              />
              <LedgerLine
                label="Modeled Fixed Cost"
                value={formatCurrency(parkingMetrics.summary.fixedPassCost)}
                detail={`${formatCurrencyCompact(
                  Number(parkingMetrics.assumptions?.unlimitedMonthly ?? 0) +
                    Number(parkingMetrics.assumptions?.transponderMonthly ?? 0)
                )}/car/mo standard`}
              />
              <LedgerLine
                label="Pass Net Value"
                value={formatSignedCurrency(parkingMetrics.summary.passNetValue)}
                detail={`Break-even ${formatNumber(
                  parkingMetrics.assumptions?.standardBreakEvenDays,
                  1
                )} days/mo`}
                tone={Number(parkingMetrics.summary.passNetValue ?? 0) >= 0 ? "positive" : "warning"}
              />
              <LedgerLine
                label="Actual Parking Cost"
                value={
                  parkingMetrics.summary.actualParkingExpense == null
                    ? "--"
                    : formatCurrency(parkingMetrics.summary.actualParkingExpense)
                }
                detail={`${formatNumber(
                  parkingMetrics.summary.parkingExpenseCount
                )} expense records / ${formatSignedCurrency(
                  parkingMetrics.summary.valueVsActualParkingExpense
                )} value vs actual`}
                tone={
                  Number(parkingMetrics.summary.valueVsActualParkingExpense ?? 0) >= 0
                    ? "positive"
                    : "warning"
                }
              />
              <LedgerLine
                label="Keep / Drop Unlimited"
                value={`${formatNumber(
                  Number(parkingMetrics.summary.keepUnlimitedCount ?? 0) +
                    Number(parkingMetrics.summary.residentCount ?? 0)
                )} / ${formatNumber(parkingMetrics.summary.dropUnlimitedCount)}`}
                detail="Unlimited justified / below break-even"
              />
              <LedgerLine
                label="Home / Parking Transfers"
                value={formatNumber(parkingTransfers?.summary?.transfers ?? 0)}
                detail={`${formatNumber(
                  parkingTransfers?.summary?.homeToParking ?? 0
                )} out / ${formatNumber(
                  parkingTransfers?.summary?.parkingToHome ?? 0
                )} home / ${formatNumber(
                  parkingTransfers?.summary?.totalMiles ?? 0,
                  1
                )} mi / ${formatNumber(
                  parkingTransfers?.summary?.totalHours ?? 0,
                  1
                )}h`}
              />
              <LedgerLine
                label="Transfer Fuel"
                value={formatCurrencyCompact(
                  parkingTransfers?.summary?.estimatedFuelCost ?? 0
                )}
                detail={`${formatNumber(
                  parkingTransfers?.summary?.estimatedGallons ?? 0,
                  1
                )} gal`}
                tone={
                  Number(parkingTransfers?.summary?.estimatedFuelCost ?? 0) > 0
                    ? "warning"
                    : "neutral"
                }
              />

              {parkingRecommendationGroups.keep.length ||
              parkingRecommendationGroups.drop.length ||
              parkingRecommendationGroups.resident.length ? (
                <div className="parking-recommendation-grid parking-recommendation-grid--compact">
                  {[
                    ["Keep Unlimited", parkingRecommendationGroups.keep, "keep"],
                    ["Drop Unlimited", parkingRecommendationGroups.drop, "drop"],
                    ["Resident Hot Swap", parkingRecommendationGroups.resident, "resident"],
                  ]
                    .filter(([, rows]) => rows.length)
                    .map(([label, rows, kind]) => (
                      <article
                        key={label}
                        className={`parking-recommendation-card parking-recommendation-card--${kind}`}
                      >
                        <div className="parking-recommendation-card__header">
                          <div className="metrics-business-card__title">{label}</div>
                          <div className="vehicle-compare__value">
                            {formatNumber(rows.length)}
                          </div>
                        </div>
                        <div className="parking-recommendation-list">
                          {rows.slice(0, 5).map((vehicle) => (
                            <div
                              key={vehicle.vehicleId}
                              className="parking-recommendation-row"
                            >
                              <span>{vehicle.vehicleName}</span>
                              <strong>
                                {formatNumber(vehicle.parkingDays)}d /{" "}
                                {formatSignedCurrency(
                                  kind === "drop"
                                    ? vehicle.savingsIfPayPerDay
                                    : vehicle.passNetValue ?? -vehicle.fixedPassCost
                                )}
                              </strong>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                </div>
              ) : null}
            </CompactLedger>
          ) : null}

          {false && parkingMetrics?.summary ? (
            <section className="metrics-section">
              <div className="metrics-section-header">
                <div className="metrics-section-title">Parking Economics</div>
                <div className="metrics-section-subtitle">
                  Park My Share days valued against unlimited pass and transponder cost
                </div>
              </div>

              <div className="metrics-summary-row">
                <MetricCard
                  label="Parking Value"
                  value={formatCurrency(parkingMetrics.summary.parkingValue)}
                  subtitle={`${formatNumber(
                    parkingMetrics.summary.fleetVehicleDays
                  )} vehicle-days at ${formatCurrencyCompact(
                    parkingMetrics.assumptions?.dayRate
                  )}/day`}
                  tone="positive"
                />
                <MetricCard
                  label="Modeled Fixed Cost"
                  value={formatCurrency(parkingMetrics.summary.fixedPassCost)}
                  subtitle={`${formatCurrencyCompact(
                    Number(parkingMetrics.assumptions?.unlimitedMonthly ?? 0) +
                      Number(parkingMetrics.assumptions?.transponderMonthly ?? 0)
                  )}/car/mo standard`}
                  tone={
                    Number(parkingMetrics.summary.passNetValue ?? 0) >= 0
                      ? "positive"
                      : "warning"
                  }
                />
                <MetricCard
                  label="Pass Net Value"
                  value={formatSignedCurrency(parkingMetrics.summary.passNetValue)}
                  subtitle={`Break-even ${formatNumber(
                    parkingMetrics.assumptions?.standardBreakEvenDays,
                    1
                  )} days/mo`}
                  tone={
                    Number(parkingMetrics.summary.passNetValue ?? 0) >= 0
                      ? "positive"
                      : "warning"
                  }
                />
                <MetricCard
                  label="Actual Cost"
                  value={
                    parkingMetrics.summary.actualParkingExpense == null
                      ? "--"
                      : formatCurrency(parkingMetrics.summary.actualParkingExpense)
                  }
                  subtitle={`${formatNumber(
                    parkingMetrics.summary.parkingExpenseCount
                  )} parking expense records`}
                  tone={
                    Number(parkingMetrics.summary.valueVsActualParkingExpense ?? 0) >= 0
                      ? "positive"
                      : "warning"
                  }
                />
                <MetricCard
                  label="Value vs Actual"
                  value={formatSignedCurrency(
                    parkingMetrics.summary.valueVsActualParkingExpense
                  )}
                  subtitle="Parking value minus expense records"
                  tone={
                    Number(parkingMetrics.summary.valueVsActualParkingExpense ?? 0) >= 0
                      ? "positive"
                      : "warning"
                  }
                />
                <MetricCard
                  label="Keep / Drop"
                  value={`${formatNumber(
                    Number(parkingMetrics.summary.keepUnlimitedCount ?? 0) +
                      Number(parkingMetrics.summary.residentCount ?? 0)
                  )} / ${formatNumber(parkingMetrics.summary.dropUnlimitedCount)}`}
                  subtitle="Unlimited justified / below break-even"
                />
                <MetricCard
                  label="Home / Parking Trips"
                  value={formatNumber(parkingTransfers?.summary?.transfers ?? 0)}
                  subtitle={`${formatNumber(
                    parkingTransfers?.summary?.homeToParking ?? 0
                  )} out · ${formatNumber(
                    parkingTransfers?.summary?.parkingToHome ?? 0
                  )} home`}
                />
                <MetricCard
                  label="Shuttle Time"
                  value={`${formatNumber(
                    parkingTransfers?.summary?.totalHours ?? 0,
                    1
                  )} hrs`}
                  subtitle={`Excludes over ${formatNumber(
                    parkingTransfers?.summary?.maxTransferHours ??
                      parkingTransfers?.assumptions?.maxTransferHours ??
                      0
                  )} hrs per trip`}
                />
                <MetricCard
                  label="Shuttle Fuel"
                  value={formatCurrencyCompact(
                    parkingTransfers?.summary?.estimatedFuelCost ?? 0
                  )}
                  subtitle={`${formatNumber(
                    parkingTransfers?.summary?.estimatedGallons ?? 0,
                    1
                  )} gal · ${formatNumber(
                    parkingTransfers?.summary?.totalMiles ?? 0,
                    1
                  )} mi`}
                />
              </div>

              {parkingRecommendationGroups.keep.length ||
              parkingRecommendationGroups.drop.length ||
              parkingRecommendationGroups.resident.length ? (
                <div className="parking-recommendation-grid">
                  {parkingRecommendationGroups.keep.length ? (
                    <article className="parking-recommendation-card parking-recommendation-card--keep">
                      <div className="parking-recommendation-card__header">
                        <div>
                          <div className="metrics-business-card__title">
                            Keep Unlimited
                          </div>
                          <div className="metrics-business-profile__meta">
                            Above break-even for this range
                          </div>
                        </div>
                        <div className="vehicle-compare__value vehicle-compare__value--positive">
                          {formatNumber(parkingRecommendationGroups.keep.length)}
                        </div>
                      </div>
                      <div className="parking-recommendation-list">
                        {parkingRecommendationGroups.keep.map((vehicle) => (
                          <div
                            key={vehicle.vehicleId}
                            className="parking-recommendation-row"
                          >
                            <span>{vehicle.vehicleName}</span>
                            <strong>
                              {formatNumber(vehicle.parkingDays)}d ·{" "}
                              {formatSignedCurrency(vehicle.passNetValue)}
                            </strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  ) : null}

                  {parkingRecommendationGroups.drop.length ? (
                    <article className="parking-recommendation-card parking-recommendation-card--drop">
                      <div className="parking-recommendation-card__header">
                        <div>
                          <div className="metrics-business-card__title">
                            Drop Unlimited
                          </div>
                          <div className="metrics-business-profile__meta">
                            Below break-even; pay-per-day is cheaper
                          </div>
                        </div>
                        <div className="vehicle-compare__value vehicle-compare__value--warning">
                          {formatNumber(parkingRecommendationGroups.drop.length)}
                        </div>
                      </div>
                      <div className="parking-recommendation-list">
                        {parkingRecommendationGroups.drop.map((vehicle) => (
                          <div
                            key={vehicle.vehicleId}
                            className="parking-recommendation-row"
                          >
                            <span>{vehicle.vehicleName}</span>
                            <strong>
                              {formatNumber(vehicle.parkingDays)}d · save{" "}
                              {formatCurrencyCompact(vehicle.savingsIfPayPerDay)}
                            </strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  ) : null}

                  {parkingRecommendationGroups.resident.length ? (
                    <article className="parking-recommendation-card parking-recommendation-card--resident">
                      <div className="parking-recommendation-card__header">
                        <div>
                          <div className="metrics-business-card__title">
                            Resident Hot Swap
                          </div>
                          <div className="metrics-business-profile__meta">
                            Dedicated car kept at Park My Share
                          </div>
                        </div>
                        <div className="vehicle-compare__value vehicle-compare__value--positive">
                          {formatNumber(parkingRecommendationGroups.resident.length)}
                        </div>
                      </div>
                      <div className="parking-recommendation-list">
                        {parkingRecommendationGroups.resident.map((vehicle) => (
                          <div
                            key={vehicle.vehicleId}
                            className="parking-recommendation-row"
                          >
                            <span>{vehicle.vehicleName}</span>
                            <strong>
                              {formatNumber(vehicle.parkingDays)}d ·{" "}
                              {formatCurrencyCompact(vehicle.fixedPassCost)}
                            </strong>
                          </div>
                        ))}
                      </div>
                    </article>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {businessFlagPreview.length ? (
            <section className="toll-panel">
              <div className="toll-panel__header">
                <div className="toll-panel__title">Business Watchlist</div>
                <div className="toll-panel__subtitle">
                  Highest-signal gaps still lowering confidence in profit and scale decisions
                </div>
              </div>
              <div className="metrics-financial-list">
                {businessFlagPreview.map((flag) => (
                  <article
                    key={`${flag.entity_type}:${flag.entity_id}:${flag.flag_code}`}
                    className="metrics-financial-line-item"
                  >
                    <div className="metrics-financial-line-top">
                      <div>
                        <div className="metrics-financial-line-title">
                          {formatFlagTitle(flag)}
                        </div>
                        <div className="metrics-financial-line-meta">
                          {formatFlagMeta(flag) || `${flag.entity_type} #${flag.entity_id}`}
                        </div>
                      </div>
                      <div className="metrics-financial-line-amount">
                        {String(flag.severity || "").toUpperCase()}
                      </div>
                    </div>
                    <div className="metrics-financial-line-split">
                      <span>{flag.note}</span>
                    </div>
                    {flag.mapping_reason ? (
                      <div className="metrics-financial-line-split">
                        <span>Why: {flag.mapping_reason}</span>
                      </div>
                    ) : null}
                    {flag.suggested_action ? (
                      <div className="metrics-financial-line-split">
                        <span>Next: {flag.suggested_action}</span>
                      </div>
                    ) : null}
                    {flag.suggested_vehicle_name ? (
                      <div className="metrics-financial-line-split">
                        <span>Likely vehicle: {flag.suggested_vehicle_name}</span>
                      </div>
                    ) : null}
                    {isMissingLaborFlag(flag) ? (
                      <div className="metrics-financial-line-actions">
                        <button
                          type="button"
                          className="metrics-inline-button"
                          onClick={() => handleOpenMissingLaborFlag(flag)}
                        >
                          Fix hours
                        </button>
                      </div>
                    ) : flag.entity_type === "trip" && flag.reservation_id ? (
                      <div className="metrics-financial-line-actions">
                        <button
                          type="button"
                          className="metrics-inline-button"
                          onClick={() => handleOpenTripFlag(flag)}
                        >
                          Open trip
                        </button>
                      </div>
                    ) : flag.entity_type === "expense" && flag.expense_id ? (
                      <div className="metrics-financial-line-actions">
                        <button
                          type="button"
                          className="metrics-inline-button"
                          onClick={() => handleOpenExpenseFlag(flag)}
                          disabled={loadingExpenseId === Number(flag.expense_id)}
                        >
                          {loadingExpenseId === Number(flag.expense_id)
                            ? "Opening..."
                            : "Edit expense"}
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {false ? (
          <section className="toll-panel">
            <div className="toll-panel__header">
              <div className="toll-panel__title">Business Inputs</div>
              <div className="toll-panel__subtitle">
                Fill in the real business assumptions so profit after debt, labor, and equity means something
              </div>
            </div>

            {businessInputsLoading ? (
              <div className="message-empty">Loading business inputs…</div>
            ) : businessInputsError ? (
              <div className="expenses-error-state">{businessInputsError}</div>
            ) : (
              <div className="metrics-business-inputs">
                {businessInputsStatus ? (
                  <div className="detail-sub">{businessInputsStatus}</div>
                ) : null}
                <div className="metrics-business-card">
                  <div className="metrics-business-card__header">
                    <div>
                      <div className="metrics-business-card__title">Business Settings</div>
                      <div className="metrics-business-profile__meta">
                        Owner cash {formatCurrencyCompact(businessSettings?.owner_cash_invested)} · 401k{" "}
                        {formatCurrencyCompact(businessSettings?.loan_401k_amount)} · startup tax{" "}
                        {formatCurrencyCompact(derivedStartupTaxTotal)} · hourly{" "}
                        {formatCurrencyCompact(
                          businessSettings?.target_owner_hourly_rate
                        )}
                      </div>
                    </div>
                    <div className="metrics-business-card__actions">
                      <button
                        type="button"
                        className="metrics-inline-button"
                        onClick={() => setBusinessSettingsOpen((open) => !open)}
                      >
                        {businessSettingsOpen ? "Collapse" : "Edit"}
                      </button>
                      <button
                        type="button"
                        className="metrics-inline-button"
                        onClick={handleSaveBusinessSettings}
                        disabled={savingBusinessSettings}
                      >
                        {savingBusinessSettings ? "Saving..." : "Save settings"}
                      </button>
                    </div>
                  </div>
                  {businessSettingsOpen ? (
                  <div className="metrics-business-grid">
                    <label className="metrics-business-field">
                      <span>Owner Cash Invested</span>
                      <input
                        value={formatInputValue(businessSettings?.owner_cash_invested)}
                        onChange={(e) =>
                          updateBusinessSetting("owner_cash_invested", e.target.value)
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>401k Loan Used</span>
                      <input
                        value={formatInputValue(businessSettings?.loan_401k_amount)}
                        onChange={(e) =>
                          updateBusinessSetting("loan_401k_amount", e.target.value)
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Other Business Loan</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.other_business_loan_amount
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "other_business_loan_amount",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Owner Hourly Rate</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_owner_hourly_rate
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_owner_hourly_rate",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Profit / Car / Month</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_minimum_monthly_profit_per_car
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_minimum_monthly_profit_per_car",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Cash-on-Cash Return</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_cash_on_cash_return
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_cash_on_cash_return",
                            e.target.value
                          )
                        }
                      />
                    </label>
                    <label className="metrics-business-field">
                      <span>Target Payback Months</span>
                      <input
                        value={formatInputValue(
                          businessSettings?.target_payback_period_months
                        )}
                        onChange={(e) =>
                          updateBusinessSetting(
                            "target_payback_period_months",
                            e.target.value
                          )
                        }
                      />
                    </label>
                  </div>
                  ) : null}
                </div>

                <div className="metrics-business-card">
                  <div className="metrics-business-card__header">
                    <div className="metrics-business-card__title">Vehicle Financial Profiles</div>
                  </div>
                  <div className="metrics-business-profile-list">
                    {vehicleProfiles.map((profile) => (
                      <article
                        key={profile.vehicle_id}
                        className="metrics-business-profile"
                      >
                        <div className="metrics-business-profile__header">
                          <div>
                            <div className="metrics-business-profile__title">
                              {profile.vehicle_name}
                            </div>
                            <div className="metrics-business-profile__meta">
                              {buildYearMakeModel(profile) || "Vehicle"} · Turo ID{" "}
                              {profile.turo_vehicle_id || "--"} · Odo{" "}
                              {formatNumber(profile.current_odometer_miles ?? 0)}
                            </div>
                            <div className="metrics-business-profile__summary">
                              Cash layout {formatCurrencyCompact(
                                profile.derived_startup_total ?? profile.purchase_price
                              )} · Tax{" "}
                              {formatCurrencyCompact(profile.derived_startup_tax_total)} · Loan{" "}
                              {formatCurrencyCompact(profile.loan_balance)} · Insurance{" "}
                              {formatCurrencyCompact(profile.insurance_monthly)}/mo · Service{" "}
                              {formatBusinessInputDate(profile.placed_in_service_date)}
                            </div>
                          </div>
                          <div className="metrics-business-card__actions">
                            <button
                              type="button"
                              className="metrics-inline-button"
                              onClick={() => toggleBusinessProfile(profile.vehicle_id)}
                            >
                              {expandedBusinessProfiles[profile.vehicle_id]
                                ? "Collapse"
                                : "Edit"}
                            </button>
                            <button
                              type="button"
                              className="metrics-inline-button"
                              onClick={() => handleSaveVehicleProfile(profile)}
                              disabled={savingVehicleId === Number(profile.vehicle_id)}
                            >
                              {savingVehicleId === Number(profile.vehicle_id)
                                ? "Saving..."
                                : "Save vehicle"}
                            </button>
                          </div>
                        </div>
                        {expandedBusinessProfiles[profile.vehicle_id] ? (
                        <div className="metrics-business-grid">
                          <label className="metrics-business-field">
                            <span>Cash Layout From Expenses</span>
                            <input
                              value={formatInputValue(
                                formatCurrencyCompact(
                                  profile.derived_startup_total ?? profile.purchase_price
                                )
                              )}
                              readOnly
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Onboard Tax From Expenses</span>
                            <input
                              value={formatInputValue(
                                formatCurrencyCompact(profile.derived_startup_tax_total)
                              )}
                              readOnly
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Purchase Date</span>
                            <input
                              type="date"
                              value={formatInputValue(profile.purchase_date)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "purchase_date",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Placed In Service</span>
                            <input
                              type="date"
                              value={formatInputValue(profile.placed_in_service_date)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "placed_in_service_date",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Miles At Purchase</span>
                            <input
                              value={formatInputValue(profile.mileage_at_purchase)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "mileage_at_purchase",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Loan Balance</span>
                            <input
                              value={formatInputValue(profile.loan_balance)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "loan_balance",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Monthly Payment</span>
                            <input
                              value={formatInputValue(profile.monthly_payment)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "monthly_payment",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Interest Rate</span>
                            <input
                              value={formatInputValue(profile.interest_rate)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "interest_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Insurance / Month</span>
                            <input
                              value={formatInputValue(profile.insurance_monthly)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "insurance_monthly",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Tracker / Month</span>
                            <input
                              value={formatInputValue(profile.tracker_monthly)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "tracker_monthly",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Registration / Year</span>
                            <input
                              value={formatInputValue(profile.registration_annual)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "registration_annual",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Inspection / Year</span>
                            <input
                              value={formatInputValue(profile.inspection_annual)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "inspection_annual",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Min Daily Rate</span>
                            <input
                              value={formatInputValue(profile.target_min_daily_rate)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "target_min_daily_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Utilization</span>
                            <input
                              value={formatInputValue(profile.target_utilization)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "target_utilization",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Owner Hourly Override</span>
                            <input
                              value={formatInputValue(
                                profile.owner_hourly_rate_override
                              )}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "owner_hourly_rate_override",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field metrics-business-field--full">
                            <span>Notes</span>
                            <textarea
                              rows={2}
                              value={formatInputValue(profile.notes)}
                              onChange={(e) =>
                                updateVehicleProfile(
                                  profile.vehicle_id,
                                  "notes",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                        </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </section>
          ) : null}

          <section className="metrics-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Utilization</div>
              <div className="metrics-section-subtitle">
                How hard the fleet worked during the selected range
              </div>
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
                label="Occupancy"
                value={formatPercent(summary.occupancy_rate, 1)}
                subtitle={formatOccupancyTrend(summary.occupancy_rate_delta)}
                tone={
                  Number(summary.occupancy_rate_delta ?? 0) > 0
                    ? "positive"
                    : Number(summary.occupancy_rate_delta ?? 0) < 0
                    ? "warning"
                    : "default"
                }
              />

              <MetricCard
                label="Cleaning / Trip"
                value={`${formatCurrencyCompact(summary.cleaning_cost_per_overlapping_trip)} actual`}
                subtitle={`${formatCurrencyCompact(summary.cleaning_cost_per_prorated_trip)} effective`}
              />
            </div>
            <div className="trip-length-grid">
              <TripLengthDistributionPanel
                distribution={summary.trip_length_distribution}
              />
              <ValuableTripLengthsPanel
                distribution={summary.trip_length_distribution}
              />
            </div>
          </section>

          <section className="metrics-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Revenue Reconciliation</div>
              <div className="metrics-section-subtitle">
                Turo expectations, bridge payment notices, and bank income
              </div>
            </div>
            <div className="metrics-ops-row">
              <MetricCard
                label="Expected Turo vs Income"
                value={formatSignedCurrency(summary.income_category_variance)}
                subtitle={
                  <>
                    <div>
                      {formatCurrencyCompact(
                        summary.scheduled_turo_output_total ?? summary.turo_output_total
                      )} expected / {formatCurrencyCompact(
                        summary.income_category_total
                      )} income / {formatCurrencyCompact(
                        summary.turo_output_deferred_total
                      )} deferred
                    </div>
                    {summary.income_reconciliation_largest_gap ? (
                      <div>
                        Largest gap {formatShortDate(
                          summary.income_reconciliation_largest_gap.date
                        )}: {formatSignedCurrency(
                          summary.income_reconciliation_largest_gap.variance
                        )}
                      </div>
                    ) : null}
                  </>
                }
                tone={
                  Math.abs(Number(summary.income_category_variance ?? 0)) < 1
                    ? "positive"
                    : Number(summary.income_category_variance ?? 0) < 0
                    ? "warning"
                    : "default"
                }
              />

              <MetricCard
                label="Payment Notices vs Bank"
                value={formatSignedCurrency(summary.payment_notice_vs_income_variance)}
                subtitle={
                  <>
                    <div>
                      {formatCurrencyCompact(summary.payment_notice_total)} notices /{" "}
                      {formatCurrencyCompact(summary.income_category_total)} bank income
                    </div>
                    <div>
                      vs expected{" "}
                      {formatSignedCurrency(summary.payment_notice_vs_expected_variance)}
                      {summary.payment_notice_reconciliation_largest_gap ? (
                        <>
                          {" "}
                          / largest {formatShortDate(
                            summary.payment_notice_reconciliation_largest_gap.date
                          )}: {formatSignedCurrency(
                            summary.payment_notice_reconciliation_largest_gap.variance
                          )}
                        </>
                      ) : null}
                    </div>
                  </>
                }
                tone={
                  Math.abs(Number(summary.payment_notice_vs_income_variance ?? 0)) < 1
                    ? "positive"
                    : "warning"
                }
              />
            </div>
          </section>

          <section className="metrics-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Mileage Efficiency</div>
              <div className="metrics-section-subtitle">
                Revenue, profit, and cost normalized by miles driven
              </div>
            </div>
            <div className="metrics-mileage-row">
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
                label="Unaccounted Miles"
                value={`${formatNumber(mileageStats.unaccountedMiles)} mi`}
                tone={
                  mileageStats.unaccountedShare >= 0.25
                    ? "warning"
                    : "default"
                }
                subtitle={`${formatPercent(mileageStats.unaccountedShare, 0)} of total miles; off-trip miles stay here until reviewed`}
                onClick={() => setOffTripAuditOpen(true)}
              />

            </div>
          </section>

      <OffTripMilesDrawer
        open={offTripAuditOpen}
        loading={offTripAuditLoading}
        error={offTripAuditError}
        audit={offTripAudit}
        onSaveReview={handleSaveOffTripReview}
        onClose={() => setOffTripAuditOpen(false)}
      />

      <TollAuditDrawer
        open={tollAuditOpen}
        loading={tollAuditLoading}
        error={tollAuditError}
        detail={tollAudit}
        focus={tollAuditFocus}
        assigningChargeId={assigningTollChargeId}
        onAssignTrip={handleAssignTollTrip}
        onClose={() => setTollAuditOpen(false)}
      />

          <CompactLedger
            title="Toll Margin"
            subtitle="Paid, recovered, outstanding, and unattributed toll exposure"
          >
            <LedgerLine
              label="Paid"
              value={formatCurrencyCompact(summary.tolls_paid)}
              detail="Toll expense recorded in this range"
            />
            <LedgerLine
              label="Recovered"
              value={formatCurrencyCompact(summary.tolls_recovered)}
              detail={`${formatPercent(summary.toll_recovery_rate, 0)} direct recovery`}
              tone="positive"
            />
            <LedgerLine
              label="Outstanding"
              value={formatCurrencyCompact(summary.tolls_attributed_outstanding)}
              detail="Matched to trips but not recovered yet"
              tone="warning"
              onClick={() => openTollAudit("outstanding")}
            />
            <LedgerLine
              label="Unattributed"
              value={formatCurrencyCompact(summary.tolls_unattributed)}
              detail="Paid tolls not assigned to a trip"
              tone={Number(summary.tolls_unattributed ?? 0) > 0 ? "negative" : "positive"}
              onClick={() => openTollAudit("unattributed")}
            />
            <LedgerLine
              label="Effective Recovery"
              value={formatPercent(summary.toll_effective_recovery_rate, 0)}
              detail="Recovered plus outstanding against paid"
              tone={
                Number(summary.toll_effective_recovery_rate) >= 0.85
                  ? "positive"
                  : Number(summary.toll_effective_recovery_rate) >= 0.65
                  ? "warning"
                  : "negative"
              }
            />
          </CompactLedger>

          {false ? (
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
                onClick={() => openTollAudit("outstanding")}
              />

              <TollStat
                label="Unattributed"
                value={formatCurrencyCompact(summary.tolls_unattributed)}
                tone="negative"
                emphasis="strong"
                onClick={() => openTollAudit("unattributed")}
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
          ) : null}

          <section className="metrics-vehicles-section">
            <div className="metrics-section-header">
              <div className="metrics-section-title">Vehicles</div>
              <div className="metrics-section-subtitle">
                Compare fleet performance across the selected range
              </div>
            </div>

            <CapitalBasisProgress
              stats={capitalBasisStats}
              selectedRange={selectedRange}
            />

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
                  <option value="rev_mile_desc">Rev / Trip Mile ↓</option>
                  <option value="trips_desc">Trips ↓</option>
                  <option value="run_rate_desc">Run Rate ↓</option>
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
              <div className="vehicle-compare-header__cell">Rented / Available</div>
              <div className="vehicle-compare-header__cell">Occupancy</div>
              <div className="vehicle-compare-header__cell">Rev / Trip Mi</div>
              <div className="vehicle-compare-header__cell">Profit / Trip Mi</div>
              <div className="vehicle-compare-header__cell">Exp / Trip Mi</div>
              <div className="vehicle-compare-header__cell">Trips</div>
              <div className="vehicle-compare-header__cell">Run Rate</div>
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
                    onOpenFinancialDetail={openFinancialDetail}
                    formatCurrency={formatCurrency}
                    formatCurrencyCompact={formatCurrencyCompact}
                    formatNumber={formatNumber}
                    formatValueTrend={formatValueTrend}
                    calendarDays={summary.calendar_days}
                  />
                );
              })}
            </div>

            <div className="metrics-business-card">
              <div className="metrics-business-card__header">
                <div>
                  <div className="metrics-business-card__title">Vehicle Economics Inputs</div>
                  <div className="metrics-business-profile__meta">
                    Cash layout, tax, financing, insurance, and service dates alongside the cars they belong to
                  </div>
                </div>
                <button
                  type="button"
                  className="metrics-inline-button"
                  onClick={() => setBusinessInputsSectionOpen((open) => !open)}
                >
                  {businessInputsSectionOpen ? "Collapse" : "Expand"}
                </button>
              </div>

              {businessInputsSectionOpen ? (
                businessInputsLoading ? (
                  <div className="message-empty">Loading business inputsâ€¦</div>
                ) : businessInputsError ? (
                  <div className="expenses-error-state">{businessInputsError}</div>
                ) : (
                  <div className="metrics-business-inputs">
                    {businessInputsStatus ? (
                      <div className="detail-sub">{businessInputsStatus}</div>
                    ) : null}
                    <div className="metrics-business-card">
                      <div className="metrics-business-card__header">
                        <div>
                          <div className="metrics-business-card__title">Business Settings</div>
                          <div className="metrics-business-profile__meta">
                            Owner cash {formatCurrencyCompact(businessSettings?.owner_cash_invested)} · 401k{" "}
                            {formatCurrencyCompact(businessSettings?.loan_401k_amount)} · startup tax{" "}
                            {formatCurrencyCompact(derivedStartupTaxTotal)} · hourly{" "}
                            {formatCurrencyCompact(
                              businessSettings?.target_owner_hourly_rate
                            )}
                          </div>
                        </div>
                        <div className="metrics-business-card__actions">
                          <button
                            type="button"
                            className="metrics-inline-button"
                            onClick={() => setBusinessSettingsOpen((open) => !open)}
                          >
                            {businessSettingsOpen ? "Collapse" : "Edit"}
                          </button>
                          <button
                            type="button"
                            className="metrics-inline-button"
                            onClick={handleSaveBusinessSettings}
                            disabled={savingBusinessSettings}
                          >
                            {savingBusinessSettings ? "Saving..." : "Save settings"}
                          </button>
                        </div>
                      </div>
                      {businessSettingsOpen ? (
                        <div className="metrics-business-grid">
                          <label className="metrics-business-field">
                            <span>Owner Cash Invested</span>
                            <input
                              value={formatInputValue(businessSettings?.owner_cash_invested)}
                              onChange={(e) =>
                                updateBusinessSetting("owner_cash_invested", e.target.value)
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>401k Loan Used</span>
                            <input
                              value={formatInputValue(businessSettings?.loan_401k_amount)}
                              onChange={(e) =>
                                updateBusinessSetting("loan_401k_amount", e.target.value)
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Other Business Loan</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.other_business_loan_amount
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "other_business_loan_amount",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Owner Hourly Rate</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_owner_hourly_rate
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_owner_hourly_rate",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Profit / Car / Month</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_minimum_monthly_profit_per_car
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_minimum_monthly_profit_per_car",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Cash-on-Cash Return</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_cash_on_cash_return
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_cash_on_cash_return",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                          <label className="metrics-business-field">
                            <span>Target Payback Months</span>
                            <input
                              value={formatInputValue(
                                businessSettings?.target_payback_period_months
                              )}
                              onChange={(e) =>
                                updateBusinessSetting(
                                  "target_payback_period_months",
                                  e.target.value
                                )
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>

                    <div className="metrics-business-card">
                      <div className="metrics-business-card__header">
                        <div className="metrics-business-card__title">Vehicle Financial Profiles</div>
                      </div>
                      <div className="metrics-business-profile-list">
                        {vehicleProfiles.map((profile) => (
                          <article
                            key={profile.vehicle_id}
                            className="metrics-business-profile"
                          >
                            <div className="metrics-business-profile__header">
                              <div>
                                <div className="metrics-business-profile__title">
                                  {profile.vehicle_name}
                                </div>
                                <div className="metrics-business-profile__meta">
                                  {buildYearMakeModel(profile) || "Vehicle"} · Turo ID{" "}
                                  {profile.turo_vehicle_id || "--"} · Odo{" "}
                                  {formatNumber(profile.current_odometer_miles ?? 0)}
                                </div>
                                <div className="metrics-business-profile__summary">
                                  Cash layout {formatCurrencyCompact(
                                    profile.derived_startup_total ?? profile.purchase_price
                                  )} · Tax{" "}
                                  {formatCurrencyCompact(profile.derived_startup_tax_total)} · Loan{" "}
                                  {formatCurrencyCompact(profile.loan_balance)} · Insurance{" "}
                                  {formatCurrencyCompact(profile.insurance_monthly)}/mo · Service{" "}
                                  {formatBusinessInputDate(profile.placed_in_service_date)}
                                </div>
                              </div>
                              <div className="metrics-business-card__actions">
                                <button
                                  type="button"
                                  className="metrics-inline-button"
                                  onClick={() => toggleBusinessProfile(profile.vehicle_id)}
                                >
                                  {expandedBusinessProfiles[profile.vehicle_id]
                                    ? "Collapse"
                                    : "Edit"}
                                </button>
                                <button
                                  type="button"
                                  className="metrics-inline-button"
                                  onClick={() => handleSaveVehicleProfile(profile)}
                                  disabled={savingVehicleId === Number(profile.vehicle_id)}
                                >
                                  {savingVehicleId === Number(profile.vehicle_id)
                                    ? "Saving..."
                                    : "Save vehicle"}
                                </button>
                              </div>
                            </div>
                            {expandedBusinessProfiles[profile.vehicle_id] ? (
                              <div className="metrics-business-grid">
                                <label className="metrics-business-field">
                                  <span>Cash Layout From Expenses</span>
                                  <input
                                    value={formatInputValue(
                                      formatCurrencyCompact(
                                        profile.derived_startup_total ?? profile.purchase_price
                                      )
                                    )}
                                    readOnly
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Onboard Tax From Expenses</span>
                                  <input
                                    value={formatInputValue(
                                      formatCurrencyCompact(profile.derived_startup_tax_total)
                                    )}
                                    readOnly
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Purchase Date</span>
                                  <input
                                    type="date"
                                    value={formatInputValue(profile.purchase_date)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "purchase_date",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Placed In Service</span>
                                  <input
                                    type="date"
                                    value={formatInputValue(profile.placed_in_service_date)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "placed_in_service_date",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Miles At Purchase</span>
                                  <input
                                    value={formatInputValue(profile.mileage_at_purchase)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "mileage_at_purchase",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Loan Balance</span>
                                  <input
                                    value={formatInputValue(profile.loan_balance)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "loan_balance",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Monthly Payment</span>
                                  <input
                                    value={formatInputValue(profile.monthly_payment)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "monthly_payment",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Interest Rate</span>
                                  <input
                                    value={formatInputValue(profile.interest_rate)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "interest_rate",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Insurance / Month</span>
                                  <input
                                    value={formatInputValue(profile.insurance_monthly)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "insurance_monthly",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Tracker / Month</span>
                                  <input
                                    value={formatInputValue(profile.tracker_monthly)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "tracker_monthly",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Registration / Year</span>
                                  <input
                                    value={formatInputValue(profile.registration_annual)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "registration_annual",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Inspection / Year</span>
                                  <input
                                    value={formatInputValue(profile.inspection_annual)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "inspection_annual",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Target Min Daily Rate</span>
                                  <input
                                    value={formatInputValue(profile.target_min_daily_rate)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "target_min_daily_rate",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Target Utilization</span>
                                  <input
                                    value={formatInputValue(profile.target_utilization)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "target_utilization",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field">
                                  <span>Owner Hourly Override</span>
                                  <input
                                    value={formatInputValue(
                                      profile.owner_hourly_rate_override
                                    )}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "owner_hourly_rate_override",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                                <label className="metrics-business-field metrics-business-field--full">
                                  <span>Notes</span>
                                  <textarea
                                    rows={2}
                                    value={formatInputValue(profile.notes)}
                                    onChange={(e) =>
                                      updateVehicleProfile(
                                        profile.vehicle_id,
                                        "notes",
                                        e.target.value
                                      )
                                    }
                                  />
                                </label>
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              ) : null}
            </div>
          </section>

          <VehicleFinancialDrawer
            open={financialDetailOpen}
            loading={financialDetailLoading}
            error={financialDetailError}
            detail={financialDetail}
            focus={financialDetailFocus}
            onClose={closeFinancialDetail}
          />

          {laborRemediationOpen ? (
            <div className="metrics-remediation-backdrop" role="presentation">
              <aside
                className="metrics-remediation-drawer"
                role="dialog"
                aria-modal="true"
                aria-label="Fix maintenance labor hours"
              >
                <div className="metrics-remediation-header">
                  <div>
                    <div className="metrics-remediation-title">
                      Maintenance Labor Hours
                    </div>
                    <div className="metrics-remediation-subtitle">
                      {laborRemediation?.vehicle?.name || "Vehicle"} items missing
                      labor estimates
                    </div>
                  </div>
                  <button
                    type="button"
                    className="metrics-remediation-close"
                    onClick={() => setLaborRemediationOpen(false)}
                    aria-label="Close labor hours drawer"
                  >
                    x
                  </button>
                </div>

                {laborRemediationLoading ? (
                  <div className="metrics-financial-empty">
                    Loading missing labor items...
                  </div>
                ) : laborRemediationError ? (
                  <div className="metrics-remediation-error">
                    {laborRemediationError}
                  </div>
                ) : null}

                {!laborRemediationLoading &&
                !laborRemediationError &&
                !(laborRemediation?.items || []).length ? (
                  <div className="metrics-financial-empty">
                    All labor hours are filled in for this vehicle.
                  </div>
                ) : null}

                <div className="metrics-remediation-list">
                  {(laborRemediation?.items || []).map((item) => {
                    const key = `${item.kind}:${item.id}`;
                    const isSaving = savingLaborItemKey === key;
                    return (
                      <article className="metrics-remediation-item" key={key}>
                        <div className="metrics-remediation-item-top">
                          <div>
                            <div className="metrics-remediation-item-title">
                              {item.title}
                            </div>
                            <div className="metrics-remediation-item-meta">
                              {item.kind === "event" ? "History" : "Task"} -{" "}
                              {item.status || item.taskType || "maintenance"} -{" "}
                              {formatMetricDateTime(item.occurredAt)}
                            </div>
                          </div>
                          {item.suggestedHours != null ? (
                            <span className="metrics-remediation-chip">
                              suggested {formatNumber(item.suggestedHours, 2)}h
                            </span>
                          ) : null}
                        </div>

                        {item.description || item.notes ? (
                          <div className="metrics-remediation-note">
                            {item.description || item.notes}
                          </div>
                        ) : null}

                        <div className="metrics-remediation-controls">
                          <label>
                            Hours
                            <input
                              type="number"
                              min="0"
                              step="0.05"
                              value={laborRemediationDrafts[key] ?? ""}
                              onChange={(event) =>
                                updateLaborDraft(item, event.target.value)
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="metrics-inline-button"
                            onClick={() => handleSaveMissingLabor(item)}
                            disabled={isSaving}
                          >
                            {isSaving ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </aside>
            </div>
          ) : null}

          <ExpenseModal
            open={expenseModalOpen}
            expense={editingExpense}
            selectedVehicleId={editingExpense?.vehicle_id ?? null}
            onClose={closeExpenseModal}
            onSaved={handleExpenseSaved}
          />
        </>
      )}
    </div>
  );
}

