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
const {
  getEffectiveTollSettings,
  hasCompleteTollCredentials,
} = require("../integrations/tollSettings");

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

function automaticTollEligibilitySql(at) {
  // This predicate is shared by new matches and safe correction of old ones.
  // Use occurrence-time history, never the trip's stage at import time.
  return `COALESCE((t.deleted_at IS NULL
    AND COALESCE(LOWER(t.workflow_stage), '') <> 'canceled'
    AND COALESCE(LOWER(t.status), '') NOT IN ('canceled', 'cancelled')
    AND t.trip_start IS NOT NULL AND t.trip_end IS NOT NULL
    AND ${at} >= t.trip_start
    AND CASE WHEN t.returned_at IS NOT NULL AND NULLIF(TRIM(t.return_detected_location), '') IS NOT NULL
      THEN ${at} < t.returned_at
      ELSE ${at} <= t.trip_end END
    AND (
      EXISTS (SELECT 1 FROM trip_stage_history ready
        WHERE ready.trip_id=t.id AND ready.next_stage='ready_for_handoff'
          AND ready.changed_at <= ${at}
          AND NOT EXISTS (SELECT 1 FROM trip_stage_history revoked
            WHERE revoked.trip_id=t.id AND revoked.next_stage IN ('booked','confirmed','canceled')
              AND (revoked.changed_at, revoked.id) > (ready.changed_at, ready.id)
              AND revoked.changed_at <= ${at}))
      OR (t.workflow_stage='ready_for_handoff' AND t.stage_updated_at IS NOT NULL
        AND t.stage_updated_at <= ${at}
        AND NOT EXISTS (SELECT 1 FROM trip_stage_history known WHERE known.trip_id=t.id))
    )), FALSE)`;
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
        AND $2::timestamptz >= t.trip_start
        AND ($2::timestamptz <= t.trip_end OR $2::timestamptz < t.returned_at)
        AND ${automaticTollEligibilitySql('$2::timestamptz')}
      ORDER BY
        CASE
          WHEN $2::timestamptz >= t.trip_start
            AND $2::timestamptz <= t.trip_end
          THEN 0
          ELSE 1
        END ASC,
        ABS(EXTRACT(EPOCH FROM ($2::timestamptz - t.trip_start))) ASC,
        t.trip_start DESC
      LIMIT 2
    `,
    [
      toll.turo_vehicle_id,
      toll.trxn_at,
    ]
  );

  return tripResult.rows.length === 1 ? tripResult.rows[0] : null;
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
        AND COALESCE(review_status, '') NOT IN ('dismissed', 'ignored')
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

async function clearInvalidAutomaticTripMatches(client) {
  // Repair only known automatic, unreviewed and unbilled assignments.
  // The existing assignment trigger preserves the previous trip in audit history.
  const result = await client.query(`UPDATE toll_charges tc
    SET matched_trip_id=NULL, match_status='vehicle_matched', updated_at=NOW()
    FROM trips t WHERE tc.matched_trip_id=t.id
      AND tc.matched_vehicle_id IS NOT NULL
      AND tc.attributed_by='automatic_sync'
      AND COALESCE(tc.review_status,'') IN ('','pending','matched')
      AND COALESCE(t.toll_review_status,'') NOT IN ('billed','waived')
      AND COALESCE(t.toll_charged_total,0)=0
      AND NOT (${automaticTollEligibilitySql('tc.trxn_at')})
      AND NOT EXISTS (SELECT 1 FROM trip_toll_billing_snapshot_items item WHERE item.toll_charge_id=tc.id)`);
  return result.rowCount;
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
        has_tolls = COALESCE(agg.toll_count, 0) > 0
          OR (
            COALESCE(t.toll_review_status, '') = 'billed'
            AND COALESCE(t.toll_charged_total, 0) > 0
          ),
        toll_count = COALESCE(agg.toll_count, 0),
        toll_total = CASE
          WHEN COALESCE(t.toll_review_status, '') = 'billed'
            AND t.toll_charged_total IS NOT NULL
          THEN t.toll_charged_total::numeric(10,2)
          ELSE COALESCE(agg.toll_total, 0)::numeric(10,2)
        END,
        updated_at = NOW()
      FROM agg
      WHERE t.id = agg.trip_id
        AND (
          COALESCE(t.has_tolls, false) IS DISTINCT FROM (
            COALESCE(agg.toll_count, 0) > 0
            OR (
              COALESCE(t.toll_review_status, '') = 'billed'
              AND COALESCE(t.toll_charged_total, 0) > 0
            )
          )
          OR COALESCE(t.toll_count, 0) IS DISTINCT FROM COALESCE(agg.toll_count, 0)
          OR COALESCE(t.toll_total, 0)::numeric(10,2) IS DISTINCT FROM (
            CASE
              WHEN COALESCE(t.toll_review_status, '') = 'billed'
                AND t.toll_charged_total IS NOT NULL
              THEN t.toll_charged_total::numeric(10,2)
              ELSE COALESCE(agg.toll_total, 0)::numeric(10,2)
            END
          )
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
        AND NOT (
          COALESCE(t.toll_review_status, '') = 'billed'
          AND COALESCE(t.toll_charged_total, 0) > 0
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
  let client = null;
  let runId = null;
  const settings = await getEffectiveTollSettings();

  const stats = {
    recordsSeen: 0,
    recordsImported: 0,
    recordsSkipped: 0,
    recordsMatchedVehicle: 0,
    recordsMatchedTrip: 0,
    recordsClearedOutsideTrip: 0,
  };

  try {
    if (settings.enabled === false) {
      return {
        ok: true,
        skipped: true,
        reason: "toll integration disabled",
        ...stats,
      };
    }

    if (!hasCompleteTollCredentials(settings)) {
      throw new Error("Toll provider login URL, activity URL, API pattern, username, and password are required");
    }

    const { records } = await fetchTollTransactions(settings);
    stats.recordsSeen = records.length;

    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('denmark.toll_assignment_actor', 'automatic_sync', true)");

    runId = await createSyncRun(client);

    for (const raw of records) {
      if (!isTollTransaction(raw)) {
        stats.recordsSkipped += 1;
        continue;
      }

      const normalized = normalizeTollRecord(raw, settings);
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

    stats.recordsClearedOutsideTrip = await clearInvalidAutomaticTripMatches(client);

    const backfilledTripMatches = await backfillUnmatchedTripMatches(client);
    stats.recordsMatchedTrip += backfilledTripMatches;

    await refreshTripTollCaches(client);

    await finishSyncRun(client, runId, {
      status: "success",
      ...stats,
      meta: { recordsClearedOutsideTrip: stats.recordsClearedOutsideTrip },
    });

    await client.query("COMMIT");
    if (stats.recordsClearedOutsideTrip) console.log('[tolls] cleared automatic out-of-window assignments', { count: stats.recordsClearedOutsideTrip });

    return {
      ok: true,
      runId,
      ...stats,
    };
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK");
    }

    if (client && runId) {
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
    if (client) {
      client.release();
    }
  }
}

module.exports = syncTolls;
module.exports.refreshTripTollCaches = refreshTripTollCaches;
module.exports.matchTrip = matchTrip;
module.exports.clearInvalidAutomaticTripMatches = clearInvalidAutomaticTripMatches;
module.exports.automaticTollEligibilitySql = automaticTollEligibilitySql;
