const pool = require("../../db");
const { getParkingSpotUsage } = require("../vehicles/parkingSpotUsage");
const { ensureVehicleRuntimeSchema } = require("../vehicles/vehicleRuntimeSchema");
const {
  getCalendarDaysInRange,
  getDateRange,
  roundMoney,
  roundNumber,
  toNumber,
} = require("./metricHelpers");

const AVERAGE_DAYS_PER_MONTH = 365.25 / 12;

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function parseCsv(value) {
  return cleanText(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function toDateKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getParkingMetricPeriod(rangeKey) {
  const range = getDateRange(rangeKey);
  const startDate = range.startDate || new Date("2000-01-01T00:00:00");
  const endDate = range.endDate || new Date();
  const start = toDateKey(startDate);
  const end = toDateKey(addDays(endDate, 1));

  return {
    key: range.key,
    start,
    end,
    endExclusive: true,
    days: getCalendarDaysInRange(startDate, endDate),
  };
}

function getParkingEconomicsConfig() {
  const expenseKeywords = parseCsv(
    process.env.PARKING_SPOT_EXPENSE_KEYWORDS || "Park My Car Share"
  );
  const expenseCategories = parseCsv(process.env.PARKING_SPOT_EXPENSE_CATEGORIES);

  const dayRate = toNumber(process.env.PARKING_SPOT_DAY_RATE, 10);
  const unlimitedMonthly = toNumber(
    process.env.PARKING_SPOT_UNLIMITED_PASS_MONTHLY,
    100
  );
  const transponderMonthly = toNumber(
    process.env.PARKING_SPOT_TRANSPONDER_MONTHLY,
    6
  );
  const residentMonthly = toNumber(
    process.env.PARKING_SPOT_RESIDENT_MONTHLY,
    unlimitedMonthly
  );

  return {
    dayRate,
    unlimitedMonthly,
    transponderMonthly,
    residentMonthly,
    passVehicles: parseCsv(process.env.PARKING_SPOT_UNLIMITED_VEHICLES),
    payPerDayVehicles: parseCsv(process.env.PARKING_SPOT_PAY_PER_DAY_VEHICLES),
    residentVehicles: parseCsv(process.env.PARKING_SPOT_RESIDENT_VEHICLES),
    transponderVehicles: parseCsv(process.env.PARKING_SPOT_TRANSPONDER_VEHICLES),
    transponderExemptVehicles: parseCsv(
      process.env.PARKING_SPOT_TRANSPONDER_EXEMPT_VEHICLES
    ),
    expenseCategories,
    expenseKeywords,
    expenseMatchMode:
      cleanText(process.env.PARKING_SPOT_EXPENSE_MATCH_MODE).toLowerCase() ||
      "keyword_only",
  };
}

function getVehicleMatchTokens(vehicle) {
  return [
    vehicle?.vehicleId,
    vehicle?.id,
    vehicle?.vehicleName,
    vehicle?.nickname,
    vehicle?.vin,
    vehicle?.dimoTokenId,
    vehicle?.dimo_token_id,
    vehicle?.turoVehicleId,
    vehicle?.turo_vehicle_id,
  ]
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean);
}

function vehicleMatches(vehicle, configuredTokens) {
  if (!configuredTokens.length) return false;
  const vehicleTokens = new Set(getVehicleMatchTokens(vehicle));
  return configuredTokens.some((token) => vehicleTokens.has(token));
}

function getActualPlan(vehicle, config) {
  if (vehicleMatches(vehicle, config.residentVehicles)) return "resident";
  if (vehicleMatches(vehicle, config.passVehicles)) return "unlimited";
  if (vehicleMatches(vehicle, config.payPerDayVehicles)) return "pay_per_day";
  return "unknown";
}

function getActualMonthlyCost(plan, vehicle, config, monthEquivalent, parkingValue) {
  if (plan === "resident") {
    return config.residentMonthly * monthEquivalent;
  }

  if (plan === "unlimited") {
    const transponderCost = vehicleMatches(vehicle, config.transponderExemptVehicles)
      ? 0
      : config.transponderMonthly;
    return (config.unlimitedMonthly + transponderCost) * monthEquivalent;
  }

  if (plan === "pay_per_day") {
    return parkingValue;
  }

  return null;
}

async function getActiveVehicles() {
  await ensureVehicleRuntimeSchema(pool);

  const { rows } = await pool.query(
    `
      SELECT
        id,
        COALESCE(NULLIF(trim(nickname), ''), vin, 'Vehicle ' || id::text) AS vehicle_name,
        vin,
        dimo_token_id,
        turo_vehicle_id,
        COALESCE(trip_eligible, true) AS trip_eligible
      FROM vehicles
      WHERE COALESCE(is_active, true) = true
      ORDER BY vehicle_name
    `
  );

  return rows.map((row) => ({
    vehicleId: row.id,
    vehicleName: row.vehicle_name,
    vin: row.vin,
    dimoTokenId: row.dimo_token_id,
    turoVehicleId: row.turo_vehicle_id,
    trip_eligible: row.trip_eligible !== false,
    tripEligible: row.trip_eligible !== false,
    parkingDays: 0,
    days: [],
  }));
}

function getExpenseTotal(expense) {
  return toNumber(expense?.price) + toNumber(expense?.tax);
}

async function fetchParkingExpenses(period, config, activeVehicles) {
  const categoryValues = config.expenseCategories;
  const keywordValues = config.expenseKeywords;
  const params = [
    period.start,
    period.end,
    categoryValues,
    keywordValues,
    config.expenseMatchMode,
  ];

  const { rows } = await pool.query(
    `
      SELECT
        e.id,
        e.vehicle_id,
        e.trip_id,
        e.vendor,
        e.category,
        e.notes,
        e.expense_scope,
        e.price,
        e.tax,
        e.date,
        ev.nickname AS expense_vehicle_name,
        tv.id AS trip_vehicle_id,
        tv.nickname AS trip_vehicle_name
      FROM expenses e
      LEFT JOIN trips t
        ON t.id = e.trip_id
      LEFT JOIN vehicles tv
        ON t.turo_vehicle_id IS NOT NULL
        AND tv.turo_vehicle_id = t.turo_vehicle_id
      LEFT JOIN vehicles ev
        ON ev.id = e.vehicle_id
      WHERE e.date >= $1::date
        AND e.date < $2::date
        AND (
          CASE
            WHEN $5::text = 'category_only' THEN
              LOWER(TRIM(COALESCE(e.category, ''))) = ANY($3::text[])
            WHEN $5::text = 'keyword_only' THEN
              cardinality($4::text[]) > 0
              AND EXISTS (
                SELECT 1
                FROM unnest($4::text[]) AS keyword
                WHERE LOWER(COALESCE(e.vendor, '') || ' ' || COALESCE(e.notes, ''))
                  LIKE '%' || keyword || '%'
              )
            WHEN $5::text = 'category_and_keyword' THEN
              LOWER(TRIM(COALESCE(e.category, ''))) = ANY($3::text[])
              AND cardinality($4::text[]) > 0
              AND EXISTS (
                SELECT 1
                FROM unnest($4::text[]) AS keyword
                WHERE LOWER(COALESCE(e.vendor, '') || ' ' || COALESCE(e.notes, ''))
                  LIKE '%' || keyword || '%'
              )
            ELSE
              LOWER(TRIM(COALESCE(e.category, ''))) = ANY($3::text[])
              OR (
                cardinality($4::text[]) > 0
                AND EXISTS (
                  SELECT 1
                  FROM unnest($4::text[]) AS keyword
                  WHERE LOWER(COALESCE(e.vendor, '') || ' ' || COALESCE(e.notes, ''))
                    LIKE '%' || keyword || '%'
                )
              )
          END
        )
      ORDER BY e.date DESC, e.id DESC
    `,
    params
  );

  const activeVehicleIds = activeVehicles.map((vehicle) => String(vehicle.vehicleId));
  const sharedAllocationVehicleIds = activeVehicles
    .filter((vehicle) => vehicle?.trip_eligible !== false && vehicle?.tripEligible !== false)
    .map((vehicle) => String(vehicle.vehicleId));
  const activeVehicleCount = Math.max(1, sharedAllocationVehicleIds.length);
  const byVehicle = new Map(activeVehicleIds.map((vehicleId) => [vehicleId, []]));
  const lineItems = [];

  for (const row of rows) {
    const total = getExpenseTotal(row);
    if (!(total > 0)) continue;

    const scope = cleanText(row.expense_scope || "direct").toLowerCase();
    const resolvedVehicleId =
      row.vehicle_id != null
        ? String(row.vehicle_id)
        : row.trip_vehicle_id != null
        ? String(row.trip_vehicle_id)
        : null;
    const allocations = [];

    if (scope === "direct" && resolvedVehicleId) {
      allocations.push({ vehicleId: resolvedVehicleId, amount: total });
    } else if (scope === "shared" || scope === "general" || scope === "apportioned") {
      for (const vehicleId of sharedAllocationVehicleIds) {
        allocations.push({ vehicleId, amount: total / activeVehicleCount });
      }
    }

    const item = {
      expenseId: row.id,
      date: row.date,
      vendor: row.vendor || null,
      category: row.category || null,
      notes: row.notes || null,
      expenseScope: scope,
      totalAmount: roundMoney(total),
      vehicleId: resolvedVehicleId,
      vehicleName: row.expense_vehicle_name || row.trip_vehicle_name || null,
      allocatedVehicles: allocations.length,
    };

    lineItems.push(item);

    for (const allocation of allocations) {
      if (!byVehicle.has(allocation.vehicleId)) {
        byVehicle.set(allocation.vehicleId, []);
      }
      byVehicle.get(allocation.vehicleId).push({
        ...item,
        allocatedAmount: roundMoney(allocation.amount),
      });
    }
  }

  return {
    total: roundMoney(rows.reduce((sum, row) => sum + getExpenseTotal(row), 0)),
    count: rows.length,
    byVehicle,
    lineItems,
  };
}

async function getParkingEconomics(rangeKey = "30d") {
  const period = getParkingMetricPeriod(rangeKey);
  const config = getParkingEconomicsConfig();
  const [usage, activeVehicles] = await Promise.all([
    getParkingSpotUsage({ start: period.start, end: period.end }),
    getActiveVehicles(),
  ]);
  const usageByVehicle = new Map(
    usage.vehicles.map((vehicle) => [Number(vehicle.vehicleId), vehicle])
  );
  const airportDutyVehicles = activeVehicles.filter((vehicle) => {
    const usageVehicle = usageByVehicle.get(Number(vehicle.vehicleId));
    if (Number(usageVehicle?.parkingDays || 0) > 0) return true;
    return getActualPlan(vehicle, config) !== "unknown";
  });
  const expenseActuals = await fetchParkingExpenses(
    period,
    config,
    airportDutyVehicles.length ? airportDutyVehicles : activeVehicles
  );
  const monthEquivalent = period.days / AVERAGE_DAYS_PER_MONTH;
  const standardFixedCost =
    (config.unlimitedMonthly + config.transponderMonthly) * monthEquivalent;
  const residentFixedCost = config.residentMonthly * monthEquivalent;
  const standardBreakEvenDays = standardFixedCost / config.dayRate;

  const vehicles = activeVehicles.map((vehicle) => {
    const usageVehicle = usageByVehicle.get(Number(vehicle.vehicleId));
    const merged = usageVehicle ? { ...vehicle, ...usageVehicle } : vehicle;
    const parkingDays = Number(merged.parkingDays || 0);
    const parkingValue = parkingDays * config.dayRate;
    const actualPlan = getActualPlan(merged, config);
    const hasConfiguredParkingPlan = actualPlan !== "unknown";
    const hasAirportDuty = parkingDays > 0 || hasConfiguredParkingPlan;
    const isResident = actualPlan === "resident";
    const fixedCost = !hasAirportDuty
      ? 0
      : isResident
      ? residentFixedCost
      : standardFixedCost;
    const breakEvenDays = fixedCost / config.dayRate;
    const actualCost = getActualMonthlyCost(
      actualPlan,
      merged,
      config,
      monthEquivalent,
      parkingValue
    );
    const parkingExpenseItems =
      expenseActuals.byVehicle.get(String(merged.vehicleId)) || [];
    const actualParkingExpense = parkingExpenseItems.reduce(
      (sum, expense) => sum + toNumber(expense.allocatedAmount),
      0
    );
    const passNetValue = parkingValue - fixedCost;
    const recommendedPlan = isResident
      ? "resident_unlimited"
      : parkingValue >= standardFixedCost
      ? "unlimited"
      : "pay_per_day";

    return {
      vehicleId: merged.vehicleId,
      vehicleName: merged.vehicleName,
      vin: merged.vin,
      dimoTokenId: merged.dimoTokenId,
      parkingDays,
      parkingValue: roundMoney(parkingValue),
      actualPlan,
      actualCost: actualCost == null ? null : roundMoney(actualCost),
      actualParkingExpense: roundMoney(actualParkingExpense),
      parkingExpenseCount: parkingExpenseItems.length,
      hasAirportDuty,
      fixedPassCost: roundMoney(fixedCost),
      passNetValue: roundMoney(passNetValue),
      valueVsActualParkingExpense: roundMoney(parkingValue - actualParkingExpense),
      savingsIfPayPerDay: roundMoney(fixedCost - parkingValue),
      breakEvenDays: hasAirportDuty ? roundNumber(breakEvenDays, 1) : null,
      recommendedPlan: hasAirportDuty ? recommendedPlan : "no_airport_duty",
      recommendation: !hasAirportDuty
        ? "No airport duty"
        : recommendedPlan === "pay_per_day"
        ? "Drop unlimited"
        : isResident
        ? "Keep resident car"
        : "Keep unlimited",
      firstParkingDay: merged.firstParkingDay || null,
      lastParkingDay: merged.lastParkingDay || null,
      expenseLineItems: parkingExpenseItems.slice(0, 8),
    };
  });

  const summary = vehicles.reduce(
    (totals, vehicle) => {
      totals.fleetVehicleDays += vehicle.parkingDays;
      totals.parkingValue += vehicle.parkingValue;
      totals.fixedPassCost += vehicle.fixedPassCost;
      totals.passNetValue += vehicle.passNetValue;
      totals.actualParkingExpense += vehicle.actualParkingExpense;
      totals.valueVsActualParkingExpense += vehicle.valueVsActualParkingExpense;
      if (vehicle.actualCost != null) totals.actualCost += vehicle.actualCost;
      if (vehicle.actualPlan !== "unknown") totals.actualCostKnown = true;
      if (vehicle.recommendedPlan === "unlimited") totals.keepUnlimitedCount += 1;
      if (vehicle.recommendedPlan === "pay_per_day") totals.dropUnlimitedCount += 1;
      if (vehicle.recommendedPlan === "resident_unlimited") totals.residentCount += 1;
      return totals;
    },
    {
      fleetVehicleDays: 0,
      parkingValue: 0,
      fixedPassCost: 0,
      passNetValue: 0,
      actualCost: 0,
      actualParkingExpense: 0,
      valueVsActualParkingExpense: 0,
      actualCostKnown: false,
      keepUnlimitedCount: 0,
      dropUnlimitedCount: 0,
      residentCount: 0,
    }
  );

  return {
    ok: true,
    period,
    parkingSpot: usage.parkingSpot,
    assumptions: {
      dayRate: config.dayRate,
      unlimitedMonthly: config.unlimitedMonthly,
      transponderMonthly: config.transponderMonthly,
      residentMonthly: config.residentMonthly,
      expenseCategories: config.expenseCategories,
      expenseKeywords: config.expenseKeywords,
      expenseMatchMode: config.expenseMatchMode,
      monthEquivalent: roundNumber(monthEquivalent, 2),
      standardBreakEvenDays: roundNumber(standardBreakEvenDays, 1),
      actualCostConfigured:
        config.passVehicles.length > 0 ||
        config.payPerDayVehicles.length > 0 ||
        config.residentVehicles.length > 0,
    },
    summary: {
      ...summary,
      parkingValue: roundMoney(summary.parkingValue),
      fixedPassCost: roundMoney(summary.fixedPassCost),
      passNetValue: roundMoney(summary.passNetValue),
      actualParkingExpense: roundMoney(summary.actualParkingExpense),
      valueVsActualParkingExpense: roundMoney(summary.valueVsActualParkingExpense),
      parkingExpenseCount: expenseActuals.count,
      actualCost: summary.actualCostKnown ? roundMoney(summary.actualCost) : null,
    },
    expenseLineItems: expenseActuals.lineItems.slice(0, 25),
    vehicles: vehicles.sort((a, b) => {
      if (b.parkingDays !== a.parkingDays) return b.parkingDays - a.parkingDays;
      return String(a.vehicleName).localeCompare(String(b.vehicleName));
    }),
  };
}

module.exports = {
  getParkingEconomics,
  getParkingEconomicsConfig,
  getVehicleMatchTokens,
  vehicleMatches,
};
