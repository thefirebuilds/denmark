// --------------------------------------------------------------
// server/scripts/backfillTripVehicleAssignments.js
//
// Backfill trip -> vehicle assignment for Denmark 2.0 trips that
// are terminal and safely matchable to a known vehicle.
//
// Dry run by default.
// Real write requires:
//   SYNC_WRITE=true
//   SYNC_CONFIRM=YES
//
// Usage:
//   node backfillTripVehicleAssignments.js
//
// Real write:
//   set SYNC_WRITE=true
//   set SYNC_CONFIRM=YES
//   node backfillTripVehicleAssignments.js
// --------------------------------------------------------------

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

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

function normalizeText(value) {
  return (
    cleanString(value)
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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

async function fetchTrips(pool) {
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
      turo_vehicle_id,
      workflow_stage,
      expense_status,
      completed_at,
      canceled_at,
      starting_odometer,
      ending_odometer,
      toll_total,
      deleted_at,
      updated_at
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
      status: cleanString(row.status),
      workflow_stage: cleanString(row.workflow_stage),
      normalized_stage: normalizedStage,
      trip_start: row.trip_start,
      trip_end: row.trip_end,
      amount: toNumber(row.amount),
      turo_vehicle_id: cleanString(row.turo_vehicle_id),
      expense_status: cleanString(row.expense_status),
      completed_at: row.completed_at,
      canceled_at: row.canceled_at,
      starting_odometer: row.starting_odometer,
      ending_odometer: row.ending_odometer,
      toll_total: toNumber(row.toll_total),
      updated_at: row.updated_at,
      raw: row,
    };
  });
}

async function fetchVehicles(pool) {
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

  for (const vehicle of vehicles) {
    if (vehicle.turo_vehicle_id) {
      byTuroVehicleId.set(vehicle.turo_vehicle_id, vehicle);
    }

    for (const label of vehicle.labels) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(vehicle);
    }
  }

  return { byTuroVehicleId, byLabel };
}

function findVehicleMatch(trip, vehicleIndexes) {
  const reasons = [];
  let matchedVehicle = null;

  if (
    trip.turo_vehicle_id &&
    vehicleIndexes.byTuroVehicleId.has(trip.turo_vehicle_id)
  ) {
    matchedVehicle = vehicleIndexes.byTuroVehicleId.get(trip.turo_vehicle_id);
    reasons.push("matched_by_turo_vehicle_id");
    return {
      matchedVehicle,
      reasons,
      confidence: "high",
      matchType: "already_assigned",
    };
  }

  if (trip.vehicle_name_norm) {
    const labelMatches = vehicleIndexes.byLabel.get(trip.vehicle_name_norm) || [];

    if (labelMatches.length === 1) {
      matchedVehicle = labelMatches[0];
      reasons.push("matched_by_vehicle_name");
      return {
        matchedVehicle,
        reasons,
        confidence: "medium",
        matchType: "backfillable",
      };
    }

    if (labelMatches.length > 1) {
      reasons.push("ambiguous_vehicle_name_match");
    }
  }

  if (!trip.turo_vehicle_id) reasons.push("missing_trip_turo_vehicle_id");
  if (!trip.vehicle_name_norm) reasons.push("missing_trip_vehicle_name");

  return {
    matchedVehicle: null,
    reasons,
    confidence: "none",
    matchType: "unmatched",
  };
}

function classifyTrip(trip, matchResult) {
  const terminal = isTerminalStage(trip.normalized_stage);

  if (!matchResult.matchedVehicle) {
    return {
      classification: terminal ? "orphan_terminal" : "orphan_non_terminal",
      actionable: false,
    };
  }

  if (trip.turo_vehicle_id === matchResult.matchedVehicle.turo_vehicle_id) {
    return {
      classification: "already_assigned",
      actionable: false,
    };
  }

  if (terminal) {
    return {
      classification: "backfillable_terminal",
      actionable: true,
    };
  }

  return {
    classification: "backfillable_non_terminal",
    actionable: false,
  };
}

function buildUpdatePayload(trip, matchedVehicle) {
  if (!matchedVehicle?.turo_vehicle_id) return null;

  const payload = {};

  if (trip.turo_vehicle_id !== matchedVehicle.turo_vehicle_id) {
    payload.turo_vehicle_id = matchedVehicle.turo_vehicle_id;
  }

  // optional canonicalization:
  if (!trip.vehicle_name && matchedVehicle.nickname) {
    payload.vehicle_name = matchedVehicle.nickname;
  }

  return Object.keys(payload).length ? payload : null;
}

