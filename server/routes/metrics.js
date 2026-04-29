// ------------------------------------------------------------
// /server/routes/metrics.js
// Fleet metrics endpoints for dashboard summary, vehicle cards,
// and trend charts.
// ------------------------------------------------------------

const express = require("express");
const pool = require("../db");
const { refreshTripTollCaches } = require("../services/tolls/syncTolls");
const {
  getSummaryMetrics,
  getTollMetricsDetail,
} = require("../services/metrics/summaryService");
const {
  getVehicleMetrics,
  getOffTripMileageAudit,
  getVehicleFinancialDetail,
} = require("../services/metrics/vehicleMetricsService");
const {
  getTrendMetrics,
} = require("../services/metrics/trendMetricsService");

const router = express.Router();

router.get("/summary", async (req, res) => {
  try {
    const data = await getSummaryMetrics(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/summary failed:", err);
    return res.status(500).json({ error: "Failed to load summary metrics" });
  }
});

router.get("/vehicles", async (req, res) => {
  try {
    const data = await getVehicleMetrics(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/vehicles failed:", err);
    return res.status(500).json({ error: "Failed to load vehicle metrics" });
  }
});

router.get("/off-trip-audit", async (req, res) => {
  try {
    const data = await getOffTripMileageAudit(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/off-trip-audit failed:", err);
    return res.status(500).json({ error: "Failed to load off-trip mileage audit" });
  }
});

router.get("/tolls/detail", async (req, res) => {
  try {
    const data = await getTollMetricsDetail(req.query.range || "30d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/tolls/detail failed:", err);
    return res.status(500).json({ error: "Failed to load toll detail" });
  }
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

router.get("/vehicles/:vehicleId/financial-detail", async (req, res) => {
  try {
    const data = await getVehicleFinancialDetail(
      req.params.vehicleId,
      req.query.range || "30d"
    );
    return res.json(data);
  } catch (err) {
    if (err?.statusCode === 404) {
      return res.status(404).json({ error: err.message || "Vehicle not found" });
    }
    console.error("GET /api/metrics/vehicles/:vehicleId/financial-detail failed:", err);
    return res.status(500).json({ error: "Failed to load vehicle financial detail" });
  }
});

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

router.get("/trends", async (req, res) => {
  try {
    const data = await getTrendMetrics(req.query.range || "90d");
    return res.json(data);
  } catch (err) {
    console.error("GET /api/metrics/trends failed:", err);
    return res.status(500).json({ error: "Failed to load trend metrics" });
  }
});

module.exports = router;
