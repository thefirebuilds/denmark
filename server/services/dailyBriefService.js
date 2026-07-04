const pool = require("../db");
const { getAiPromptSettings } = require("./aiPromptSettings");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_DAILY_BRIEF_MODEL ||
  process.env.OPENAI_FMV_MODEL ||
  "gpt-4.1-mini";
const DEFAULT_TIME_ZONE = process.env.DAILY_BRIEF_TIME_ZONE || "America/Chicago";
const DAILY_BRIEF_LATEST_KEY = "ai.dailyBrief.latest";
const DAILY_BRIEF_RUN_HISTORY_KEY = "ai.dailyBrief.runHistory";

function cleanText(value, maxLength = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  return Math.round(toNumber(value) * 100) / 100;
}

function getLocalDateString(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeBriefDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return getLocalDateString();
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function mapTrip(row) {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    vehicleNickname: row.vehicle_nickname,
    start: row.trip_start,
    end: row.trip_end,
    pickupLocation: row.pickup_location,
    returnLocation: row.return_location,
    status: row.status,
    workflowStage: row.workflow_stage,
    amount: row.amount == null ? null : Number(row.amount),
    tollTotal: row.toll_total == null ? null : Number(row.toll_total),
    tollReviewStatus: row.toll_review_status,
    expenseStatus: row.expense_status,
    closedOut: row.closed_out === true,
  };
}

function mapTask(row) {
  return {
    id: row.id,
    vehicleName: row.vehicle_name,
    title: row.title,
    priority: row.priority,
    status: row.status,
    blocksRental: row.blocks_rental === true,
    blocksGuestExport: row.blocks_guest_export === true,
    needsReview: row.needs_review === true,
    updatedAt: row.updated_at,
  };
}

function mapTripChange(row) {
  return {
    id: row.id,
    type: row.message_type,
    subject: row.subject,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    reservationId: row.reservation_id,
    tripId: row.trip_id,
    amount: row.amount == null ? null : Number(row.amount),
    timestamp: row.message_timestamp || row.created_at,
  };
}

function mapLatestBookedTrip(row) {
  if (!row) return null;
  return {
    timestamp: row.message_timestamp || row.created_at || row.trip_created_at,
    guestName: row.guest_name,
    vehicleName: row.vehicle_name || row.vehicle_nickname,
    reservationId: row.reservation_id,
    tripId: row.trip_id,
    start: row.trip_start,
    end: row.trip_end,
    amount: row.amount == null ? null : Number(row.amount),
    subject: row.subject,
  };
}

function mapFleetStatusCandidate(row) {
  const revenue = roundMoney(row.revenue);
  const costs = roundMoney(row.operating_cost);
  const netRevenue = roundMoney(revenue - costs);
  const bookedDays = roundMoney(row.booked_days);
  const activeTripCount = Number(row.active_trip_count || 0);
  const avgDailyRate =
    bookedDays > 0 ? roundMoney(revenue / bookedDays) : roundMoney(row.avg_daily_rate);
  const bookingCount = Number(row.booking_count || 0);
  const blockerTasks = Number(row.blocker_tasks || 0);
  const highPriorityTasks = Number(row.high_priority_tasks || 0);
  const openMaintenanceTasks = Number(row.open_maintenance_tasks || 0);
  const blockerDays = roundMoney(row.blocker_days);
  const issueTrips = Number(row.issue_trips || 0);
  const chadScore = roundMoney(
    netRevenue +
      avgDailyRate * 1.5 +
      bookingCount * 25 +
      bookedDays * 10 -
      blockerDays * 35 -
      blockerTasks * 50 -
      highPriorityTasks * 25 -
      issueTrips * 25
  );
  const princessScore = roundMoney(
    costs +
      blockerDays * 75 +
      blockerTasks * 100 +
      highPriorityTasks * 50 +
      openMaintenanceTasks * 15 +
      issueTrips * 50 -
      revenue * 0.2 -
      bookingCount * 10
  );

  return {
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    revenue,
    costs,
    netRevenue,
    bookedDays,
    bookingCount,
    activeTripCount,
    avgDailyRate,
    openMaintenanceTasks,
    blockerTasks,
    highPriorityTasks,
    blockerDays,
    issueTrips,
    chadScore,
    princessScore,
  };
}

function selectFleetStatus(candidates) {
  const ranked = Array.isArray(candidates) ? candidates : [];
  const activeCandidates = ranked.filter(
    (item) =>
      item.bookingCount > 0 ||
      item.revenue > 0 ||
      item.costs > 0 ||
      item.openMaintenanceTasks > 0
  );
  if (!activeCandidates.length) {
    return {
      lookbackDays: 10,
      chad: null,
      princess: null,
      candidates: [],
    };
  }

  const byChad = [...activeCandidates].sort(
    (a, b) => b.chadScore - a.chadScore || b.netRevenue - a.netRevenue
  );
  const byPrincess = [...activeCandidates].sort(
    (a, b) => b.princessScore - a.princessScore || b.costs - a.costs
  );

  return {
    lookbackDays: 10,
    chad: byChad[0] || null,
    princess: byPrincess[0] || null,
    candidates: activeCandidates
      .sort((a, b) => b.chadScore - a.chadScore)
      .slice(0, 8),
  };
}

