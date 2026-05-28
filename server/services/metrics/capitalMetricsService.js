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
        COALESCE(
          SUM(COALESCE(t.amount, 0)) FILTER (
            WHERE (
                t.trip_end <= NOW()
                OR (
                  t.canceled_at <= NOW()
                  AND COALESCE(t.amount, 0) > 0
                )
              )
              AND (
                t.canceled_at IS NULL
                OR COALESCE(t.amount, 0) > 0
              )
          ),
          0
        ) AS capital_recovered,
        COALESCE(
          SUM(COALESCE(t.amount, 0)) FILTER (
            WHERE t.trip_end > NOW()
              AND (
                LOWER(COALESCE(t.workflow_stage, '')) NOT IN ('canceled', 'cancelled')
                AND LOWER(COALESCE(t.status, '')) NOT IN ('canceled', 'cancelled')
                AND t.canceled_at IS NULL
              )
          ),
          0
        ) AS capital_booked_future,
        COUNT(*) FILTER (
          WHERE (
              t.trip_end <= NOW()
              OR (
                t.canceled_at <= NOW()
                AND COALESCE(t.amount, 0) > 0
              )
            )
            AND COALESCE(t.amount, 0) > 0
            AND (
              t.canceled_at IS NULL
              OR COALESCE(t.amount, 0) > 0
            )
        )::int AS capital_recovered_trip_count,
        COUNT(*) FILTER (
          WHERE t.trip_end > NOW()
            AND COALESCE(t.amount, 0) > 0
            AND (
              LOWER(COALESCE(t.workflow_stage, '')) NOT IN ('canceled', 'cancelled')
              AND LOWER(COALESCE(t.status, '')) NOT IN ('canceled', 'cancelled')
              AND t.canceled_at IS NULL
            )
        )::int AS capital_booked_future_trip_count,
        MIN(t.trip_start) FILTER (
          WHERE t.trip_end > NOW()
            AND COALESCE(t.amount, 0) > 0
            AND (
              LOWER(COALESCE(t.workflow_stage, '')) NOT IN ('canceled', 'cancelled')
              AND LOWER(COALESCE(t.status, '')) NOT IN ('canceled', 'cancelled')
              AND t.canceled_at IS NULL
            )
        ) AS capital_booked_future_first_trip_start,
        MAX(t.trip_end) FILTER (
          WHERE t.trip_end > NOW()
            AND COALESCE(t.amount, 0) > 0
            AND (
              LOWER(COALESCE(t.workflow_stage, '')) NOT IN ('canceled', 'cancelled')
              AND LOWER(COALESCE(t.status, '')) NOT IN ('canceled', 'cancelled')
              AND t.canceled_at IS NULL
            )
        ) AS capital_booked_future_last_trip_end,
        MIN(t.trip_start) FILTER (
          WHERE t.canceled_at IS NULL
             OR COALESCE(t.amount, 0) > 0
        ) AS onboarding_date
      FROM vehicles v
      LEFT JOIN trips t
        ON CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
      GROUP BY v.id
    )
    SELECT
      v.id AS vehicle_id,
      COALESCE(cb.onboarding_expenses, 0) AS onboarding_expenses,
      COALESCE(cb.onboarding_expenses, 0) AS capital_basis,
      COALESCE(ltr.capital_recovered, 0) AS capital_recovered,
      COALESCE(ltr.capital_booked_future, 0) AS capital_booked_future,
      COALESCE(ltr.capital_recovered_trip_count, 0) AS capital_recovered_trip_count,
      COALESCE(ltr.capital_booked_future_trip_count, 0) AS capital_booked_future_trip_count,
      ltr.capital_booked_future_first_trip_start,
      ltr.capital_booked_future_last_trip_end,
      GREATEST(
        COALESCE(cb.onboarding_expenses, 0) - COALESCE(ltr.capital_recovered, 0),
        0
      ) AS capital_remaining,
      GREATEST(
        COALESCE(cb.onboarding_expenses, 0)
          - COALESCE(ltr.capital_recovered, 0)
          - COALESCE(ltr.capital_booked_future, 0),
        0
      ) AS capital_remaining_after_booked,
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
