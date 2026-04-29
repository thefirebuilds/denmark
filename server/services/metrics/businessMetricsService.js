const pool = require("../../db");
const {
  getDateRange,
  getOverlapDays,
  getTripProratedAmount,
  getTripProratedValue,
  roundMoney,
  roundNumber,
  safeDivide,
  toNumber,
  tripOverlapsRange,
  getCalendarDaysInRange,
} = require("./metricHelpers");
const { getVehicleMetrics } = require("./vehicleMetricsService");

let ensureBusinessMetricsTablesPromise = null;

const DEFAULT_BUSINESS_SETTINGS = {
  owner_cash_invested: null,
  loan_401k_amount: null,
  other_business_loan_amount: null,
  current_cash_reserve: null,
  monthly_software_costs: 0,
  monthly_hosting_costs: 0,
  monthly_notification_costs: 0,
  bookkeeping_tax_costs: 0,
  tools_equipment_costs: 0,
  target_owner_hourly_rate: 35,
  target_minimum_monthly_profit_per_car: 300,
  target_cash_on_cash_return: 0.2,
  target_payback_period_months: 24,
};

function normalizeText(value) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function normalizeNumberOrNull(value) {
  if (value === "" || value == null) return null;
  const cleaned = String(value).replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeDateOrNull(value) {
  if (value === "" || value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function monthEquivalentForRange(startDate, endDate) {
  const days = getCalendarDaysInRange(startDate, endDate);
  return days > 0 ? days / 30.4375 : 1;
}

function getCurrentQuarterRange(now = new Date()) {
  const month = now.getMonth();
  const quarterStartMonth = Math.floor(month / 3) * 3;
  const start = new Date(now.getFullYear(), quarterStartMonth, 1);
  const end = new Date(now.getFullYear(), quarterStartMonth + 3, 0, 23, 59, 59, 999);
  return { start, end };
}

function getPreviousQuarterRange(now = new Date()) {
  const current = getCurrentQuarterRange(now);
  const previousEnd = new Date(current.start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  previousEnd.setHours(23, 59, 59, 999);
  return getCurrentQuarterRange(previousEnd);
}

function formatQuarterKey(date) {
  const d = new Date(date);
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${quarter}`;
}

function toDateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function classifyExpense(expense) {
  const category = String(expense?.category || "").trim().toLowerCase();
  const vendor = String(expense?.vendor || "").trim().toLowerCase();
  const capitalized = expense?.is_capitalized === true;

  if (capitalized || category === "vehicle onboard") return "startup";
  if (category.includes("insurance")) return "fixed_overhead";
  if (category.includes("registration")) return "compliance";
  if (category.includes("inspection")) return "compliance";
  if (category.includes("tolls") || vendor.includes("hctra")) return "tolls";
  if (
    category.includes("maintenance") ||
    category.includes("oil") ||
    category.includes("filter") ||
    category.includes("cleaning")
  ) {
    return "maintenance";
  }
  if (
    category.includes("repair") ||
    category.includes("tire") ||
    category.includes("brake") ||
    category.includes("battery")
  ) {
    return "repair";
  }
  if (
    category.includes("improvement") ||
    category.includes("upgrade") ||
    category.includes("accessory")
  ) {
    return "improvement";
  }
  return "operating";
}

function prorateMonthlyAmount(amount, startDate, endDate) {
  return toNumber(amount) * monthEquivalentForRange(startDate, endDate);
}

function getConfidenceLabel(score) {
  if (score >= 0.85) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}

function summarizeFlags(flags) {
  const totals = { high: 0, medium: 0, low: 0 };
  for (const flag of flags) {
    const severity = String(flag?.severity || "").toLowerCase();
    if (totals[severity] != null) totals[severity] += 1;
  }
  return totals;
}

function buildVehicleRecommendation(vehicle, settings) {
  const profitAfterLabor = toNumber(vehicle.net_profit_after_labor);
  const monthlyProfit = toNumber(vehicle.monthly_profit_equivalent);
  const ownerHourProfit = toNumber(vehicle.profit_per_owner_hour);
  const utilization = toNumber(vehicle.utilization_rate);
  const downtime = toNumber(vehicle.days_down_for_maintenance);
  const confidence = String(vehicle.data_confidence || "low");
  const targetMonthly = toNumber(
    settings.target_minimum_monthly_profit_per_car,
    300
  );
  const targetHourly = toNumber(settings.target_owner_hourly_rate, 35);

  if (confidence === "low") return "INSUFFICIENT DATA";
  if (profitAfterLabor < -200 || monthlyProfit < 0) return "SELL / EXIT";
  if (downtime >= 7 || ownerHourProfit < targetHourly * 0.5) return "WATCH";
  if (utilization >= 0.75 && monthlyProfit >= targetMonthly && ownerHourProfit >= targetHourly) {
    return "SCALE TYPE";
  }
  if (monthlyProfit >= targetMonthly * 0.6) return "KEEP";
  return "OPTIMIZE";
}

async function ensureBusinessMetricsTables(client = pool) {
  if (!ensureBusinessMetricsTablesPromise) {
    ensureBusinessMetricsTablesPromise = (async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.vehicle_financial_profiles (
          id BIGSERIAL PRIMARY KEY,
          vehicle_id BIGINT NOT NULL UNIQUE REFERENCES public.vehicles(id) ON DELETE CASCADE,
          purchase_price NUMERIC(10,2),
          purchase_date DATE,
          placed_in_service_date DATE,
          mileage_at_purchase INTEGER,
          loan_balance NUMERIC(10,2),
          monthly_payment NUMERIC(10,2),
          interest_rate NUMERIC(6,4),
          insurance_monthly NUMERIC(10,2),
          tracker_monthly NUMERIC(10,2),
          registration_annual NUMERIC(10,2),
          inspection_annual NUMERIC(10,2),
          target_min_daily_rate NUMERIC(10,2),
          target_utilization NUMERIC(6,4),
          owner_hourly_rate_override NUMERIC(10,2),
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.business_financial_settings (
          id BIGSERIAL PRIMARY KEY,
          owner_cash_invested NUMERIC(12,2),
          loan_401k_amount NUMERIC(12,2),
          other_business_loan_amount NUMERIC(12,2),
          current_cash_reserve NUMERIC(12,2),
          monthly_software_costs NUMERIC(10,2),
          monthly_hosting_costs NUMERIC(10,2),
          monthly_notification_costs NUMERIC(10,2),
          bookkeeping_tax_costs NUMERIC(10,2),
          tools_equipment_costs NUMERIC(10,2),
          target_owner_hourly_rate NUMERIC(10,2),
          target_minimum_monthly_profit_per_car NUMERIC(10,2),
          target_cash_on_cash_return NUMERIC(8,4),
          target_payback_period_months INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.trip_financial_facts (
          id BIGSERIAL PRIMARY KEY,
          trip_id INTEGER NOT NULL UNIQUE REFERENCES public.trips(id) ON DELETE CASCADE,
          reservation_id BIGINT NOT NULL,
          vehicle_id BIGINT REFERENCES public.vehicles(id) ON DELETE SET NULL,
          host_payout NUMERIC(10,2),
          delivery_fee_collected NUMERIC(10,2),
          extras_collected NUMERIC(10,2),
          tolls_collected NUMERIC(10,2),
          fuel_reimbursed NUMERIC(10,2),
          cleaning_reimbursed NUMERIC(10,2),
          smoking_reimbursed NUMERIC(10,2),
          actual_tolls NUMERIC(10,2),
          actual_fuel_cost NUMERIC(10,2),
          actual_cleaning_cost NUMERIC(10,2),
          owner_cleaning_minutes INTEGER,
          owner_delivery_minutes INTEGER,
          owner_admin_minutes INTEGER,
          miles_added INTEGER,
          guest_rating NUMERIC(3,2),
          issue_flag BOOLEAN NOT NULL DEFAULT FALSE,
          reimbursement_status TEXT,
          claim_status TEXT,
          data_confidence TEXT,
          source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.metric_period_snapshots (
          id BIGSERIAL PRIMARY KEY,
          period_key TEXT NOT NULL UNIQUE,
          period_type TEXT NOT NULL,
          range_start DATE NOT NULL,
          range_end DATE NOT NULL,
          summary JSONB NOT NULL,
          data_confidence TEXT,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.vehicle_period_snapshots (
          id BIGSERIAL PRIMARY KEY,
          snapshot_id BIGINT NOT NULL REFERENCES public.metric_period_snapshots(id) ON DELETE CASCADE,
          vehicle_id BIGINT REFERENCES public.vehicles(id) ON DELETE SET NULL,
          vehicle_name TEXT,
          recommendation_status TEXT,
          data_confidence TEXT,
          metrics JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.metric_data_quality_flags (
          id BIGSERIAL PRIMARY KEY,
          period_key TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          flag_code TEXT NOT NULL,
          severity TEXT NOT NULL,
          confidence_penalty NUMERIC(6,4) NOT NULL DEFAULT 0,
          note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          resolved_at TIMESTAMPTZ
        );
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS public.ai_metric_reviews (
          id BIGSERIAL PRIMARY KEY,
          period_key TEXT NOT NULL,
          snapshot_id BIGINT REFERENCES public.metric_period_snapshots(id) ON DELETE SET NULL,
          review_kind TEXT NOT NULL DEFAULT 'quarterly',
          model TEXT,
          prompt_version TEXT,
          input_payload JSONB NOT NULL,
          output_json JSONB,
          summary TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_trip_financial_facts_vehicle_id
          ON public.trip_financial_facts (vehicle_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_metric_period_snapshots_period_type
          ON public.metric_period_snapshots (period_type, range_end DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_period_snapshots_snapshot_id
          ON public.vehicle_period_snapshots (snapshot_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_metric_data_quality_flags_period_key
          ON public.metric_data_quality_flags (period_key, entity_type, entity_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_ai_metric_reviews_period_key
          ON public.ai_metric_reviews (period_key, created_at DESC);
      `);
    })().catch((err) => {
      ensureBusinessMetricsTablesPromise = null;
      throw err;
    });
  }

  await ensureBusinessMetricsTablesPromise;
}

