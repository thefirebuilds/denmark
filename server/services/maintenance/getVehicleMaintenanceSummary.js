// --------------------------------------------------------------
// /server/services/maintenance/getVehicleMaintenanceSummary.js
// Service to get a comprehensive maintenance summary for a vehicle, including:
// - Current maintenance rule statuses based on intervals and last results
// - Open maintenance tasks with priority counts  
// - Guest-visible condition notes
// This is used to power the vehicle maintenance summary view and related components.
// -------------------------------------------------------------- 


const pool = require("../../db");
const {
  ensureDefaultMaintenanceRulesForVehicle,
} = require("./ruleTemplates");
const {
  ACTIVE_TASK_STATUSES,
  closeSatisfiedMaintenanceTasks,
} = require("./syncMaintenanceTasks");
const { ensureVehicleAliasesTable } = require("../vehicles/vehicleAliases");
const {
  refreshVehicleOdometerRollups,
} = require("../vehicles/odometerRollupService");

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function addDays(dateValue, days) {
  if (!dateValue || !Number.isFinite(days)) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d;
}

function subtractDays(dateValue, days) {
  if (!dateValue || !Number.isFinite(days)) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - days);
  return d;
}

function parseDotCode(dotCode) {
  if (!dotCode || !/^\d{4}$/.test(String(dotCode))) return null;

  const value = String(dotCode);
  const week = Number(value.slice(0, 2));
  const yearSuffix = Number(value.slice(2, 4));

  if (week < 1 || week > 53) return null;

  return {
    week,
    year: 2000 + yearSuffix,
  };
}

function isoWeekStartDate(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - jan4Day + 1);

  const target = new Date(mondayWeek1);
  target.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);

  return target;
}

function diffYears(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return ms / (365.25 * 24 * 60 * 60 * 1000);
}

function getRuleStatus({ rule, currentOdometerMiles, now = new Date() }) {
  switch (rule.rule_code) {
    case "tire_age_review":
      return getTireAgeReviewStatus({ rule, currentOdometerMiles, now });

    case "cleaning":
      return getCleaningStatus({ rule, currentOdometerMiles, now });

    default:
      return getDefaultRuleStatus({ rule, currentOdometerMiles, now });
  }
}

function getDefaultRuleStatus({ rule, currentOdometerMiles, now = new Date() }) {
  const intervalMiles = toIntOrNull(rule.interval_miles);
  const intervalDays = toIntOrNull(rule.interval_days);
  const dueSoonMiles = toIntOrNull(rule.due_soon_miles) ?? 0;
  const dueSoonDays = toIntOrNull(rule.due_soon_days) ?? 0;

  const lastOdometerMiles = toIntOrNull(rule.last_odometer_miles);
  const lastPerformedAt = rule.last_performed_at
    ? new Date(rule.last_performed_at)
    : null;

  let mileageStatus = "ok";
  let dateStatus = "ok";

  let nextDueMiles = null;
  let nextDueDate = null;

  if (intervalMiles) {
    if (lastOdometerMiles === null || currentOdometerMiles === null) {
      mileageStatus = "unknown";
    } else {
      nextDueMiles = lastOdometerMiles + intervalMiles;

      if (currentOdometerMiles >= nextDueMiles) {
        mileageStatus = "overdue";
      } else if (currentOdometerMiles >= nextDueMiles - dueSoonMiles) {
        mileageStatus = "due_soon";
      }
    }
  }

  if (intervalDays) {
    if (!lastPerformedAt || Number.isNaN(lastPerformedAt.getTime())) {
      dateStatus = "unknown";
    } else {
      nextDueDate = addDays(lastPerformedAt, intervalDays);
      const dueSoonDate = subtractDays(nextDueDate, dueSoonDays);

      if (now >= nextDueDate) {
        dateStatus = "overdue";
      } else if (now >= dueSoonDate) {
        dateStatus = "due_soon";
      }
    }
  }

  const statuses = [mileageStatus, dateStatus];
  let status = "ok";

  if (statuses.includes("overdue")) {
    status = "overdue";
  } else if (statuses.includes("due_soon")) {
    status = "due_soon";
  } else if (statuses.includes("unknown")) {
    status = "unknown";
  }

  if (
    rule.requires_pass_result &&
    (rule.last_result === "fail" || rule.last_result === "attention")
  ) {
    status = "overdue";
  }

  return {
    ruleId: rule.id,
    ruleCode: rule.rule_code,
    title: rule.title,
    category: rule.category,
    status,
    lastEvent: rule.last_event_id
      ? {
          id: rule.last_event_id,
          performedAt: rule.last_performed_at,
          odometerMiles: lastOdometerMiles,
          result: rule.last_result,
          notes: rule.last_notes || null,
          data: rule.last_data || {},
        }
      : null,
    nextDueMiles,
    nextDueDate: nextDueDate ? nextDueDate.toISOString() : null,
    blocksRentalWhenOverdue: Boolean(rule.blocks_rental_when_overdue),
    blocksGuestExportWhenOverdue: Boolean(
      rule.blocks_guest_export_when_overdue
    ),
    requiresPassResult: Boolean(rule.requires_pass_result),
  };
}

