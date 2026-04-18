//----------------------------------------------
// /src/components/metrics/TollStat.jsx
//----------------------------------------------

export default function TollStat({
  label,
  value,
  tone = "default",
  emphasis = "normal",
}) {
  return (
    <div
      className={`toll-stat toll-stat--${tone} toll-stat--${emphasis}`}
    >
      <div className="toll-stat__label">{label}</div>
      <div className="toll-stat__value">{value}</div>
    </div>
  );
}