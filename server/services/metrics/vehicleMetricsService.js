// ------------------------------------------------------------
// /server/services/metrics/vehicleMetricsService.js
// Per-vehicle metrics for the metrics panel card grid.
// ------------------------------------------------------------

const pool = require("../../db");
const {
  clampNonNegative,
  getDateRange,
  getExpenseTotal,
  getOverlapDays,
  getTripFuelReimbursementValue,
  getTripMiles,
  getTripProratedAmount,
  getTripProratedCount,
  getTripProratedValue,
  getTripRecognizedTollRevenueValue,
  isTripTollAttributedOutstanding,
  isTripTollRecovered,
  roundMoney,
  roundNumber,
  safeDivide,
  toMapBy,
  toNumber,
  tripOverlapsRange,
} = require("./metricHelpers");
const {
  getCapitalMetricsByVehicle,
} = require("./capitalMetricsService");
const {
  getLatestVehicleFmvEstimates,
} = require("../vehicles/fmvEstimateService");

async function fetchActiveVehicles(client) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        vin,
        nickname,
        make,
        model,
        year,
        turo_vehicle_id,
        current_odometer_miles,
        onboarding_date,
        acquisition_cost,
        is_active,
        in_service
      FROM vehicles
      WHERE is_active = true
        AND in_service = true
      ORDER BY COALESCE(nickname, vin)
    `
  );

  return rows;
}

async function fetchTripsForVehicles(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        id,
        reservation_id,
        guest_name,
        turo_vehicle_id,
        trip_start,
        trip_end,
        amount,
        fuel_reimbursement_total,
        starting_odometer,
        ending_odometer,
        toll_total,
        toll_review_status,
        workflow_stage,
        expense_status,
        completed_at,
        canceled_at
      FROM trips
      WHERE trip_start <= $2
        AND trip_end >= COALESCE($1, trip_start)
        AND (
          canceled_at IS NULL
          OR COALESCE(amount, 0) > 0
        )
    `,
    [startDate, endDate]
  );

  return rows.filter((trip) => tripOverlapsRange(trip, startDate, endDate));
}

async function fetchExpensesForVehicles(client, startDate, endDate) {
  if (!startDate) {
    const { rows } = await client.query(
      `
        SELECT
          id,
          vehicle_id,
          vendor,
          price,
          tax,
          category,
          expense_scope,
          trip_id,
          date,
          is_capitalized
        FROM expenses
        WHERE date <= $1::date
      `,
      [endDate]
    );
    return rows;
  }

  const { rows } = await client.query(
    `
      SELECT
        id,
        vehicle_id,
        vendor,
        price,
        tax,
        category,
        expense_scope,
        trip_id,
        date,
        is_capitalized
      FROM expenses
      WHERE date >= $1::date
        AND date <= $2::date
    `,
    [startDate, endDate]
  );

  return rows;
}

async function fetchVehicleOdometerAnchors(client, startDate, endDate) {
  const { rows } = await client.query(
    `
      SELECT
        v.id AS vehicle_id,

        start_before.odometer_miles AS start_before_odometer,
        start_before.recorded_at AS start_before_recorded_at,

        start_in_range.odometer_miles AS start_in_range_odometer,
        start_in_range.recorded_at AS start_in_range_recorded_at,

        end_row.odometer_miles AS end_odometer,
        end_row.recorded_at AS end_recorded_at

      FROM vehicles v

      LEFT JOIN LATERAL (
        SELECT h.odometer_miles, h.recorded_at
        FROM vehicle_odometer_history h
        WHERE h.vehicle_id = v.id
          AND $1::timestamp IS NOT NULL
          AND h.recorded_at <= $1::timestamp
        ORDER BY h.recorded_at DESC
        LIMIT 1
      ) start_before ON true

      LEFT JOIN LATERAL (
        SELECT h.odometer_miles, h.recorded_at
        FROM vehicle_odometer_history h
        WHERE h.vehicle_id = v.id
          AND $1::timestamp IS NOT NULL
          AND h.recorded_at >= $1::timestamp
          AND h.recorded_at <= $2::timestamp
        ORDER BY h.recorded_at ASC
        LIMIT 1
      ) start_in_range ON true

      LEFT JOIN LATERAL (
        SELECT h.odometer_miles, h.recorded_at
        FROM vehicle_odometer_history h
        WHERE h.vehicle_id = v.id
          AND h.recorded_at <= $2::timestamp
        ORDER BY h.recorded_at DESC
        LIMIT 1
      ) end_row ON true

      WHERE v.is_active = true
        AND v.in_service = true
    `,
    [startDate, endDate]
  );

  return rows;
}

