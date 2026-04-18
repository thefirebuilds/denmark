// --------------------------------------------------------------
// server/scripts/syncLegacyTrips.js
//
// Sync safe terminal trip details from Denmark 1.0 into Denmark 2.0.
// - complete/canceled trips only
// - never touches live/ongoing trips
// - dry run by default
//
// Usage:
//   node syncLegacyTrips.js
//
// Real write:
//   SYNC_WRITE=true node syncLegacyTrips.js
//
// Optional:
//   SYNC_OUTPUT_PATH=./tmp/trip-sync-results.json node syncLegacyTrips.js
// --------------------------------------------------------------

require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const {
  normalizeLegacyTrip,
  normalizeD2Trip,
} = require("../services/trips/legacyTripNormalizer");

const {
  reconcileTrips,
} = require("../services/trips/legacyTripCompare");

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

async function fetchLegacyTrips(pool) {
  const sql = `
    SELECT
      id,
      vehicle_id,
      reservation_id,
      renter_name,
      platform,
      start_date,
      end_date,
      gross_income,
      parking_cost,
      guest_parking_reimbursed,
      toll_charges_guest,
      fuel_cost,
      cleaning_cost,
      misc_costs,
      net_income,
      mileage_start,
      mileage_end,
      repair_notes,
      notes,
      expense_report_done,
      created_on,
      updated_on,
      toll_reimbursement,
      status,
      start_at,
      end_at
    FROM trips
    WHERE reservation_id IS NOT NULL
    ORDER BY id
  `;

  const { rows } = await pool.query(sql);
  return rows.map(normalizeLegacyTrip).filter((row) => row.reservation_id);
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
      trip_details_url,
      guest_profile_url,
      created_from_message_id,
      last_message_id,
      needs_review,
      created_at,
      updated_at,
      closed_out,
      closed_out_at,
      turo_vehicle_id,
      workflow_stage,
      stage_updated_at,
      expense_status,
      completed_at,
      canceled_at,
      mileage_included,
      starting_odometer,
      has_tolls,
      toll_count,
      toll_total,
      toll_review_status,
      ending_odometer,
      fuel_reimbursement_total,
      notes,
      deleted_at
    FROM trips
    WHERE reservation_id IS NOT NULL
      AND deleted_at IS NULL
    ORDER BY id
  `;

  const { rows } = await pool.query(sql);
  return rows.map(normalizeD2Trip).filter((row) => row.reservation_id);
}

function isTerminalStage(stage) {
  return stage === "complete" || stage === "canceled";
}

function shouldUseLegacyTollReimbursement(legacy, d2) {
  const legacyToll = Number(legacy?.toll_reimbursement ?? 0);
  const d2Toll = Number(d2?.toll_total ?? 0);

  if (!Number.isFinite(legacyToll) || legacyToll <= 0) return false;
  if (!Number.isFinite(d2Toll)) return true;

  return d2Toll === 0 || d2Toll < legacyToll;
}

function getTerminalStatusForInsert(legacyStage) {
  if (legacyStage === "canceled") return "canceled";
  if (legacyStage === "complete") return "completed";
  return legacyStage || "completed";
}

function buildApprovedUpdates(compareRow) {
  const { legacy, d2, delta_fields = [] } = compareRow;

  if (!legacy || !d2) return null;
  if (!isTerminalStage(legacy.normalized_stage)) return null;
  if (!compareRow.safe_to_sync) return null;
  if (compareRow.compare_status !== "field_mismatch") return null;

  const deltaSet = new Set(delta_fields);
  const approved = {};

  // ------------------------------------------------------------
  // canceled trips: safe closeout repair
  // ------------------------------------------------------------
  if (legacy.normalized_stage === "canceled") {
    if (deltaSet.has("workflow_stage") && d2.normalized_stage !== "canceled") {
      approved.workflow_stage = "canceled";
    }

    if (deltaSet.has("canceled_at") && !d2.canceled_at && legacy.canceled_at) {
      approved.canceled_at = legacy.canceled_at;
    }

    if (deltaSet.has("expense_status") && d2.expense_status !== "none") {
      approved.expense_status = "none";
    }

    if (deltaSet.has("closed_out") && d2.closed_out !== true) {
      approved.closed_out = true;
    }

    if (
      deltaSet.has("closed_out") &&
      !d2.raw?.closed_out_at &&
      (legacy.canceled_at || legacy.completed_at)
    ) {
      approved.closed_out_at = legacy.canceled_at || legacy.completed_at;
    }

    if (deltaSet.has("guest_name") && !d2.guest_name && legacy.guest_name) {
      approved.guest_name = legacy.guest_name;
    }

    // canceled trips can still have real income
    if (
      deltaSet.has("amount") &&
      (d2.amount === null || Number(d2.amount) === 0) &&
      legacy.amount !== null
    ) {
      approved.amount = legacy.amount;
    }

    if (
      deltaSet.has("starting_odometer") &&
      d2.starting_odometer == null &&
      legacy.starting_odometer != null
    ) {
      approved.starting_odometer = legacy.starting_odometer;
    }

    if (
      deltaSet.has("ending_odometer") &&
      d2.ending_odometer == null &&
      legacy.ending_odometer != null
    ) {
      approved.ending_odometer = legacy.ending_odometer;
    }

    if (deltaSet.has("toll_total") && shouldUseLegacyTollReimbursement(legacy, d2)) {
      approved.toll_total = Number(legacy.toll_reimbursement);
      approved.has_tolls = Number(legacy.toll_reimbursement) > 0;
    }

    return Object.keys(approved).length ? approved : null;
  }

  // ------------------------------------------------------------
  // complete trips: only touch rows already terminal in D2
  // ------------------------------------------------------------
  if (legacy.normalized_stage === "complete") {
    if (!isTerminalStage(d2.normalized_stage)) {
      return null;
    }

    if (deltaSet.has("workflow_stage") && d2.normalized_stage !== "complete") {
      approved.workflow_stage = "complete";
    }

    if (deltaSet.has("guest_name") && !d2.guest_name && legacy.guest_name) {
      approved.guest_name = legacy.guest_name;
    }

    if (
      deltaSet.has("amount") &&
      (d2.amount === null || Number(d2.amount) === 0) &&
      legacy.amount !== null
    ) {
      approved.amount = legacy.amount;
    }

    if (
      deltaSet.has("starting_odometer") &&
      d2.starting_odometer == null &&
      legacy.starting_odometer != null
    ) {
      approved.starting_odometer = legacy.starting_odometer;
    }

    if (
      deltaSet.has("ending_odometer") &&
      d2.ending_odometer == null &&
      legacy.ending_odometer != null
    ) {
      approved.ending_odometer = legacy.ending_odometer;
    }

    if (deltaSet.has("expense_status") && d2.expense_status !== "resolved") {
      approved.expense_status = "resolved";
    }

    if (deltaSet.has("completed_at") && !d2.completed_at && legacy.completed_at) {
      approved.completed_at = legacy.completed_at;
    }

    if (deltaSet.has("closed_out") && d2.closed_out !== true) {
      approved.closed_out = true;
    }

    if (
      deltaSet.has("closed_out") &&
      !d2.raw?.closed_out_at &&
      legacy.completed_at
    ) {
      approved.closed_out_at = legacy.completed_at;
    }

    if (deltaSet.has("toll_total") && shouldUseLegacyTollReimbursement(legacy, d2)) {
      approved.toll_total = Number(legacy.toll_reimbursement);
      approved.has_tolls = Number(legacy.toll_reimbursement) > 0;
    }

    return Object.keys(approved).length ? approved : null;
  }

  return null;
}

function buildApprovedInsert(compareRow) {
  const { legacy } = compareRow;

  if (!legacy) return null;
  if (compareRow.compare_status !== "missing_in_d2") return null;
  if (!isTerminalStage(legacy.normalized_stage)) return null;

  const legacyToll = Number(legacy.toll_reimbursement ?? 0);
  const isCanceled = legacy.normalized_stage === "canceled";
  const isComplete = legacy.normalized_stage === "complete";

  return {
    reservation_id: legacy.reservation_id,
    guest_name: legacy.guest_name,
    trip_start: legacy.trip_start,
    trip_end: legacy.trip_end,
    status: getTerminalStatusForInsert(legacy.normalized_stage),
    amount: legacy.amount,
    needs_review: true,
    closed_out: true,
    closed_out_at: legacy.canceled_at || legacy.completed_at || legacy.trip_end || legacy.trip_start,
    workflow_stage: legacy.normalized_stage,
    expense_status: isCanceled ? "none" : isComplete ? "resolved" : null,
    completed_at: isComplete ? legacy.completed_at : null,
    canceled_at: isCanceled ? legacy.canceled_at : null,
    starting_odometer: legacy.starting_odometer,
    ending_odometer: legacy.ending_odometer,
    has_tolls: legacyToll > 0,
    toll_total: legacyToll > 0 ? legacyToll : 0,
    notes: legacy.notes,
  };
}

function buildUpdateSql(tripId, updates) {
  const entries = Object.entries(updates);
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
        workflow_stage,
        expense_status,
        closed_out,
        completed_at,
        canceled_at,
        starting_odometer,
        ending_odometer,
        amount
    `,
    values,
  };
}