function getTireAgeReviewStatus({ rule, currentOdometerMiles, now = new Date() }) {
  const base = getDefaultRuleStatus({ rule, currentOdometerMiles, now });

  const data = rule.last_data || {};
  const dotCode = data.dot_code || null;
  const installDate = data.install_date || null;
  const treadDepth32nds =
    data.tread_depth_32nds === undefined || data.tread_depth_32nds === null || data.tread_depth_32nds === ""
      ? null
      : Number(data.tread_depth_32nds);

  const cfg = rule.rule_config || {};
  const attentionAgeYears = Number(cfg.attention_age_years || 5);
  const failAgeYears = Number(cfg.fail_age_years || 7);

  let manufacturedAt = null;
  let tireAgeYears = null;
  let ageStatus = "unknown";

  const parsed = parseDotCode(dotCode);
  if (parsed) {
    const manufacturedDate = isoWeekStartDate(parsed.year, parsed.week);
    manufacturedAt = manufacturedDate.toISOString();
    tireAgeYears = diffYears(manufacturedDate, now);

    if (tireAgeYears >= failAgeYears) {
      ageStatus = "overdue";
    } else if (tireAgeYears >= attentionAgeYears) {
      ageStatus = "due_soon";
    } else {
      ageStatus = "ok";
    }
  }

  let status = base.status;
  if (ageStatus === "overdue") {
    status = "overdue";
  } else if (ageStatus === "due_soon" && status !== "overdue") {
    status = "due_soon";
  } else if (status === "ok" && ageStatus === "unknown") {
    status = "unknown";
  }

  return {
    ...base,
    status,
    tireAge: {
      dotCode,
      installDate,
      treadDepth32nds,
      manufacturedAt,
      tireAgeYears: tireAgeYears != null ? Number(tireAgeYears.toFixed(2)) : null,
      attentionAgeYears,
      failAgeYears,
    },
  };
}

function getCleaningStatus({ rule, currentOdometerMiles, now = new Date() }) {
  const base = getDefaultRuleStatus({ rule, currentOdometerMiles, now });
  const data = rule.last_data || {};

  return {
    ...base,
    status: base.lastEvent ? "ok" : "unknown",
    cleaning: {
      interiorCleanedAt: data.interior_cleaned_at || null,
      exteriorCleanedAt: data.exterior_cleaned_at || null,
    },
  };
}

function buildPriorityCounts(tasks) {
  return tasks.reduce(
    (acc, task) => {
      if (acc[task.priority] !== undefined) {
        acc[task.priority] += 1;
      }
      return acc;
    },
    { urgent: 0, high: 0, medium: 0, low: 0 }
  );
}