async function fetchOffTripAuditReviews(client) {
  const { rows } = await client.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = 'metrics.off_trip_audit_reviews'
      LIMIT 1
    `
  );

  const value = rows[0]?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function isTripActiveAtRangeEnd(trip, endDate) {
  if (!trip || !endDate) return false;
  if (trip.canceled_at) return false;

  const rangeEnd = new Date(endDate);
  const tripStart = trip.trip_start ? new Date(trip.trip_start) : null;
  const tripEnd = trip.trip_end ? new Date(trip.trip_end) : null;

  if (
    !tripStart ||
    Number.isNaN(rangeEnd.getTime()) ||
    Number.isNaN(tripStart.getTime())
  ) {
    return false;
  }

  if (tripStart > rangeEnd) return false;

  if (!tripEnd || Number.isNaN(tripEnd.getTime())) {
    return true;
  }

  return tripEnd >= rangeEnd;
}

function hasOpenTripAtRangeEnd(trips, endDate) {
  return (trips || []).some((trip) => isTripActiveAtRangeEnd(trip, endDate));
}

function buildTripVehicleKeyMaps(vehicles) {
  const byTuroVehicleId = new Map();

  for (const vehicle of vehicles) {
    if (vehicle.turo_vehicle_id) {
      byTuroVehicleId.set(String(vehicle.turo_vehicle_id), String(vehicle.id));
    }
  }

  return { byTuroVehicleId };
}

function resolveTripVehicleId(trip, maps) {
  if (
    trip?.turo_vehicle_id &&
    maps.byTuroVehicleId.has(String(trip.turo_vehicle_id))
  ) {
    return maps.byTuroVehicleId.get(String(trip.turo_vehicle_id));
  }

  return null;
}

function getTripSortTime(trip, fieldName) {
  const value = trip?.[fieldName];
  if (!value) return 0;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function calculateTripOffTripMiles(trips) {
  const odometerTrips = (trips || [])
    .filter((trip) => toNumber(trip?.starting_odometer, null) != null)
    .slice()
    .sort((a, b) => {
      const startDiff =
        getTripSortTime(a, "trip_start") - getTripSortTime(b, "trip_start");
      if (startDiff) return startDiff;
      return Number(a.id || 0) - Number(b.id || 0);
    });

  if (!odometerTrips.length) {
    return {
      offTripMiles: 0,
      tripMiles: 0,
      totalMiles: 0,
      firstTripStartOdometer: null,
      lastClosedTripEndOdometer: null,
      closedTripCount: 0,
      skippedClosedTripCount: 0,
      confidence: "missing",
    };
  }

  let firstTripStartOdometer = null;
  let lastClosedTripEndOdometer = null;
  let lastKnownOdometer = null;
  let offTripMiles = 0;
  let tripMiles = 0;
  let tripOdometerCount = 0;
  let skippedTripOdometerCount = 0;

  for (const trip of odometerTrips) {
    const startOdometer = toNumber(trip.starting_odometer, null);
    const endOdometer = toNumber(trip.ending_odometer, null);

    if (startOdometer == null) {
      skippedTripOdometerCount += 1;
      continue;
    }

    if (firstTripStartOdometer == null) {
      firstTripStartOdometer = startOdometer;
      lastKnownOdometer = startOdometer;
    }

    if (lastKnownOdometer != null && startOdometer > lastKnownOdometer) {
      offTripMiles += startOdometer - lastKnownOdometer;
      lastKnownOdometer = startOdometer;
    }

    if (endOdometer == null) {
      tripOdometerCount += 1;
      continue;
    }

    if (endOdometer < startOdometer) {
      skippedTripOdometerCount += 1;
      continue;
    }

    if (lastKnownOdometer != null && endOdometer < lastKnownOdometer) {
      skippedTripOdometerCount += 1;
      continue;
    }

    tripMiles += Math.max(
      0,
      endOdometer - Math.max(startOdometer, lastKnownOdometer || startOdometer)
    );
    lastKnownOdometer = endOdometer;
    lastClosedTripEndOdometer = endOdometer;
    tripOdometerCount += 1;
  }

  if (
    firstTripStartOdometer == null ||
    lastClosedTripEndOdometer == null ||
    lastClosedTripEndOdometer < firstTripStartOdometer
  ) {
    return {
      offTripMiles: 0,
      tripMiles,
      totalMiles: 0,
      firstTripStartOdometer,
      lastClosedTripEndOdometer,
      closedTripCount: tripOdometerCount,
      skippedClosedTripCount: skippedTripOdometerCount,
      confidence: "low",
    };
  }

  const totalMiles = lastKnownOdometer - firstTripStartOdometer;

  return {
    offTripMiles: clampNonNegative(offTripMiles),
    tripMiles,
    totalMiles,
    firstTripStartOdometer,
    lastClosedTripEndOdometer,
    closedTripCount: tripOdometerCount,
    skippedClosedTripCount: skippedTripOdometerCount,
    confidence: skippedTripOdometerCount > 0 ? "medium" : "high",
  };
}

function calculateTripOffTripAudit(trips) {
  const odometerTrips = (trips || [])
    .filter((trip) => toNumber(trip?.starting_odometer, null) != null)
    .slice()
    .sort((a, b) => {
      const startDiff =
        getTripSortTime(a, "trip_start") - getTripSortTime(b, "trip_start");
      if (startDiff) return startDiff;
      return Number(a.id || 0) - Number(b.id || 0);
    });

  const segments = [];
  const skippedTrips = [];
  let lastKnownOdometer = null;
  let lastClosedTrip = null;

  for (const trip of odometerTrips) {
    const startOdometer = toNumber(trip.starting_odometer, null);
    const endOdometer = toNumber(trip.ending_odometer, null);

    if (startOdometer == null) {
      continue;
    }

    if (lastKnownOdometer == null) {
      lastKnownOdometer = startOdometer;
    }

    if (lastKnownOdometer != null && startOdometer > lastKnownOdometer) {
      const gapMiles = clampNonNegative(startOdometer - lastKnownOdometer);
      const previousTripEndMs =
        lastClosedTrip?.trip_end ? new Date(lastClosedTrip.trip_end).getTime() : NaN;
      const nextTripStartMs = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;

      segments.push({
        previous_trip_id: lastClosedTrip?.id ?? null,
        previous_reservation_id: lastClosedTrip?.reservation_id ?? null,
        previous_guest_name: lastClosedTrip?.guest_name ?? null,
        previous_trip_end: lastClosedTrip?.trip_end ?? null,
        previous_ending_odometer: lastKnownOdometer,
        next_trip_id: trip?.id ?? null,
        next_reservation_id: trip?.reservation_id ?? null,
        next_guest_name: trip?.guest_name ?? null,
        next_trip_start: trip?.trip_start ?? null,
        next_starting_odometer: startOdometer,
        off_trip_miles: gapMiles,
        gap_days:
          Number.isFinite(previousTripEndMs) && Number.isFinite(nextTripStartMs)
            ? roundNumber(
                (nextTripStartMs - previousTripEndMs) / (1000 * 60 * 60 * 24),
                2
              )
            : null,
      });

      lastKnownOdometer = startOdometer;
    }

    if (endOdometer == null) {
      continue;
    }

    if (endOdometer < startOdometer) {
      skippedTrips.push({
        trip_id: trip?.id ?? null,
        reservation_id: trip?.reservation_id ?? null,
        guest_name: trip?.guest_name ?? null,
        trip_start: trip?.trip_start ?? null,
        trip_end: trip?.trip_end ?? null,
        starting_odometer: startOdometer,
        ending_odometer: endOdometer,
        reason: "ending odometer before starting odometer",
        anchor_previous_reservation_id: lastClosedTrip?.reservation_id ?? null,
        anchor_previous_guest_name: lastClosedTrip?.guest_name ?? null,
        anchor_previous_trip_end: lastClosedTrip?.trip_end ?? null,
        anchor_previous_ending_odometer: lastKnownOdometer,
      });
      continue;
    }

    if (lastKnownOdometer != null && endOdometer < lastKnownOdometer) {
      skippedTrips.push({
        trip_id: trip?.id ?? null,
        reservation_id: trip?.reservation_id ?? null,
        guest_name: trip?.guest_name ?? null,
        trip_start: trip?.trip_start ?? null,
        trip_end: trip?.trip_end ?? null,
        starting_odometer: startOdometer,
        ending_odometer: endOdometer,
        reason: "trip odometer regressed below prior known vehicle odometer",
        anchor_previous_reservation_id: lastClosedTrip?.reservation_id ?? null,
        anchor_previous_guest_name: lastClosedTrip?.guest_name ?? null,
        anchor_previous_trip_end: lastClosedTrip?.trip_end ?? null,
        anchor_previous_ending_odometer: lastKnownOdometer,
      });
      continue;
    }

    lastKnownOdometer = endOdometer;
    lastClosedTrip = trip;
  }

  return {
    segments,
    skippedTrips,
  };
}

function buildSegmentAuditKey(segment) {
  return [
    "segment",
    segment.vehicle_id,
    segment.previous_trip_id ?? "start",
    segment.next_trip_id ?? "next",
  ].join(":");
}

function buildSkippedTripAuditKey(skippedTrip) {
  return [
    "skipped",
    skippedTrip.vehicle_id,
    skippedTrip.trip_id ?? skippedTrip.reservation_id ?? "trip",
  ].join(":");
}

function normalizeAuditReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      review_status: null,
      review_reason: null,
      reconciled_off_trip_miles: null,
      reviewed_at: null,
    };
  }

  const reviewStatus =
    typeof value.review_status === "string" && value.review_status.trim() !== ""
      ? value.review_status.trim().toLowerCase()
      : null;

  const reviewReason =
    typeof value.review_reason === "string" && value.review_reason.trim() !== ""
      ? value.review_reason.trim()
      : null;

  const reviewedAt =
    typeof value.reviewed_at === "string" && value.reviewed_at.trim() !== ""
      ? value.reviewed_at
      : null;

  const reconciledOffTripMiles =
    value.reconciled_off_trip_miles === "" ||
    value.reconciled_off_trip_miles == null
      ? null
      : toNumber(value.reconciled_off_trip_miles, null);

  return {
    review_status: reviewStatus,
    review_reason: reviewReason,
    reconciled_off_trip_miles: reconciledOffTripMiles,
    reviewed_at: reviewedAt,
  };
}

function applyAuditReview(row, reviewMap, keyBuilder) {
  const auditKey = keyBuilder(row);
  const review = normalizeAuditReview(reviewMap?.[auditKey]);
  const rawOffTripMiles =
    row?.off_trip_miles == null ? null : Number(row.off_trip_miles);
  const effectiveOffTripMiles =
    review.reconciled_off_trip_miles != null
      ? review.reconciled_off_trip_miles
      : rawOffTripMiles;

  return {
    ...row,
    audit_key: auditKey,
    raw_off_trip_miles: rawOffTripMiles,
    off_trip_miles: effectiveOffTripMiles,
    ...review,
    is_reviewed: Boolean(review.review_status),
  };
}

function resolveAnchorStart(anchor) {
  if (anchor?.start_before_odometer != null) {
    return {
      odometer: toNumber(anchor.start_before_odometer),
      source: "before_range",
    };
  }

  if (anchor?.start_in_range_odometer != null) {
    return {
      odometer: toNumber(anchor.start_in_range_odometer),
      source: "in_range",
    };
  }

  return {
    odometer: null,
    source: "missing",
  };
}

function getRangeDayCount(startDate, endDate) {
  const end = endDate ? new Date(endDate) : null;
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    return 0;
  }

  if (!startDate) {
    return 90;
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    return 0;
  }

  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(1, Math.ceil((end - start) / msPerDay));
}

function getDaysSinceOnboarding(onboardingDate) {
  if (!onboardingDate) return 0;

  const onboard = new Date(onboardingDate);
  if (Number.isNaN(onboard.getTime())) return 0;

  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.max(1, Math.ceil((now - onboard) / msPerDay));
}

function projectPayoff({
  capitalBasis,
  capitalRecovered,
  capitalRemaining,
  tripIncome,
  tripCountOverlapping,
  startDate,
  endDate,
  onboardingDate,
}) {
  const rangeDays = getRangeDayCount(startDate, endDate);
  const daysSinceOnboarding = getDaysSinceOnboarding(onboardingDate);

  const recentDailyRecovery =
    rangeDays > 0 ? safeDivide(tripIncome, rangeDays, 0) : 0;

  const lifetimeDailyRecovery =
    daysSinceOnboarding > 0
      ? safeDivide(capitalRecovered, daysSinceOnboarding, 0)
      : 0;

  let chosenDailyRecovery = 0;
  let projectedPayoffStatus = "no_revenue";

  if (toNumber(capitalBasis) <= 0) {
    return {
      capital_recovery_rate_monthly: 0,
      projected_payoff_days: null,
      projected_payoff_date: null,
      projected_payoff_status: "no_basis",
      payoff_confidence: "none",
    };
  }

  if (toNumber(capitalRemaining) <= 0) {
    return {
      capital_recovery_rate_monthly: 0,
      projected_payoff_days: 0,
      projected_payoff_date: null,
      projected_payoff_status: "paid_off",
      payoff_confidence: "complete",
    };
  }

  if (recentDailyRecovery > 0 && tripCountOverlapping >= 2) {
    chosenDailyRecovery = recentDailyRecovery;
    projectedPayoffStatus = "projected_recent";
  } else if (recentDailyRecovery > 0 && lifetimeDailyRecovery > 0) {
    chosenDailyRecovery =
      recentDailyRecovery * 0.65 + lifetimeDailyRecovery * 0.35;
    projectedPayoffStatus = "projected_blended";
  } else if (lifetimeDailyRecovery > 0) {
    chosenDailyRecovery = lifetimeDailyRecovery;
    projectedPayoffStatus = "projected_lifetime";
  }

  if (chosenDailyRecovery <= 0) {
    return {
      capital_recovery_rate_monthly: 0,
      projected_payoff_days: null,
      projected_payoff_date: null,
      projected_payoff_status: "no_revenue",
      payoff_confidence: "low",
    };
  }

  const projectedDays = Math.max(
    1,
    Math.ceil(toNumber(capitalRemaining) / chosenDailyRecovery)
  );

  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  anchor.setDate(anchor.getDate() + projectedDays);

  let payoffConfidence = "medium";
  if (projectedPayoffStatus === "projected_recent") payoffConfidence = "high";
  if (projectedPayoffStatus === "projected_lifetime") payoffConfidence = "low";

  return {
    capital_recovery_rate_monthly: roundMoney(chosenDailyRecovery * 30),
    projected_payoff_days: projectedDays,
    projected_payoff_date: anchor.toISOString(),
    projected_payoff_status: projectedPayoffStatus,
    payoff_confidence: payoffConfidence,
  };
}

async function getVehicleMetrics(rangeKey = "30d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const client = await pool.connect();

  try {
    const vehicles = await fetchActiveVehicles(client);
    const trips = await fetchTripsForVehicles(client, startDate, endDate);
    const expenses = await fetchExpensesForVehicles(client, startDate, endDate);
    const odometerAnchors = await fetchVehicleOdometerAnchors(
      client,
      startDate,
      endDate
    );
    const capitalMetricsRows = await getCapitalMetricsByVehicle(client);
    const latestFmvEstimates = await getLatestVehicleFmvEstimates(client);

    const odometerMap = toMapBy(odometerAnchors, (row) =>
      String(row.vehicle_id)
    );
    const capitalMetricsMap = toMapBy(capitalMetricsRows, (row) =>
      String(row.vehicle_id)
    );
    const latestFmvMap = new Map(
      latestFmvEstimates
        .map((row) => [String(row?.vehicle?.vin || row?.vehicle_vin || ""), row])
        .filter(([key]) => key)
    );

    const tripIdToVehicleId = new Map();
    const maps = buildTripVehicleKeyMaps(vehicles);

    const vehicleTrips = new Map();
    const vehicleMetrics = new Map();

    for (const vehicle of vehicles) {
      const vehicleId = String(vehicle.id);
      vehicleTrips.set(vehicleId, []);

      const anchor = odometerMap.get(vehicleId) || {};
      const resolvedStart = resolveAnchorStart(anchor);
      const resolvedEnd =
        anchor?.end_odometer != null ? toNumber(anchor.end_odometer) : null;

      let totalMiles = 0;
      let mileageConfidence = "low";

      if (
        resolvedStart.odometer != null &&
        resolvedEnd != null &&
        resolvedEnd >= resolvedStart.odometer
      ) {
        totalMiles = resolvedEnd - resolvedStart.odometer;

        if (resolvedStart.source === "before_range") {
          mileageConfidence = "high";
        } else if (resolvedStart.source === "in_range") {
          mileageConfidence = "medium";
        }
      }

      const capital = capitalMetricsMap.get(vehicleId) || {};

      vehicleMetrics.set(vehicleId, {
        vehicle_id: vehicleId,
        nickname: vehicle.nickname,
        vin: vehicle.vin,
        turo_vehicle_id: vehicle.turo_vehicle_id,
        current_odometer: vehicle.current_odometer_miles,

        onboarding_date: capital.onboarding_date || vehicle.onboarding_date,
        acquisition_cost: roundMoney(vehicle.acquisition_cost || 0),

        onboarding_expenses: roundMoney(toNumber(capital.onboarding_expenses)),
        capital_basis: roundMoney(toNumber(capital.capital_basis)),
        capital_recovered: roundMoney(toNumber(capital.capital_recovered)),
        capital_remaining: roundMoney(toNumber(capital.capital_remaining)),
        capital_recovery_pct: roundNumber(
          toNumber(capital.capital_recovery_pct),
          1
        ),
        capital_status: String(capital.capital_status || "no_basis"),

        capital_recovery_rate_monthly: 0,
        projected_payoff_days: null,
        projected_payoff_date: null,
        projected_payoff_status: "no_basis",
        payoff_confidence: "none",

        trip_income: 0,
        fuel_reimbursement_income: 0,
        toll_revenue_income: 0,
        other_income: 0,
        direct_expenses: 0,
        general_expenses: 0,
        shared_expenses: 0,
        apportioned_expenses: 0,
        total_expenses: 0,
        net_profit: 0,
        trip_count_overlapping: 0,
        trip_count_prorated: 0,
        booked_vehicle_days: 0,
        income_per_overlapping_trip: 0,
        income_per_prorated_trip: 0,
        income_per_booked_day: 0,
        trip_miles: 0,
        total_miles: totalMiles,
        off_trip_miles: 0,
        unallocated_miles: 0,
        has_open_trip_at_range_end: false,
        mileage_confidence: mileageConfidence,
        tolls_recovered: 0,
        tolls_attributed_outstanding: 0,
        tolls_unattributed: 0,
        tolls_paid: 0,
        fmv_estimate_low: null,
        fmv_estimate_mid: null,
        fmv_estimate_high: null,
        fmv_estimated_at: null,
        fmv_confidence: null,
        fmv_previous_mid: null,
        fmv_previous_estimated_at: null,
        fmv_change: null,
      });
    }

    for (const trip of trips) {
      const vehicleId = resolveTripVehicleId(trip, maps);
      if (!vehicleId) continue;

      tripIdToVehicleId.set(String(trip.id), vehicleId);

      if (!vehicleTrips.has(vehicleId)) {
        vehicleTrips.set(vehicleId, []);
      }

      vehicleTrips.get(vehicleId).push(trip);
    }

    for (const vehicle of vehicles) {
      const vehicleId = String(vehicle.id);
      const metrics = vehicleMetrics.get(vehicleId);
      const latestFmv = latestFmvMap.get(String(vehicle.vin || ""));
      const tripsForVehicle = vehicleTrips.get(vehicleId) || [];
      const closedTripMileage = calculateTripOffTripMiles(tripsForVehicle);
      
      const openTripAtRangeEnd = hasOpenTripAtRangeEnd(tripsForVehicle, endDate);
      metrics.has_open_trip_at_range_end = openTripAtRangeEnd;
      metrics.closed_trip_mileage_count = closedTripMileage.closedTripCount;
      metrics.closed_trip_mileage_skipped_count =
        closedTripMileage.skippedClosedTripCount;
      metrics.closed_trip_mileage_total = roundNumber(
        closedTripMileage.totalMiles,
        1
      );
      metrics.closed_trip_recorded_miles = roundNumber(
        closedTripMileage.tripMiles,
        1
      );
      metrics.closed_trip_mileage_confidence = closedTripMileage.confidence;
      metrics.closed_trip_off_trip_miles = roundNumber(
        closedTripMileage.offTripMiles,
        1
      );
      metrics.first_trip_start_odometer =
        closedTripMileage.firstTripStartOdometer;
      metrics.last_closed_trip_end_odometer =
        closedTripMileage.lastClosedTripEndOdometer;
      metrics.trip_count_overlapping = tripsForVehicle.length;

      metrics.trip_count_prorated = tripsForVehicle.reduce(
        (sum, trip) => sum + getTripProratedCount(trip, startDate, endDate),
        0
      );

      metrics.trip_income = roundMoney(
        tripsForVehicle.reduce(
          (sum, trip) => sum + getTripProratedAmount(trip, startDate, endDate),
          0
        )
      );

      metrics.fuel_reimbursement_income = roundMoney(
        tripsForVehicle.reduce(
          (sum, trip) =>
            sum + getTripFuelReimbursementValue(trip, startDate, endDate),
          0
        )
      );

      metrics.toll_revenue_income = roundMoney(
        tripsForVehicle.reduce(
          (sum, trip) =>
            sum + getTripRecognizedTollRevenueValue(trip, startDate, endDate),
          0
        )
      );

      metrics.other_income = roundMoney(
        toNumber(metrics.fuel_reimbursement_income) +
          toNumber(metrics.toll_revenue_income)
      );

      metrics.booked_vehicle_days = tripsForVehicle.reduce(
        (sum, trip) =>
          sum +
          getOverlapDays(trip.trip_start, trip.trip_end, startDate, endDate),
        0
      );

      metrics.trip_miles = tripsForVehicle.reduce(
        (sum, trip) => sum + getTripMiles(trip),
        0
      );

      metrics.tolls_recovered = roundMoney(
        tripsForVehicle.reduce((sum, trip) => {
          if (!isTripTollRecovered(trip)) return sum;

          return (
            sum +
            getTripProratedValue(
              trip.toll_total,
              trip.trip_start,
              trip.trip_end,
              startDate,
              endDate
            )
          );
        }, 0)
      );

      metrics.tolls_attributed_outstanding = roundMoney(
        tripsForVehicle.reduce((sum, trip) => {
          if (!isTripTollAttributedOutstanding(trip)) return sum;

          return (
            sum +
            getTripProratedValue(
              trip.toll_total,
              trip.trip_start,
              trip.trip_end,
              startDate,
              endDate
            )
          );
        }, 0)
      );

      if (metrics.total_miles <= 0 && metrics.trip_miles > 0) {
        metrics.mileage_confidence = "medium";
      }
    }

    const activeVehicleCount = vehicles.length || 1;

    let totalFleetMiles = 0;
    let totalFleetTripMiles = 0;

    for (const metrics of vehicleMetrics.values()) {
      totalFleetMiles += toNumber(metrics.total_miles);
      totalFleetTripMiles += toNumber(metrics.trip_miles);
    }

    const apportionedBase =
      totalFleetMiles > 0 ? totalFleetMiles : totalFleetTripMiles;

    for (const expense of expenses) {
      const total = getExpenseTotal(expense);
      const scope = String(expense.expense_scope || "direct").toLowerCase();

      let resolvedVehicleId =
        expense.vehicle_id != null ? String(expense.vehicle_id) : null;

      if (
        !resolvedVehicleId &&
        expense.trip_id &&
        tripIdToVehicleId.has(String(expense.trip_id))
      ) {
        resolvedVehicleId = tripIdToVehicleId.get(String(expense.trip_id));
      }

      if (scope === "direct") {
        if (resolvedVehicleId && vehicleMetrics.has(resolvedVehicleId)) {
          const metrics = vehicleMetrics.get(resolvedVehicleId);

          metrics.direct_expenses += total;

          if (
            String(expense.category || "").toLowerCase() === "tolls" ||
            String(expense.vendor || "").toLowerCase().includes("hctra")
          ) {
            metrics.tolls_paid += total;
          }
        }

        continue;
      }

      if (scope === "general" || scope === "shared") {
        const evenShare = total / activeVehicleCount;

        for (const metrics of vehicleMetrics.values()) {
          if (scope === "shared") {
            metrics.shared_expenses += evenShare;
          } else {
            metrics.general_expenses += evenShare;
          }

          if (
            String(expense.category || "").toLowerCase() === "tolls" ||
            String(expense.vendor || "").toLowerCase().includes("hctra")
          ) {
            metrics.tolls_paid += evenShare;
          }
        }
        continue;
      }

      if (scope === "apportioned") {
        const useMiles = apportionedBase > 0;

        for (const metrics of vehicleMetrics.values()) {
          const basisMiles =
            totalFleetMiles > 0
              ? metrics.mileage_confidence === "high" ||
                metrics.mileage_confidence === "medium"
                ? toNumber(metrics.total_miles)
                : 0
              : toNumber(metrics.trip_miles);

          const share = useMiles
            ? safeDivide(basisMiles, apportionedBase, 0)
            : safeDivide(1, activeVehicleCount, 0);

          metrics.apportioned_expenses += total * share;

          if (
            String(expense.category || "").toLowerCase() === "tolls" ||
            String(expense.vendor || "").toLowerCase().includes("hctra")
          ) {
            metrics.tolls_paid += total * share;
          }
        }
      }
    }

    const responseVehicles = [];

    for (const vehicle of vehicles) {
      const vehicleId = String(vehicle.id);
      const metrics = vehicleMetrics.get(vehicleId);
      const latestFmv = latestFmvMap.get(String(vehicle.vin || ""));

      metrics.acquisition_cost = roundMoney(metrics.acquisition_cost);
      metrics.onboarding_expenses = roundMoney(metrics.onboarding_expenses);
      metrics.capital_basis = roundMoney(metrics.capital_basis);
      metrics.capital_recovered = roundMoney(metrics.capital_recovered);
      metrics.capital_remaining = roundMoney(metrics.capital_remaining);
      metrics.capital_recovery_pct = roundNumber(
        metrics.capital_recovery_pct,
        1
      );

      metrics.direct_expenses = roundMoney(metrics.direct_expenses);
      metrics.general_expenses = roundMoney(metrics.general_expenses);
      metrics.shared_expenses = roundMoney(metrics.shared_expenses);
      metrics.apportioned_expenses = roundMoney(metrics.apportioned_expenses);

      metrics.total_expenses = roundMoney(
        toNumber(metrics.direct_expenses) +
          toNumber(metrics.general_expenses) +
          toNumber(metrics.shared_expenses) +
          toNumber(metrics.apportioned_expenses)
      );

      metrics.net_profit = roundMoney(
        toNumber(metrics.trip_income) +
          toNumber(metrics.other_income) -
          toNumber(metrics.total_expenses)
      );
      metrics.revenue_total = roundMoney(
        toNumber(metrics.trip_income) + toNumber(metrics.other_income)
      );

      metrics.trip_count_prorated = roundNumber(metrics.trip_count_prorated, 2);

      metrics.income_per_overlapping_trip = roundMoney(
        safeDivide(metrics.trip_income, metrics.trip_count_overlapping)
      );

      metrics.income_per_prorated_trip = roundMoney(
        safeDivide(metrics.trip_income, metrics.trip_count_prorated)
      );

      metrics.income_per_booked_day = roundMoney(
        safeDivide(metrics.trip_income, metrics.booked_vehicle_days)
      );

      const residualMiles = clampNonNegative(
        toNumber(metrics.total_miles) - toNumber(metrics.trip_miles)
      );

      metrics.unallocated_miles = roundNumber(residualMiles, 1);
      metrics.off_trip_miles = roundNumber(metrics.closed_trip_off_trip_miles, 1);

      if (
        metrics.closed_trip_mileage_confidence === "missing" &&
        String(metrics.mileage_confidence).toLowerCase() === "high"
      ) {
        metrics.mileage_confidence = "medium";
      }

      metrics.tolls_paid = roundMoney(metrics.tolls_paid);

      metrics.tolls_unattributed = roundMoney(
        Math.max(
          0,
          toNumber(metrics.tolls_paid) -
            toNumber(metrics.tolls_recovered) -
            toNumber(metrics.tolls_attributed_outstanding)
        )
      );

      const payoffProjection = projectPayoff({
        capitalBasis: metrics.capital_basis,
        capitalRecovered: metrics.capital_recovered,
        capitalRemaining: metrics.capital_remaining,
        tripIncome: metrics.trip_income,
        tripCountOverlapping: metrics.trip_count_overlapping,
        startDate,
        endDate,
        onboardingDate: metrics.onboarding_date,
      });

      metrics.payoff_confidence = payoffProjection.payoff_confidence;
      metrics.capital_recovery_rate_monthly = roundMoney(
        payoffProjection.capital_recovery_rate_monthly
      );
      metrics.projected_payoff_days = payoffProjection.projected_payoff_days;
      metrics.projected_payoff_date = payoffProjection.projected_payoff_date;
      metrics.projected_payoff_status =
        payoffProjection.projected_payoff_status;

      metrics.fmv_estimate_low =
        latestFmv?.estimate_low == null
          ? null
          : roundMoney(latestFmv.estimate_low);
      metrics.fmv_estimate_mid =
        latestFmv?.estimate_mid == null
          ? null
          : roundMoney(latestFmv.estimate_mid);
      metrics.fmv_estimate_high =
        latestFmv?.estimate_high == null
          ? null
          : roundMoney(latestFmv.estimate_high);
      metrics.fmv_estimated_at = latestFmv?.estimated_at || null;
      metrics.fmv_confidence = latestFmv?.confidence || null;
      metrics.fmv_previous_mid =
        latestFmv?.previous_estimate_mid == null
          ? null
          : roundMoney(latestFmv.previous_estimate_mid);
      metrics.fmv_previous_estimated_at =
        latestFmv?.previous_estimated_at || null;
      metrics.fmv_change =
        latestFmv?.estimate_change == null
          ? null
          : roundMoney(latestFmv.estimate_change);

      responseVehicles.push(metrics);
    }

    responseVehicles.sort((a, b) => {
      if (b.net_profit !== a.net_profit) return b.net_profit - a.net_profit;
      return String(a.nickname || "").localeCompare(String(b.nickname || ""));
    });

    return {
      range: key,
      vehicles: responseVehicles,
    };
  } finally {
    client.release();
  }
}

async function getOffTripMileageAudit(rangeKey = "30d") {
  const { key, startDate, endDate } = getDateRange(rangeKey);
  const client = await pool.connect();

  try {
    const [vehicles, trips] = await Promise.all([
      fetchActiveVehicles(client),
      fetchTripsForVehicles(client, startDate, endDate),
    ]);
    const reviewMap = await fetchOffTripAuditReviews(client);

    const maps = buildTripVehicleKeyMaps(vehicles);
    const vehicleTrips = new Map();

    for (const trip of trips) {
      const vehicleId = resolveTripVehicleId(trip, maps);
      if (!vehicleId) continue;

      if (!vehicleTrips.has(vehicleId)) {
        vehicleTrips.set(vehicleId, []);
      }

      vehicleTrips.get(vehicleId).push(trip);
    }

    const rows = [];
    const rowsSkipped = [];
    const vehiclesWithSegments = [];

    for (const vehicle of vehicles) {
      const vehicleId = String(vehicle.id);
      const tripsForVehicle = vehicleTrips.get(vehicleId) || [];
      const audit = calculateTripOffTripAudit(tripsForVehicle);
      const segments = audit.segments;
      const skippedTrips = audit.skippedTrips;
      const totalMiles = segments.reduce(
        (sum, segment) => sum + Number(segment?.off_trip_miles ?? 0),
        0
      );

      if (!segments.length) continue;

      const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model]
        .filter(Boolean)
        .join(" ");

      vehiclesWithSegments.push({
        vehicle_id: vehicle.id,
        vin: vehicle.vin,
        nickname: vehicle.nickname,
        label: vehicleLabel || vehicle.nickname || vehicle.vin,
        segment_count: segments.length,
        skipped_trip_count: skippedTrips.length,
        off_trip_miles: roundNumber(totalMiles, 1),
      });

      for (const segment of segments) {
        rows.push({
          vehicle_id: vehicle.id,
          vin: vehicle.vin,
          nickname: vehicle.nickname,
          vehicle_label: vehicleLabel || vehicle.nickname || vehicle.vin,
          ...segment,
        });
      }

      for (const skippedTrip of skippedTrips) {
        rowsSkipped.push({
          vehicle_id: vehicle.id,
          vin: vehicle.vin,
          nickname: vehicle.nickname,
          vehicle_label: vehicleLabel || vehicle.nickname || vehicle.vin,
          ...skippedTrip,
        });
      }
    }

    const reviewedRows = rows.map((row) =>
      applyAuditReview(row, reviewMap, buildSegmentAuditKey)
    );
    const reviewedSkippedRows = rowsSkipped.map((row) =>
      applyAuditReview(row, reviewMap, buildSkippedTripAuditKey)
    );

    reviewedRows.sort((a, b) => {
      if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
        return a.is_reviewed ? 1 : -1;
      }

      const milesDiff =
        Number(b?.off_trip_miles ?? 0) - Number(a?.off_trip_miles ?? 0);
      if (milesDiff !== 0) return milesDiff;

      const aStart = a.next_trip_start ? new Date(a.next_trip_start).getTime() : 0;
      const bStart = b.next_trip_start ? new Date(b.next_trip_start).getTime() : 0;
      if (aStart !== bStart) return bStart - aStart;

      return String(a.nickname || "").localeCompare(String(b.nickname || ""));
    });

    reviewedSkippedRows.sort((a, b) => {
      if (Boolean(a.is_reviewed) !== Boolean(b.is_reviewed)) {
        return a.is_reviewed ? 1 : -1;
      }

      const aStart = a.trip_start ? new Date(a.trip_start).getTime() : 0;
      const bStart = b.trip_start ? new Date(b.trip_start).getTime() : 0;
      if (aStart !== bStart) return bStart - aStart;

      return String(a.nickname || "").localeCompare(String(b.nickname || ""));
    });

    vehiclesWithSegments.sort((a, b) => {
      if (b.off_trip_miles !== a.off_trip_miles) {
        return b.off_trip_miles - a.off_trip_miles;
      }
      return String(a.nickname || "").localeCompare(String(b.nickname || ""));
    });

    const reviewedTotalsByVehicle = new Map();
    for (const row of reviewedRows) {
      const vehicleId = String(row.vehicle_id);
      reviewedTotalsByVehicle.set(
        vehicleId,
        (reviewedTotalsByVehicle.get(vehicleId) || 0) +
          Number(row.off_trip_miles ?? 0)
      );
    }

    const reviewedVehicles = vehiclesWithSegments
      .map((vehicle) => ({
        ...vehicle,
        off_trip_miles: roundNumber(
          reviewedTotalsByVehicle.get(String(vehicle.vehicle_id)) || 0,
          1
        ),
      }))
      .sort((a, b) => {
        if (b.off_trip_miles !== a.off_trip_miles) {
          return b.off_trip_miles - a.off_trip_miles;
        }
        return String(a.nickname || "").localeCompare(String(b.nickname || ""));
      });

    return {
      range: key,
      generated_at: new Date().toISOString(),
      summary: {
        total_off_trip_miles: roundNumber(
          reviewedRows.reduce((sum, row) => sum + Number(row?.off_trip_miles ?? 0), 0),
          1
        ),
        segment_count: reviewedRows.length,
        skipped_trip_count: reviewedSkippedRows.length,
        reviewed_count:
          reviewedRows.filter((row) => row.is_reviewed).length +
          reviewedSkippedRows.filter((row) => row.is_reviewed).length,
        vehicle_count: vehiclesWithSegments.length,
      },
      vehicles: reviewedVehicles,
      segments: reviewedRows,
      skipped_trips: reviewedSkippedRows,
    };
  } finally {
    client.release();
  }
}

async function getVehicleFinancialDetail(vehicleIdInput, rangeKey = "30d") {
  const targetVehicleId = String(vehicleIdInput || "").trim();
  const { startDate, endDate, key } = getDateRange(rangeKey);
  const client = await pool.connect();

  try {
    const [vehicles, trips, expenses, vehicleMetricsPayload] = await Promise.all([
      fetchActiveVehicles(client),
      fetchTripsForVehicles(client, startDate, endDate),
      fetchExpensesForVehicles(client, startDate, endDate),
      getVehicleMetrics(rangeKey),
    ]);
    const vehicleMetrics = Array.isArray(vehicleMetricsPayload?.vehicles)
      ? vehicleMetricsPayload.vehicles
      : [];

    const vehicle = vehicles.find((item) => String(item.id) === targetVehicleId);
    if (!vehicle) {
      const err = new Error(`Vehicle ${targetVehicleId} not found`);
      err.statusCode = 404;
      throw err;
    }

    const metric = vehicleMetrics.find(
      (item) => String(item.vehicle_id) === targetVehicleId
    );

    const maps = buildTripVehicleKeyMaps(vehicles);
    const tripIdToVehicleId = new Map();
    const tripsForVehicle = [];

    for (const trip of trips) {
      const resolvedVehicleId = resolveTripVehicleId(trip, maps);
      if (!resolvedVehicleId) continue;
      tripIdToVehicleId.set(String(trip.id), resolvedVehicleId);
      if (resolvedVehicleId === targetVehicleId) {
        tripsForVehicle.push(trip);
      }
    }

    const activeVehicleCount = Math.max(1, vehicles.length);
    const totalFleetMiles = vehicleMetrics.reduce(
      (sum, item) => sum + toNumber(item?.total_miles),
      0
    );
    const totalFleetTripMiles = vehicleMetrics.reduce(
      (sum, item) => sum + toNumber(item?.trip_miles),
      0
    );
    const apportionedBase =
      totalFleetMiles > 0 ? totalFleetMiles : totalFleetTripMiles;
    const targetBasisMiles =
      totalFleetMiles > 0
        ? String(metric?.mileage_confidence || "").toLowerCase() === "high" ||
          String(metric?.mileage_confidence || "").toLowerCase() === "medium"
          ? toNumber(metric?.total_miles)
          : 0
        : toNumber(metric?.trip_miles);

    const tripRows = tripsForVehicle
      .map((trip) => {
        const tripIncome = roundMoney(
          getTripProratedAmount(trip, startDate, endDate)
        );
        const fuelIncome = roundMoney(
          getTripFuelReimbursementValue(trip, startDate, endDate)
        );
        const tollIncome = roundMoney(
          getTripRecognizedTollRevenueValue(trip, startDate, endDate)
        );
        const totalRevenue = roundMoney(
          toNumber(tripIncome) + toNumber(fuelIncome) + toNumber(tollIncome)
        );

        return {
          trip_id: trip.id,
          reservation_id: trip.reservation_id || null,
          guest_name: trip.guest_name || null,
          trip_start: trip.trip_start || null,
          trip_end: trip.trip_end || null,
          trip_income: tripIncome,
          fuel_reimbursement_income: fuelIncome,
          toll_revenue_income: tollIncome,
          total_revenue: totalRevenue,
        };
      })
      .sort((a, b) => {
        const aStart = a.trip_start ? new Date(a.trip_start).getTime() : 0;
        const bStart = b.trip_start ? new Date(b.trip_start).getTime() : 0;
        return bStart - aStart;
      });

    const expenseRows = expenses
      .map((expense) => {
        const totalAmount = getExpenseTotal(expense);
        const scope = String(expense.expense_scope || "direct").toLowerCase();
        let resolvedVehicleId =
          expense.vehicle_id != null ? String(expense.vehicle_id) : null;

        if (
          !resolvedVehicleId &&
          expense.trip_id &&
          tripIdToVehicleId.has(String(expense.trip_id))
        ) {
          resolvedVehicleId = tripIdToVehicleId.get(String(expense.trip_id));
        }

        let allocatedAmount = 0;

        if (scope === "direct") {
          if (resolvedVehicleId !== targetVehicleId) return null;
          allocatedAmount = totalAmount;
        } else if (scope === "general" || scope === "shared") {
          allocatedAmount = totalAmount / activeVehicleCount;
        } else if (scope === "apportioned") {
          const share =
            apportionedBase > 0
              ? safeDivide(targetBasisMiles, apportionedBase, 0)
              : safeDivide(1, activeVehicleCount, 0);
          allocatedAmount = totalAmount * share;
        } else {
          return null;
        }

        if (!(allocatedAmount > 0)) return null;

        const trip = expense.trip_id
          ? trips.find((item) => String(item.id) === String(expense.trip_id))
          : null;

        return {
          expense_id: expense.id,
          date: expense.date || null,
          vendor: expense.vendor || null,
          category: expense.category || null,
          expense_scope: scope,
          trip_id: expense.trip_id || null,
          reservation_id: trip?.reservation_id || null,
          guest_name: trip?.guest_name || null,
          total_amount: roundMoney(totalAmount),
          allocated_amount: roundMoney(allocatedAmount),
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const aDate = a.date ? new Date(a.date).getTime() : 0;
        const bDate = b.date ? new Date(b.date).getTime() : 0;
        if (bDate !== aDate) return bDate - aDate;
        return Number(b.allocated_amount) - Number(a.allocated_amount);
      });

    return {
      range: key,
      vehicle: {
        vehicle_id: vehicle.id,
        vin: vehicle.vin,
        nickname: vehicle.nickname || null,
        year: vehicle.year || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
      },
      revenue: {
        trip_income: roundMoney(metric?.trip_income),
        fuel_reimbursement_income: roundMoney(metric?.fuel_reimbursement_income),
        toll_revenue_income: roundMoney(metric?.toll_revenue_income),
        other_income: roundMoney(metric?.other_income),
        total_revenue: roundMoney(metric?.revenue_total),
        trips: tripRows,
      },
      expenses: {
        direct_expenses: roundMoney(metric?.direct_expenses),
        general_expenses: roundMoney(metric?.general_expenses),
        shared_expenses: roundMoney(metric?.shared_expenses),
        apportioned_expenses: roundMoney(metric?.apportioned_expenses),
        total_expenses: roundMoney(metric?.total_expenses),
        line_items: expenseRows,
      },
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getVehicleMetrics,
  getOffTripMileageAudit,
  getVehicleFinancialDetail,
};