function buildMonthlyProjection(finance) {
  const monthToDateRevenue = roundMoney(finance.month_to_date_revenue);
  const bookedRemainingRevenue = roundMoney(finance.booked_remaining_month_revenue);
  const daysElapsed = Math.max(1, Number(finance.month_days_elapsed || 1));
  const daysInMonth = Math.max(daysElapsed, Number(finance.month_days_total || daysElapsed));
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);
  const runRateDailyRevenue = roundMoney(monthToDateRevenue / daysElapsed);
  const runRateProjectedRevenue = roundMoney(runRateDailyRevenue * daysInMonth);
  const bookedProjectedRevenue = roundMoney(
    monthToDateRevenue + bookedRemainingRevenue
  );
  const blendedProjectedRevenue = roundMoney(
    Math.max(bookedProjectedRevenue, runRateProjectedRevenue)
  );

  return {
    monthStart: finance.month_start || null,
    monthEnd: finance.month_end || null,
    daysElapsed,
    daysRemaining,
    daysInMonth,
    monthToDateRevenue,
    bookedRemainingRevenue,
    runRateDailyRevenue,
    runRateProjectedRevenue,
    bookedProjectedRevenue,
    blendedProjectedRevenue,
    projectionMethod:
      bookedProjectedRevenue >= runRateProjectedRevenue
        ? "booked_remaining"
        : "run_rate",
  };
}

