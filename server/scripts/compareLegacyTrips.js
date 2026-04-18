// --------------------------------------------------------------
// server/scripts/compareLegacyTrips.js
//
// Read-only reconciliation script that compares Denmark 1.0 trips
// against Denmark 2.0 trips by reservation_id and writes a JSON
// report to disk.
//
// Usage:
//   node server/scripts/compareLegacyTrips.js
//
// Optional env:
//   COMPARE_INCLUDE_MATCHES=true
//   COMPARE_OUTPUT_PATH=./tmp/trip-reconciliation.json
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
  // Uses standard PG* env vars automatically
  return new Pool({
    // no config needed — pg will read:
    // PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
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

function maybeFilterMatches(report) {
  const includeMatches =
    String(process.env.COMPARE_INCLUDE_MATCHES || "").toLowerCase() === "true";

  if (includeMatches) return report;

  return {
    ...report,
    rows: report.rows.filter((row) => row.compare_status !== "match"),
  };
}

async function writeReport(report) {
  const defaultPath = path.resolve(process.cwd(), "tmp", "trip-reconciliation.json");
  const outputPath = process.env.COMPARE_OUTPUT_PATH
    ? path.resolve(process.cwd(), process.env.COMPARE_OUTPUT_PATH)
    : defaultPath;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  return outputPath;
}

function printSummary(report, outputPath) {
  console.log("");
  console.log("Trip reconciliation summary");
  console.log("---------------------------");
  console.log(`Generated at: ${report.generated_at}`);
  console.log(`Total compared: ${report.summary.total}`);
  console.log(`Matches: ${report.summary.match}`);
  console.log(`Field mismatches: ${report.summary.field_mismatch}`);
  console.log(`Missing in Denmark 2.0: ${report.summary.missing_in_d2}`);
  console.log(`Missing in legacy: ${report.summary.missing_in_legacy}`);
  console.log(`Safe-to-sync rows: ${report.summary.safe_to_sync}`);
  console.log(`Duplicate reservation rows collapsed: ${report.summary.duplicate_rows}`);
  console.log("");
  console.log("Top delta fields:");
  for (const [field, count] of Object.entries(report.delta_field_counts)) {
    console.log(`  ${field}: ${count}`);
  }
  console.log("");
  console.log(`Report written to: ${outputPath}`);
  console.log("");
}

async function main() {
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
    const fullReport = reconcileTrips({ legacyTrips, d2Trips });
    const outputReport = maybeFilterMatches(fullReport);

    const outputPath = await writeReport(outputReport);
    printSummary(fullReport, outputPath);
  } finally {
    await Promise.allSettled([legacyPool.end(), d2Pool.end()]);
  }
}

main().catch((err) => {
  console.error("");
  console.error("compareLegacyTrips failed:");
  console.error(err);
  console.error("");
  process.exit(1);
});