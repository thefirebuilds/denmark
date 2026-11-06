import { revenueSpendStats } from '../../utils/revenueSpendStats';
const currency = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export default function RevenueSpendProgress({ report, status }) {
  const stats = revenueSpendStats(report);
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
    <details className="recovery-meter-details"><summary>What’s included</summary>
      <p>All-time revenue and expense-ledger totals using the existing Metrics calculation. Spend includes tax and capitalized entries, net of refunds. Vehicle purchases are included only when recorded as expenses; capital basis is not added again.</p>
      {report?._report?.calculated_at && <p>Updated {new Date(report._report.calculated_at).toLocaleString()}{report._report.stale ? ' (saved report awaiting refresh)' : ''}.</p>}
    </details>
  </section>;
}
