// Missing reports must not look like zero spend or completed cost recovery.
export function revenueSpendStats(report) {
  if (report?.revenue == null || report?.expenses == null) return null;
  const revenue = Number(report.revenue);
  const spend = Number(report.expenses);
  if (!Number.isFinite(revenue) || !Number.isFinite(spend)) return null;
  const coveragePct = spend > 0 ? revenue / spend * 100 : null;
  return { revenue, spend, net: revenue - spend, coveragePct,
    fillPct: coveragePct == null ? 0 : Math.max(0, Math.min(100, coveragePct)) };
}

export function spendPayoffOutlook(report, paceReport, now = Date.now()) {
  const totals = revenueSpendStats(report);
  if (!totals) return null;
  const pace = revenueSpendStats(paceReport);
  const days = Number(paceReport?.calendar_days);
  const dailyNet = pace && Number.isFinite(days) && days > 0 ? pace.net / days : null;
  const monthlyNet = dailyNet == null ? null : dailyNet * 30.4375;
  if (totals.net >= 0) return { status: 'covered', monthlyNet, breakEvenDate: null };
  if (dailyNet == null) return { status: 'unavailable', monthlyNet, breakEvenDate: null };
  if (dailyNet <= 0) return { status: 'not_recovering', monthlyNet, breakEvenDate: null };
  const estimate = new Date(now + (-totals.net / dailyNet) * 86400000);
  return { status: Number.isFinite(estimate.getTime()) ? 'projected' : 'unavailable', monthlyNet,
    breakEvenDate: Number.isFinite(estimate.getTime()) ? estimate.toISOString() : null };
}