function clampScore(value) {
  const score = Math.round(Number(value));
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function mapVehicleOperationsRow(row) {
  const openMaintenanceItems = Number(row.open_maintenance_items || 0);
  const blockerMaintenanceItems = Number(row.blocker_maintenance_items || 0);
  const diagnosticAlerts =
    row.mil_on === true || Number(row.dtc_count || 0) > 0 ? 1 : 0;
  const lastCommAt =
    row.last_comm_at || row.vehicle_last_updated || row.captured_at || null;
  const lastCommMs = lastCommAt ? new Date(lastCommAt).getTime() : NaN;
  const lastCommAgeHours = Number.isFinite(lastCommMs)
    ? Math.max(0, Math.round((Date.now() - lastCommMs) / 3600000))
    : null;
  const downtimeRisk =
    blockerMaintenanceItems > 0 || diagnosticAlerts > 0 || lastCommAgeHours == null || lastCommAgeHours >= 24
      ? "high"
      : openMaintenanceItems > 0 || lastCommAgeHours >= 6
      ? "medium"
      : "low";

  return {
    vehicleId: row.vehicle_id,
    vin: row.vin,
    vehicleName: row.vehicle_name,
    inService: row.in_service !== false,
    mileage: row.current_odometer_miles == null ? null : Number(row.current_odometer_miles),
    currentLocation: row.address || (row.latitude != null && row.longitude != null
      ? `${Number(row.latitude).toFixed(3)}, ${Number(row.longitude).toFixed(3)}`
      : null),
    telemetrySource: row.service_name || null,
    lastCommAt,
    lastCommAgeHours,
    fuelLevel: row.fuel_level == null ? null : Number(row.fuel_level),
    batteryVoltage: row.battery_voltage == null ? null : Number(row.battery_voltage),
    diagnosticAlerts,
    milOn: row.mil_on === true,
    dtcCount: Number(row.dtc_count || 0),
    registration: {
      month: row.registration_month == null ? null : Number(row.registration_month),
      year: row.registration_year == null ? null : Number(row.registration_year),
    },
    insuranceMonthly: row.insurance_monthly == null ? null : Number(row.insurance_monthly),
    registrationAnnual: row.registration_annual == null ? null : Number(row.registration_annual),
    loanBalance: row.loan_balance == null ? null : Number(row.loan_balance),
    monthlyPayment: row.monthly_payment == null ? null : Number(row.monthly_payment),
    nextReservation: row.next_trip_id
      ? {
          tripId: row.next_trip_id,
          guestName: row.next_guest_name,
          start: row.next_trip_start,
          end: row.next_trip_end,
          amount: row.next_amount == null ? null : Number(row.next_amount),
        }
      : null,
    openMaintenanceItems,
    blockerMaintenanceItems,
    highPriorityMaintenanceItems: Number(row.high_priority_maintenance_items || 0),
    estimatedMaintenanceLaborHours:
      row.estimated_maintenance_labor_hours == null
        ? null
        : Number(row.estimated_maintenance_labor_hours),
    estimatedRepairCost:
      row.estimated_maintenance_labor_hours == null
        ? null
        : roundMoney(Number(row.estimated_maintenance_labor_hours) * 75),
    maintenanceTitles: Array.isArray(row.maintenance_titles)
      ? row.maintenance_titles
      : [],
    downtimeRisk,
  };
}

function buildExecutiveOperationsContext({
  activeTrips,
  closingTrips,
  finance,
  fleetStatus,
  messages,
  monthlyProjection,
  openingTrips,
  operations,
  pendingCloseouts,
  tasks,
  tripChanges,
  vehicleStatus,
}) {
  const activeFleetCount = Number(operations.active_fleet_count || 0);
  const occupiedVehicleCount = Number(operations.occupied_vehicle_count || 0);
  const offlineVehicles = vehicleStatus.filter(
    (vehicle) => vehicle.inService === false || vehicle.downtimeRisk === "high"
  );
  const availableVehicleCount = Math.max(
    0,
    activeFleetCount - occupiedVehicleCount - offlineVehicles.length
  );
  const monthToDateRevenue = roundMoney(finance.month_to_date_revenue);
  const monthToDateExpenses = roundMoney(finance.month_to_date_expenses);
  const monthToDateProfit = roundMoney(monthToDateRevenue - monthToDateExpenses);
  const revenuePerVehicle = activeFleetCount
    ? roundMoney(monthToDateRevenue / activeFleetCount)
    : 0;
  const profitPerVehicle = activeFleetCount
    ? roundMoney(monthToDateProfit / activeFleetCount)
    : 0;
  const urgentTasks = tasks.filter((task) =>
    ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
  );
  const blockers = tasks.filter(
    (task) => task.blocksRental || task.blocksGuestExport || task.needsReview
  );
  const staleTelemetryCount = vehicleStatus.filter(
    (vehicle) => vehicle.lastCommAgeHours == null || vehicle.lastCommAgeHours >= 24
  ).length;
  const diagnosticVehicleCount = vehicleStatus.filter(
    (vehicle) => vehicle.diagnosticAlerts > 0
  ).length;
  const vehiclesWithNext30Risk = vehicleStatus.filter(
    (vehicle) => vehicle.downtimeRisk !== "low" && vehicle.nextReservation
  );
  const upcomingReservationCount = vehicleStatus.filter(
    (vehicle) => vehicle.nextReservation
  ).length;
  const totalLoanBalance = roundMoney(
    vehicleStatus.reduce((sum, vehicle) => sum + toNumber(vehicle.loanBalance), 0)
  );
  const upcomingLoanPayments = roundMoney(
    vehicleStatus.reduce((sum, vehicle) => sum + toNumber(vehicle.monthlyPayment), 0)
  );
  const insurancePayments = roundMoney(
    vehicleStatus.reduce((sum, vehicle) => sum + toNumber(vehicle.insuranceMonthly), 0)
  );
  const registrationRenewals = roundMoney(
    vehicleStatus.reduce((sum, vehicle) => sum + toNumber(vehicle.registrationAnnual) / 12, 0)
  );
  const expectedMaintenanceCosts = roundMoney(
    vehicleStatus.reduce((sum, vehicle) => sum + toNumber(vehicle.estimatedRepairCost), 0)
  );
  const projected30DayCashFlow = roundMoney(
    monthlyProjection.runRateDailyRevenue * 30 -
      monthToDateExpenses -
      upcomingLoanPayments -
      insurancePayments -
      expectedMaintenanceCosts
  );

  const categoryScores = {
    fleetReliability: clampScore(100 - staleTelemetryCount * 12 - diagnosticVehicleCount * 15),
    cashFlow: clampScore(70 + Math.min(25, monthToDateProfit / 100) - Math.max(0, -projected30DayCashFlow / 50)),
    utilization: clampScore(occupiedVehicleCount && activeFleetCount ? (occupiedVehicleCount / activeFleetCount) * 100 : 45),
    maintenanceReadiness: clampScore(100 - blockers.length * 18 - urgentTasks.length * 10),
    bookingPipeline: clampScore(50 + openingTrips.length * 8 + tripChanges.length * 3 + Number(finance.booked_remaining_month_revenue || 0) / 100),
    revenuePerformance: clampScore(50 + monthToDateProfit / 50 + monthlyProjection.blendedProjectedRevenue / 200),
    operationalRisk: clampScore(100 - vehiclesWithNext30Risk.length * 15 - pendingCloseouts.length * 8),
  };
  const fleetHealthScore = clampScore(
    Object.values(categoryScores).reduce((sum, score) => sum + score, 0) /
      Object.values(categoryScores).length
  );

  const profitLeaks = [
    pendingCloseouts.length
      ? {
          issue: "Unclosed trips / reimbursements",
          evidence: `${pendingCloseouts.length} closeout(s), ${roundMoney(finance.open_closeout_tolls)} tolls exposed`,
          estimatedAnnualImpact: roundMoney(toNumber(finance.open_closeout_tolls) * 12),
        }
      : null,
    blockers.length
      ? {
          issue: "Maintenance blockers",
          evidence: `${blockers.length} blocker task(s) can reduce availability`,
          estimatedAnnualImpact: roundMoney(blockers.length * 350 * 12),
        }
      : null,
    fleetStatus.princess
      ? {
          issue: `${fleetStatus.princess.vehicleName} cost / downtime drag`,
          evidence: `${fleetStatus.princess.costs} costs, ${fleetStatus.princess.blockerDays} blocker days in ${fleetStatus.lookbackDays}d`,
          estimatedAnnualImpact: roundMoney(toNumber(fleetStatus.princess.costs) * 36.5),
        }
      : null,
  ].filter(Boolean);

  return {
    fleetHealthScore,
    categoryScores,
    businessSnapshot: {
      vehiclesInService: activeFleetCount,
      vehiclesRented: occupiedVehicleCount,
      vehiclesAvailable: availableVehicleCount,
      vehiclesOffline: offlineVehicles.length,
      todaysPickups: openingTrips.length,
      todaysReturns: closingTrips.length,
      upcomingReservations: upcomingReservationCount,
      currentOccupancy: operations.occupancyPercent,
      rolling30DayOccupancy: null,
      monthToDateRevenue,
      monthToDateProfit,
      revenuePerVehicle,
      profitPerVehicle,
      cashAvailableForFleetOperations: null,
    },
    cashFlow: {
      operatingCash: null,
      outstandingReimbursements: roundMoney(finance.open_closeout_tolls),
      upcomingLoanPayments,
      insurancePayments,
      registrationRenewals,
      expectedMaintenanceCosts,
      projected30DayCashFlow,
      totalLoanBalance,
    },
    reservationIntelligence: {
      checkInsToday: openingTrips,
      checkOutsToday: closingTrips,
      lateReturns: pendingCloseouts,
      guestIssues: messages.unreadGuestCount,
      schedulingConflicts: [],
      vehiclesAtRiskOfMissingBooking: vehiclesWithNext30Risk,
    },
    maintenanceOutlook: {
      totalOpen: tasks.length,
      urgentOrHigh: urgentTasks,
      blockers,
      estimatedMaintenanceSpend: expectedMaintenanceCosts,
      likelyDowntime: vehicleStatus.filter((vehicle) => vehicle.downtimeRisk === "high"),
    },
    profitLeakDetection: profitLeaks,
    revenueOpportunities: [
      fleetStatus.chad
        ? {
            opportunity: `Protect and replicate ${fleetStatus.chad.vehicleName} performance`,
            evidence: `${fleetStatus.chad.netRevenue} net revenue over ${fleetStatus.lookbackDays}d`,
            estimatedImpact: roundMoney(Math.max(0, fleetStatus.chad.netRevenue) * 3),
            confidence: "medium",
          }
        : null,
      availableVehicleCount > 0
        ? {
            opportunity: "Fill idle available fleet days",
            evidence: `${availableVehicleCount} available vehicle(s) today`,
            estimatedImpact: roundMoney(availableVehicleCount * 45 * 30),
            confidence: "medium",
          }
        : null,
    ].filter(Boolean),
    operationalRisks: [
      staleTelemetryCount
        ? { severity: "high", risk: "Telemetry blind spots", evidence: `${staleTelemetryCount} vehicle(s) stale or missing comms` }
        : null,
      totalLoanBalance > 0
        ? { severity: "medium", risk: "Debt exposure", evidence: `${totalLoanBalance} fleet loan balance tracked` }
        : null,
      vehiclesWithNext30Risk.length
        ? { severity: "high", risk: "Booking disruption", evidence: `${vehiclesWithNext30Risk.length} vehicle(s) have risk plus upcoming trips` }
        : null,
    ].filter(Boolean),
    kpiDashboard: {
      occupancy: operations.occupancyPercent,
      revenue: monthToDateRevenue,
      profit: monthToDateProfit,
      revenuePerAvailableVehicle: revenuePerVehicle,
      fleetUtilization: operations.occupancyPercent,
      downtimeRiskVehicles: offlineVehicles.length,
      maintenanceCostPerMile: null,
      guestRating: null,
      trendComparisons: "Previous-day, last-week, and last-month trend fields are not yet materialized in this context; call out missing trend data instead of inventing it.",
    },
    decisionsRequired: [],
    blindSpot: profitLeaks[0] || null,
  };
}

async function collectDailyBriefContext(options = {}) {
  const date = normalizeBriefDate(options.date);
  const timeZone = cleanText(options.timeZone, 80) || DEFAULT_TIME_ZONE;

  const client = options.client || pool;
  const params = [date];
  const tripsSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    )
    SELECT
      t.id,
      t.reservation_id,
      t.guest_name,
      t.vehicle_name,
      COALESCE(v.nickname, v.turo_vehicle_name, t.vehicle_name) AS vehicle_nickname,
      t.trip_start,
      t.trip_end,
      t.pickup_location,
      t.return_location,
      t.status,
      t.workflow_stage,
      t.amount,
      t.toll_total,
      t.toll_review_status,
      t.expense_status,
      t.closed_out
    FROM trips t
    LEFT JOIN vehicles v
      ON (
        NULLIF(t.turo_vehicle_id, '') IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
      OR (
        COALESCE(t.vehicle_name, '') <> ''
        AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) = LOWER(t.vehicle_name)
      )
    CROSS JOIN bounds b
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
      AND (
        (t.trip_start >= b.day_start AND t.trip_start < b.day_end)
        OR (t.trip_end >= b.day_start AND t.trip_end < b.day_end)
        OR (t.trip_start < b.day_end AND t.trip_end >= b.day_start)
        OR (t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false)
      )
    ORDER BY t.trip_start ASC NULLS LAST, t.trip_end ASC NULLS LAST
    LIMIT 80
  `;

  const tasksSql = `
    SELECT
      mt.id,
      COALESCE(v.nickname, v.turo_vehicle_name, mt.vehicle_vin) AS vehicle_name,
      mt.title,
      mt.priority,
      mt.status,
      mt.blocks_rental,
      mt.blocks_guest_export,
      mt.needs_review,
      mt.updated_at
    FROM maintenance_tasks mt
    LEFT JOIN vehicles v ON v.vin = mt.vehicle_vin
    WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
    ORDER BY
      CASE mt.priority
        WHEN 'urgent' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        ELSE 4
      END,
      mt.updated_at DESC
    LIMIT 40
  `;

  const messageSql = `
    SELECT
      COUNT(*) FILTER (WHERE status = 'unread') AS raw_unread_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND message_type IN ('guest_message', 'guest_message_thread')
      ) AS raw_unread_guest_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND COALESCE(message_type, '') NOT IN ('payment_notice', 'renter_activity')
          AND NOT (
            message_type = 'turo_notification'
            AND trip_id IS NOT NULL
            AND subject ILIKE '%upcoming trip%'
          )
      ) AS actionable_unread_count,
      COUNT(*) FILTER (
        WHERE status = 'unread'
          AND message_type = 'guest_message'
      ) AS unread_guest_message_count,
      COUNT(DISTINCT CASE
        WHEN status = 'unread'
          AND message_type = 'guest_message'
        THEN COALESCE(
          CASE WHEN trip_id IS NOT NULL THEN 'trip:' || trip_id::text END,
          CASE WHEN reservation_id IS NOT NULL THEN 'reservation:' || reservation_id::text END,
          'guest:' || LOWER(COALESCE(guest_name, 'unknown')) || ':' || LOWER(COALESCE(vehicle_name, 'unknown'))
        )
      END) AS actionable_guest_thread_count,
      MAX(message_timestamp) FILTER (
        WHERE status = 'unread'
          AND COALESCE(message_type, '') NOT IN ('payment_notice', 'renter_activity')
      ) AS newest_unread_at,
      (
        SELECT COALESCE(jsonb_object_agg(message_type, message_count), '{}'::jsonb)
        FROM (
          SELECT
            COALESCE(NULLIF(message_type, ''), 'unknown') AS message_type,
            COUNT(*)::int AS message_count
          FROM messages
          WHERE status = 'unread'
          GROUP BY COALESCE(NULLIF(message_type, ''), 'unknown')
        ) unread_by_type
      ) AS unread_by_type
    FROM messages
  `;

  const tripChangesSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    )
    SELECT
      m.id,
      m.message_type,
      m.subject,
      m.guest_name,
      COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
      COALESCE(t.vehicle_name, m.vehicle_name) AS vehicle_name,
      m.reservation_id,
      COALESCE(m.trip_id, t.id) AS trip_id,
      m.amount,
      m.message_timestamp,
      m.created_at
    FROM messages m
    LEFT JOIN trips t
      ON t.id = m.trip_id
      OR (
        m.reservation_id IS NOT NULL
        AND t.reservation_id IS NOT NULL
        AND m.reservation_id = t.reservation_id
      )
    LEFT JOIN vehicles v
      ON (
        t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
      OR (
        COALESCE(t.vehicle_name, m.vehicle_name, '') <> ''
        AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) =
          LOWER(COALESCE(t.vehicle_name, m.vehicle_name))
      )
    CROSS JOIN bounds b
    WHERE COALESCE(m.message_timestamp, m.created_at) >= b.day_start
      AND COALESCE(m.message_timestamp, m.created_at) < b.day_end
      AND m.message_type IN ('trip_booked', 'trip_changed')
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
    ORDER BY COALESCE(m.message_timestamp, m.created_at) DESC, m.id DESC
    LIMIT 30
  `;

  const operationsSql = `
    WITH bounds AS (
      SELECT $1::date AS day_start, ($1::date + INTERVAL '1 day') AS day_end
    ),
    fleet AS (
      SELECT
        v.id,
        v.vin,
        COALESCE(v.nickname, v.turo_vehicle_name, v.vin) AS vehicle_name,
        v.turo_vehicle_id
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) = true
        AND COALESCE(v.in_service, true) = true
    ),
    active_today AS (
      SELECT DISTINCT f.id AS vehicle_id
      FROM fleet f
      JOIN trips t
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND f.turo_vehicle_id IS NOT NULL
          AND t.turo_vehicle_id = f.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) = LOWER(f.vehicle_name)
        )
      CROSS JOIN bounds b
      WHERE t.deleted_at IS NULL
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_start < b.day_end
        AND t.trip_end >= b.day_start
    ),
    latest_booking AS (
      SELECT
        m.id,
        m.subject,
        m.guest_name,
        COALESCE(v.nickname, t.vehicle_name, m.vehicle_name) AS vehicle_nickname,
        COALESCE(t.vehicle_name, m.vehicle_name) AS vehicle_name,
        m.reservation_id,
        COALESCE(m.trip_id, t.id) AS trip_id,
        COALESCE(m.amount, t.amount) AS amount,
        m.message_timestamp,
        m.created_at,
        t.created_at AS trip_created_at,
        t.trip_start,
        t.trip_end
      FROM messages m
      LEFT JOIN trips t
        ON t.id = m.trip_id
        OR (
          m.reservation_id IS NOT NULL
          AND t.reservation_id IS NOT NULL
          AND m.reservation_id = t.reservation_id
        )
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, m.vehicle_name, '') <> ''
          AND LOWER(COALESCE(v.nickname, v.turo_vehicle_name, '')) =
            LOWER(COALESCE(t.vehicle_name, m.vehicle_name))
        )
      WHERE m.message_type = 'trip_booked'
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
      ORDER BY COALESCE(m.message_timestamp, m.created_at, t.created_at) DESC NULLS LAST, m.id DESC
      LIMIT 1
    )
    SELECT
      (SELECT COUNT(*) FROM fleet)::int AS active_fleet_count,
      (SELECT COUNT(*) FROM active_today)::int AS occupied_vehicle_count,
      (
        SELECT COALESCE(jsonb_agg(vehicle_name ORDER BY vehicle_name), '[]'::jsonb)
        FROM (
          SELECT f.vehicle_name
          FROM fleet f
          JOIN active_today a ON a.vehicle_id = f.id
        ) occupied
      ) AS occupied_vehicle_names,
      (
        SELECT to_jsonb(latest_booking)
        FROM latest_booking
      ) AS latest_booking
  `;

  const fleetStatusSql = `
    WITH bounds AS (
      SELECT
        ($1::date + INTERVAL '1 day') AS range_end,
        ($1::date + INTERVAL '1 day' - INTERVAL '10 days') AS range_start
    ),
    fleet AS (
      SELECT
        v.id,
        v.vin,
        COALESCE(v.nickname, v.turo_vehicle_name, v.vin) AS vehicle_name,
        v.turo_vehicle_id
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) = true
        AND COALESCE(v.in_service, true) = true
    ),
    trip_vehicle AS (
      SELECT
        t.*,
        f.id AS vehicle_id,
        f.vehicle_name
      FROM trips t
      JOIN fleet f
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND f.turo_vehicle_id IS NOT NULL
          AND t.turo_vehicle_id = f.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) = LOWER(f.vehicle_name)
        )
      CROSS JOIN bounds b
      WHERE t.deleted_at IS NULL
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_start < b.range_end
        AND t.trip_end >= b.range_start
    ),
    trip_window_metrics AS (
      SELECT
        tv.vehicle_id,
        COALESCE(tf.host_payout, tv.amount, 0) AS total_revenue,
        COALESCE(tf.issue_flag, false) AS issue_flag,
        tv.trip_start >= b.range_start AND tv.trip_start < b.range_end AS started_in_window,
        GREATEST(
          0,
          EXTRACT(EPOCH FROM (
            LEAST(tv.trip_end, b.range_end) - GREATEST(tv.trip_start, b.range_start)
          )) / 86400.0
        ) AS overlap_days,
        GREATEST(
          EXTRACT(EPOCH FROM (tv.trip_end - tv.trip_start)) / 86400.0,
          1
        ) AS trip_days
      FROM trip_vehicle tv
      CROSS JOIN bounds b
      LEFT JOIN trip_financial_facts tf ON tf.trip_id = tv.id
    ),
    trip_metrics AS (
      SELECT
        vehicle_id,
        COUNT(*) FILTER (WHERE started_in_window)::int AS booking_count,
        COUNT(*)::int AS active_trip_count,
        COALESCE(SUM(total_revenue * (overlap_days / NULLIF(trip_days, 0))), 0) AS revenue,
        COALESCE(SUM(overlap_days), 0) AS booked_days,
        COUNT(*) FILTER (WHERE issue_flag = true)::int AS issue_trips
      FROM trip_window_metrics
      GROUP BY vehicle_id
    ),
    expense_vehicle AS (
      SELECT
        COALESCE(e.vehicle_id::bigint, tv.vehicle_id) AS vehicle_id,
        e.price,
        e.tax
      FROM expenses e
      CROSS JOIN bounds b
      LEFT JOIN trip_vehicle tv ON tv.id = e.trip_id
      WHERE e.date >= b.range_start::date
        AND e.date < b.range_end::date
        AND COALESCE(e.is_capitalized, false) = false
    ),
    expense_metrics AS (
      SELECT
        vehicle_id,
        COALESCE(SUM(COALESCE(price, 0) + COALESCE(tax, 0)), 0) AS operating_cost
      FROM expense_vehicle
      WHERE vehicle_id IS NOT NULL
      GROUP BY vehicle_id
    ),
    maintenance_metrics AS (
      SELECT
        f.id AS vehicle_id,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
        )::int AS open_maintenance_tasks,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
            AND (mt.blocks_rental = true OR mt.blocks_guest_export = true)
        )::int AS blocker_tasks,
        COUNT(*) FILTER (
          WHERE mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
            AND mt.priority IN ('urgent', 'high')
        )::int AS high_priority_tasks,
        COALESCE(SUM(
          CASE
            WHEN mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
              AND (mt.blocks_rental = true OR mt.blocks_guest_export = true)
            THEN GREATEST(
              0,
              EXTRACT(EPOCH FROM (
                b.range_end - GREATEST(mt.created_at::timestamptz, b.range_start)
              )) / 86400.0
            )
            ELSE 0
          END
        ), 0) AS blocker_days
      FROM fleet f
      CROSS JOIN bounds b
      LEFT JOIN maintenance_tasks mt ON mt.vehicle_vin = f.vin
      GROUP BY f.id
    )
    SELECT
      f.id AS vehicle_id,
      f.vehicle_name,
      COALESCE(tm.booking_count, 0) AS booking_count,
      COALESCE(tm.active_trip_count, 0) AS active_trip_count,
      COALESCE(tm.revenue, 0) AS revenue,
      COALESCE(tm.booked_days, 0) AS booked_days,
      CASE
        WHEN COALESCE(tm.booked_days, 0) > 0
        THEN COALESCE(tm.revenue, 0) / tm.booked_days
        ELSE 0
      END AS avg_daily_rate,
      COALESCE(tm.issue_trips, 0) AS issue_trips,
      COALESCE(em.operating_cost, 0) AS operating_cost,
      COALESCE(mm.open_maintenance_tasks, 0) AS open_maintenance_tasks,
      COALESCE(mm.blocker_tasks, 0) AS blocker_tasks,
      COALESCE(mm.high_priority_tasks, 0) AS high_priority_tasks,
      COALESCE(mm.blocker_days, 0) AS blocker_days
    FROM fleet f
    LEFT JOIN trip_metrics tm ON tm.vehicle_id = f.id
    LEFT JOIN expense_metrics em ON em.vehicle_id = f.id
    LEFT JOIN maintenance_metrics mm ON mm.vehicle_id = f.id
    ORDER BY COALESCE(tm.revenue, 0) DESC, f.vehicle_name ASC
  `;

  const financeSql = `
    WITH bounds AS (
      SELECT
        $1::date AS day_start,
        ($1::date + INTERVAL '1 day') AS day_end,
        date_trunc('month', $1::date)::date AS month_start,
        (date_trunc('month', $1::date) + INTERVAL '1 month')::date AS month_end
    )
    SELECT
      b.month_start,
      b.month_end,
      EXTRACT(DAY FROM b.day_start)::int AS month_days_elapsed,
      EXTRACT(DAY FROM (b.month_end - INTERVAL '1 day'))::int AS month_days_total,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.day_start AND t.trip_start < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS opening_trip_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_end >= b.day_start AND t.trip_end < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS closing_trip_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.month_start AND t.trip_start < b.day_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS month_to_date_revenue,
      (
        SELECT COALESCE(SUM(COALESCE(e.price, 0) + COALESCE(e.tax, 0)), 0)
        FROM expenses e
        WHERE e.date >= b.month_start
          AND e.date < b.day_end::date
          AND COALESCE(e.is_capitalized, false) = false
      ) AS month_to_date_expenses,
      COALESCE(SUM(CASE
        WHEN t.trip_start >= b.day_end AND t.trip_start < b.month_end
        THEN COALESCE(tf.host_payout, t.amount, 0)
        ELSE 0
      END), 0) AS booked_remaining_month_revenue,
      COALESCE(SUM(CASE
        WHEN t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false
        THEN COALESCE(t.toll_total, 0)
        ELSE 0
      END), 0) AS open_closeout_tolls,
      COUNT(*) FILTER (
        WHERE t.trip_end < b.day_end AND COALESCE(t.closed_out, false) = false
      ) AS open_closeout_count
    FROM trips t
    LEFT JOIN trip_financial_facts tf ON tf.trip_id = t.id
    CROSS JOIN bounds b
    WHERE t.deleted_at IS NULL
      AND COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
    GROUP BY b.month_start, b.month_end, b.day_start, b.day_end
  `;

  const vehicleStatusSql = `
    WITH fleet AS (
      SELECT
        v.id,
        v.vin,
        COALESCE(v.nickname, v.turo_vehicle_name, v.vin) AS vehicle_name,
        v.turo_vehicle_id,
        v.current_odometer_miles,
        v.registration_month,
        v.registration_year,
        v.in_service,
        v.is_active,
        v.dimo_token_id,
        v.bouncie_vehicle_id,
        v.external_vehicle_key
      FROM vehicles v
      WHERE COALESCE(v.is_active, true) = true
    )
    SELECT
      f.id AS vehicle_id,
      f.vin,
      f.vehicle_name,
      f.current_odometer_miles,
      f.registration_month,
      f.registration_year,
      f.in_service,
      fp.loan_balance,
      fp.monthly_payment,
      fp.insurance_monthly,
      fp.registration_annual,
      latest.service_name,
      latest.address,
      latest.latitude,
      latest.longitude,
      latest.fuel_level,
      latest.battery_voltage,
      latest.mil_on,
      latest.dtc_count,
      latest.vehicle_last_updated,
      latest.captured_at,
      COALESCE(
        latest.vehicle_last_updated,
        latest.ignition_last_updated,
        latest.location_last_updated,
        latest.speed_last_updated,
        latest.odometer_last_updated,
        latest.fuel_level_last_updated,
        latest.captured_at
      ) AS last_comm_at,
      next_trip.id AS next_trip_id,
      next_trip.guest_name AS next_guest_name,
      next_trip.trip_start AS next_trip_start,
      next_trip.trip_end AS next_trip_end,
      next_trip.amount AS next_amount,
      COALESCE(maintenance.open_maintenance_items, 0) AS open_maintenance_items,
      COALESCE(maintenance.blocker_maintenance_items, 0) AS blocker_maintenance_items,
      COALESCE(maintenance.high_priority_maintenance_items, 0) AS high_priority_maintenance_items,
      maintenance.estimated_maintenance_labor_hours,
      COALESCE(maintenance.maintenance_titles, '[]'::jsonb) AS maintenance_titles
    FROM fleet f
    LEFT JOIN vehicle_financial_profiles fp
      ON fp.vehicle_id = f.id
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM vehicle_telemetry_snapshots s
      WHERE (
        (f.vin IS NOT NULL AND s.vin IS NOT NULL AND LOWER(s.vin) = LOWER(f.vin))
        OR (f.dimo_token_id IS NOT NULL AND s.dimo_token_id = f.dimo_token_id)
        OR (COALESCE(f.bouncie_vehicle_id, '') <> '' AND s.external_vehicle_key = f.bouncie_vehicle_id)
        OR (COALESCE(f.external_vehicle_key, '') <> '' AND s.external_vehicle_key = f.external_vehicle_key)
      )
      ORDER BY COALESCE(
        s.vehicle_last_updated,
        s.ignition_last_updated,
        s.location_last_updated,
        s.speed_last_updated,
        s.odometer_last_updated,
        s.fuel_level_last_updated,
        s.captured_at
      ) DESC NULLS LAST,
      s.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.guest_name, t.trip_start, t.trip_end, t.amount
      FROM trips t
      WHERE t.deleted_at IS NULL
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_start >= $1::date
        AND (
          (t.turo_vehicle_id IS NOT NULL AND f.turo_vehicle_id IS NOT NULL AND t.turo_vehicle_id = f.turo_vehicle_id)
          OR (COALESCE(t.vehicle_name, '') <> '' AND LOWER(t.vehicle_name) = LOWER(f.vehicle_name))
        )
      ORDER BY t.trip_start ASC NULLS LAST, t.id ASC
      LIMIT 1
    ) next_trip ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS open_maintenance_items,
        COUNT(*) FILTER (WHERE mt.blocks_rental = true OR mt.blocks_guest_export = true OR mt.needs_review = true)::int AS blocker_maintenance_items,
        COUNT(*) FILTER (WHERE mt.priority IN ('urgent', 'high'))::int AS high_priority_maintenance_items,
        SUM(COALESCE(mt.actual_labor_hours, mt.estimated_labor_hours, 0)) AS estimated_maintenance_labor_hours,
        jsonb_agg(mt.title ORDER BY
          CASE mt.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          mt.updated_at DESC
        ) FILTER (WHERE mt.title IS NOT NULL) AS maintenance_titles
      FROM maintenance_tasks mt
      WHERE mt.vehicle_vin = f.vin
        AND mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
    ) maintenance ON true
    ORDER BY f.vehicle_name ASC
  `;

  const tripsResult = await client.query(tripsSql, params);
  const tasksResult = await client.query(tasksSql);
  const messageResult = await client.query(messageSql);
  const tripChangesResult = await client.query(tripChangesSql, params);
  const operationsResult = await client.query(operationsSql, params);
  const fleetStatusResult = await client.query(fleetStatusSql, params);
  const financeResult = await client.query(financeSql, params);
  const vehicleStatusResult = await client.query(vehicleStatusSql, params);

  const trips = tripsResult.rows.map(mapTrip);
  const dayStartMs = new Date(`${date}T00:00:00`).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const inDay = (value) => {
    const ms = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ms) && ms >= dayStartMs && ms < dayEndMs;
  };

  const openingTrips = trips.filter((trip) => inDay(trip.start));
  const closingTrips = trips.filter((trip) => inDay(trip.end));
  const activeTrips = trips.filter((trip) => {
    const startMs = trip.start ? new Date(trip.start).getTime() : NaN;
    const endMs = trip.end ? new Date(trip.end).getTime() : NaN;
    return (
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs < dayEndMs &&
      endMs >= dayStartMs
    );
  });
  const pendingCloseouts = trips.filter(
    (trip) =>
      trip.end &&
      new Date(trip.end).getTime() < dayEndMs &&
      trip.closedOut !== true
  );

  const tasks = tasksResult.rows.map(mapTask);
  const finance = financeResult.rows[0] || {};
  const monthlyProjection = buildMonthlyProjection(finance);
  const messages = messageResult.rows[0] || {};
  const operations = operationsResult.rows[0] || {};
  const activeFleetCount = Number(operations.active_fleet_count || 0);
  const occupiedVehicleCount = Number(operations.occupied_vehicle_count || 0);
  const occupancyPercent =
    activeFleetCount > 0
      ? Math.round((occupiedVehicleCount / activeFleetCount) * 1000) / 10
      : null;
  const tripChanges = tripChangesResult.rows.map(mapTripChange);
  const fleetStatus = selectFleetStatus(
    fleetStatusResult.rows.map(mapFleetStatusCandidate)
  );
  const vehicleStatus = vehicleStatusResult.rows.map(mapVehicleOperationsRow);
  const operationsWithOccupancy = {
    ...operations,
    occupancyPercent,
  };
  const executive = buildExecutiveOperationsContext({
    activeTrips,
    closingTrips,
    finance,
    fleetStatus,
    messages: {
      unreadGuestCount: Number(messages.actionable_guest_thread_count || 0),
    },
    monthlyProjection,
    openingTrips,
    operations: operationsWithOccupancy,
    pendingCloseouts,
    tasks,
    tripChanges,
    vehicleStatus,
  });

  return {
    date,
    timeZone,
    generatedAt: new Date().toISOString(),
    trips: {
      opening: openingTrips,
      closing: closingTrips,
      newTripsStarting: openingTrips,
      tripsEndingToday: closingTrips,
      active: activeTrips,
      pendingCloseouts,
      changesToday: tripChanges,
    },
    tasks: {
      totalOpen: tasks.length,
      urgentOrHigh: tasks.filter((task) =>
        ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
      ),
      blockers: tasks.filter(
        (task) => task.blocksRental || task.blocksGuestExport || task.needsReview
      ),
      sample: tasks.slice(0, 12),
    },
    messages: {
      unreadCount: Number(messages.actionable_unread_count || 0),
      unreadGuestCount: Number(messages.actionable_guest_thread_count || 0),
      rawUnreadCount: Number(messages.raw_unread_count || 0),
      rawUnreadGuestCount: Number(messages.raw_unread_guest_count || 0),
      unreadGuestMessageCount: Number(messages.unread_guest_message_count || 0),
      actionableGuestThreadCount: Number(messages.actionable_guest_thread_count || 0),
      newestUnreadAt: messages.newest_unread_at || null,
      unreadByType:
        messages.unread_by_type &&
        typeof messages.unread_by_type === "object" &&
        !Array.isArray(messages.unread_by_type)
          ? messages.unread_by_type
          : {},
    },
    operations: {
      latestBookedTrip: mapLatestBookedTrip(operations.latest_booking),
      occupancy: {
        occupiedVehicleCount,
        activeFleetCount,
        occupancyPercent,
        occupiedVehicleNames: Array.isArray(operations.occupied_vehicle_names)
          ? operations.occupied_vehicle_names
          : [],
      },
    },
    fleetStatus,
    vehicleStatus,
    executive,
    finance: {
      openingTripRevenue: roundMoney(finance.opening_trip_revenue),
      closingTripRevenue: roundMoney(finance.closing_trip_revenue),
      monthToDateRevenue: roundMoney(finance.month_to_date_revenue),
      monthToDateExpenses: roundMoney(finance.month_to_date_expenses),
      monthToDateProfit: roundMoney(
        toNumber(finance.month_to_date_revenue) - toNumber(finance.month_to_date_expenses)
      ),
      monthlyProjection,
      openCloseoutTolls: roundMoney(finance.open_closeout_tolls),
      openCloseoutCount: Number(finance.open_closeout_count || 0),
    },
  };
}

