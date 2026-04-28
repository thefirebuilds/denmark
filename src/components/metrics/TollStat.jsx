//----------------------------------------------
// /src/components/metrics/TollStat.jsx
//----------------------------------------------

export default function TollStat({
  label,
  value,
  tone = "default",
  emphasis = "normal",
  onClick = null,
}) {
  const className =
    `toll-stat toll-stat--${tone} toll-stat--${emphasis}` +
    (typeof onClick === "function" ? " toll-stat--interactive" : "");

  const content = (
    <>
      <div className="toll-stat__label">{label}</div>
      <div className="toll-stat__value">{value}</div>
    </>
  );

  if (typeof onClick === "function") {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
    >
      {content}
    </div>
  );
}
