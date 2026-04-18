// --------------------------------------------------------------
// server/scripts/auditOrphanTrips.js
//
// Read-only audit for Denmark 2.0 trips that are likely missing
// usable vehicle assignment for per-vehicle metrics.
//
// It looks at:
// - D2 trips
// - D2 vehicles
// - legacy trips (for reservation_id -> legacy vehicle_id)
//
// It does NOT update anything.
// --------------------------------------------------------------

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createLegacyPool() {
  return new Pool({
    host: requireEnv("DB_HOST_LEG"),
    port: Number(process.env.DB_PORT_LEG || 5432),
    user: requireEnv("DB_USER_LEG"),
    password: requireEnv("DB_PASS_LEG"),
    database: requireEnv("DB_NAME_LEG"),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
}

function createD2Pool() {
  return new Pool({
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeText(value) {
  return cleanString(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function normalizeTripStage(workflowStage, status) {
  const stage = cleanString(workflowStage)?.toLowerCase();
  const rawStatus = cleanString(status)?.toLowerCase();

  if (stage) return stage;

  if (rawStatus === "canceled" || rawStatus === "cancelled") return "canceled";
  if (
    rawStatus === "completed" ||
    rawStatus === "complete" ||
    rawStatus === "closed" ||
    rawStatus === "closed_out"
  ) {
    return "complete";
  }
  if (rawStatus === "in_progress" || rawStatus === "active") return "in_progress";
  if (rawStatus === "confirmed") return "confirmed";
  if (rawStatus === "booked") return "booked";

  return rawStatus || "unknown";
}

function isTerminalStage(stage) {
  return stage === "complete" || stage === "canceled";
}

function isLiveStage(stage) {
  return ["booked", "confirmed", "ready_for_handoff", "in_progress", "turnaround", "awaiting_expenses"].includes(stage);
}

async function getTableColumns(pool, tableName) {
  const sql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `;
  const { rows } = await pool.query(sql, [tableName]);
  return rows.map((r) => r.column_name);
}

function pickExistingColumns(existingColumns, desiredColumns) {
  const set = new Set(existingColumns);
  return desiredColumns.filter((c) => set.has(c));
}

async function fetchD2Trips(pool) {
  const sql = `
    SELECT
      id,
      reservation_id,
      vehicle_name,
      guest_name,
      trip_start,
      trip_end,
      status,
      amount,
      created_at,
      updated_at,
      closed_out,
      closed_out_at,
      turo_vehicle_id,
      workflow_stage,
      expense_status,
      completed_at,
      canceled_at,
      starting_odometer,
      has_tolls,
      toll_count,
      toll_total,
      ending_odometer,
      notes,
      deleted_at
    FROM trips
    WHERE deleted_at IS NULL
    ORDER BY id
  `;
  const { rows } = await pool.query(sql);

  return rows.map((row) => {
    const normalizedStage = normalizeTripStage(row.workflow_stage, row.status);
    return {
      id: row.id,
      reservation_id: cleanString(row.reservation_id),
      vehicle_name: cleanString(row.vehicle_name),
      vehicle_name_norm: normalizeText(row.vehicle_name),
      guest_name: cleanString(row.guest_name),
      trip_start: row.trip_start,
      trip_end: row.trip_end,
      status: cleanString(row.status),
      workflow_stage: cleanString(row.workflow_stage),
      normalized_stage: normalizedStage,
      amount: toNumber(row.amount),
      turo_vehicle_id: cleanString(row.turo_vehicle_id),
      starting_odometer: row.starting_odometer,
      ending_odometer: row.ending_odometer,
      toll_total: toNumber(row.toll_total),
      has_tolls: row.has_tolls,
      expense_status: cleanString(row.expense_status),
      closed_out: row.closed_out,
      completed_at: row.completed_at,
      canceled_at: row.canceled_at,
      notes: cleanString(row.notes),
      raw: row,
    };
  });
}

async function fetchLegacyTrips(pool) {
  const sql = `
    SELECT
      id,
      reservation_id,
      vehicle_id,
      renter_name,
      status,
      start_date,
      end_date,
      start_at,
      end_at,
      gross_income,
      mileage_start,
      mileage_end,
      toll_reimbursement,
      notes,
      expense_report_done,
      updated_on
    FROM trips
    ORDER BY id
  `;

  const { rows } = await pool.query(sql);

  const byReservation = new Map();

  for (const row of rows) {
    const reservationId = cleanString(row.reservation_id);
    if (!reservationId) continue;

    const existing = byReservation.get(reservationId);
    const candidate = {
      id: row.id,
      reservation_id: reservationId,
      legacy_vehicle_id: row.vehicle_id ?? null,
      renter_name: cleanString(row.renter_name),
      status: cleanString(row.status),
      amount: toNumber(row.gross_income),
      starting_odometer: row.mileage_start ?? null,
      ending_odometer: row.mileage_end ?? null,
      toll_reimbursement: toNumber(row.toll_reimbursement),
      expense_report_done: row.expense_report_done === true,
      updated_on: row.updated_on,
      notes: cleanString(row.notes),
      raw: row,
    };

    if (!existing) {
      byReservation.set(reservationId, candidate);
      continue;
    }

    const existingScore =
      (existing.legacy_vehicle_id != null ? 3 : 0) +
      (existing.amount != null ? 2 : 0) +
      (existing.starting_odometer != null ? 2 : 0) +
      (existing.ending_odometer != null ? 2 : 0) +
      (existing.expense_report_done ? 2 : 0);

    const candidateScore =
      (candidate.legacy_vehicle_id != null ? 3 : 0) +
      (candidate.amount != null ? 2 : 0) +
      (candidate.starting_odometer != null ? 2 : 0) +
      (candidate.ending_odometer != null ? 2 : 0) +
      (candidate.expense_report_done ? 2 : 0);

    if (candidateScore > existingScore) {
      byReservation.set(reservationId, candidate);
      continue;
    }

    if (candidateScore === existingScore) {
      const existingTs = new Date(existing.updated_on || 0).getTime() || 0;
      const candidateTs = new Date(candidate.updated_on || 0).getTime() || 0;
      if (candidateTs > existingTs) {
        byReservation.set(reservationId, candidate);
      }
    }
  }

  return byReservation;
}

async function fetchD2Vehicles(pool) {
  const existingColumns = await getTableColumns(pool, "vehicles");

  const desired = [
    "id",
    "nickname",
    "year",
    "make",
    "model",
    "vin",
    "plate_number",
    "turo_vehicle_id",
    "turo_vehicle_name",
  ];

  const cols = pickExistingColumns(existingColumns, desired);
  if (!cols.length) {
    throw new Error("Could not find usable columns on public.vehicles");
  }

  const sql = `SELECT ${cols.join(", ")} FROM vehicles ORDER BY id`;
  const { rows } = await pool.query(sql);

  return rows.map((row) => {
    const year = row.year != null ? String(row.year) : null;
    const make = cleanString(row.make);
    const model = cleanString(row.model);
    const nickname = cleanString(row.nickname);
    const turoVehicleName = cleanString(row.turo_vehicle_name);

    const labels = [
      nickname,
      turoVehicleName,
      [year, make, model].filter(Boolean).join(" "),
      [make, model].filter(Boolean).join(" "),
      model,
    ]
      .map(normalizeText)
      .filter(Boolean);

    return {
      id: row.id,
      nickname,
      year,
      make,
      model,
      vin: cleanString(row.vin),
      plate_number: cleanString(row.plate_number),
      turo_vehicle_id: cleanString(row.turo_vehicle_id),
      turo_vehicle_name: turoVehicleName,
      labels: [...new Set(labels)],
      raw: row,
    };
  });
}

function buildVehicleIndexes(vehicles) {
  const byTuroVehicleId = new Map();
  const byLabel = new Map();
  const byId = new Map();

  for (const vehicle of vehicles) {
    byId.set(vehicle.id, vehicle);

    if (vehicle.turo_vehicle_id) {
      byTuroVehicleId.set(vehicle.turo_vehicle_id, vehicle);
    }

    for (const label of vehicle.labels) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(vehicle);
    }
  }

  return { byTuroVehicleId, byLabel, byId };
}

function findVehicleMatch(trip, vehicleIndexes, legacyMap) {
  const reasons = [];
  let matchedVehicle = null;

  if (trip.turo_vehicle_id && vehicleIndexes.byTuroVehicleId.has(trip.turo_vehicle_id)) {
    matchedVehicle = vehicleIndexes.byTuroVehicleId.get(trip.turo_vehicle_id);
    reasons.push("matched_by_turo_vehicle_id");
    return { matchedVehicle, reasons, confidence: "high" };
  }

  if (trip.vehicle_name_norm) {
    const labelMatches = vehicleIndexes.byLabel.get(trip.vehicle_name_norm) || [];
    if (labelMatches.length === 1) {
      matchedVehicle = labelMatches[0];
      reasons.push("matched_by_vehicle_name");
      return { matchedVehicle, reasons, confidence: "medium" };
    }
    if (labelMatches.length > 1) {
      reasons.push("ambiguous_vehicle_name_match");
    }
  }

  const legacy = trip.reservation_id ? legacyMap.get(trip.reservation_id) : null;
  if (legacy?.legacy_vehicle_id && vehicleIndexes.byId.has(legacy.legacy_vehicle_id)) {
    matchedVehicle = vehicleIndexes.byId.get(legacy.legacy_vehicle_id);
    reasons.push("matched_by_legacy_vehicle_id");
    return { matchedVehicle, reasons, confidence: "medium" };
  }

  if (legacy?.legacy_vehicle_id && !vehicleIndexes.byId.has(legacy.legacy_vehicle_id)) {
    reasons.push("legacy_vehicle_id_not_found_in_d2_vehicles");
  }

  if (!trip.turo_vehicle_id) reasons.push("missing_trip_turo_vehicle_id");
  if (!trip.vehicle_name_norm) reasons.push("missing_trip_vehicle_name");

  return { matchedVehicle: null, reasons, confidence: "none" };
}

function classifyTrip(trip, matchResult, legacyMap) {
  const legacy = trip.reservation_id ? legacyMap.get(trip.reservation_id) : null;
  const terminal = isTerminalStage(trip.normalized_stage);
  const live = isLiveStage(trip.normalized_stage);

  const hasDirectAssignment = Boolean(trip.turo_vehicle_id);
  const hasVehicleName = Boolean(trip.vehicle_name_norm);
  const hasLegacyVehicle = Boolean(legacy?.legacy_vehicle_id);

  let className = "assigned";
  let actionable = false;

  if (!matchResult.matchedVehicle) {
    if (terminal) {
      className = "orphan_terminal";
      actionable = true;
    } else if (live) {
      className = "orphan_live";
      actionable = false;
    } else {
      className = "orphan_other";
      actionable = true;
    }
  } else if (!hasDirectAssignment && (hasVehicleName || hasLegacyVehicle)) {
    className = terminal ? "backfillable_terminal" : "backfillable_live";
    actionable = terminal;
  }

  const likelyMetricImpact =
    terminal &&
    (trip.amount != null || trip.toll_total != null || trip.starting_odometer != null || trip.ending_odometer != null);

  return {
    trip_id: trip.id,
    reservation_id: trip.reservation_id,
    workflow_stage: trip.normalized_stage,
    status: trip.status,
    vehicle_name: trip.vehicle_name,
    trip_turo_vehicle_id: trip.turo_vehicle_id,
    amount: trip.amount,
    toll_total: trip.toll_total,
    starting_odometer: trip.starting_odometer,
    ending_odometer: trip.ending_odometer,

    legacy_vehicle_id: legacy?.legacy_vehicle_id ?? null,
    legacy_amount: legacy?.amount ?? null,
    legacy_toll_reimbursement: legacy?.toll_reimbursement ?? null,

    matched_vehicle_id: matchResult.matchedVehicle?.id ?? null,
    matched_vehicle_nickname: matchResult.matchedVehicle?.nickname ?? null,
    matched_vehicle_turo_vehicle_id: matchResult.matchedVehicle?.turo_vehicle_id ?? null,
    match_confidence: matchResult.confidence,
    match_reasons: matchResult.reasons,

    classification: className,
    actionable,
    likely_metric_impact: likelyMetricImpact,
  };
}

function summarize(rows) {
  const summary = {
    total_trips: rows.length,
    assigned: 0,
    backfillable_terminal: 0,
    backfillable_live: 0,
    orphan_terminal: 0,
    orphan_live: 0,
    orphan_other: 0,
    actionable: 0,
    likely_metric_impact: 0,
  };

  for (const row of rows) {
    if (summary[row.classification] !== undefined) {
      summary[row.classification] += 1;
    }
    if (row.actionable) summary.actionable += 1;
    if (row.likely_metric_impact) summary.likely_metric_impact += 1;
  }

  return summary;
}

function bucketBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] ?? "null";
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
}

async function writeReport(report) {
  const outputPath = path.resolve(process.cwd(), "tmp", "orphan-trip-audit.json");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  return outputPath;
}

async function main() {
  const legacyPool = createLegacyPool();
  const d2Pool = createD2Pool();

  try {
    console.log("Loading D2 trips...");
    const trips = await fetchD2Trips(d2Pool);
    console.log(`Loaded ${trips.length} D2 trips.`);

    console.log("Loading D2 vehicles...");
    const vehicles = await fetchD2Vehicles(d2Pool);
    console.log(`Loaded ${vehicles.length} D2 vehicles.`);

    console.log("Loading legacy trip map...");
    const legacyMap = await fetchLegacyTrips(legacyPool);
    console.log(`Loaded ${legacyMap.size} legacy reservations.`);

    const vehicleIndexes = buildVehicleIndexes(vehicles);

    const classified = trips.map((trip) => {
      const match = findVehicleMatch(trip, vehicleIndexes, legacyMap);
      return classifyTrip(trip, match, legacyMap);
    });

    const interestingRows = classified
      .filter((row) => row.classification !== "assigned")
      .sort((a, b) => {
        if (Number(b.actionable) !== Number(a.actionable)) {
          return Number(b.actionable) - Number(a.actionable);
        }
        if (Number(b.likely_metric_impact) !== Number(a.likely_metric_impact)) {
          return Number(b.likely_metric_impact) - Number(a.likely_metric_impact);
        }
        return String(a.reservation_id || "").localeCompare(String(b.reservation_id || ""));
      });

    const report = {
      generated_at: new Date().toISOString(),
      summary: summarize(classified),
      classification_counts: bucketBy(classified, "classification"),
      stage_counts: bucketBy(classified, "workflow_stage"),
      match_reason_counts: (() => {
        const counts = {};
        for (const row of classified) {
          for (const reason of row.match_reasons || []) {
            counts[reason] = (counts[reason] || 0) + 1;
          }
        }
        return Object.fromEntries(
          Object.entries(counts).sort((a, b) => b[1] - a[1])
        );
      })(),
      rows: interestingRows,
    };

    const outputPath = await writeReport(report);

    console.log("");
    console.log("Orphan trip audit summary");
    console.log("-------------------------");
    for (const [key, value] of Object.entries(report.summary)) {
      console.log(`${key}: ${value}`);
    }
    console.log("");
    console.log(`Report written to: ${outputPath}`);
    console.log("");
  } finally {
    await Promise.allSettled([legacyPool.end(), d2Pool.end()]);
  }
}

main().catch((err) => {
  console.error("");
  console.error("auditOrphanTrips failed:");
  console.error(err);
  console.error("");
  process.exit(1);
});