async function getVehicleMaintenanceSummary(
  clientOrVin,
  maybeVin = null,
  options = {}
) {
  const client = maybeVin ? clientOrVin : pool;
  const selector = String(maybeVin || clientOrVin || "").trim();
  const normalizedSelector = selector.toLowerCase();
  const refreshOdometerRollup = options.refreshOdometerRollup !== false;

  await ensureVehicleAliasesTable(client);

  const vehicleResult = await client.query(
    `
      SELECT
        v.id,
        v.vin,
        v.nickname,
        v.year,
        v.make,
        v.model,
        v.turo_vehicle_id,
        v.bouncie_vehicle_id,
        v.rockauto_url,
        v.lockbox_pin,
        v.current_odometer_miles,
        latest_maintenance_odometer.odometer_miles AS latest_maintenance_odometer_miles,
        odometer_rollup.odometer_miles AS rollup_odometer_miles,
        odometer_rollup.source AS rollup_odometer_source,
        odometer_rollup.source_trip_id AS rollup_source_trip_id,
        odometer_rollup.source_reservation_id AS rollup_source_reservation_id,
        odometer_rollup.source_trip_start AS rollup_source_trip_start,
        odometer_rollup.estimated_trip_miles AS rollup_estimated_trip_miles,
        odometer_rollup.calculated_at AS rollup_calculated_at,
        onboarding_trip.starting_odometer AS onboarding_odometer_miles,
        turo_mileage.total_turo_miles,
        turo_mileage.counted_turo_mileage_trips,
        v.is_active
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT me.odometer_miles
        FROM maintenance_events me
        WHERE me.vehicle_vin = v.vin
          AND me.odometer_miles IS NOT NULL
        ORDER BY me.performed_at DESC, me.id DESC
        LIMIT 1
      ) latest_maintenance_odometer ON TRUE
      LEFT JOIN vehicle_odometer_rollups odometer_rollup
        ON odometer_rollup.vehicle_id = v.id
      LEFT JOIN LATERAL (
        SELECT t.starting_odometer
        FROM trips t
        WHERE t.starting_odometer IS NOT NULL
          AND (
            (
              v.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id::text = v.turo_vehicle_id::text
            )
            OR lower(trim(COALESCE(t.vehicle_name, ''))) = lower(trim(COALESCE(v.nickname, '')))
            OR EXISTS (
              SELECT 1
              FROM vehicle_aliases va_trip
              WHERE va_trip.vehicle_id = v.id
                AND va_trip.active = true
                AND lower(trim(va_trip.alias)) = lower(trim(COALESCE(t.vehicle_name, '')))
            )
          )
          AND (
            t.canceled_at IS NULL
            OR COALESCE(t.amount, 0) > 0
          )
        ORDER BY t.trip_start ASC NULLS LAST, t.id ASC
        LIMIT 1
      ) onboarding_trip ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN t.starting_odometer IS NOT NULL
                 AND t.ending_odometer IS NOT NULL
                 AND t.ending_odometer >= t.starting_odometer
                THEN t.ending_odometer - t.starting_odometer
                ELSE 0
              END
            ),
            0
          ) AS total_turo_miles,
          COUNT(*) FILTER (
            WHERE t.starting_odometer IS NOT NULL
              AND t.ending_odometer IS NOT NULL
              AND t.ending_odometer >= t.starting_odometer
          )::int AS counted_turo_mileage_trips
        FROM trips t
        WHERE (
            (
              v.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id::text = v.turo_vehicle_id::text
            )
            OR lower(trim(COALESCE(t.vehicle_name, ''))) = lower(trim(COALESCE(v.nickname, '')))
            OR EXISTS (
              SELECT 1
              FROM vehicle_aliases va_trip
              WHERE va_trip.vehicle_id = v.id
                AND va_trip.active = true
                AND lower(trim(va_trip.alias)) = lower(trim(COALESCE(t.vehicle_name, '')))
            )
          )
          AND (
            t.canceled_at IS NULL
            OR COALESCE(t.amount, 0) > 0
          )
      ) turo_mileage ON TRUE
      WHERE lower(trim(v.vin)) = $1
         OR lower(trim(v.nickname)) = $1
         OR lower(trim(COALESCE(v.license_plate, ''))) = $1
         OR EXISTS (
           SELECT 1
           FROM vehicle_aliases va
           WHERE va.vehicle_id = v.id
             AND va.active = true
             AND lower(trim(va.alias)) = $1
         )
      LIMIT 1
    `,
    [normalizedSelector]
  );

  const vehicle = vehicleResult.rows[0];

  if (!vehicle) {
    const err = new Error(`Vehicle not found for selector ${selector}`);
    err.statusCode = 404;
    throw err;
  }

  const vin = vehicle.vin;

  if (refreshOdometerRollup) {
    await refreshVehicleOdometerRollups({ client, vehicleVin: vin });

    const refreshedRollupResult = await client.query(
      `
        SELECT
          odometer_miles AS rollup_odometer_miles,
          source AS rollup_odometer_source,
          source_trip_id AS rollup_source_trip_id,
          source_reservation_id AS rollup_source_reservation_id,
          source_trip_start AS rollup_source_trip_start,
          estimated_trip_miles AS rollup_estimated_trip_miles,
          calculated_at AS rollup_calculated_at
        FROM vehicle_odometer_rollups
        WHERE vehicle_id = $1
        LIMIT 1
      `,
      [vehicle.id]
    );

    if (refreshedRollupResult.rows[0]) {
      Object.assign(vehicle, refreshedRollupResult.rows[0]);
    }
  }

  await ensureDefaultMaintenanceRulesForVehicle(client, vehicle.vin);

  const rulesResult = await client.query(
    `
        SELECT
          r.id,
          r.vehicle_vin,
          r.rule_code,
          r.title,
          r.description,
          r.category,
          r.interval_miles,
          r.interval_days,
          r.due_soon_miles,
          r.due_soon_days,
          r.blocks_rental_when_overdue,
          r.blocks_guest_export_when_overdue,
          r.requires_pass_result,
          r.is_active,
          r.rule_config,

          e.id AS last_event_id,
          e.performed_at AS last_performed_at,
          e.odometer_miles AS last_odometer_miles,
          e.result AS last_result,
          e.notes AS last_notes,
          e.data AS last_data
        FROM maintenance_rules r
        LEFT JOIN LATERAL (
          SELECT
            me.id,
            me.performed_at,
            me.odometer_miles,
            me.result,
            me.notes,
            me.data
          FROM maintenance_events me
          WHERE me.rule_id = r.id
          ORDER BY
            CASE
              WHEN me.performed_at > NOW() + INTERVAL '7 days' THEN 1
              ELSE 0
            END,
            me.performed_at DESC,
            me.id DESC
          LIMIT 1
        ) e ON TRUE
        WHERE r.vehicle_vin = $1
          AND r.is_active = TRUE
        ORDER BY r.category, r.title
      `,
    [vin]
  );

  const vehicleOdometerMiles = toIntOrNull(vehicle.current_odometer_miles);
  const maintenanceOdometerMiles = toIntOrNull(
    vehicle.latest_maintenance_odometer_miles
  );
  const rollupOdometerMiles = toIntOrNull(vehicle.rollup_odometer_miles);
  const odometerCandidates = [
    { miles: vehicleOdometerMiles, source: "vehicle" },
    { miles: maintenanceOdometerMiles, source: "maintenance" },
    { miles: rollupOdometerMiles, source: vehicle.rollup_odometer_source || "rollup" },
  ].filter((candidate) => candidate.miles != null);
  const currentOdometerCandidate =
    odometerCandidates.length > 0
      ? odometerCandidates.reduce((best, candidate) =>
          candidate.miles > best.miles ? candidate : best
        )
      : null;
  const currentOdometerMiles = currentOdometerCandidate?.miles ?? null;
  const currentOdometerSource = currentOdometerCandidate?.source ?? null;
  const estimatedTripOdometerMiles =
    vehicle.rollup_odometer_source === "active_trip_estimate"
      ? rollupOdometerMiles
      : null;
  const onboardingOdometerMiles = toIntOrNull(vehicle.onboarding_odometer_miles);
  const totalTuroMiles =
    vehicle.total_turo_miles == null ? null : Number(vehicle.total_turo_miles);
  const countedTuroMileageTrips =
    vehicle.counted_turo_mileage_trips == null
      ? 0
      : Number(vehicle.counted_turo_mileage_trips);

  const ruleStatuses = rulesResult.rows.map((rule) =>
    getRuleStatus({
      rule,
      currentOdometerMiles,
    })
  );

  await closeSatisfiedMaintenanceTasks(client, vin, { ruleStatuses });

  const [tasksResult, notesResult, historyResult] = await Promise.all([
    client.query(
      `
        SELECT
          id,
          vehicle_vin,
          rule_id,
          related_trip_id,
          task_type,
          title,
          description,
          priority,
          status,
          blocks_rental,
          blocks_guest_export,
          needs_review,
          source,
          trigger_type,
          trigger_context,
          source_key,
          created_at,
          updated_at
        FROM maintenance_tasks
        WHERE vehicle_vin = $1
          AND status = ANY($2::text[])
        ORDER BY
          CASE priority
            WHEN 'urgent' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            WHEN 'low' THEN 4
            ELSE 5
          END,
          created_at ASC
      `,
      [vin, ACTIVE_TASK_STATUSES]
    ),
    client.query(
      `
        SELECT
          id,
          note_type,
          area,
          title,
          description,
          severity,
          guest_visible,
          active,
          recorded_at,
          resolved_at,
          photo_url
        FROM vehicle_condition_notes
        WHERE vehicle_vin = $1
          AND active = TRUE
          AND guest_visible = TRUE
        ORDER BY recorded_at DESC, id DESC
      `,
      [vin]
    ),
    client.query(
      `
        SELECT
          me.id,
          me.rule_id,
          r.rule_code,
          me.performed_at,
          me.odometer_miles,
          me.result,
          me.notes,
          me.data,
          me.performed_by,
          me.source,
          me.created_at
        FROM maintenance_events me
        JOIN maintenance_rules r
          ON r.id = me.rule_id
        WHERE r.vehicle_vin = $1
        ORDER BY
          r.rule_code ASC,
          CASE
            WHEN me.performed_at > NOW() + INTERVAL '7 days' THEN 1
            ELSE 0
          END,
          me.performed_at DESC,
          me.id DESC
      `,
      [vin]
    ),
  ]);

  const tasks = tasksResult.rows;
  const guestVisibleConditionNotes = notesResult.rows;

  const ruleHistory = historyResult.rows.reduce((acc, row) => {
  const ruleCode = row.rule_code;

    if (!acc[ruleCode]) {
      acc[ruleCode] = [];
    }

    acc[ruleCode].push({
      id: row.id,
      ruleId: row.rule_id,
      performedAt: row.performed_at,
      odometerMiles: toIntOrNull(row.odometer_miles),
      result: row.result,
      notes: row.notes || null,
      data: row.data || {},
      performedBy: row.performed_by || null,
      source: row.source || null,
      createdAt: row.created_at || null,
    });

    return acc;
  }, {});

  const hasReviewTask = tasks.some((task) => task.needs_review);
  const hasRentalBlockerTask = tasks.some((task) => task.blocks_rental);
  const hasGuestExportBlockerTask = tasks.some(
    (task) => task.blocks_guest_export
  );

  const hasOverdueRule = ruleStatuses.some((rule) => rule.status === "overdue");
  const hasRentalBlockingOverdueRule = ruleStatuses.some(
    (rule) => rule.status === "overdue" && rule.blocksRentalWhenOverdue
  );
  const hasGuestExportBlockingOverdueRule = ruleStatuses.some(
    (rule) => rule.status === "overdue" && rule.blocksGuestExportWhenOverdue
  );

  return {
    vehicle: {
      vin: vehicle.vin,
      nickname: vehicle.nickname,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      turoVehicleId: vehicle.turo_vehicle_id,
      bouncieVehicleId: vehicle.bouncie_vehicle_id,
      rockautoUrl: vehicle.rockauto_url,
      rockauto_url: vehicle.rockauto_url,
      lockboxPin: vehicle.lockbox_pin || null,
      lockbox_pin: vehicle.lockbox_pin || null,
      currentOdometerMiles,
      currentOdometerSource,
      onboardingOdometerMiles,
      totalTuroMiles,
      countedTuroMileageTrips,
      estimatedCurrentOdometerMiles: estimatedTripOdometerMiles,
      estimatedTripMiles:
        vehicle.rollup_estimated_trip_miles == null
          ? null
          : Number(vehicle.rollup_estimated_trip_miles),
      odometerRollupCalculatedAt: vehicle.rollup_calculated_at || null,
      isActive: vehicle.is_active,
    },
    currentOdometerMiles,
    currentOdometerSource,
    onboardingOdometerMiles,
    totalTuroMiles,
    countedTuroMileageTrips,
    estimatedCurrentOdometerMiles: estimatedTripOdometerMiles,
    estimatedTripMiles:
      vehicle.rollup_estimated_trip_miles == null
        ? null
        : Number(vehicle.rollup_estimated_trip_miles),
    odometerRollupCalculatedAt: vehicle.rollup_calculated_at || null,
    needsReview:
      hasReviewTask ||
      hasRentalBlockerTask ||
      hasGuestExportBlockerTask ||
      hasOverdueRule,
    blocksRental: hasRentalBlockerTask || hasRentalBlockingOverdueRule,
    blocksGuestExport:
      hasGuestExportBlockerTask || hasGuestExportBlockingOverdueRule,
    openTaskCounts: buildPriorityCounts(tasks),
    tasks,
    ruleStatuses,
    ruleHistory,
    guestVisibleConditionNotes,
  };
}

module.exports = {
  getVehicleMaintenanceSummary,
};