async function syncTripFinancialFacts(client = pool) {
  await client.query(`
    INSERT INTO trip_financial_facts (
      trip_id,
      reservation_id,
      vehicle_id,
      host_payout,
      tolls_collected,
      fuel_reimbursed,
      actual_tolls,
      miles_added,
      reimbursement_status,
      data_confidence,
      source_payload,
      created_at,
      updated_at
    )
    SELECT
      t.id,
      t.reservation_id,
      v.id,
      COALESCE(t.amount, 0),
      COALESCE(t.toll_charged_total, t.toll_total, 0),
      COALESCE(t.fuel_reimbursement_total, 0),
      COALESCE(t.toll_total, 0),
      CASE
        WHEN t.starting_odometer IS NOT NULL
         AND t.ending_odometer IS NOT NULL
         AND t.ending_odometer >= t.starting_odometer
        THEN t.ending_odometer - t.starting_odometer
        ELSE NULL
      END,
      CASE
        WHEN COALESCE(t.toll_review_status, 'none') IN ('billed', 'waived')
          OR COALESCE(t.expense_status, 'none') IN ('resolved', 'waived')
        THEN 'resolved'
        WHEN COALESCE(t.toll_total, 0) > 0
          OR COALESCE(t.fuel_reimbursement_total, 0) > 0
        THEN 'pending'
        ELSE 'none'
      END,
      CASE
        WHEN t.amount IS NULL
          OR t.turo_vehicle_id IS NULL
          OR (t.starting_odometer IS NULL AND t.ending_odometer IS NULL)
        THEN 'medium'
        ELSE 'high'
      END,
      jsonb_build_object(
        'toll_review_status', t.toll_review_status,
        'expense_status', t.expense_status,
        'workflow_stage', t.workflow_stage
      ),
      NOW(),
      NOW()
    FROM trips t
    LEFT JOIN vehicles v
      ON CAST(v.turo_vehicle_id AS text) = CAST(t.turo_vehicle_id AS text)
    ON CONFLICT (trip_id)
    DO UPDATE SET
      reservation_id = EXCLUDED.reservation_id,
      vehicle_id = COALESCE(EXCLUDED.vehicle_id, trip_financial_facts.vehicle_id),
      host_payout = COALESCE(EXCLUDED.host_payout, trip_financial_facts.host_payout),
      tolls_collected = COALESCE(EXCLUDED.tolls_collected, trip_financial_facts.tolls_collected),
      fuel_reimbursed = COALESCE(EXCLUDED.fuel_reimbursed, trip_financial_facts.fuel_reimbursed),
      actual_tolls = COALESCE(EXCLUDED.actual_tolls, trip_financial_facts.actual_tolls),
      miles_added = COALESCE(EXCLUDED.miles_added, trip_financial_facts.miles_added),
      reimbursement_status = COALESCE(EXCLUDED.reimbursement_status, trip_financial_facts.reimbursement_status),
      data_confidence = COALESCE(EXCLUDED.data_confidence, trip_financial_facts.data_confidence),
      source_payload = COALESCE(EXCLUDED.source_payload, trip_financial_facts.source_payload),
      updated_at = NOW();
  `);
}

async function getBusinessFinancialSettings(client = pool) {
  await ensureBusinessMetricsTables(client);

  const { rows } = await client.query(`
    SELECT *
    FROM business_financial_settings
    ORDER BY id ASC
    LIMIT 1
  `);

  if (!rows[0]) {
    return { ...DEFAULT_BUSINESS_SETTINGS };
  }

  return {
    ...DEFAULT_BUSINESS_SETTINGS,
    ...rows[0],
  };
}

async function upsertBusinessFinancialSettings(input = {}, client = pool) {
  await ensureBusinessMetricsTables(client);
  const existing = await getBusinessFinancialSettings(client);

  const next = {
    ...existing,
    owner_cash_invested: normalizeNumberOrNull(input.owner_cash_invested ?? existing.owner_cash_invested),
    loan_401k_amount: normalizeNumberOrNull(input.loan_401k_amount ?? existing.loan_401k_amount),
    other_business_loan_amount: normalizeNumberOrNull(input.other_business_loan_amount ?? existing.other_business_loan_amount),
    current_cash_reserve: normalizeNumberOrNull(input.current_cash_reserve ?? existing.current_cash_reserve),
    monthly_software_costs: normalizeNumberOrNull(input.monthly_software_costs ?? existing.monthly_software_costs),
    monthly_hosting_costs: normalizeNumberOrNull(input.monthly_hosting_costs ?? existing.monthly_hosting_costs),
    monthly_notification_costs: normalizeNumberOrNull(input.monthly_notification_costs ?? existing.monthly_notification_costs),
    bookkeeping_tax_costs: normalizeNumberOrNull(input.bookkeeping_tax_costs ?? existing.bookkeeping_tax_costs),
    tools_equipment_costs: normalizeNumberOrNull(input.tools_equipment_costs ?? existing.tools_equipment_costs),
    target_owner_hourly_rate: normalizeNumberOrNull(input.target_owner_hourly_rate ?? existing.target_owner_hourly_rate),
    target_minimum_monthly_profit_per_car: normalizeNumberOrNull(
      input.target_minimum_monthly_profit_per_car ?? existing.target_minimum_monthly_profit_per_car
    ),
    target_cash_on_cash_return: normalizeNumberOrNull(
      input.target_cash_on_cash_return ?? existing.target_cash_on_cash_return
    ),
    target_payback_period_months: normalizeNumberOrNull(
      input.target_payback_period_months ?? existing.target_payback_period_months
    ),
  };

  const id = existing.id || 1;
  const { rows } = await client.query(
    `
      INSERT INTO business_financial_settings (
        id,
        owner_cash_invested,
        loan_401k_amount,
        other_business_loan_amount,
        current_cash_reserve,
        monthly_software_costs,
        monthly_hosting_costs,
        monthly_notification_costs,
        bookkeeping_tax_costs,
        tools_equipment_costs,
        target_owner_hourly_rate,
        target_minimum_monthly_profit_per_car,
        target_cash_on_cash_return,
        target_payback_period_months,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW()
      )
      ON CONFLICT (id)
      DO UPDATE SET
        owner_cash_invested = EXCLUDED.owner_cash_invested,
        loan_401k_amount = EXCLUDED.loan_401k_amount,
        other_business_loan_amount = EXCLUDED.other_business_loan_amount,
        current_cash_reserve = EXCLUDED.current_cash_reserve,
        monthly_software_costs = EXCLUDED.monthly_software_costs,
        monthly_hosting_costs = EXCLUDED.monthly_hosting_costs,
        monthly_notification_costs = EXCLUDED.monthly_notification_costs,
        bookkeeping_tax_costs = EXCLUDED.bookkeeping_tax_costs,
        tools_equipment_costs = EXCLUDED.tools_equipment_costs,
        target_owner_hourly_rate = EXCLUDED.target_owner_hourly_rate,
        target_minimum_monthly_profit_per_car = EXCLUDED.target_minimum_monthly_profit_per_car,
        target_cash_on_cash_return = EXCLUDED.target_cash_on_cash_return,
        target_payback_period_months = EXCLUDED.target_payback_period_months,
        updated_at = NOW()
      RETURNING *
    `,
    [
      id,
      next.owner_cash_invested,
      next.loan_401k_amount,
      next.other_business_loan_amount,
      next.current_cash_reserve,
      next.monthly_software_costs,
      next.monthly_hosting_costs,
      next.monthly_notification_costs,
      next.bookkeeping_tax_costs,
      next.tools_equipment_costs,
      next.target_owner_hourly_rate,
      next.target_minimum_monthly_profit_per_car,
      next.target_cash_on_cash_return,
      next.target_payback_period_months,
    ]
  );

  return { ...DEFAULT_BUSINESS_SETTINGS, ...rows[0] };
}

