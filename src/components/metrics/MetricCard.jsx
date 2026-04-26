//----------------------------------------------
// /src/components/metrics/MetricCard.jsx
//----------------------------------------------

export default function MetricCard({
  label,
  value,
  tone = "default",
  subtitle = null,
  onClick = null,
}) {
  const clickable = typeof onClick === "function";

  return (
    <div
      className={`metric-card metric-card--${tone} ${
        clickable ? "metric-card--clickable" : ""
      }`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__value">{value}</div>
      {subtitle ? <div className="metric-card__subtitle">{subtitle}</div> : null}
    </div>
  );
}
