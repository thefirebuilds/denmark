// ------------------------------------------------------------
// /server/services/metrics/capitalMetricsService.js
// All-time capital basis + all-time capital recovery by vehicle.
// Mirrors /api/expenses/capital-basis for onboarding basis.
// ------------------------------------------------------------

const pool = require("../../db");

async function getCapitalMetricsByVehicle(client = null) {
  const runner = client || pool;

  const query = `
    WITH capital_basis_by_vehicle AS (
      SELECT
        v.id AS vehicle_id,
        COALESCE(
          SUM(
            CASE
              WHEN e.is_capitalized = true
               AND e.category = 'Vehicle Onboard'
              THEN COALESCE(e.price, 0) + COALESCE(e.tax, 0)
              ELSE 0
            END
          ),
          0
        ) AS onboarding_expenses
      FROM vehicles v
      LEFT JOIN expenses e
        ON e.vehicle_id = v.id
      GROUP BY v.id
    ),
    lifetime_trip_recovery AS (
      SELECT
        v.id AS vehicle_id,
        COALESCE(SUM(COALESCE(t.amount, 0)), 0) AS capital_recovered,
        MIN(t.trip_start) AS onboarding_date
      FROM vehicles v
      LEFT JOIN trips t
        ON CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
       AND (
         t.canceled_at IS NULL
         OR COALESCE(t.amount, 0) > 0
       )
      GROUP BY v.id
    )
    SELECT
      v.id AS vehicle_id,
      COALESCE(cb.onboarding_expenses, 0) AS onboarding_expenses,
      COALESCE(cb.onboarding_expenses, 0) AS capital_basis,
      COALESCE(ltr.capital_recovered, 0) AS capital_recovered,
      GREATEST(
        COALESCE(cb.onboarding_expenses, 0) - COALESCE(ltr.capital_recovered, 0),
        0
      ) AS capital_remaining,
      CASE
        WHEN COALESCE(cb.onboarding_expenses, 0) <= 0 THEN 0
        ELSE ROUND(
          LEAST(
            (COALESCE(ltr.capital_recovered, 0) / NULLIF(cb.onboarding_expenses, 0)) * 100,
            100
          )::numeric,
          1
        )
      END AS capital_recovery_pct,
      CASE
        WHEN COALESCE(cb.onboarding_expenses, 0) <= 0 THEN 'no_basis'
        WHEN COALESCE(ltr.capital_recovered, 0) >= COALESCE(cb.onboarding_expenses, 0) THEN 'paid_off'
        ELSE 'in_progress'
      END AS capital_status,
      ltr.onboarding_date
    FROM vehicles v
    LEFT JOIN capital_basis_by_vehicle cb
      ON cb.vehicle_id = v.id
    LEFT JOIN lifetime_trip_recovery ltr
      ON ltr.vehicle_id = v.id
    WHERE v.is_active = true
      AND v.in_service = true
    ORDER BY v.id
  `;

  const { rows } = await runner.query(query);
  return rows;
}



module.exports = {
  getCapitalMetricsByVehicle,
};