async function listVehicleFinancialProfiles(client = pool) {
  await ensureBusinessMetricsTables(client);

  const { rows } = await client.query(`
    WITH startup_expenses AS (
      SELECT
        e.vehicle_id,
        SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)) AS startup_total,
        SUM(COALESCE(e.tax, 0)) AS startup_tax_total
      FROM expenses e
      WHERE (
        e.is_capitalized = true
        OR LOWER(COALESCE(e.category, '')) = 'vehicle onboard'
      )
        AND e.vehicle_id IS NOT NULL
      GROUP BY e.vehicle_id
    )
    SELECT
      v.id AS vehicle_id,
      v.nickname AS vehicle_name,
      v.vin,
      v.turo_vehicle_id,
      v.year,
      v.make,
      v.model,
      v.current_odometer_miles,
      v.onboarding_date,
      v.acquisition_cost,
      COALESCE(se.startup_total, 0) AS derived_startup_total,
      COALESCE(se.startup_tax_total, 0) AS derived_startup_tax_total,
      vfp.id,
      vfp.purchase_price,
      vfp.purchase_date,
      vfp.placed_in_service_date,
      vfp.mileage_at_purchase,
      vfp.loan_balance,
      vfp.monthly_payment,
      vfp.interest_rate,
      vfp.insurance_monthly,
      vfp.tracker_monthly,
      vfp.registration_annual,
      vfp.inspection_annual,
      vfp.target_min_daily_rate,
      vfp.target_utilization,
      vfp.owner_hourly_rate_override,
      vfp.notes
    FROM vehicles v
    LEFT JOIN startup_expenses se
      ON se.vehicle_id = v.id
    LEFT JOIN vehicle_financial_profiles vfp
      ON vfp.vehicle_id = v.id
    WHERE v.is_active = true
      AND v.in_service = true
    ORDER BY COALESCE(v.nickname, v.vin)
  `);

  return rows;
}

async function upsertVehicleFinancialProfile(vehicleIdInput, input = {}, client = pool) {
  await ensureBusinessMetricsTables(client);
  const vehicleId = Number(vehicleIdInput);
  if (!Number.isInteger(vehicleId) || vehicleId <= 0) {
    const err = new Error("Invalid vehicle id");
    err.statusCode = 400;
    throw err;
  }

  const { rows: existingRows } = await client.query(
    `SELECT * FROM vehicle_financial_profiles WHERE vehicle_id = $1 LIMIT 1`,
    [vehicleId]
  );
  const existing = existingRows[0] || {};

  const next = {
    purchase_price: normalizeNumberOrNull(input.purchase_price ?? existing.purchase_price),
    purchase_date: normalizeDateOrNull(input.purchase_date ?? existing.purchase_date),
    placed_in_service_date: normalizeDateOrNull(
      input.placed_in_service_date ?? existing.placed_in_service_date
    ),
    mileage_at_purchase:
      normalizeNumberOrNull(input.mileage_at_purchase ?? existing.mileage_at_purchase),
    loan_balance: normalizeNumberOrNull(input.loan_balance ?? existing.loan_balance),
    monthly_payment: normalizeNumberOrNull(input.monthly_payment ?? existing.monthly_payment),
    interest_rate: normalizeNumberOrNull(input.interest_rate ?? existing.interest_rate),
    insurance_monthly:
      normalizeNumberOrNull(input.insurance_monthly ?? existing.insurance_monthly),
    tracker_monthly:
      normalizeNumberOrNull(input.tracker_monthly ?? existing.tracker_monthly),
    registration_annual:
      normalizeNumberOrNull(input.registration_annual ?? existing.registration_annual),
    inspection_annual:
      normalizeNumberOrNull(input.inspection_annual ?? existing.inspection_annual),
    target_min_daily_rate:
      normalizeNumberOrNull(input.target_min_daily_rate ?? existing.target_min_daily_rate),
    target_utilization:
      normalizeNumberOrNull(input.target_utilization ?? existing.target_utilization),
    owner_hourly_rate_override: normalizeNumberOrNull(
      input.owner_hourly_rate_override ?? existing.owner_hourly_rate_override
    ),
    notes: normalizeText(input.notes ?? existing.notes),
  };

  await client.query(
    `
      INSERT INTO vehicle_financial_profiles (
        vehicle_id,
        purchase_price,
        purchase_date,
        placed_in_service_date,
        mileage_at_purchase,
        loan_balance,
        monthly_payment,
        interest_rate,
        insurance_monthly,
        tracker_monthly,
        registration_annual,
        inspection_annual,
        target_min_daily_rate,
        target_utilization,
        owner_hourly_rate_override,
        notes,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW()
      )
      ON CONFLICT (vehicle_id)
      DO UPDATE SET
        purchase_price = EXCLUDED.purchase_price,
        purchase_date = EXCLUDED.purchase_date,
        placed_in_service_date = EXCLUDED.placed_in_service_date,
        mileage_at_purchase = EXCLUDED.mileage_at_purchase,
        loan_balance = EXCLUDED.loan_balance,
        monthly_payment = EXCLUDED.monthly_payment,
        interest_rate = EXCLUDED.interest_rate,
        insurance_monthly = EXCLUDED.insurance_monthly,
        tracker_monthly = EXCLUDED.tracker_monthly,
        registration_annual = EXCLUDED.registration_annual,
        inspection_annual = EXCLUDED.inspection_annual,
        target_min_daily_rate = EXCLUDED.target_min_daily_rate,
        target_utilization = EXCLUDED.target_utilization,
        owner_hourly_rate_override = EXCLUDED.owner_hourly_rate_override,
        notes = EXCLUDED.notes,
        updated_at = NOW()
    `,
    [
      vehicleId,
      next.purchase_price,
      next.purchase_date,
      next.placed_in_service_date,
      next.mileage_at_purchase,
      next.loan_balance,
      next.monthly_payment,
      next.interest_rate,
      next.insurance_monthly,
      next.tracker_monthly,
      next.registration_annual,
      next.inspection_annual,
      next.target_min_daily_rate,
      next.target_utilization,
      next.owner_hourly_rate_override,
      next.notes,
    ]
  );

  const { rows } = await client.query(
    `
      WITH startup_expenses AS (
        SELECT
          e.vehicle_id,
          SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)) AS startup_total,
          SUM(COALESCE(e.tax, 0)) AS startup_tax_total
        FROM expenses e
        WHERE (
          e.is_capitalized = true
          OR LOWER(COALESCE(e.category, '')) = 'vehicle onboard'
        )
          AND e.vehicle_id = $1
        GROUP BY e.vehicle_id
      )
      SELECT
        v.id AS vehicle_id,
        v.nickname AS vehicle_name,
        v.vin,
        v.turo_vehicle_id,
        v.year,
        v.make,
        v.model,
        v.current_odometer_miles,
        v.onboarding_date,
        v.acquisition_cost,
        COALESCE(se.startup_total, 0) AS derived_startup_total,
        COALESCE(se.startup_tax_total, 0) AS derived_startup_tax_total,
        vfp.id,
        vfp.purchase_price,
        vfp.purchase_date,
        vfp.placed_in_service_date,
        vfp.mileage_at_purchase,
        vfp.loan_balance,
        vfp.monthly_payment,
        vfp.interest_rate,
        vfp.insurance_monthly,
        vfp.tracker_monthly,
        vfp.registration_annual,
        vfp.inspection_annual,
        vfp.target_min_daily_rate,
        vfp.target_utilization,
        vfp.owner_hourly_rate_override,
        vfp.notes
      FROM vehicles v
      LEFT JOIN startup_expenses se
        ON se.vehicle_id = v.id
      LEFT JOIN vehicle_financial_profiles vfp
        ON vfp.vehicle_id = v.id
      WHERE v.id = $1
      LIMIT 1
    `,
    [vehicleId]
  );

  return rows[0] || null;
}

async function fetchVehiclesWithProfiles(client = pool) {
  const { rows } = await client.query(`
    WITH startup_expenses AS (
      SELECT
        e.vehicle_id,
        SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)) AS startup_total,
        SUM(COALESCE(e.tax, 0)) AS startup_tax_total
      FROM expenses e
      WHERE (
        e.is_capitalized = true
        OR LOWER(COALESCE(e.category, '')) = 'vehicle onboard'
      )
        AND e.vehicle_id IS NOT NULL
      GROUP BY e.vehicle_id
    )
    SELECT
      v.id,
      v.vin,
      v.nickname,
      v.year,
      v.make,
      v.model,
      v.turo_vehicle_id,
      v.current_odometer_miles,
      v.onboarding_date,
      v.acquisition_cost,
      COALESCE(se.startup_total, 0) AS derived_startup_total,
      COALESCE(se.startup_tax_total, 0) AS derived_startup_tax_total,
      fp.purchase_price,
      fp.purchase_date,
      fp.placed_in_service_date,
      fp.mileage_at_purchase,
      fp.loan_balance,
      fp.monthly_payment,
      fp.interest_rate,
      fp.insurance_monthly,
      fp.tracker_monthly,
      fp.registration_annual,
      fp.inspection_annual,
      fp.target_min_daily_rate,
      fp.target_utilization,
      fp.owner_hourly_rate_override
    FROM vehicles v
    LEFT JOIN startup_expenses se
      ON se.vehicle_id = v.id
    LEFT JOIN vehicle_financial_profiles fp
      ON fp.vehicle_id = v.id
    WHERE v.is_active = true
      AND v.in_service = true
    ORDER BY COALESCE(v.nickname, v.vin)
  `);
  return rows;
}

