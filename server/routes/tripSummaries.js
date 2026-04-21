// -------------------------------------------
// server/routes/tripSummaries.js
// API routes for the historical trip ledger / trip summaries view.
// Supports filtering, editing, and soft deletion of trip records.
// -------------------------------------------

const express = require("express");
const pool = require("../db");
const { pushPublicAvailabilitySnapshotSafe } = require("../services/pushPublicAvailability");

const router = express.Router();

function startOfTodayChicago() {
  const now = new Date();
  const chicago = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Chicago" })
  );
  chicago.setHours(0, 0, 0, 0);
  return chicago;
}

function endOfTodayChicago() {
  const d = startOfTodayChicago();
  d.setHours(23, 59, 59, 999);
  return d;
}

function computeDisplayStatus(trip) {
  const now = new Date();
  const todayStart = startOfTodayChicago();
  const todayEnd = endOfTodayChicago();

  const start = trip.trip_start ? new Date(trip.trip_start) : null;
  const end = trip.trip_end ? new Date(trip.trip_end) : null;

  if (trip.status === "canceled" || trip.workflow_stage === "canceled") {
    return "canceled";
  }

  if (!start || !end) return "unknown";
  if (end < now) return "past";

  if (start > now) {
    if (start >= todayStart && start <= todayEnd) return "starting_today";
    return "upcoming";
  }

  if (end >= todayStart && end <= todayEnd) return "ending_today";
  if (start <= now && end >= now) return "active";

  return "unknown";
}

function getMilesDriven(trip) {
  const start = Number(trip?.starting_odometer);
  const end = Number(trip?.ending_odometer);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return end - start;
}

function getTripDays(trip) {
  const start = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;
  const end = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return (end - start) / (1000 * 60 * 60 * 24);
}

function enrichTripSummary(trip) {
  const milesDriven = getMilesDriven(trip);
  const tripDays = getTripDays(trip);
  const grossIncome = Number(trip.gross_income ?? 0);

  return {
    ...trip,
    display_status: computeDisplayStatus(trip),
    miles_driven: milesDriven,
    trip_days: tripDays,
    revenue_per_day:
      tripDays && tripDays > 0 ? grossIncome / tripDays : null,
    revenue_per_mile:
      Number.isFinite(milesDriven) && milesDriven > 0
        ? grossIncome / milesDriven
        : null,
  };
}

