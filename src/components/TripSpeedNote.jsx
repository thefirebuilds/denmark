const TOS_SPEED_THRESHOLD_MPH = 80;

export default function TripSpeedNote({ trip }) {
  const maxSpeed = Number(trip?.max_speed_mph);
  const overThresholdCount = Number(trip?.speed_over_80_count);
  const hasSpeed = Number.isFinite(maxSpeed) && maxSpeed >= 0;
  const likelyTosViolation =
    (hasSpeed && maxSpeed > TOS_SPEED_THRESHOLD_MPH) ||
    (Number.isFinite(overThresholdCount) && overThresholdCount > 0);

  return (
    <div
      className={`trip-speed-note${likelyTosViolation ? " is-violation" : ""}`}
      role={likelyTosViolation ? "alert" : undefined}
    >
      <span>
        Telemetry max speed: {hasSpeed ? `${Math.round(maxSpeed)} mph` : "unavailable"}
      </span>
      {likelyTosViolation ? (
        <span>Likely TOS violation (over 80 mph)</span>
      ) : hasSpeed ? (
        <span>No likely speed-related TOS violation</span>
      ) : null}
    </div>
  );
}