function normalizePromptInstructions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item, 4000)).filter(Boolean);
  }

  const text = cleanText(value, 24000);
  return text ? [text] : [];
}

function buildBriefPrompt(context, promptSettings = {}) {
  return JSON.stringify(
    {
      context,
      promptVersion: promptSettings.version || "daily-brief",
      instructions: normalizePromptInstructions(promptSettings.instructions),
    },
    null,
    2
  );
}

async function generateDailyBrief(options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 503;
    throw err;
  }

  const context = await collectDailyBriefContext(options);
  const promptSettings = await getAiPromptSettings();
  const dailyBriefPrompt = promptSettings.dailyBrief || {};
  const model = options.model || DEFAULT_OPENAI_MODEL;
  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: cleanText(
              dailyBriefPrompt.systemPrompt,
              12000
            ) || "Return only the brief text.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: buildBriefPrompt(context, dailyBriefPrompt) }],
      },
    ],
    temperature: 0.25,
    max_output_tokens: 2600,
  };

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(`OpenAI daily brief request failed: HTTP ${response.status}`);
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  const brief = extractResponseText(raw);
  if (!brief) {
    const err = new Error("OpenAI daily brief request returned no text output");
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  return {
    date: context.date,
    timeZone: context.timeZone,
    generatedAt: context.generatedAt,
    model,
    promptVersion: dailyBriefPrompt.version || null,
    brief,
    context,
  };
}

