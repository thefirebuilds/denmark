// ------------------------------------------------------------
// /server/routes/metrics.js
// Fleet metrics endpoints for dashboard summary, vehicle cards,
// and trend charts.
// ------------------------------------------------------------

const express = require("express");
const pool = require("../db");
const { refreshTripTollCaches } = require("../services/tolls/syncTolls");
const {
  getTollMetricsDetail,
} = require("../services/metrics/summaryService");
const {
  getTollAccountBalance,
  reconcileTollAccountBalance,
} = require("../services/metrics/tollAccountBalanceService");


const router = express.Router();
const { limitMetricRead } = require("../services/metrics/metricReadLimiter");
const { savedMetricReport } = require("../services/metrics/metricReportCache");

router.get("/", savedMetricReport('summary'));

router.get("/summary", savedMetricReport('summary'));

router.get("/vehicles", savedMetricReport('vehicles'));

router.get("/off-trip-audit", savedMetricReport('offTripAudit'));

router.get("/tolls/detail", limitMetricRead(async (req, res) => {
  try {
    const data = await getTollMetricsDetail(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/tolls/detail failed:", err);
    return res.status(500).json({ error: "Failed to load toll detail" });
  }
}));

router.get("/tolls/account-balance", async (_req, res) => {
  try {
    return res.json(await getTollAccountBalance());
  } catch (err) {
    console.error("GET /api/metrics/tolls/account-balance failed:", err);
    return res.status(500).json({ error: "Failed to load toll account balance" });
  }
});

router.put("/tolls/account-balance", async (req, res) => {
  try {
    return res.json(await reconcileTollAccountBalance(req.body?.amount));
  } catch (err) {
    console.error("PUT /api/metrics/tolls/account-balance failed:", err);
    return res.status(err.status || 500).json({ error: err.message || "Failed to reconcile toll account balance" });
  }
});

router.get("/parking", savedMetricReport('parking'));

router.get("/parking/home-transfers", savedMetricReport('homeTransfers'));

// Retired: never generate AI briefings, including from stale clients.
router.all(['/daily-brief', '/daily-brief/context', '/daily-brief/latest'], (req, res) => {
  res.status(410).json({ error: 'Daily business briefings have been retired.' });
});

router.put("/tolls/charges/:tollChargeId/assign-trip", async (req, res) => {
  const tollChargeId = Number(req.params.tollChargeId);
  const rawTripId = req.body?.trip_id;
  const disposition =
    typeof req.body?.disposition === "string"
      ? req.body.disposition.trim().toLowerCase()
      : "";
  const isOffTrip = disposition === "off_trip" || rawTripId === "__off_trip__";
  const tripId = isOffTrip ? null : Number(rawTripId);

  if (!Number.isInteger(tollChargeId) || tollChargeId <= 0) {
    return res.status(400).json({ error: "Invalid toll charge id" });
  }

  if (!isOffTrip && (!Number.isInteger(tripId) || tripId <= 0)) {
    return res.status(400).json({ error: "trip_id is required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const tollResult = await client.query(
      `
        SELECT
          tc.id,
          tc.trxn_at,
          tc.matched_vehicle_id,
          v.turo_vehicle_id AS matched_vehicle_turo_id
        FROM toll_charges tc
        LEFT JOIN vehicles v
          ON v.id = tc.matched_vehicle_id
        WHERE tc.id = $1
        FOR UPDATE OF tc
      `,
      [tollChargeId]
    );

    const tollCharge = tollResult.rows[0];
    let trip = null;

    if (!isOffTrip) {
      const tripResult = await client.query(
        `
          SELECT
            t.id,
            t.turo_vehicle_id
          FROM trips t
          WHERE t.id = $1
          LIMIT 1
        `,
        [tripId]
      );
      trip = tripResult.rows[0];
    }

    if (!tollCharge) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Toll charge not found" });
    }

    if (!isOffTrip && !trip) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip not found" });
    }

    if (
      !isOffTrip &&
      tollCharge.matched_vehicle_turo_id &&
      trip.turo_vehicle_id &&
      String(tollCharge.matched_vehicle_turo_id) !== String(trip.turo_vehicle_id)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Selected trip does not match the toll charge vehicle",
      });
    }

    if (isOffTrip) {
      await client.query("SELECT set_config('denmark.toll_assignment_actor', 'manual_metrics', true)");
      await client.query(
        `
          UPDATE toll_charges
          SET
            matched_trip_id = NULL,
            match_status = CASE
              WHEN matched_vehicle_id IS NOT NULL THEN 'vehicle_matched'
              ELSE 'unmatched'
            END,
            review_status = 'dismissed',
            updated_at = NOW()
          WHERE id = $1
        `,
        [tollChargeId]
      );
    } else {
      await client.query("SELECT set_config('denmark.toll_assignment_actor', 'manual_metrics', true)");
      await client.query(
        `
          UPDATE toll_charges
          SET
            matched_trip_id = $2,
            match_status = 'trip_matched',
            review_status = CASE
              WHEN review_status IN ('pending', 'matched') THEN 'matched'
              ELSE review_status
            END,
            updated_at = NOW()
          WHERE id = $1
        `,
        [tollChargeId, tripId]
      );
    }

    await refreshTripTollCaches(client);
    await client.query("COMMIT");

    return res.json({
      ok: true,
      toll_charge_id: tollChargeId,
      trip_id: tripId,
      disposition: isOffTrip ? "off_trip" : "trip_matched",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PUT /api/metrics/tolls/charges/:tollChargeId/assign-trip failed:", err);
    return res.status(500).json({ error: "Failed to assign toll charge to trip" });
  } finally {
    client.release();
  }
});

