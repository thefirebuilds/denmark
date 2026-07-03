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
  const revenuePerMile = Number(vehicle?.revenue_per_mile ?? 0);
  const profitPerMile = Number(vehicle?.profit_per_mile ?? 0);
  const totalMiles = Number(vehicle?.total_miles ?? vehicle?.total_miles_basis ?? 0);
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
          <div className="vehicle-card__stat-label">Revenue / Mile</div>
          <div className="vehicle-card__stat-value">
            {formatCurrencyCompact(revenuePerMile)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Profit / Mile</div>
          <div className="vehicle-card__stat-value">
            {formatCurrencyCompact(profitPerMile)}
          </div>
        </div>

        <div className="vehicle-card__stat">
          <div className="vehicle-card__stat-label">Miles</div>
          <div className="vehicle-card__stat-value">
            {formatNumber(totalMiles)}
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