function buildInsertSql(payload) {
  const columns = [];
  const placeholders = [];
  const values = [];
  let idx = 1;

  for (const [field, value] of Object.entries(payload)) {
    columns.push(field);
    placeholders.push(`$${idx}`);
    values.push(value);
    idx += 1;
  }

  return {
    sql: `
      INSERT INTO trips (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING
        id,
        reservation_id,
        workflow_stage,
        expense_status,
        closed_out,
        completed_at,
        canceled_at,
        starting_odometer,
        ending_odometer,
        amount,
        toll_total,
        has_tolls
    `,
    values,
  };
}

async function writeResults(results) {
  const defaultPath = path.resolve(process.cwd(), "tmp", "trip-sync-results.json");
  const outputPath = process.env.SYNC_OUTPUT_PATH
    ? path.resolve(process.cwd(), process.env.SYNC_OUTPUT_PATH)
    : defaultPath;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(results, null, 2), "utf8");
  return outputPath;
}

function summarizeSync(actions, writeMode) {
  const summary = {
    write_mode: writeMode,
    considered_rows: actions.length,
    update_candidates: 0,
    insert_candidates: 0,
    executed_updates: 0,
    executed_inserts: 0,
    skipped_rows: 0,
    canceled_repairs: 0,
    completed_repairs: 0,
    field_counts: {},
  };

  for (const action of actions) {
    const payload =
      action.operation === "insert" ? action.insert_payload : action.updates;

    if (!payload || !Object.keys(payload).length) {
      summary.skipped_rows += 1;
      continue;
    }

    if (action.operation === "insert") {
      summary.insert_candidates += 1;
      if (action.executed) summary.executed_inserts += 1;
    } else {
      summary.update_candidates += 1;
      if (action.executed) summary.executed_updates += 1;
    }

    if (action.legacy_stage === "canceled") {
      summary.canceled_repairs += 1;
    } else if (action.legacy_stage === "complete") {
      summary.completed_repairs += 1;
    }

    for (const field of Object.keys(payload)) {
      summary.field_counts[field] = (summary.field_counts[field] || 0) + 1;
    }
  }

  summary.field_counts = Object.fromEntries(
    Object.entries(summary.field_counts).sort((a, b) => b[1] - a[1])
  );

  return summary;
}