function parseOptionalInteger(value, label) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    const err = new Error(`${label} must be a valid integer`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function parseOptionalNumber(value, label) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const err = new Error(`${label} must be a valid number`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function cleanOptionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

async function resolveTripVehicle(client, { turo_vehicle_id, vehicle_name }) {
  const normalizedVehicleId = cleanOptionalText(turo_vehicle_id);
  const normalizedVehicleName = cleanOptionalText(vehicle_name);

  if (normalizedVehicleId) {
    const vehicleLookup = await client.query(
      `
        SELECT turo_vehicle_id, nickname
        FROM vehicles
        WHERE CAST(turo_vehicle_id AS text) = $1
        LIMIT 1
      `,
      [normalizedVehicleId]
    );

    if (!vehicleLookup.rows.length) {
      const err = new Error(`Vehicle id not found: ${turo_vehicle_id}`);
      err.statusCode = 400;
      throw err;
    }

    return {
      turoVehicleId: vehicleLookup.rows[0].turo_vehicle_id,
      vehicleName: vehicleLookup.rows[0].nickname,
    };
  }

  if (normalizedVehicleName) {
    const vehicleLookup = await client.query(
      `
        SELECT turo_vehicle_id, nickname
        FROM vehicles
        WHERE LOWER(nickname) = LOWER($1)
        LIMIT 1
      `,
      [normalizedVehicleName]
    );

    if (!vehicleLookup.rows.length) {
      const err = new Error(`Vehicle nickname not found: ${normalizedVehicleName}`);
      err.statusCode = 400;
      throw err;
    }

    return {
      turoVehicleId: vehicleLookup.rows[0].turo_vehicle_id,
      vehicleName: vehicleLookup.rows[0].nickname,
    };
  }

  return {
    turoVehicleId: null,
    vehicleName: null,
  };
}

const TRIP_SUMMARY_SELECT = `
  SELECT
    t.id,
    t.reservation_id,
    t.turo_vehicle_id,
    COALESCE(v.nickname, t.vehicle_name) AS vehicle_name,
    v.nickname AS vehicle_nickname,
    v.id AS vehicle_id,
    v.year AS vehicle_year,
    v.make AS vehicle_make,
    v.model AS vehicle_model,
    t.guest_name,
    t.trip_start,
    t.trip_end,
    t.amount AS gross_income,
    t.status,
    t.needs_review,
    t.mileage_included,
    t.starting_odometer,
    t.ending_odometer,
    t.has_tolls,
    t.toll_count,
    t.toll_total,
    t.toll_review_status,
    t.fuel_reimbursement_total,
    t.max_engine_rpm,
    t.notes,
    t.closed_out,
    t.closed_out_at,
    t.workflow_stage,
    t.stage_updated_at,
    t.expense_status,
    t.completed_at,
    t.canceled_at,
    t.created_at,
    t.updated_at,
    t.deleted_at,
    t.created_from_message_id,
    t.last_message_id,
    ti.message_count,
    ti.unread_messages,
    ti.last_message_at,
    ti.last_unread_at,
    t.trip_details_url,
    t.guest_profile_url
  FROM trips t
  LEFT JOIN trip_intelligence ti
    ON ti.id = t.id
  LEFT JOIN vehicles v
    ON v.turo_vehicle_id = t.turo_vehicle_id
`;

router.get("/", async (req, res) => {
  try {
    const vehicle = String(
      req.query.vehicle ??
        req.query.vehicle_id ??
        req.query.vehicle_name ??
        ""
    ).trim();

    const startDate = String(req.query.start_date || "").trim();
    const endDate = String(req.query.end_date || "").trim();
    const search = String(req.query.search || "").trim();

    const includeCanceled =
      String(req.query.include_canceled || "true").toLowerCase() === "true";

    const includeDeleted =
      String(req.query.include_deleted || "false").toLowerCase() === "true";

    const params = [
      vehicle || null,
      startDate || null,
      endDate || null,
      search || null,
      includeCanceled,
      includeDeleted,
    ];

    const query = `
      ${TRIP_SUMMARY_SELECT}
      WHERE
        ($6::boolean = true OR t.deleted_at IS NULL)
        AND (
          $1::text IS NULL
          OR (
            LOWER($1) = 'unassigned'
            AND (
              t.turo_vehicle_id IS NULL
              OR CAST(t.turo_vehicle_id AS text) = ''
              OR v.id IS NULL
            )
          )
          OR CAST(t.turo_vehicle_id AS text) = $1
          OR LOWER(COALESCE(v.nickname, '')) = LOWER($1)
          OR LOWER(COALESCE(t.vehicle_name, '')) = LOWER($1)
          OR CAST(v.id AS text) = $1
        )
        AND ($2::date IS NULL OR t.trip_start::date >= $2::date)
        AND ($3::date IS NULL OR t.trip_end::date <= $3::date)
        AND (
          $4::text IS NULL
          OR COALESCE(t.guest_name, '') ILIKE '%' || $4 || '%'
          OR COALESCE(CAST(t.reservation_id AS text), '') ILIKE '%' || $4 || '%'
          OR COALESCE(v.nickname, t.vehicle_name, '') ILIKE '%' || $4 || '%'
          OR COALESCE(t.notes, '') ILIKE '%' || $4 || '%'
        )
        AND (
          $5::boolean = true
          OR (
            LOWER(COALESCE(t.status, '')) <> 'canceled'
            AND LOWER(COALESCE(t.workflow_stage, '')) <> 'canceled'
          )
        )
      ORDER BY
        t.trip_start DESC NULLS LAST,
        t.id DESC
    `;

    const { rows } = await pool.query(query, params);
    res.json(rows.map(enrichTripSummary));
  } catch (err) {
    console.error("GET /api/trip-summaries failed:", {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Failed to load trip summaries" });
  }
});

router.post("/", async (req, res) => {
  const body = req.body || {};

  let parsed;
  try {
    parsed = {
      reservation_id: parseOptionalInteger(body.reservation_id, "reservation_id"),
      guest_name: cleanOptionalText(body.guest_name),
      trip_start: body.trip_start || null,
      trip_end: body.trip_end || null,
      amount: parseOptionalNumber(
        body.gross_income === "" || body.gross_income == null
          ? body.amount
          : body.gross_income,
        "Amount"
      ),
      status: cleanOptionalText(body.status) || "booked_unconfirmed",
      needs_review:
        typeof body.needs_review === "boolean" ? body.needs_review : true,
      mileage_included: parseOptionalInteger(
        body.mileage_included,
        "mileage_included"
      ),
      starting_odometer: parseOptionalInteger(
        body.starting_odometer,
        "starting_odometer"
      ),
      ending_odometer: parseOptionalInteger(
        body.ending_odometer,
        "ending_odometer"
      ),
      fuel_reimbursement_total: parseOptionalNumber(
        body.fuel_reimbursement_total,
        "fuel_reimbursement_total"
      ),
      notes: cleanOptionalText(body.notes),
      workflow_stage: cleanOptionalText(body.workflow_stage) || "booked",
      expense_status: cleanOptionalText(body.expense_status),
      trip_details_url: cleanOptionalText(body.trip_details_url),
      guest_profile_url: cleanOptionalText(body.guest_profile_url),
    };
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }

  if (!parsed.reservation_id) {
    return res.status(400).json({ error: "reservation_id is required" });
  }

  if (!parsed.trip_start || !parsed.trip_end) {
    return res.status(400).json({ error: "trip_start and trip_end are required" });
  }

  if (!parsed.guest_name) {
    return res.status(400).json({ error: "guest_name is required" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const vehicle = await resolveTripVehicle(client, {
      turo_vehicle_id: body.turo_vehicle_id,
      vehicle_name: body.vehicle_name,
    });

    const hasMeaningfulTolls =
      body.has_tolls === true ||
      Number(body.toll_count ?? 0) > 0 ||
      Number(body.toll_total ?? 0) > 0 ||
      (cleanOptionalText(body.toll_review_status) &&
        cleanOptionalText(body.toll_review_status) !== "none");

    const tollCount = hasMeaningfulTolls
      ? Math.max(1, parseOptionalInteger(body.toll_count, "toll_count") ?? 1)
      : 0;
    const tollTotal = parseOptionalNumber(body.toll_total, "toll_total") ?? 0;
    const tollReviewStatus = hasMeaningfulTolls
      ? cleanOptionalText(body.toll_review_status) || "pending"
      : "none";

    const insertResult = await client.query(
      `
        INSERT INTO trips (
          reservation_id,
          guest_name,
          vehicle_name,
          turo_vehicle_id,
          trip_start,
          trip_end,
          amount,
          status,
          needs_review,
          mileage_included,
          starting_odometer,
          ending_odometer,
          fuel_reimbursement_total,
          notes,
          has_tolls,
          toll_count,
          toll_total,
          toll_review_status,
          workflow_stage,
          stage_updated_at,
          expense_status,
          trip_details_url,
          guest_profile_url
        )
        VALUES (
          $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), $20, $21, $22
        )
        RETURNING id
      `,
      [
        parsed.reservation_id,
        parsed.guest_name,
        vehicle.vehicleName,
        vehicle.turoVehicleId,
        parsed.trip_start,
        parsed.trip_end,
        parsed.amount,
        parsed.status,
        parsed.needs_review,
        parsed.mileage_included,
        parsed.starting_odometer,
        parsed.ending_odometer,
        parsed.fuel_reimbursement_total,
        parsed.notes,
        hasMeaningfulTolls,
        tollCount,
        tollTotal,
        tollReviewStatus,
        parsed.workflow_stage,
        parsed.expense_status,
        parsed.trip_details_url,
        parsed.guest_profile_url,
      ]
    );

    const tripId = insertResult.rows[0].id;
    const refreshed = await client.query(
      `
        ${TRIP_SUMMARY_SELECT}
        WHERE t.id = $1
        LIMIT 1
      `,
      [tripId]
    );

    await client.query("COMMIT");

    void pushPublicAvailabilitySnapshotSafe("trip created manually");

    return res.status(201).json(enrichTripSummary(refreshed.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/trip-summaries failed:", {
      message: err.message,
      body: req.body,
      stack: err.stack,
    });

    if (err.code === "23505") {
      return res.status(409).json({
        error: "A trip with that reservation_id already exists",
      });
    }

    return res.status(err.statusCode || 500).json({
      error: err.message || "Failed to create trip summary",
    });
  } finally {
    client.release();
  }
});

router.get("/:id", async (req, res) => {
  try {
    const tripId = Number(req.params.id);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const query = `
      ${TRIP_SUMMARY_SELECT}
      WHERE t.id = $1
      LIMIT 1
    `;

    const { rows } = await pool.query(query, [tripId]);

    if (!rows.length) {
      return res.status(404).json({ error: "Trip summary not found" });
    }

    res.json(enrichTripSummary(rows[0]));
  } catch (err) {
    console.error("GET /api/trip-summaries/:id failed:", {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: "Failed to load trip summary" });
  }
});

router.patch("/:id", async (req, res) => {
  const tripId = Number(req.params.id);

  if (!Number.isInteger(tripId) || tripId <= 0) {
    return res.status(400).json({ error: "Invalid trip id" });
  }

  const body = req.body || {};

  const {
    reservation_id,
    guest_name,
    vehicle_name,
    turo_vehicle_id,
    trip_start,
    trip_end,
    gross_income,
    amount,
    status,
    needs_review,
    mileage_included,
    starting_odometer,
    ending_odometer,
    has_tolls,
    toll_count,
    toll_total,
    toll_review_status,
    fuel_reimbursement_total,
    notes,
    closed_out,
    closed_out_at,
    workflow_stage,
    stage_updated_at,
    expense_status,
    completed_at,
    canceled_at,
    created_from_message_id,
    last_message_id,
    trip_details_url,
    guest_profile_url,
  } = body;

  const hasField = (name) => Object.prototype.hasOwnProperty.call(body, name);

  const reservationIdWasProvided = hasField("reservation_id");
  const vehicleFieldWasProvided =
    hasField("turo_vehicle_id") || hasField("vehicle_name");
  const amountFieldWasProvided =
    hasField("amount") || hasField("gross_income");
  const createdFromMessageWasProvided = hasField("created_from_message_id");
  const lastMessageWasProvided = hasField("last_message_id");

  const normalizedVehicleId =
    turo_vehicle_id == null ? "" : String(turo_vehicle_id).trim();

  const normalizedVehicleName =
    vehicle_name == null ? "" : String(vehicle_name).trim();

  const normalizedCreatedFromMessageId =
    created_from_message_id == null
      ? null
      : String(created_from_message_id).trim() || null;

  const normalizedLastMessageId =
    last_message_id == null ? null : String(last_message_id).trim() || null;

  const numericReservationId = !reservationIdWasProvided
    ? null
    : reservation_id === "" || reservation_id == null
      ? null
      : Number(reservation_id);

  if (
    reservationIdWasProvided &&
    numericReservationId != null &&
    (!Number.isFinite(numericReservationId) ||
      !Number.isInteger(numericReservationId))
  ) {
    return res.status(400).json({ error: "reservation_id must be a valid integer" });
  }

  const numericGrossIncome = !amountFieldWasProvided
    ? null
    : gross_income === "" || gross_income == null
      ? amount === "" || amount == null
        ? null
        : Number(amount)
      : Number(gross_income);

  if (
    amountFieldWasProvided &&
    numericGrossIncome != null &&
    !Number.isFinite(numericGrossIncome)
  ) {
    return res.status(400).json({ error: "Amount must be a valid number" });
  }

  const numericMileageIncluded =
    mileage_included === "" || mileage_included == null
      ? null
      : Number(mileage_included);

  if (
    hasField("mileage_included") &&
    numericMileageIncluded != null &&
    !Number.isFinite(numericMileageIncluded)
  ) {
    return res.status(400).json({ error: "mileage_included must be a valid number" });
  }

  const numericStartingOdometer =
    starting_odometer === "" || starting_odometer == null
      ? null
      : Number(starting_odometer);

  if (
    hasField("starting_odometer") &&
    numericStartingOdometer != null &&
    !Number.isFinite(numericStartingOdometer)
  ) {
    return res.status(400).json({ error: "starting_odometer must be a valid number" });
  }

  const numericEndingOdometer =
    ending_odometer === "" || ending_odometer == null
      ? null
      : Number(ending_odometer);

  if (
    hasField("ending_odometer") &&
    numericEndingOdometer != null &&
    !Number.isFinite(numericEndingOdometer)
  ) {
    return res.status(400).json({ error: "ending_odometer must be a valid number" });
  }

  const numericFuelReimbursement =
    fuel_reimbursement_total === "" || fuel_reimbursement_total == null
      ? null
      : Number(fuel_reimbursement_total);

  if (
    hasField("fuel_reimbursement_total") &&
    numericFuelReimbursement != null &&
    !Number.isFinite(numericFuelReimbursement)
  ) {
    return res.status(400).json({ error: "fuel_reimbursement_total must be a valid number" });
  }

  const numericTollCount =
    toll_count === "" || toll_count == null ? null : Number(toll_count);

  if (
    hasField("toll_count") &&
    numericTollCount != null &&
    !Number.isFinite(numericTollCount)
  ) {
    return res.status(400).json({ error: "toll_count must be a valid number" });
  }

  const numericTollTotal =
    toll_total === "" || toll_total == null ? null : Number(toll_total);

  if (
    hasField("toll_total") &&
    numericTollTotal != null &&
    !Number.isFinite(numericTollTotal)
  ) {
    return res.status(400).json({ error: "toll_total must be a valid number" });
  }

    const tollFieldsWereProvided =
    hasField("has_tolls") ||
    hasField("toll_count") ||
    hasField("toll_total") ||
    hasField("toll_review_status");

  const incomingHasTolls =
    typeof has_tolls === "boolean" ? has_tolls : null;

  const hasMeaningfulTolls =
    (numericTollTotal != null && numericTollTotal > 0) ||
    (numericTollCount != null && numericTollCount > 0) ||
    incomingHasTolls === true ||
    (typeof toll_review_status === "string" &&
      toll_review_status.trim() !== "" &&
      toll_review_status !== "none");

  const normalizedHasTolls = tollFieldsWereProvided
    ? hasMeaningfulTolls
    : incomingHasTolls;

  const normalizedTollCount = tollFieldsWereProvided
    ? hasMeaningfulTolls
      ? Math.max(1, numericTollCount ?? 1)
      : 0
    : numericTollCount;

  const normalizedTollTotal = tollFieldsWereProvided
    ? numericTollTotal ?? 0
    : numericTollTotal;

  const normalizedTollReviewStatus = tollFieldsWereProvided
    ? hasMeaningfulTolls
      ? typeof toll_review_status === "string" &&
        toll_review_status.trim() !== "" &&
        toll_review_status !== "none"
        ? toll_review_status
        : "pending"
      : "none"
    : toll_review_status ?? null;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let resolvedVehicleId = null;
    let resolvedVehicleName = null;

    if (vehicleFieldWasProvided) {
      if (normalizedVehicleId !== "") {
        const vehicleLookup = await client.query(
          `
            SELECT turo_vehicle_id, nickname
            FROM vehicles
            WHERE CAST(turo_vehicle_id AS text) = $1
            LIMIT 1
          `,
          [normalizedVehicleId]
        );

        if (!vehicleLookup.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `Vehicle id not found: ${turo_vehicle_id}`,
          });
        }

        resolvedVehicleId = vehicleLookup.rows[0].turo_vehicle_id;
        resolvedVehicleName = vehicleLookup.rows[0].nickname;
      } else if (normalizedVehicleName !== "") {
        const vehicleLookup = await client.query(
          `
            SELECT turo_vehicle_id, nickname
            FROM vehicles
            WHERE LOWER(nickname) = LOWER($1)
            LIMIT 1
          `,
          [normalizedVehicleName]
        );

        if (!vehicleLookup.rows.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `Vehicle nickname not found: ${normalizedVehicleName}`,
          });
        }

        resolvedVehicleId = vehicleLookup.rows[0].turo_vehicle_id;
        resolvedVehicleName = vehicleLookup.rows[0].nickname;
      }
    }

    const updateResult = await client.query(
      `
        UPDATE trips
        SET
          reservation_id = CASE WHEN $1::boolean THEN $2 ELSE reservation_id END,
          guest_name = CASE WHEN $3::boolean THEN $4 ELSE guest_name END,
          vehicle_name = CASE WHEN $5::boolean THEN $6 ELSE vehicle_name END,
          trip_start = CASE WHEN $7::boolean THEN $8::timestamptz ELSE trip_start END,
          trip_end = CASE WHEN $9::boolean THEN $10::timestamptz ELSE trip_end END,
          amount = CASE WHEN $11::boolean THEN $12 ELSE amount END,
          status = CASE WHEN $13::boolean THEN $14 ELSE status END,
          needs_review = CASE WHEN $15::boolean THEN $16 ELSE needs_review END,
          turo_vehicle_id = CASE WHEN $5::boolean THEN $17 ELSE turo_vehicle_id END,
          mileage_included = CASE WHEN $18::boolean THEN $19 ELSE mileage_included END,
          starting_odometer = CASE WHEN $20::boolean THEN $21 ELSE starting_odometer END,
          ending_odometer = CASE WHEN $22::boolean THEN $23 ELSE ending_odometer END,
          fuel_reimbursement_total = CASE WHEN $24::boolean THEN $25 ELSE fuel_reimbursement_total END,
          notes = CASE WHEN $26::boolean THEN $27 ELSE notes END,
          has_tolls = CASE WHEN $28::boolean THEN $29 ELSE has_tolls END,
          toll_count = CASE WHEN $30::boolean THEN $31 ELSE toll_count END,
          toll_total = CASE WHEN $32::boolean THEN $33 ELSE toll_total END,
          toll_review_status = CASE WHEN $34::boolean THEN $35 ELSE toll_review_status END,
          closed_out = CASE WHEN $36::boolean THEN $37 ELSE closed_out END,
          closed_out_at = CASE WHEN $38::boolean THEN $39::timestamptz ELSE closed_out_at END,
          workflow_stage = CASE WHEN $40::boolean THEN $41 ELSE workflow_stage END,
          stage_updated_at = CASE WHEN $42::boolean THEN $43::timestamptz ELSE stage_updated_at END,
          expense_status = CASE WHEN $44::boolean THEN $45 ELSE expense_status END,
          completed_at = CASE WHEN $46::boolean THEN $47::timestamptz ELSE completed_at END,
          canceled_at = CASE WHEN $48::boolean THEN $49::timestamptz ELSE canceled_at END,
          created_from_message_id = CASE WHEN $50::boolean THEN $51 ELSE created_from_message_id END,
          last_message_id = CASE WHEN $52::boolean THEN $53 ELSE last_message_id END,
          trip_details_url = CASE WHEN $54::boolean THEN $55 ELSE trip_details_url END,
          guest_profile_url = CASE WHEN $56::boolean THEN $57 ELSE guest_profile_url END,
          updated_at = NOW()
        WHERE id = $58
        RETURNING id
      `,
      [
        reservationIdWasProvided,
        numericReservationId,

        hasField("guest_name"),
        guest_name ?? null,

        vehicleFieldWasProvided,
        resolvedVehicleName,

        hasField("trip_start"),
        trip_start || null,

        hasField("trip_end"),
        trip_end || null,

        amountFieldWasProvided,
        numericGrossIncome,

        hasField("status"),
        status ?? null,

        hasField("needs_review"),
        typeof needs_review === "boolean" ? needs_review : null,

        resolvedVehicleId,

        hasField("mileage_included"),
        numericMileageIncluded,

        hasField("starting_odometer"),
        numericStartingOdometer,

        hasField("ending_odometer"),
        numericEndingOdometer,

        hasField("fuel_reimbursement_total"),
        numericFuelReimbursement,

        
        hasField("notes"),
        notes ?? null,

        tollFieldsWereProvided || hasField("has_tolls"),
        normalizedHasTolls,

        tollFieldsWereProvided || hasField("toll_count"),
        normalizedTollCount,

        tollFieldsWereProvided || hasField("toll_total"),
        normalizedTollTotal,

        tollFieldsWereProvided || hasField("toll_review_status"),
        normalizedTollReviewStatus,

        hasField("closed_out"),
        typeof closed_out === "boolean" ? closed_out : null,

        hasField("closed_out_at"),
        closed_out_at || null,

        hasField("workflow_stage"),
        workflow_stage ?? null,

        hasField("stage_updated_at"),
        stage_updated_at || null,

        hasField("expense_status"),
        expense_status ?? null,

        hasField("completed_at"),
        completed_at || null,

        hasField("canceled_at"),
        canceled_at || null,

        createdFromMessageWasProvided,
        normalizedCreatedFromMessageId,

        lastMessageWasProvided,
        normalizedLastMessageId,

        hasField("trip_details_url"),
        trip_details_url ?? null,

        hasField("guest_profile_url"),
        guest_profile_url ?? null,

        tripId,
      ]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Trip summary not found" });
    }

    const refreshed = await client.query(
      `
        ${TRIP_SUMMARY_SELECT}
        WHERE t.id = $1
        LIMIT 1
      `,
      [tripId]
    );

    await client.query("COMMIT");

    if (hasField("status")) {
      void pushPublicAvailabilitySnapshotSafe("trip status changed");
    }

    if (!refreshed.rows.length) {
      return res.json({ id: tripId });
    }

    return res.json(enrichTripSummary(refreshed.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/trip-summaries/:id failed:", {
      message: err.message,
      tripId,
      body: req.body,
      stack: err.stack,
    });
    return res.status(500).json({
      error: "Failed to update trip summary",
      detail: err.message,
    });
  } finally {
    client.release();
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const tripId = Number(req.params.id);

    if (!Number.isInteger(tripId) || tripId <= 0) {
      return res.status(400).json({ error: "Invalid trip id" });
    }

    const result = await pool.query(
      `
        UPDATE trips
        SET
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id
      `,
      [tripId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "Trip summary not found" });
    }

    res.json({ ok: true, id: tripId });
  } catch (err) {
    console.error("DELETE /api/trip-summaries/:id failed:", err.message || err);
    res.status(500).json({ error: "Failed to delete trip summary" });
  }
});

module.exports = router;
