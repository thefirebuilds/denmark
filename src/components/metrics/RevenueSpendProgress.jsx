import { useMemo, useState } from 'react';
import FleetTrendChart from './FleetTrendChart';
import { dailySpendGap, revenueSpendStats, selectSpendGapRange, spendPayoffOutlook } from '../../utils/revenueSpendStats';
const currency = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const gapCurrency = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const gapSeries = [{ key: 'gap', label: 'Spend minus revenue', color: '#60a5fa', format: gapCurrency }];
const gapRanges = { '30d': '30 days', '90d': '90 days', '180d': '180 days', '12mo': '12 months', all: 'All time' };
const describeChange = change => change === 0 ? 'Gap held steady' : `Gap ${change > 0 ? 'widened' : 'narrowed'} by ${gapCurrency(Math.abs(change))}`;

export default function RevenueSpendProgress({ report, status, paceReport, trends }) {
  const [gapRange, setGapRange] = useState('90d');
  const stats = revenueSpendStats(report);
  const outlook = spendPayoffOutlook(report, paceReport);
  const history = useMemo(() => dailySpendGap(report, trends), [report, trends]);
  const gapPoints = useMemo(() => selectSpendGapRange(history, gapRange), [history, gapRange]);
  const latestGap = gapPoints.at(-1);
  const outlookLabel = outlook?.status === 'covered' ? 'Break-even reached'
    : outlook?.status === 'projected' ? new Date(outlook.breakEvenDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : outlook?.status === 'not_recovering' ? 'No break-even at this pace' : 'Need pace data';
  return <section className="capital-basis-progress revenue-spend-progress" aria-label="All-time revenue versus recorded spend">
    <div className="capital-basis-progress__header">
      <div>
        <div className="capital-basis-progress__eyebrow">Revenue vs. Total Spend <span>All time</span></div>
        <div className="capital-basis-progress__title">{stats ? `${currency(stats.revenue)} revenue / ${currency(stats.spend)} spent` : 'Waiting for saved totals'}</div>
      </div>
      <div className="capital-basis-progress__percent">{stats?.coveragePct != null ? `${Math.round(stats.coveragePct)}%` : '--'}</div>
    </div>
    <div className="capital-basis-progress__track" role="progressbar" aria-label="Recorded spend covered by revenue" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stats?.coveragePct == null ? undefined : Math.round(stats.fillPct)} aria-valuetext={stats?.coveragePct != null ? `${Math.round(stats.coveragePct)} percent of recorded spend covered` : 'Coverage unavailable'}>
      <div className="capital-basis-progress__fill" style={{ width: `${stats?.fillPct || 0}%` }} />
    </div>
    <div className="capital-basis-progress__footer">
      {stats ? <span><strong className={stats.net >= 0 ? 'revenue-spend-positive' : 'revenue-spend-negative'}>{currency(Math.abs(stats.net))}</strong>{stats.net >= 0 ? 'Above spend' : 'Still to cover'}</span> : <span>{status?.pending ? 'Preparing the first all-time report' : 'Totals temporarily unavailable'}</span>}
      {stats && <span>Revenue / recorded spend</span>}
    </div>
    <label className="revenue-spend-range">
      History range
      <select className="metrics-toolbar__select" value={gapRange} onChange={event => setGapRange(event.target.value)}>
        {Object.entries(gapRanges).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    {latestGap ? <FleetTrendChart title="Daily Spend Gap" subtitle={`${describeChange(latestGap.change)} on the latest day`}
      points={gapPoints} series={gapSeries} fitValues
      detail={point => describeChange(point.change)}
      definition="Estimated all-time spend minus revenue. Starts from the saved all-time gap and works backward using daily recorded revenue and expenses. A falling line means revenue is catching up with spending. Negative values mean revenue is ahead."
      footer={`${gapRanges[gapRange]} · Latest day may be partial`} />
      : <p>Daily spend gap history needs all-time totals and daily trends from the same reporting day.</p>}
    <details className="recovery-meter-details"><summary>Payoff outlook</summary>
      <div className="capital-basis-progress__ticker revenue-spend-outlook">
        <span><strong>{outlookLabel}</strong>Expected break even</span>
        <span><strong>{outlook?.monthlyNet != null ? outlook.monthlyNet.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '--'}</strong>Monthly net pace</span>
      </div>
      <p>Uses trailing 30-day revenue minus all recorded expenses, scaled to a month. Projects the current shortfall at that net pace; continued spending reduces recovery. New purchases or changes in revenue can move the date.</p>
      {paceReport?._report?.calculated_at && <p>Pace updated {new Date(paceReport._report.calculated_at).toLocaleString()}{paceReport._report.stale ? ' (saved report awaiting refresh)' : ''}.</p>}
    </details>
    <details className="recovery-meter-details"><summary>What's included</summary>
      <p>All-time revenue and expense-ledger totals using the existing Metrics calculation. Spend includes tax and capitalized entries, net of refunds. Vehicle purchases are included only when recorded as expenses; capital basis is not added again.</p>
      {report?._report?.calculated_at && <p>Updated {new Date(report._report.calculated_at).toLocaleString()}{report._report.stale ? ' (saved report awaiting refresh)' : ''}.</p>}
    </details>
  </section>;
}