router.get("/vehicles/:vehicleId/financial-detail", savedMetricReport('vehicleFinancial', req => ({ ...req.query, vehicleId: req.params.vehicleId })));

router.put("/off-trip-audit/review", async (req, res) => {
  try {
    const auditKey =
      typeof req.body?.audit_key === "string" ? req.body.audit_key.trim() : "";
    const reviewStatus =
      typeof req.body?.review_status === "string"
        ? req.body.review_status.trim().toLowerCase()
        : "";
    const reviewReason =
      typeof req.body?.review_reason === "string"
        ? req.body.review_reason.trim()
        : "";
    const reconciledOffTripMiles =
      req.body?.reconciled_off_trip_miles === "" ||
      req.body?.reconciled_off_trip_miles == null
        ? null
        : Number(req.body.reconciled_off_trip_miles);

    if (!auditKey) {
      return res.status(400).json({ error: "audit_key is required" });
    }

    const allowedStatuses = new Set(["", "validated", "reconciled", "ignored"]);
    if (!allowedStatuses.has(reviewStatus)) {
      return res.status(400).json({ error: "Invalid review_status" });
    }

    if (
      reconciledOffTripMiles != null &&
      (!Number.isFinite(reconciledOffTripMiles) || reconciledOffTripMiles < 0)
    ) {
      return res.status(400).json({ error: "Invalid reconciled_off_trip_miles" });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `
          SELECT value
          FROM app_settings
          WHERE key = 'metrics.off_trip_audit_reviews'
          FOR UPDATE
        `
      );

      const currentValue =
        rows[0]?.value && typeof rows[0].value === "object" && !Array.isArray(rows[0].value)
          ? { ...rows[0].value }
          : {};

      if (!reviewStatus && !reviewReason && reconciledOffTripMiles == null) {
        delete currentValue[auditKey];
      } else {
        currentValue[auditKey] = {
          review_status: reviewStatus || null,
          review_reason: reviewReason || null,
          reconciled_off_trip_miles: reconciledOffTripMiles,
          reviewed_at: new Date().toISOString(),
        };
      }

      const upsertResult = await client.query(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('metrics.off_trip_audit_reviews', $1::jsonb, NOW())
          ON CONFLICT (key)
          DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
          RETURNING value, updated_at
        `,
        [JSON.stringify(currentValue)]
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        audit_key: auditKey,
        review: currentValue[auditKey] || null,
        updated_at: upsertResult.rows[0]?.updated_at || null,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("PUT /api/metrics/off-trip-audit/review failed:", err);
    return res.status(500).json({ error: "Failed to save off-trip audit review" });
  }
});

router.get("/trends", savedMetricReport('trends'));

module.exports = router;