async function fetchTripsForBusinessMetrics(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        t.id,
        t.reservation_id,
        t.guest_name,
        t.status,
        t.turo_vehicle_id,
        t.trip_start,
        t.trip_end,
        t.amount,
        t.toll_total,
        t.toll_charged_total,
        t.fuel_reimbursement_total,
        t.starting_odometer,
        t.ending_odometer,
        t.workflow_stage,
        t.expense_status,
        t.canceled_at,
        tf.vehicle_id,
        tf.delivery_fee_collected,
        tf.extras_collected,
        tf.tolls_collected,
        tf.fuel_reimbursed,
        tf.cleaning_reimbursed,
        tf.smoking_reimbursed,
        tf.actual_tolls,
        tf.actual_fuel_cost,
        tf.actual_cleaning_cost,
        tf.owner_cleaning_minutes,
        tf.owner_delivery_minutes,
        tf.owner_admin_minutes,
        tf.issue_flag,
        tf.reimbursement_status,
        tf.claim_status,
        tf.data_confidence
      FROM trips t
      LEFT JOIN trip_financial_facts tf
        ON tf.trip_id = t.id
      WHERE t.trip_start <= $2
        AND t.trip_end >= COALESCE($1, t.trip_start)
        AND (
          t.canceled_at IS NULL
          OR COALESCE(t.amount, 0) > 0
        )
    `,
    [startDate, endDate]
  );

  return rows.filter((trip) => tripOverlapsRange(trip, startDate, endDate));
}

async function fetchExpensesForBusinessMetrics(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        e.*,
        v.turo_vehicle_id AS expense_vehicle_turo_id
      FROM expenses e
      LEFT JOIN vehicles v
        ON v.id = e.vehicle_id
      WHERE e.date <= $2::date
        AND ($1::date IS NULL OR e.date >= $1::date)
    `,
    [startDate ? toDateOnly(startDate) : null, toDateOnly(endDate)]
  );
  return rows;
}

