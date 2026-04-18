// ------------------------------------------------------------
// /server/scripts/import_hctra_statement_backfill.js
//
// Import cleaned tab-delimited HCTRA statement rows directly
// into public.toll_charges with idempotent dedupe.
//
// Usage:
//   node server/scripts/import_hctra_statement_backfill.js /path/to/cleaned_hctra.txt
//
// Notes:
// - Imports only rows with trans_type = "Toll" by default
// - Skips "Excuse Toll" rows for now
// - Stores positive dollar amounts in toll_charges.amount
// - Uses source = 'hctra_statement_backfill'
// - Dedupes via unique(source, external_fingerprint)
// ------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

// Adjust this if your project uses a shared DB config helper.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const IMPORT_SOURCE = "hctra_statement_backfill";


function cleanText(value) {
  return String(value || "").trim();
}

function parseMoney(value) {
  const raw = String(value || "").trim().replace(/[$,]/g, "");
  if (!raw) return null;

  const num = Number(raw);
  if (!Number.isFinite(num)) return null;

  // HCTRA statement toll rows appear negative; store positive amount in DB.
  return Math.abs(num).toFixed(2);
}

function parseTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const match = raw.match(
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/
  );

  if (!match) return null;

  const [, mm, dd, yyyy, hh, mi, ss] = match;
  return `${yyyy}-${mm}-${dd} ${String(hh).padStart(2, "0")}:${mi}:${ss}`;
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeText(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePlate(value) {
  return normalizeText(value).replace(/[^A-Z0-9]/g, "");
}

function buildTollFingerprint(record) {
  const parts = [
    record.trxnAt || "",
    normalizePlate(record.licensePlate),
    Number(record.amount || 0).toFixed(2),
    normalizeText(record.agencyName),
    normalizeText(record.facilityName),
    normalizeText(record.plazaName),
    normalizeText(record.laneName),
    normalizeText(record.direction),
    normalizeText(record.transType),
  ];

  return crypto
    .createHash("sha256")
    .update(parts.join("|"))
    .digest("hex");
}

function buildFingerprint(parsed) {
  return buildTollFingerprint({
    trxnAt: parseTimestamp(parsed.trxn_at_raw),
    licensePlate: parsed.license_plate,
    amount: Math.abs(Number(parsed.amount_raw || 0)),
    agencyName: "HCTRA",
    facilityName: parsed.facility_name,
    plazaName: parsed.plaza_name,
    laneName: parsed.lane_name || "",
    direction: parsed.direction,
    transType: parsed.trans_type,
  });
}

function parseLine(line) {
  const parts = line.split("\t").map((v) => v.trim());

  if (parts.length !== 9) {
    return null;
  }

  return {
    account_tag_id: parts[0],
    trxn_at_raw: parts[1],
    posted_at_raw: parts[2],
    license_plate: parts[3],
    facility_name: parts[4],
    direction: parts[5],
    plaza_name: parts[6],
    trans_type: parts[7],
    amount_raw: parts[8],
    lane_name: null,
    raw_parts: parts,
  };
}

async function insertRow(client, parsed, { dryRun = false } = {}) {
  const amount = parseMoney(parsed.amount_raw);
  if (amount == null) {
    return { inserted: false, skipped: true, reason: "bad_amount" };
  }

  const transType = cleanText(parsed.trans_type);
  if (!/^toll$/i.test(transType)) {
    return { inserted: false, skipped: true, reason: "non_toll_type" };
  }

  const trxnAt = parseTimestamp(parsed.trxn_at_raw);
  if (!trxnAt) {
    return { inserted: false, skipped: true, reason: "missing_trxn_at" };
  }

  const postedAt = parseTimestamp(parsed.posted_at_raw);
  function normalizeStoredPlate(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^[A-Z]{2}-/, "")
    .replace(/[^A-Z0-9]/g, "");
}

const plate = normalizeStoredPlate(parsed.license_plate);
const plateNormalized = normalizeStoredPlate(parsed.license_plate);

  const rawPayload = {
    import_source: IMPORT_SOURCE,
    account_tag_id: cleanText(parsed.account_tag_id),
    trxn_at_raw: cleanText(parsed.trxn_at_raw),
    posted_at_raw: cleanText(parsed.posted_at_raw),
    license_plate: plate,
    facility_name: cleanText(parsed.facility_name),
    plaza_name: cleanText(parsed.plaza_name),
    lane_name: cleanText(parsed.lane_name),
    direction: cleanText(parsed.direction),
    trans_type: transType,
    amount_raw: cleanText(parsed.amount_raw),
    raw_parts: parsed.raw_parts,
  };

  const externalFingerprint = buildFingerprint(parsed);

  if (dryRun) {
    const checkSql = `
      SELECT id
      FROM toll_charges
      WHERE source = $1
        AND external_fingerprint = $2
      LIMIT 1
    `;

    const checkResult = await client.query(checkSql, [
      IMPORT_SOURCE,
      externalFingerprint,
    ]);

    if (checkResult.rowCount > 0) {
      return { inserted: false, skipped: true, reason: "duplicate" };
    }

    return {
      inserted: true,
      skipped: false,
      reason: null,
      dryRun: true,
      preview: {
        source: IMPORT_SOURCE,
        external_fingerprint: externalFingerprint,
        trxn_at: trxnAt,
        posted_at: postedAt,
        license_plate: plate || null,
        license_plate_normalized: plateNormalized || null,
        amount,
        facility_name: cleanText(parsed.facility_name) || null,
        plaza_name: cleanText(parsed.plaza_name) || null,
        direction: cleanText(parsed.direction) || null,
        trans_type: transType,
      },
    };
  }

  const sql = `
    INSERT INTO toll_charges (
      source,
      external_fingerprint,
      trxn_at,
      posted_at,
      license_plate,
      license_state,
      license_plate_normalized,
      vehicle_nickname,
      amount,
      agency_name,
      facility_name,
      plaza_name,
      lane_name,
      direction,
      trans_type,
      raw_payload
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16::jsonb
    )
    ON CONFLICT (source, external_fingerprint) DO NOTHING
    RETURNING id
  `;

  const values = [
    IMPORT_SOURCE,
    externalFingerprint,
    trxnAt,
    postedAt,
    plate || null,
    "TX",
    plateNormalized || null,
    null,
    amount,
    "HCTRA",
    cleanText(parsed.facility_name) || null,
    cleanText(parsed.plaza_name) || null,
    cleanText(parsed.lane_name) || null,
    cleanText(parsed.direction) || null,
    transType,
    JSON.stringify(rawPayload),
  ];

  const result = await client.query(sql, values);

  if (result.rowCount > 0) {
    return { inserted: true, skipped: false, reason: null };
  }

  return { inserted: false, skipped: true, reason: "duplicate" };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const inputPath = args.find((arg) => !arg.startsWith("--"));

  if (!inputPath) {
    console.error(
      "Usage: node server/scripts/import_hctra_statement_backfill.js /path/to/file.tsv [--dry-run]"
    );
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(absPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const client = await pool.connect();

  let totalLines = 0;
  let parsedRows = 0;
  let inserted = 0;
  let duplicates = 0;
  let nonTollSkipped = 0;
  let badRows = 0;
  const previewRows = [];
  const PREVIEW_MONTH_PREFIX = "2026-02-";

  try {
    if (!dryRun) {
      await client.query("BEGIN");
    }

    for (const line of lines) {
      totalLines += 1;

      if (/^tag id\t/i.test(line)) {
        continue;
      }

      const parsed = parseLine(line);
      if (!parsed) {
        badRows += 1;
        continue;
      }

      parsedRows += 1;

      const result = await insertRow(client, parsed, { dryRun });

      if (result.inserted) {
  inserted += 1;

  if (
    dryRun &&
    result.preview &&
    previewRows.length < 15 &&
    String(result.preview.trxn_at || "").startsWith(PREVIEW_MONTH_PREFIX)
  ) {
    previewRows.push(result.preview);
  }
} else if (result.reason === "duplicate") {
        duplicates += 1;
      } else if (result.reason === "non_toll_type") {
        nonTollSkipped += 1;
      } else {
        badRows += 1;
      }
    }

    if (!dryRun) {
      await client.query("COMMIT");
    }

    console.log("");
    console.log(
      dryRun
        ? "HCTRA statement backfill dry run complete"
        : "HCTRA statement backfill import complete"
    );
    console.log("--------------------------------------");
    console.log(`file:              ${absPath}`);
    console.log(`mode:              ${dryRun ? "DRY RUN" : "WRITE"}`);
    console.log(`lines_seen:        ${totalLines}`);
    console.log(`rows_parsed:       ${parsedRows}`);
    console.log(`would_insert:      ${dryRun ? inserted : 0}`);
    console.log(`inserted:          ${dryRun ? 0 : inserted}`);
    console.log(`duplicates:        ${duplicates}`);
    console.log(`non_toll_skipped:  ${nonTollSkipped}`);
    console.log(`bad_rows:          ${badRows}`);
    console.log(`source:            ${IMPORT_SOURCE}`);
    console.log("");

    if (dryRun) {
  console.log("Sample February 2026 rows that would be inserted:");
  console.log("-------------------------------------------------");

  if (previewRows.length === 0) {
    console.log("(none)");
  } else {
    for (const row of previewRows) {
      console.log(
        [
          row.external_fingerprint,
          row.trxn_at,
          row.license_plate || "",
          row.amount,
          row.facility_name || "",
          row.plaza_name || "",
        ].join(" | ")
      );
    }
  }

  console.log("");
}
  } catch (err) {
    if (!dryRun) {
      await client.query("ROLLBACK");
    }
    console.error(dryRun ? "Dry run failed:" : "Import failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});