async function main() {
  const writeMode = String(process.env.SYNC_WRITE || "").toLowerCase() === "true";

  const legacyPool = createLegacyPool();
  const d2Pool = createD2Pool();

  try {
    console.log("Loading legacy trips...");
    const legacyTrips = await fetchLegacyTrips(legacyPool);
    console.log(`Loaded ${legacyTrips.length} legacy trips.`);

    console.log("Loading Denmark 2.0 trips...");
    const d2Trips = await fetchD2Trips(d2Pool);
    console.log(`Loaded ${d2Trips.length} Denmark 2.0 trips.`);

    console.log("Reconciling...");
    const report = reconcileTrips({ legacyTrips, d2Trips });

        const candidateRows = report.rows.filter((row) => {
            if (!row.legacy) return false;
            if (!isTerminalStage(row.legacy.normalized_stage)) return false;

            if (row.compare_status === "missing_in_d2") {
                return true;
            }

            if (!row.d2) return false;
            if (!row.safe_to_sync) return false;
            if (row.compare_status !== "field_mismatch") return false;

            return true;
            });

    const actions = [];

        for (const row of candidateRows) {
      const isInsert = row.compare_status === "missing_in_d2";

      const updates = isInsert ? null : buildApprovedUpdates(row);
      const insertPayload = isInsert ? buildApprovedInsert(row) : null;

      const action = {
        reservation_id: row.reservation_id,
        trip_id: row.d2?.id ?? null,
        legacy_stage: row.legacy?.normalized_stage ?? null,
        d2_stage: row.d2?.normalized_stage ?? null,
        compare_status: row.compare_status,
        delta_fields: row.delta_fields || [],
        operation: isInsert ? "insert" : "update",
        updates,
        insert_payload: insertPayload,
        executed: false,
        result: null,
      };

      if (isInsert) {
        if (!insertPayload || !Object.keys(insertPayload).length) {
          actions.push(action);
          continue;
        }

        if (writeMode) {
          const query = buildInsertSql(insertPayload);
          const result = await d2Pool.query(query.sql, query.values);
          action.executed = true;
          action.result = result.rows[0] || null;
        }

        actions.push(action);
        continue;
      }

      if (!updates || !Object.keys(updates).length) {
        actions.push(action);
        continue;
      }

      if (writeMode) {
        const query = buildUpdateSql(row.d2.id, updates);
        const result = await d2Pool.query(query.sql, query.values);
        action.executed = true;
        action.result = result.rows[0] || null;
      }

      actions.push(action);
    }

    const results = {
      generated_at: new Date().toISOString(),
      write_mode: writeMode,
      reconcile_summary: report.summary,
      duplicate_rows: report.duplicates,
      sync_summary: summarizeSync(actions, writeMode),
      actions,
    };

    const outputPath = await writeResults(results);

    console.log("");
    console.log("Trip sync summary");
    console.log("-----------------");
    console.log(`Mode: ${writeMode ? "WRITE" : "DRY RUN"}`);
    console.log(`Considered rows: ${results.sync_summary.considered_rows}`);
    console.log(`Update candidates: ${results.sync_summary.update_candidates}`);
    console.log(`Insert candidates: ${results.sync_summary.insert_candidates}`);
    console.log(`Executed updates: ${results.sync_summary.executed_updates}`);
    console.log(`Executed inserts: ${results.sync_summary.executed_inserts}`);
    console.log(`Skipped rows: ${results.sync_summary.skipped_rows}`);
    console.log(`Canceled repairs: ${results.sync_summary.canceled_repairs}`);
    console.log(`Completed repairs: ${results.sync_summary.completed_repairs}`);
    console.log("");
    console.log("Fields to update:");
    for (const [field, count] of Object.entries(results.sync_summary.field_counts)) {
      console.log(`  ${field}: ${count}`);
    }
    console.log("");
    console.log(`Results written to: ${outputPath}`);
    console.log("");
  } finally {
    await Promise.allSettled([legacyPool.end(), d2Pool.end()]);
  }
}

main().catch((err) => {
  console.error("");
  console.error("syncLegacyTrips failed:");
  console.error(err);
  console.error("");
  process.exit(1);
});