async function fetchStartupBasisByVehicle(client, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        e.vehicle_id,
        SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)) AS startup_total
      FROM expenses e
      WHERE e.date <= $1::date
        AND (
          e.is_capitalized = true
          OR LOWER(COALESCE(e.category, '')) = 'vehicle onboard'
        )
        AND e.vehicle_id IS NOT NULL
      GROUP BY e.vehicle_id
    `,
    [toDateOnly(endDate)]
  );

  return new Map(rows.map((row) => [String(row.vehicle_id), toNumber(row.startup_total)]));
}

function buildTripVehicleMap(vehicles) {
  const byTuroVehicleId = new Map();
  const byId = new Map();
  for (const vehicle of vehicles) {
    byId.set(String(vehicle.id), vehicle);
    if (vehicle.turo_vehicle_id) {
      byTuroVehicleId.set(String(vehicle.turo_vehicle_id), String(vehicle.id));
    }
  }
  return { byTuroVehicleId, byId };
}

function resolveTripVehicleId(trip, maps) {
  if (trip?.vehicle_id != null && maps.byId.has(String(trip.vehicle_id))) {
    return String(trip.vehicle_id);
  }
  if (trip?.turo_vehicle_id && maps.byTuroVehicleId.has(String(trip.turo_vehicle_id))) {
    return maps.byTuroVehicleId.get(String(trip.turo_vehicle_id));
  }
  return null;
}

function allocateExpenseAmount(expense, vehicleMetricsById, tripIdToVehicleId, fleetMilesBasis) {
  const total = toNumber(expense?.price) + toNumber(expense?.tax);
  const scope = String(expense?.expense_scope || "direct").toLowerCase();
  const allocations = [];

  let resolvedVehicleId = expense?.vehicle_id != null ? String(expense.vehicle_id) : null;
  if (!resolvedVehicleId && expense?.trip_id && tripIdToVehicleId.has(String(expense.trip_id))) {
    resolvedVehicleId = tripIdToVehicleId.get(String(expense.trip_id));
  }

  if (scope === "direct") {
    if (resolvedVehicleId && vehicleMetricsById.has(resolvedVehicleId)) {
      allocations.push([resolvedVehicleId, total]);
    }
    return allocations;
  }

  const vehicleIds = Array.from(vehicleMetricsById.keys());
  if (!vehicleIds.length) return allocations;

  if (scope === "general" || scope === "shared") {
    const fleetAvailableDaysBasis = vehicleIds.reduce((sum, vehicleId) => {
      const metric = vehicleMetricsById.get(vehicleId);
      return sum + Math.max(0, toNumber(metric?.days_available));
    }, 0);

    if (fleetAvailableDaysBasis > 0) {
      for (const [vehicleId, metric] of vehicleMetricsById.entries()) {
        const share = safeDivide(
          Math.max(0, toNumber(metric?.days_available)),
          fleetAvailableDaysBasis,
          0
        );
        allocations.push([vehicleId, total * share]);
      }
    } else {
      const evenShare = total / vehicleIds.length;
      for (const vehicleId of vehicleIds) {
        allocations.push([vehicleId, evenShare]);
      }
    }
    return allocations;
  }

  if (scope === "apportioned") {
    if (fleetMilesBasis > 0) {
      for (const [vehicleId, metric] of vehicleMetricsById.entries()) {
        const share = safeDivide(metric.total_miles_basis, fleetMilesBasis, 0);
        allocations.push([vehicleId, total * share]);
      }
    } else {
      const evenShare = total / vehicleIds.length;
      for (const vehicleId of vehicleIds) {
        allocations.push([vehicleId, evenShare]);
      }
    }
  }

  return allocations;
}

function describeExpenseMappingIssue(expense, tripIdToVehicleId) {
  const scope = String(expense?.expense_scope || "direct").trim().toLowerCase();
  const hasVehicleId = expense?.vehicle_id != null;
  const hasTripId = expense?.trip_id != null;
  const tripMapsToVehicle =
    hasTripId && tripIdToVehicleId.has(String(expense.trip_id));

  if (scope === "direct") {
    if (hasVehicleId) {
      return {
        reason: "vehicle attribution points to a vehicle outside the active fleet",
        action: "reassign the vehicle or change the scope if this should be shared",
      };
    }
    if (hasTripId && !tripMapsToVehicle) {
      return {
        reason: "trip linkage does not resolve to an active vehicle",
        action: "fix the linked trip or assign the expense directly to a vehicle",
      };
    }
    return {
      reason: "direct expense has no vehicle or usable trip linkage",
      action: "assign a vehicle, link a mapped trip, or change the scope",
    };
  }

  if (!["general", "shared", "apportioned"].includes(scope)) {
    return {
      reason: "expense scope is missing or not recognized",
      action: "set scope to direct, shared, general, or apportioned",
    };
  }

  return {
    reason: "expense could not be allocated with the current scope and references",
    action: "review scope, vehicle, and trip linkage",
  };
}

function getSuggestedVehicleForExpense(expense, vehicleMetricsById) {
  const haystack = `${expense?.vendor || ""} ${expense?.category || ""} ${expense?.notes || ""}`
    .trim()
    .toLowerCase();

  if (!haystack) return null;

  for (const metric of vehicleMetricsById.values()) {
    const vehicleName = String(metric?.vehicle_name || "")
      .trim()
      .toLowerCase();
    if (vehicleName && haystack.includes(vehicleName)) {
      return {
        vehicle_id: metric.vehicle_id,
        vehicle_name: metric.vehicle_name,
      };
    }
  }

  return null;
}

function buildQualityFlag(
  periodKey,
  entityType,
  entityId,
  flagCode,
  severity,
  penalty,
  note,
  details = {}
) {
  return {
    period_key: periodKey,
    entity_type: entityType,
    entity_id: String(entityId),
    flag_code: flagCode,
    severity,
    confidence_penalty: penalty,
    note,
    ...details,
  };
}

function isTripInProgressForBusinessMetrics(trip) {
  const stage = String(trip?.workflow_stage || "").trim().toLowerCase();
  return (
    stage === "in_progress" ||
    stage === "ready_for_handoff" ||
    stage === "trip_started" ||
    stage === "started"
  );
}

function isTripCanceledForBusinessMetrics(trip) {
  if (trip?.canceled_at) return true;

  const status = String(trip?.status || "").trim().toLowerCase();
  const stage = String(trip?.workflow_stage || "").trim().toLowerCase();
  return (
    status === "canceled" ||
    status === "cancelled" ||
    stage === "canceled" ||
    stage === "cancelled"
  );
}

function hasTripEndedForBusinessMetrics(trip, now = Date.now()) {
  const endMs = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;
  if (!Number.isFinite(endMs)) return false;
  return endMs < now - 60 * 60 * 1000;
}

async function computeBusinessMetricsForWindow({ key, startDate, endDate }, client = pool) {
  await ensureBusinessMetricsTables(client);
  await syncTripFinancialFacts(client);
  const [settings, vehicles, vehicleOpsPayload, trips, expenses, startupBasisByVehicle] = await Promise.all([
    getBusinessFinancialSettings(client),
    fetchVehiclesWithProfiles(client),
    getVehicleMetrics(key),
    fetchTripsForBusinessMetrics(client, startDate, endDate),
    fetchExpensesForBusinessMetrics(client, startDate, endDate),
    fetchStartupBasisByVehicle(client, endDate),
  ]);

  const vehicleOps = Array.isArray(vehicleOpsPayload?.vehicles)
    ? vehicleOpsPayload.vehicles
    : [];
  const vehicleOpsById = new Map(
    vehicleOps.map((item) => [String(item.vehicle_id), item])
  );
  const maps = buildTripVehicleMap(vehicles);

  const periodKey =
    key === "all"
      ? "all-time"
      : key === "ytd"
      ? `${new Date(endDate).getFullYear()}-YTD`
      : `${toDateOnly(startDate)}:${toDateOnly(endDate)}`;

  const vehicleMetricsById = new Map();
  const flags = [];
  const tripIdToVehicleId = new Map();
  const firstTripStartByVehicle = new Map();
  const monthWeight = monthEquivalentForRange(startDate || endDate, endDate);

  for (const vehicle of vehicles) {
    const vehicleId = String(vehicle.id);
    const ops = vehicleOpsById.get(vehicleId) || {};
    const placedInServiceDate =
      vehicle.placed_in_service_date ||
      vehicle.onboarding_date ||
      toDateOnly(vehicle.purchase_date) ||
      null;

    const availableDays = Number(
      ops.calendar_days_available ??
        (placedInServiceDate
          ? getCalendarDaysInRange(
              new Date(Math.max(new Date(placedInServiceDate).getTime(), new Date(startDate || placedInServiceDate).getTime())),
              endDate
            )
          : 0)
    );

    const fixedOverhead =
      prorateMonthlyAmount(vehicle.insurance_monthly, startDate || endDate, endDate) +
      prorateMonthlyAmount(vehicle.tracker_monthly, startDate || endDate, endDate) +
      monthWeight * safeDivide(vehicle.registration_annual, 12, 0) +
      monthWeight * safeDivide(vehicle.inspection_annual, 12, 0);

    const debtService = prorateMonthlyAmount(
      vehicle.monthly_payment,
      startDate || endDate,
      endDate
    );

    vehicleMetricsById.set(vehicleId, {
      vehicle_id: vehicle.id,
      vehicle_name: vehicle.nickname || vehicle.vin,
      turo_vehicle_id: vehicle.turo_vehicle_id || null,
      year_make_model: [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" "),
      purchase_price: roundMoney(
        vehicle.purchase_price ??
          vehicle.acquisition_cost ??
          vehicle.derived_startup_total ??
          startupBasisByVehicle.get(vehicleId) ??
          0
      ),
      purchase_date: vehicle.purchase_date || null,
      placed_in_service_date: placedInServiceDate,
      current_estimated_value: roundMoney(ops.fmv_estimate_mid),
      current_mileage: vehicle.current_odometer_miles ?? ops.current_odometer ?? null,
      mileage_at_purchase: vehicle.mileage_at_purchase ?? null,
      loan_balance: roundMoney(vehicle.loan_balance),
      monthly_payment: roundMoney(vehicle.monthly_payment),
      interest_rate: vehicle.interest_rate == null ? null : Number(vehicle.interest_rate),
      insurance_monthly: roundMoney(vehicle.insurance_monthly),
      tracker_monthly: roundMoney(vehicle.tracker_monthly),
      registration_annual: roundMoney(vehicle.registration_annual),
      inspection_annual: roundMoney(vehicle.inspection_annual),
      setup_costs_total: 0,
      maintenance_total_to_date: 0,
      repairs_total_to_date: 0,
      unreimbursed_damage_total: 0,
      days_available: availableDays,
      days_booked: 0,
      days_blocked: 0,
      days_down_for_maintenance: 0,
      host_payout_total: 0,
      ancillary_revenue_collected: 0,
      reimbursements_collected: 0,
      unreimbursed_costs: 0,
      estimated_owner_hours: 0,
      current_equity: 0,
      net_profit: 0,
      net_profit_after_debt_service: 0,
      net_profit_after_labor: 0,
      utilization_rate: 0,
      revenue_per_available_day: 0,
      revenue_per_booked_day: 0,
      profit_per_available_day: 0,
      profit_per_booked_day: 0,
      profit_per_owner_hour: 0,
      maintenance_cost_per_mile: 0,
      repair_cost_per_mile: 0,
      depreciation_per_mile: null,
      break_even_utilization: null,
      break_even_daily_rate: null,
      payback_period_months: null,
      downside_if_vehicle_sold_today: null,
      recommendation_status: "INSUFFICIENT DATA",
      data_confidence: "medium",
      confidence_score: 1,
      total_miles_basis:
        vehicle.current_odometer_miles != null && vehicle.mileage_at_purchase != null
          ? Math.max(
              0,
              Number(vehicle.current_odometer_miles) - Number(vehicle.mileage_at_purchase)
            )
          : Number(ops.total_miles ?? 0),
      tolls_paid: roundMoney(ops.tolls_paid),
      tolls_recovered: roundMoney(ops.tolls_recovered),
      tolls_unattributed: roundMoney(ops.tolls_unattributed),
      tolls_outstanding: roundMoney(ops.tolls_attributed_outstanding),
      source_metrics: {
        mileage_confidence: ops.mileage_confidence || null,
        fmv_confidence: ops.fmv_confidence || null,
        trip_count: 0,
      },
    });
    if (!vehicle.monthly_payment && vehicle.loan_balance) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "vehicle",
          vehicle.id,
          "missing_monthly_payment",
          "medium",
          0.08,
          `${vehicle.nickname || vehicle.vin} has loan balance but no monthly payment`
        )
      );
    }
  }

  for (const trip of trips) {
    const vehicleId = resolveTripVehicleId(trip, maps);
    if (!vehicleId || !vehicleMetricsById.has(vehicleId)) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "trip",
          trip.id,
          "missing_vehicle_mapping",
          "high",
          0.2,
          `Reservation ${trip.reservation_id} is not mapped to an active vehicle`,
          {
            reservation_id: trip.reservation_id,
            guest_name: trip.guest_name || null,
            vehicle_name: null,
            turo_vehicle_id:
              trip.turo_vehicle_id == null ? null : String(trip.turo_vehicle_id),
          }
        )
      );
      continue;
    }

    tripIdToVehicleId.set(String(trip.id), vehicleId);
    const metric = vehicleMetricsById.get(vehicleId);
    const tripStartDate = trip.trip_start ? new Date(trip.trip_start) : null;
    if (tripStartDate && !Number.isNaN(tripStartDate.getTime())) {
      const existingFirst = firstTripStartByVehicle.get(vehicleId);
      if (!existingFirst || tripStartDate.getTime() < existingFirst.getTime()) {
        firstTripStartByVehicle.set(vehicleId, tripStartDate);
      }
    }
    const hostPayout = getTripProratedAmount(trip, startDate, endDate);
    const tollsCollected = getTripProratedValue(
      trip.tolls_collected ?? trip.toll_charged_total,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const fuelReimbursed = getTripProratedValue(
      trip.fuel_reimbursed ?? trip.fuel_reimbursement_total,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const deliveryCollected = getTripProratedValue(
      trip.delivery_fee_collected,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const extrasCollected = getTripProratedValue(
      trip.extras_collected,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const cleaningReimbursed = getTripProratedValue(
      trip.cleaning_reimbursed,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const smokingReimbursed = getTripProratedValue(
      trip.smoking_reimbursed,
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );
    const ownerMinutes =
      toNumber(trip.owner_cleaning_minutes) +
      toNumber(trip.owner_delivery_minutes) +
      toNumber(trip.owner_admin_minutes);
    const overlapDays = getOverlapDays(
      trip.trip_start,
      trip.trip_end,
      startDate,
      endDate
    );

    metric.host_payout_total += hostPayout;
    metric.ancillary_revenue_collected += deliveryCollected + extrasCollected;
    metric.reimbursements_collected +=
      tollsCollected + fuelReimbursed + cleaningReimbursed + smokingReimbursed;
    metric.estimated_owner_hours += ownerMinutes / 60;
    metric.days_booked += overlapDays;
    metric.source_metrics.trip_count += 1;

    if (trip.amount == null) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "trip",
          trip.id,
          "missing_host_payout",
          "high",
          0.16,
          `Reservation ${trip.reservation_id} is missing payout`,
          {
            reservation_id: trip.reservation_id,
            guest_name: trip.guest_name || null,
            vehicle_name: metric.vehicle_name || null,
            trip_id: trip.id,
          }
        )
      );
    }
    const tripIsInProgress = isTripInProgressForBusinessMetrics(trip);
    const tripIsCanceled = isTripCanceledForBusinessMetrics(trip);
    const tripHasEnded = hasTripEndedForBusinessMetrics(trip);
    const hasStartingOdometer = trip.starting_odometer != null;
    const hasEndingOdometer = trip.ending_odometer != null;
    const currentVehicleOdometer = Number(metric.current_mileage);
    const startingOdometer = Number(trip.starting_odometer);
    const canInferLiveEndingOdometer =
      tripIsInProgress &&
      hasStartingOdometer &&
      Number.isFinite(currentVehicleOdometer) &&
      Number.isFinite(startingOdometer) &&
      currentVehicleOdometer >= startingOdometer;

    const shouldRequireFirmTripMileage =
      !tripIsCanceled && !tripIsInProgress && tripHasEnded;

    if (
      shouldRequireFirmTripMileage &&
      (!hasStartingOdometer || (!hasEndingOdometer && !canInferLiveEndingOdometer))
    ) {
      const missingFields = [];
      if (!hasStartingOdometer) {
        missingFields.push("starting odometer");
      }
      if (!hasEndingOdometer && !canInferLiveEndingOdometer) {
        missingFields.push("ending odometer");
      }

      flags.push(
        buildQualityFlag(
          periodKey,
          "trip",
          trip.id,
          "missing_trip_mileage",
          !hasStartingOdometer ? "medium" : "low",
          !hasStartingOdometer ? 0.08 : 0.03,
          `Reservation ${trip.reservation_id} is missing ${missingFields.join(
            " and "
          )}`,
          {
            reservation_id: trip.reservation_id,
            guest_name: trip.guest_name || null,
            vehicle_name: metric.vehicle_name || null,
            trip_id: trip.id,
            missing_fields: missingFields,
            inferred_live_odometer:
              canInferLiveEndingOdometer && !hasEndingOdometer
                ? currentVehicleOdometer
                : null,
          }
        )
      );
    }
    const shouldFlagPendingReimbursement =
      !tripIsCanceled && !tripIsInProgress && tripHasEnded;

    if (
      shouldFlagPendingReimbursement &&
      (toNumber(trip.toll_total) > 0 || toNumber(trip.fuel_reimbursement_total) > 0) &&
      String(trip.reimbursement_status || "").toLowerCase() === "pending"
    ) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "trip",
          trip.id,
          "pending_reimbursement_status",
          "medium",
          0.05,
          `Reservation ${trip.reservation_id} has unresolved reimbursement signals`,
          {
            reservation_id: trip.reservation_id,
            guest_name: trip.guest_name || null,
            vehicle_name: metric.vehicle_name || null,
            trip_id: trip.id,
          }
        )
      );
    }
  }

  const fleetMilesBasis = Array.from(vehicleMetricsById.values()).reduce(
    (sum, item) => sum + Number(item.total_miles_basis ?? 0),
    0
  );
  const startupExpenseTotalsByVehicle = new Map();

  for (const expense of expenses) {
    const expenseType = classifyExpense(expense);
    const allocations = allocateExpenseAmount(
      expense,
      vehicleMetricsById,
      tripIdToVehicleId,
      fleetMilesBasis
    );
    const total = toNumber(expense.price) + toNumber(expense.tax);

    if (!allocations.length) {
      const mappingIssue = describeExpenseMappingIssue(expense, tripIdToVehicleId);
      const suggestedVehicle = getSuggestedVehicleForExpense(
        expense,
        vehicleMetricsById
      );
      flags.push(
        buildQualityFlag(
          periodKey,
          "expense",
          expense.id,
          "unmapped_expense",
          "medium",
          0.04,
          `Expense ${expense.id} could not be mapped into vehicle economics`,
          {
            expense_id: expense.id,
            expense_vendor: expense.vendor || null,
            expense_category: expense.category || null,
            expense_scope: expense.expense_scope || null,
            expense_vehicle_id: expense.vehicle_id ?? null,
            expense_trip_id: expense.trip_id ?? null,
            expense_total: roundMoney(total),
            mapping_reason: mappingIssue.reason,
            suggested_action: mappingIssue.action,
            suggested_vehicle_id: suggestedVehicle?.vehicle_id ?? null,
            suggested_vehicle_name: suggestedVehicle?.vehicle_name ?? null,
            note: `Expense ${expense.id} could not be mapped into vehicle economics: ${mappingIssue.reason}. Next step: ${mappingIssue.action}.`,
          }
        )
      );
      continue;
    }

    for (const [vehicleId, allocatedAmount] of allocations) {
      const metric = vehicleMetricsById.get(vehicleId);
      if (!metric) continue;

      if (expenseType === "startup") {
        metric.setup_costs_total += allocatedAmount;
        startupExpenseTotalsByVehicle.set(
          vehicleId,
          (startupExpenseTotalsByVehicle.get(vehicleId) || 0) + allocatedAmount
        );
        continue;
      }

      if (expenseType === "maintenance") {
        metric.maintenance_total_to_date += allocatedAmount;
      } else if (expenseType === "repair") {
        metric.repairs_total_to_date += allocatedAmount;
      }

      metric.net_profit -= allocatedAmount;
      metric.unreimbursed_costs +=
        expenseType === "tolls" ? Math.max(0, allocatedAmount - toNumber(metric.tolls_recovered)) : 0;
    }

    if (!expense.category) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "expense",
          expense.id,
          "missing_category",
          "low",
          0.02,
          `Expense ${expense.id} has no category`,
          {
            expense_id: expense.id,
            expense_vendor: expense.vendor || null,
            expense_category: null,
            expense_scope: expense.expense_scope || null,
            expense_vehicle_id: expense.vehicle_id ?? null,
            expense_trip_id: expense.trip_id ?? null,
            expense_total: roundMoney(total),
            suggested_action: "choose the closest category so the expense rolls up correctly",
            note: `Expense ${expense.id} has no category. Next step: choose the closest category so the expense rolls up correctly.`,
          }
        )
      );
    }

    if (!expense.expense_scope) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "expense",
          expense.id,
          "missing_scope",
          "medium",
          0.03,
          `Expense ${expense.id} has no scope`,
          {
            expense_id: expense.id,
            expense_vendor: expense.vendor || null,
            expense_category: expense.category || null,
            expense_scope: null,
            expense_vehicle_id: expense.vehicle_id ?? null,
            expense_trip_id: expense.trip_id ?? null,
            expense_total: roundMoney(total),
            suggested_action:
              "set scope to direct, general, shared, or apportioned so the expense can be allocated",
            note: `Expense ${expense.id} has no scope. Next step: set scope to direct, general, shared, or apportioned so the expense can be allocated.`,
          }
        )
      );
    }
  }

  const fleetMetrics = [];
  for (const metric of vehicleMetricsById.values()) {
    const firstTripStart = firstTripStartByVehicle.get(String(metric.vehicle_id));
    if (!metric.placed_in_service_date && firstTripStart) {
      metric.placed_in_service_date = toDateOnly(firstTripStart);
    }

    if (!(toNumber(metric.purchase_price) > 0)) {
      const startupBasis = Math.max(
        toNumber(startupExpenseTotalsByVehicle.get(String(metric.vehicle_id))),
        toNumber(startupBasisByVehicle.get(String(metric.vehicle_id)))
      );
      if (startupBasis > 0) {
        metric.purchase_price = startupBasis;
      }
    }

    const settingsHourly =
      metric.owner_hourly_rate_override != null
        ? toNumber(metric.owner_hourly_rate_override)
        : toNumber(settings.target_owner_hourly_rate, 35);
    const fixedOverhead =
      prorateMonthlyAmount(metric.insurance_monthly, startDate || endDate, endDate) +
      prorateMonthlyAmount(metric.tracker_monthly, startDate || endDate, endDate) +
      monthWeight * safeDivide(metric.registration_annual, 12, 0) +
      monthWeight * safeDivide(metric.inspection_annual, 12, 0);
    const debtService = prorateMonthlyAmount(metric.monthly_payment, startDate || endDate, endDate);
    const laborCost = toNumber(metric.estimated_owner_hours) * settingsHourly;
    const recognizedRevenue =
      toNumber(metric.host_payout_total) +
      toNumber(metric.ancillary_revenue_collected) +
      toNumber(metric.reimbursements_collected);

    metric.net_profit += recognizedRevenue;
    metric.net_profit -= fixedOverhead;
    metric.net_profit_after_debt_service = metric.net_profit - debtService;
    metric.net_profit_after_labor = metric.net_profit_after_debt_service - laborCost;
    metric.current_equity =
      toNumber(metric.current_estimated_value) - toNumber(metric.loan_balance);
    metric.utilization_rate = safeDivide(metric.days_booked, metric.days_available, 0);
    metric.revenue_per_available_day = safeDivide(recognizedRevenue, metric.days_available, 0);
    metric.revenue_per_booked_day = safeDivide(recognizedRevenue, metric.days_booked, 0);
    metric.profit_per_available_day = safeDivide(metric.net_profit_after_labor, metric.days_available, 0);
    metric.profit_per_booked_day = safeDivide(metric.net_profit_after_labor, metric.days_booked, 0);
    metric.profit_per_owner_hour = safeDivide(metric.net_profit_after_labor, metric.estimated_owner_hours, 0);
    metric.monthly_profit_equivalent = safeDivide(metric.net_profit_after_labor, monthWeight || 1, 0);
    metric.maintenance_cost_per_mile = safeDivide(
      metric.maintenance_total_to_date,
      metric.total_miles_basis,
      0
    );
    metric.repair_cost_per_mile = safeDivide(
      metric.repairs_total_to_date,
      metric.total_miles_basis,
      0
    );
    metric.depreciation_per_mile =
      metric.purchase_price && metric.current_estimated_value && metric.current_mileage && metric.mileage_at_purchase != null
        ? safeDivide(
            toNumber(metric.purchase_price) - toNumber(metric.current_estimated_value),
            Math.max(1, toNumber(metric.current_mileage) - toNumber(metric.mileage_at_purchase)),
            0
          )
        : null;
    metric.break_even_daily_rate =
      metric.days_available > 0
        ? safeDivide(
            fixedOverhead + debtService + laborCost,
            Math.max(1, metric.days_booked || metric.days_available * Math.max(0.35, metric.target_utilization || 0.5)),
            0
          )
        : null;
    metric.break_even_utilization =
      metric.days_available > 0 && metric.revenue_per_booked_day > 0
        ? safeDivide(
            fixedOverhead + debtService + laborCost,
            metric.revenue_per_booked_day * metric.days_available,
            0
          )
        : null;
    metric.payback_period_months =
      metric.monthly_profit_equivalent > 0 && metric.setup_costs_total > 0
        ? safeDivide(metric.setup_costs_total, metric.monthly_profit_equivalent, null)
        : null;
    metric.downside_if_vehicle_sold_today =
      toNumber(metric.current_estimated_value) - toNumber(metric.loan_balance);

    if (!(toNumber(metric.purchase_price) > 0)) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "vehicle",
          metric.vehicle_id,
          "missing_purchase_price",
          "high",
          0.18,
          `${metric.vehicle_name} has no purchase basis recorded in profile or startup expenses`
        )
      );
    }

    if (!metric.placed_in_service_date) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "vehicle",
          metric.vehicle_id,
          "missing_placed_in_service_date",
          "medium",
          0.1,
          `${metric.vehicle_name} has no placed-in-service date or first scheduled trip`
        )
      );
    }

    const relevantFlags = flags.filter(
      (flag) => flag.entity_type === "vehicle" && flag.entity_id === String(metric.vehicle_id)
    );
    const tripFlags = flags.filter(
      (flag) =>
        flag.entity_type === "trip" &&
        tripIdToVehicleId.get(String(flag.entity_id)) === String(metric.vehicle_id)
    );
    const allFlags = [...relevantFlags, ...tripFlags];
    const penalty = allFlags.reduce((sum, flag) => sum + toNumber(flag.confidence_penalty), 0);
    metric.confidence_score = Math.max(
      0.05,
      roundNumber(1 - penalty - (metric.source_metrics.mileage_confidence === "low" ? 0.08 : 0), 2)
    );
    metric.data_confidence = getConfidenceLabel(metric.confidence_score);
    metric.recommendation_status = buildVehicleRecommendation(metric, settings);

    if (metric.utilization_rate > 1.02) {
      flags.push(
        buildQualityFlag(
          periodKey,
          "vehicle",
          metric.vehicle_id,
          "occupancy_over_100",
          "medium",
          0.06,
          `${metric.vehicle_name} shows utilization above 100%`
        )
      );
      metric.confidence_score = Math.max(0.05, metric.confidence_score - 0.06);
      metric.data_confidence = getConfidenceLabel(metric.confidence_score);
    }

    fleetMetrics.push({
      ...metric,
      setup_costs_total: roundMoney(metric.setup_costs_total),
      maintenance_total_to_date: roundMoney(metric.maintenance_total_to_date),
      repairs_total_to_date: roundMoney(metric.repairs_total_to_date),
      unreimbursed_costs: roundMoney(metric.unreimbursed_costs),
      host_payout_total: roundMoney(metric.host_payout_total),
      ancillary_revenue_collected: roundMoney(metric.ancillary_revenue_collected),
      reimbursements_collected: roundMoney(metric.reimbursements_collected),
      current_equity: roundMoney(metric.current_equity),
      net_profit: roundMoney(metric.net_profit),
      net_profit_after_debt_service: roundMoney(metric.net_profit_after_debt_service),
      net_profit_after_labor: roundMoney(metric.net_profit_after_labor),
      estimated_owner_hours: roundNumber(metric.estimated_owner_hours, 2),
      utilization_rate: roundNumber(metric.utilization_rate, 4),
      revenue_per_available_day: roundMoney(metric.revenue_per_available_day),
      revenue_per_booked_day: roundMoney(metric.revenue_per_booked_day),
      profit_per_available_day: roundMoney(metric.profit_per_available_day),
      profit_per_booked_day: roundMoney(metric.profit_per_booked_day),
      profit_per_owner_hour: roundMoney(metric.profit_per_owner_hour),
      maintenance_cost_per_mile: roundMoney(metric.maintenance_cost_per_mile),
      repair_cost_per_mile: roundMoney(metric.repair_cost_per_mile),
      depreciation_per_mile:
        metric.depreciation_per_mile == null ? null : roundMoney(metric.depreciation_per_mile),
      break_even_daily_rate:
        metric.break_even_daily_rate == null ? null : roundMoney(metric.break_even_daily_rate),
      break_even_utilization:
        metric.break_even_utilization == null ? null : roundNumber(metric.break_even_utilization, 4),
      payback_period_months:
        metric.payback_period_months == null ? null : roundNumber(metric.payback_period_months, 1),
      downside_if_vehicle_sold_today: roundMoney(metric.downside_if_vehicle_sold_today),
      monthly_profit_equivalent: roundMoney(metric.monthly_profit_equivalent),
      confidence_score: roundNumber(metric.confidence_score, 2),
    });
  }

  fleetMetrics.sort((a, b) => toNumber(b.net_profit_after_labor) - toNumber(a.net_profit_after_labor));

  const fleetSummary = {
    owner_cash_invested: roundMoney(settings.owner_cash_invested),
    total_host_payout: roundMoney(fleetMetrics.reduce((sum, item) => sum + toNumber(item.host_payout_total), 0)),
    total_reimbursements: roundMoney(fleetMetrics.reduce((sum, item) => sum + toNumber(item.reimbursements_collected), 0)),
    total_ancillary_revenue: roundMoney(fleetMetrics.reduce((sum, item) => sum + toNumber(item.ancillary_revenue_collected), 0)),
    total_operating_expenses: roundMoney(
      fleetMetrics.reduce(
        (sum, item) =>
          sum +
          toNumber(item.maintenance_total_to_date) +
          toNumber(item.repairs_total_to_date),
        0
      )
    ),
    total_startup_capital: roundMoney(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.setup_costs_total), 0)
    ),
    total_cash_returned: roundMoney(
      fleetMetrics.reduce(
        (sum, item) =>
          sum +
          toNumber(item.host_payout_total) +
          toNumber(item.ancillary_revenue_collected) +
          toNumber(item.reimbursements_collected),
        0
      )
    ),
    net_operating_profit: roundMoney(fleetMetrics.reduce((sum, item) => sum + toNumber(item.net_profit), 0)),
    net_profit_after_debt_service: roundMoney(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.net_profit_after_debt_service), 0)
    ),
    net_profit_after_owner_labor: roundMoney(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.net_profit_after_labor), 0)
    ),
    current_fleet_equity: roundMoney(fleetMetrics.reduce((sum, item) => sum + toNumber(item.current_equity), 0)),
    current_fleet_market_value: roundMoney(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.current_estimated_value), 0)
    ),
    estimated_owner_hours: roundNumber(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.estimated_owner_hours), 0),
      2
    ),
    cash_on_cash_return:
      settings.owner_cash_invested && settings.owner_cash_invested > 0
        ? roundNumber(
            safeDivide(
              fleetMetrics.reduce((sum, item) => sum + toNumber(item.net_profit_after_labor), 0),
              settings.owner_cash_invested,
              0
            ),
            4
          )
        : null,
    avg_utilization_rate: roundNumber(
      safeDivide(
        fleetMetrics.reduce((sum, item) => sum + toNumber(item.utilization_rate), 0),
        fleetMetrics.length,
        0
      ),
      4
    ),
    avg_revenue_per_available_day: roundMoney(
      safeDivide(
        fleetMetrics.reduce((sum, item) => sum + toNumber(item.revenue_per_available_day), 0),
        fleetMetrics.length,
        0
      )
    ),
    avg_profit_per_owner_hour: roundMoney(
      safeDivide(
        fleetMetrics.reduce((sum, item) => sum + toNumber(item.profit_per_owner_hour), 0),
        fleetMetrics.length,
        0
      )
    ),
  };

  fleetSummary.cash_recovered_pct =
    settings.owner_cash_invested && settings.owner_cash_invested > 0
      ? roundNumber(
          safeDivide(
            fleetSummary.total_cash_returned,
            settings.owner_cash_invested,
            0
          ),
          4
        )
      : null;
  fleetSummary.unrecovered_owner_cash =
    settings.owner_cash_invested && settings.owner_cash_invested > 0
      ? roundMoney(settings.owner_cash_invested - fleetSummary.total_cash_returned)
      : null;
  fleetSummary.owner_capital_coverage_pct =
    settings.owner_cash_invested && settings.owner_cash_invested > 0
      ? roundNumber(
          safeDivide(
            fleetSummary.total_cash_returned + fleetSummary.current_fleet_equity,
            settings.owner_cash_invested,
            0
          ),
          4
        )
      : null;

  const flagSummary = summarizeFlags(flags);
  const fleetConfidenceScore = roundNumber(
    safeDivide(
      fleetMetrics.reduce((sum, item) => sum + toNumber(item.confidence_score), 0),
      fleetMetrics.length,
      0
    ),
    2
  );

  return {
    range: key,
    period_key: periodKey,
    generated_at: new Date().toISOString(),
    settings,
    fleet_summary: {
      ...fleetSummary,
      data_confidence: getConfidenceLabel(fleetConfidenceScore),
      confidence_score: fleetConfidenceScore,
      flag_counts: flagSummary,
    },
    vehicles: fleetMetrics,
    flags,
  };
}

async function getBusinessMetrics(rangeKey = "90d", client = pool) {
  const range = getDateRange(rangeKey);
  return computeBusinessMetricsForWindow(range, client);
}

async function createBusinessMetricSnapshot(periodType = "quarterly", client = pool) {
  await ensureBusinessMetricsTables(client);
  const now = new Date();
  const currentQuarter = getCurrentQuarterRange(now);
  const previousQuarter = getPreviousQuarterRange(now);
  const range = periodType === "quarterly" ? currentQuarter : currentQuarter;
  const periodKey =
    periodType === "quarterly"
      ? formatQuarterKey(range.start)
      : `${periodType}:${toDateOnly(range.start)}:${toDateOnly(range.end)}`;

  const payload = await computeBusinessMetricsForWindow(
    {
      key: periodType === "quarterly" ? periodKey : periodType,
      startDate: range.start,
      endDate: range.end,
    },
    client
  );

  const { rows } = await client.query(
    `
      INSERT INTO metric_period_snapshots (
        period_key,
        period_type,
        range_start,
        range_end,
        summary,
        data_confidence,
        generated_at
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,NOW())
      ON CONFLICT (period_key)
      DO UPDATE SET
        period_type = EXCLUDED.period_type,
        range_start = EXCLUDED.range_start,
        range_end = EXCLUDED.range_end,
        summary = EXCLUDED.summary,
        data_confidence = EXCLUDED.data_confidence,
        generated_at = NOW()
      RETURNING id, period_key, generated_at
    `,
    [
      periodKey,
      periodType,
      toDateOnly(range.start),
      toDateOnly(range.end),
      JSON.stringify(payload.fleet_summary),
      payload.fleet_summary.data_confidence,
    ]
  );

  const snapshot = rows[0];
  await client.query(`DELETE FROM vehicle_period_snapshots WHERE snapshot_id = $1`, [snapshot.id]);
  await client.query(`DELETE FROM metric_data_quality_flags WHERE period_key = $1`, [snapshot.period_key]);

  for (const vehicle of payload.vehicles) {
    await client.query(
      `
        INSERT INTO vehicle_period_snapshots (
          snapshot_id,
          vehicle_id,
          vehicle_name,
          recommendation_status,
          data_confidence,
          metrics,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
      `,
      [
        snapshot.id,
        vehicle.vehicle_id,
        vehicle.vehicle_name,
        vehicle.recommendation_status,
        vehicle.data_confidence,
        JSON.stringify(vehicle),
      ]
    );
  }

  for (const flag of payload.flags) {
    await client.query(
      `
        INSERT INTO metric_data_quality_flags (
          period_key,
          entity_type,
          entity_id,
          flag_code,
          severity,
          confidence_penalty,
          note,
          created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      `,
      [
        snapshot.period_key,
        flag.entity_type,
        flag.entity_id,
        flag.flag_code,
        flag.severity,
        flag.confidence_penalty,
        flag.note,
      ]
    );
  }

  return {
    snapshot_id: snapshot.id,
    period_key: snapshot.period_key,
    generated_at: snapshot.generated_at,
    previous_period_key: formatQuarterKey(previousQuarter.start),
    fleet_summary: payload.fleet_summary,
    vehicles: payload.vehicles,
    flags: payload.flags,
  };
}

async function listBusinessMetricSnapshots(client = pool) {
  await ensureBusinessMetricsTables(client);
  const { rows } = await client.query(`
    SELECT id, period_key, period_type, range_start, range_end, data_confidence, generated_at, summary
    FROM metric_period_snapshots
    ORDER BY range_end DESC, generated_at DESC
  `);
  return rows;
}

function buildAnalysisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      period: { type: "string" },
      fleet_summary: {
        type: "object",
        additionalProperties: false,
        properties: {
          operating_profit: { type: "number" },
          cash_flow_after_debt_service: { type: "number" },
          profit_after_owner_labor: { type: "number" },
          fleet_equity: { type: "number" },
          confidence: { type: "string" },
        },
        required: [
          "operating_profit",
          "cash_flow_after_debt_service",
          "profit_after_owner_labor",
          "fleet_equity",
          "confidence",
        ],
      },
      vehicles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            vehicle_name: { type: "string" },
            status: { type: "string" },
            confidence: { type: "string" },
            reasons: { type: "array", items: { type: "string" } },
            recommended_actions: { type: "array", items: { type: "string" } },
          },
          required: [
            "vehicle_name",
            "status",
            "confidence",
            "reasons",
            "recommended_actions",
          ],
        },
      },
      fleet_recommendations: {
        type: "array",
        items: { type: "string" },
      },
      data_quality_warnings: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: [
      "period",
      "fleet_summary",
      "vehicles",
      "fleet_recommendations",
      "data_quality_warnings",
    ],
  };
}

async function buildQuarterlyAnalysisPayload(client = pool) {
  await ensureBusinessMetricsTables(client);
  const snapshot = await createBusinessMetricSnapshot("quarterly", client);
  const previousSnapshots = await listBusinessMetricSnapshots(client);
  const previous = previousSnapshots.find((item) => item.period_key !== snapshot.period_key) || null;

  const prompt = [
    "You are reviewing a Turo fleet business.",
    "Use only the supplied JSON snapshot.",
    "Do not treat gross revenue as success by itself.",
    "Separate operating profit, cash flow after debt service, profit after owner labor, and equity.",
    "Explain weak confidence where source data is incomplete.",
    "Classify each vehicle as SCALE TYPE, KEEP, OPTIMIZE, WATCH, SELL / EXIT, or INSUFFICIENT DATA.",
  ].join(" ");

  const inputPayload = {
    current_period: snapshot.period_key,
    previous_period: previous?.period_key || null,
    current_snapshot: {
      fleet_summary: snapshot.fleet_summary,
      vehicles: snapshot.vehicles,
      flags: snapshot.flags,
    },
    comparison_snapshot: previous?.summary || null,
    business_goals: await getBusinessFinancialSettings(client),
  };

  return {
    period_key: snapshot.period_key,
    prompt_version: "business-metrics-v1",
    prompt,
    json_schema: buildAnalysisSchema(),
    input_payload: inputPayload,
  };
}

module.exports = {
  ensureBusinessMetricsTables,
  syncTripFinancialFacts,
  getBusinessFinancialSettings,
  upsertBusinessFinancialSettings,
  listVehicleFinancialProfiles,
  upsertVehicleFinancialProfile,
  getBusinessMetrics,
  createBusinessMetricSnapshot,
  listBusinessMetricSnapshots,
  buildQuarterlyAnalysisPayload,
};
