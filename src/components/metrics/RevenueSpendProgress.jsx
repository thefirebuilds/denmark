import { revenueSpendStats, spendPayoffOutlook } from '../../utils/revenueSpendStats';
const currency = value => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export default function RevenueSpendProgress({ report, status, paceReport }) {
  const stats = revenueSpendStats(report);
  const outlook = spendPayoffOutlook(report, paceReport);
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
