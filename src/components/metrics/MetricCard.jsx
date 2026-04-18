//----------------------------------------------
// /src/components/metrics/MetricCard.jsx
//----------------------------------------------

export default function MetricCard({
  label,
  value,
  tone = "default",
  subtitle = null,
}) {
  return (
    <div className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__value">{value}</div>
      {subtitle ? <div className="metric-card__subtitle">{subtitle}</div> : null}
    </div>
  );
}