function buildUpdateSql(tripId, payload) {
  const entries = Object.entries(payload);
  if (!entries.length) return null;

  const setParts = [];
  const values = [];
  let idx = 1;

  for (const [field, value] of entries) {
    setParts.push(`${field} = $${idx}`);
    values.push(value);
    idx += 1;
  }

  setParts.push(`updated_at = now()`);
  values.push(tripId);

  return {
    sql: `
      UPDATE trips
      SET ${setParts.join(", ")}
      WHERE id = $${idx}
      RETURNING
        id,
        reservation_id,
        vehicle_name,
        turo_vehicle_id,
        workflow_stage,
        amount,
        toll_total
    `,
    values,
  };
}

function summarize(actions, writeMode) {
  const summary = {
    write_mode: writeMode,
    considered_rows: actions.length,
    update_candidates: 0,
    executed_updates: 0,
    skipped_rows: 0,
    field_counts: {},
    classification_counts: {},
  };

  for (const action of actions) {
    summary.classification_counts[action.classification] =
      (summary.classification_counts[action.classification] || 0) + 1;

    if (!action.payload || !Object.keys(action.payload).length) {
      summary.skipped_rows += 1;
      continue;
    }

    summary.update_candidates += 1;
    if (action.executed) summary.executed_updates += 1;

    for (const field of Object.keys(action.payload)) {
      summary.field_counts[field] = (summary.field_counts[field] || 0) + 1;
    }
  }

  summary.field_counts = Object.fromEntries(
    Object.entries(summary.field_counts).sort((a, b) => b[1] - a[1])
  );

  summary.classification_counts = Object.fromEntries(
    Object.entries(summary.classification_counts).sort((a, b) => b[1] - a[1])
  );

  return summary;
}

async function writeReport(report) {
  const outputPath = path.resolve(
    process.cwd(),
    "tmp",
    "trip-vehicle-backfill.json"
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  return outputPath;
}

async function main() {
  const writeMode =
    String(process.env.SYNC_WRITE || "").toLowerCase() === "true" &&
    String(process.env.SYNC_CONFIRM || "") === "YES";

  const d2Pool = createD2Pool();

  try {
    console.log("Loading trips...");
    const trips = await fetchTrips(d2Pool);
    console.log(`Loaded ${trips.length} trips.`);

    console.log("Loading vehicles...");
    const vehicles = await fetchVehicles(d2Pool);
    console.log(`Loaded ${vehicles.length} vehicles.`);

    const vehicleIndexes = buildVehicleIndexes(vehicles);

    const actions = [];

    for (const trip of trips) {
      const match = findVehicleMatch(trip, vehicleIndexes);
      const classification = classifyTrip(trip, match);

      if (classification.classification !== "backfillable_terminal") {
        continue;
      }

      const payload = buildUpdatePayload(trip, match.matchedVehicle);

      const action = {
        trip_id: trip.id,
        reservation_id: trip.reservation_id,
        workflow_stage: trip.normalized_stage,
        classification: classification.classification,
        current_vehicle_name: trip.vehicle_name,
        current_turo_vehicle_id: trip.turo_vehicle_id,
        matched_vehicle_id: match.matchedVehicle?.id ?? null,
        matched_vehicle_nickname: match.matchedVehicle?.nickname ?? null,
        matched_vehicle_turo_vehicle_id: match.matchedVehicle?.turo_vehicle_id ?? null,
        amount: trip.amount,
        toll_total: trip.toll_total,
        match_confidence: match.confidence,
        match_reasons: match.reasons,
        payload,
        executed: false,
        result: null,
      };

      if (payload && writeMode) {
        const query = buildUpdateSql(trip.id, payload);
        const result = await d2Pool.query(query.sql, query.values);
        action.executed = true;
        action.result = result.rows[0] || null;
      }

      actions.push(action);
    }

    const report = {
      generated_at: new Date().toISOString(),
      write_mode: writeMode,
      summary: summarize(actions, writeMode),
      actions,
    };

    const outputPath = await writeReport(report);

    console.log("");
    console.log("Trip vehicle backfill summary");
    console.log("-----------------------------");
    console.log(`Mode: ${writeMode ? "WRITE" : "DRY RUN"}`);
    console.log(`Considered rows: ${report.summary.considered_rows}`);
    console.log(`Update candidates: ${report.summary.update_candidates}`);
    console.log(`Executed updates: ${report.summary.executed_updates}`);
    console.log(`Skipped rows: ${report.summary.skipped_rows}`);
    console.log("");
    console.log("Fields to update:");
    for (const [field, count] of Object.entries(report.summary.field_counts)) {
      console.log(`  ${field}: ${count}`);
    }
    console.log("");
    console.log(`Report written to: ${outputPath}`);
    console.log("");
  } finally {
    await Promise.allSettled([d2Pool.end()]);
  }
}

main().catch((err) => {
  console.error("");
  console.error("backfillTripVehicleAssignments failed:");
  console.error(err);
  console.error("");
  process.exit(1);
});