async function getLatestDailyBrief(client = pool) {
  const { rows } = await client.query(
    `
      SELECT value, updated_at
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [DAILY_BRIEF_LATEST_KEY]
  );

  return rows[0]
    ? {
        ...(rows[0].value || {}),
        savedAt: rows[0].updated_at,
      }
    : null;
}

async function getDailyBriefRunHistory(client = pool) {
  const { rows } = await client.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [DAILY_BRIEF_RUN_HISTORY_KEY]
  );

  const value = rows[0]?.value;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function saveDailyBriefResult(result, client = pool) {
  const value = {
    date: result.date,
    timeZone: result.timeZone,
    generatedAt: result.generatedAt,
    model: result.model,
    brief: result.brief,
    context: result.context,
  };
  const history = await getDailyBriefRunHistory(client);
  const historyValue = {
    ...history,
    [result.date]: {
      generatedAt: result.generatedAt,
      model: result.model,
      briefLength: String(result.brief || "").length,
    },
  };

  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [DAILY_BRIEF_LATEST_KEY, JSON.stringify(value)]
  );

  await client.query(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [DAILY_BRIEF_RUN_HISTORY_KEY, JSON.stringify(historyValue)]
  );

  return value;
}

async function generateAndSaveDailyBrief(options = {}) {
  const result = await generateDailyBrief(options);
  await saveDailyBriefResult(result, options.client || pool);
  return result;
}

module.exports = {
  collectDailyBriefContext,
  generateAndSaveDailyBrief,
  generateDailyBrief,
  getDailyBriefRunHistory,
  getLatestDailyBrief,
  saveDailyBriefResult,
};
