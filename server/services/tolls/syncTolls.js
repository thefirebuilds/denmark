// ------------------------------------------------------------
// /server/services/tolls/syncTolls.js
//
// Syncs toll transactions from HCTRA into public.toll_charges,
// dedupes inserts, and backfills vehicle/trip matches.
//
// Responsibilities:
// - create a toll_sync_runs record
// - fetch and normalize toll transactions
// - insert new toll_charges rows
// - backfill matched_vehicle_id
// - backfill matched_trip_id
// - optionally refresh cache-style toll summary fields on trips
//
// Important design rules:
// - toll_charges is the source-of-truth toll ledger
// - sync must be additive and idempotent
// - sync must NOT downgrade workflow state such as
//   trips.toll_review_status = 'billed'
// - trip UX should aggregate tolls from toll_charges by trip/vehicle/time
//   and treat trips.toll_total / toll_count / has_tolls as cache only
//
// ------------------------------------------------------------

const pool = require("../../db");
const { fetchTollTransactions } = require("./client");
const { isTollTransaction, normalizeTollRecord } = require("./normalize");

async function createSyncRun(client) {
  const result = await client.query(
    `
      INSERT INTO toll_sync_runs (source, status)
      VALUES ('hctra_eztag', 'running')
      RETURNING id
    `
  );

  return result.rows[0].id;
}

async function finishSyncRun(client, runId, fields) {
  await client.query(
    `
      UPDATE toll_sync_runs
      SET
        finished_at = NOW(),
        status = $2,
        records_seen = $3,
        records_imported = $4,
        records_skipped = $5,
        records_matched_vehicle = $6,
        records_matched_trip = $7,
        error_text = $8,
        meta = $9
      WHERE id = $1
    `,
    [
      runId,
      fields.status,
      fields.recordsSeen || 0,
      fields.recordsImported || 0,
      fields.recordsSkipped || 0,
      fields.recordsMatchedVehicle || 0,
      fields.recordsMatchedTrip || 0,
      fields.errorText || null,
      fields.meta || null,
    ]
  );
}

