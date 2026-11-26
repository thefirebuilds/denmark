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

export function dailySpendGap(report, trends) {
  if (trends?.granularity !== 'day' || !Array.isArray(trends.points)) return [];

  if (trends.range === 'daily-all') {
    let gapCents = 0;
    const points = [];
    for (const day of trends.points) {
      const changeCents = getDailyGapChangeCents(day);
      if (changeCents == null) return [];
      gapCents += changeCents;
      points.push({ label: day.label, gap: gapCents / 100, change: changeCents / 100 });
    }
    return points;
  }

  const totals = revenueSpendStats(report);
  const reportDay = report?._report?.calculated_at?.slice(0, 10);
  const trendDay = trends?._report?.calculated_at?.slice(0, 10);
  if (!totals || !reportDay || reportDay !== trendDay) return [];

  let gapCents = Math.round(-totals.net * 100);
  const points = [];
  for (const day of [...trends.points].reverse()) {
    const changeCents = getDailyGapChangeCents(day);
    if (changeCents == null) return [];
    points.push({ label: day.label, gap: gapCents / 100, change: changeCents / 100 });
    gapCents -= changeCents;
  }
  return points.reverse();
}

function getDailyGapChangeCents(day) {
  if (day.revenue == null || day.expenses == null) return null;
  const changeCents = Math.round((Number(day.expenses) - Number(day.revenue)) * 100);
  return Number.isFinite(changeCents) ? changeCents : null;
}

export function selectSpendGapRange(points, range) {
  if (range === 'all' || !points.length) return points;
  if (range !== '12mo') return points.slice(-Number.parseInt(range, 10));

  const latest = new Date(`${points.at(-1).label}T00:00:00Z`);
  const anniversary = new Date(Date.UTC(latest.getUTCFullYear() - 1, latest.getUTCMonth(), 1));
  const lastDay = new Date(Date.UTC(anniversary.getUTCFullYear(), anniversary.getUTCMonth() + 1, 0)).getUTCDate();
  anniversary.setUTCDate(Math.min(latest.getUTCDate(), lastDay));
  const cutoff = anniversary.toISOString().slice(0, 10);
  return points.filter(point => point.label > cutoff);
}
