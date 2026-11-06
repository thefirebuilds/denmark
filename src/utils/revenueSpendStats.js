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
