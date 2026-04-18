//----------------------------------------------
// /src/components/metrics/VehicleCard.jsx
//----------------------------------------------

export default function VehicleCard({
  vehicle,
  formatCurrency,
  formatCurrencyCompact,
  formatNumber,
}) {
  const netProfit = Number(vehicle?.net_profit ?? 0);
  const incomePerBookedDay = Number(vehicle?.income_per_booked_day ?? 0);
  const incomePerTrip = Number(vehicle?.income_per_overlapping_trip ?? 0);
  const tripCount = Number(vehicle?.trip_count_overlapping ?? 0);
  const bookedDays = Number(vehicle?.booked_vehicle_days ?? 0);

  return (
    <article className="vehicle-card">
      <div className="vehicle-card__header">
        <div className="vehicle-card__identity">
          <div className="vehicle-card__name">
            {vehicle?.nickname || "Unnamed vehicle"}
          </div>

          <div className="vehicle-card__meta">
            {vehicle?.vin || "No VIN"}
          </div>
        </div>
      </div>

      <div
        className={`vehicle-card__profit ${
          netProfit >= 0
            ? "vehicle-card__profit--positive"
            : "vehicle-card__profit--negative"
        }`}
      >
        {formatCurrency(netProfit)}
      </div>

      <div className="vehicle-card__profit-label">Net profit</div>

      <div className="vehicle-card__stats">
        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Revenue</div>
          <div className="vehicle-card__stat-value">
            {formatCurrency(vehicle?.trip_income)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Expenses</div>
          <div className="vehicle-card__stat-value">
            {formatCurrency(vehicle?.total_expenses)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Rev / Booked Day</div>
          <div className="vehicle-card__stat-value">
            {formatCurrencyCompact(incomePerBookedDay)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Rev / Trip</div>
          <div className="vehicle-card__stat-value">
            {formatCurrencyCompact(incomePerTrip)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Trips</div>
          <div className="vehicle-card__stat-value">
            {formatNumber(tripCount)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Booked Days</div>
          <div className="vehicle-card__stat-value">
            {formatNumber(bookedDays)}
          </div>
        </div>
      </div>
    </article>
  );
}