async function insertTollCharge(client, toll) {
  const result = await client.query(
    `
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
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (source, external_fingerprint) DO NOTHING
      RETURNING id
    `,
    [
      toll.source,
      toll.externalFingerprint,
      toll.trxnAt,
      toll.postedAt,
      toll.licensePlate,
      toll.licenseState,
      toll.licensePlateNormalized,
      toll.vehicleNickname,
      toll.amount,
      toll.agencyName,
      toll.facilityName,
      toll.plazaName,
      toll.laneName,
      toll.direction,
      toll.transType,
      JSON.stringify(toll.rawPayload),
    ]
  );

  return result.rows[0] || null;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePlate(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function matchVehicle(client, toll) {
  const normalizedPlate = normalizePlate(toll.licensePlate);
  const normalizedNickname = normalizeText(toll.vehicleNickname);

  if (normalizedPlate) {
    const byPlate = await client.query(
      `
        SELECT id, vin, nickname, turo_vehicle_name, license_plate, license_state
        FROM vehicles
        WHERE is_active = true
          AND REGEXP_REPLACE(UPPER(COALESCE(license_plate, '')), '[^A-Z0-9]', '', 'g') = $1
        ORDER BY id ASC
        LIMIT 1
      `,
      [normalizedPlate]
    );

    if (byPlate.rows[0]) {
      return byPlate.rows[0];
    }
  }

  if (normalizedNickname) {
    const byNickname = await client.query(
      `
        SELECT id, vin, nickname, turo_vehicle_name, license_plate, license_state
        FROM vehicles
        WHERE is_active = true
          AND (
            LOWER(COALESCE(nickname, '')) = $1
            OR LOWER(COALESCE(turo_vehicle_name, '')) = $1
          )
        ORDER BY id ASC
        LIMIT 1
      `,
      [normalizedNickname]
    );

    if (byNickname.rows[0]) {
      return byNickname.rows[0];
    }
  }

  return null;
}

async function applyVehicleMatch(client, tollChargeId, vehicleId) {
  await client.query(
    `
      UPDATE toll_charges
      SET
        matched_vehicle_id = $2,
        match_status = CASE
          WHEN matched_trip_id IS NOT NULL THEN 'trip_matched'
          ELSE 'vehicle_matched'
        END,
        updated_at = NOW()
      WHERE id = $1
    `,
    [tollChargeId, vehicleId]
  );
}

async function backfillUnmatchedVehicleMatches(client) {
  const tollsResult = await client.query(
    `
      SELECT id, vehicle_nickname, license_plate
      FROM toll_charges
      WHERE matched_vehicle_id IS NULL
      ORDER BY trxn_at DESC
    `
  );

  let matchedCount = 0;

  for (const toll of tollsResult.rows) {
    const matchedVehicle = await matchVehicle(client, {
      vehicleNickname: toll.vehicle_nickname,
      licensePlate: toll.license_plate,
    });

    if (matchedVehicle) {
      await applyVehicleMatch(client, toll.id, matchedVehicle.id);
      matchedCount += 1;
    }
  }

  return matchedCount;
}

async function matchTrip(client, tollChargeId) {
  const result = await client.query(
    `
      SELECT
        tc.id AS toll_charge_id,
        tc.trxn_at,
        tc.matched_vehicle_id,
        v.turo_vehicle_id
      FROM toll_charges tc
      LEFT JOIN vehicles v
        ON v.id = tc.matched_vehicle_id
      WHERE tc.id = $1
      LIMIT 1
    `,
    [tollChargeId]
  );

  const toll = result.rows[0];
  if (!toll || !toll.trxn_at || !toll.turo_vehicle_id) {
    return null;
  }

  const tripResult = await client.query(
    `
      SELECT
        t.id,
        t.trip_start,
        t.trip_end,
        t.turo_vehicle_id
      FROM trips t
      WHERE t.turo_vehicle_id = $1
        AND t.workflow_stage <> 'canceled'
        AND t.trip_start IS NOT NULL
        AND t.trip_end IS NOT NULL
        AND $2::timestamptz >= (t.trip_start - INTERVAL '2 hours')
        AND $2::timestamptz <= (t.trip_end + INTERVAL '12 hours')
      ORDER BY
        ABS(EXTRACT(EPOCH FROM ($2::timestamptz - t.trip_start))) ASC,
        t.trip_start DESC
      LIMIT 1
    `,
    [toll.turo_vehicle_id, toll.trxn_at]
  );

  return tripResult.rows[0] || null;
}

async function applyTripMatch(client, tollChargeId, tripId) {
  await client.query(
    `
      UPDATE toll_charges
      SET
        matched_trip_id = $2,
        match_status = 'trip_matched',
        updated_at = NOW()
      WHERE id = $1
    `,
    [tollChargeId, tripId]
  );
}

async function backfillUnmatchedTripMatches(client) {
  const tollsResult = await client.query(
    `
      SELECT id
      FROM toll_charges
      WHERE matched_vehicle_id IS NOT NULL
        AND matched_trip_id IS NULL
      ORDER BY trxn_at DESC
    `
  );

  let matchedCount = 0;

  for (const toll of tollsResult.rows) {
    const matchedTrip = await matchTrip(client, toll.id);
    if (matchedTrip) {
      await applyTripMatch(client, toll.id, matchedTrip.id);
      matchedCount += 1;
    }
  }

  return matchedCount;
}

/**
 * Refresh cache-only toll summary fields on trips from matched toll_charges.
 *
 * IMPORTANT:
 * - This function must not mutate trips.toll_review_status.
 * - Workflow state belongs to user/business actions, not raw sync.
 * - We only refresh has_tolls / toll_count / toll_total here.
 */
async function refreshTripTollCaches(client) {
  await client.query(
    `
      WITH agg AS (
        SELECT
          matched_trip_id AS trip_id,
          COUNT(*)::integer AS toll_count,
          COALESCE(SUM(amount), 0)::numeric(10,2) AS toll_total
        FROM toll_charges
        WHERE matched_trip_id IS NOT NULL
        GROUP BY matched_trip_id
      )
      UPDATE trips t
      SET
        has_tolls = COALESCE(agg.toll_count, 0) > 0,
        toll_count = COALESCE(agg.toll_count, 0),
        toll_total = COALESCE(agg.toll_total, 0)::numeric(10,2),
        updated_at = NOW()
      FROM agg
      WHERE t.id = agg.trip_id
        AND (
          COALESCE(t.has_tolls, false) IS DISTINCT FROM (COALESCE(agg.toll_count, 0) > 0)
          OR COALESCE(t.toll_count, 0) IS DISTINCT FROM COALESCE(agg.toll_count, 0)
          OR COALESCE(t.toll_total, 0)::numeric(10,2) IS DISTINCT FROM COALESCE(agg.toll_total, 0)::numeric(10,2)
        )
    `
  );

  await client.query(
    `
      UPDATE trips t
      SET
        has_tolls = false,
        toll_count = 0,
        toll_total = 0.00,
        updated_at = NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM toll_charges tc
        WHERE tc.matched_trip_id = t.id
      )
        AND (
          COALESCE(t.has_tolls, false) = true
          OR COALESCE(t.toll_count, 0) <> 0
          OR COALESCE(t.toll_total, 0) <> 0
        )
    `
  );
}

async function syncTolls() {
  const client = await pool.connect();
  let runId = null;

  const stats = {
    recordsSeen: 0,
    recordsImported: 0,
    recordsSkipped: 0,
    recordsMatchedVehicle: 0,
    recordsMatchedTrip: 0,
  };

  try {
    await client.query("BEGIN");

    runId = await createSyncRun(client);

    const { records } = await fetchTollTransactions();
    stats.recordsSeen = records.length;

    for (const raw of records) {
      if (!isTollTransaction(raw)) {
        stats.recordsSkipped += 1;
        continue;
      }

      const normalized = normalizeTollRecord(raw);
      if (!normalized) {
        stats.recordsSkipped += 1;
        continue;
      }

      const inserted = await insertTollCharge(client, normalized);
      if (inserted) {
        stats.recordsImported += 1;
      }
    }

    const backfilledVehicleMatches = await backfillUnmatchedVehicleMatches(client);
    stats.recordsMatchedVehicle += backfilledVehicleMatches;

    const backfilledTripMatches = await backfillUnmatchedTripMatches(client);
    stats.recordsMatchedTrip += backfilledTripMatches;

    await refreshTripTollCaches(client);

    await finishSyncRun(client, runId, {
      status: "success",
      ...stats,
    });

    await client.query("COMMIT");

    return {
      ok: true,
      runId,
      ...stats,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    if (runId) {
      try {
        await finishSyncRun(client, runId, {
          status: "error",
          ...stats,
          errorText: error.message,
        });
      } catch (finishErr) {
        console.error("Failed to mark toll sync run as error:", finishErr);
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = syncTolls;
module.exports.refreshTripTollCaches = refreshTripTollCaches;
