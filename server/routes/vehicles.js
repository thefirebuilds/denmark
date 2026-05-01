// --------------------------------
// /server/routes/vehicles.js
// Express routes for fetching and updating vehicle data  
// --------------------------------

const express = require("express");
const pool = require("../db");
const {
  getCombinedVehicleStatusFeed,
  getCachedVehicleStatusFeed,
  getVehicleStatusFeed,
} = require("../services/vehicles/statusFeed");
const {
  generateFleetFmvEstimates,
  generateVehicleFmvEstimate,
  getLatestVehicleFmvEstimates,
  getVehicleFmvEstimateHistory,
} = require("../services/vehicles/fmvEstimateService");

const router = express.Router();

function normalizeSelector(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePlate(value) {
  if (value == null) return null;
  const cleaned = String(value).trim().toUpperCase();
  return cleaned || null;
}

function toNullableText(value) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function toNullableInt(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function toNullableNumber(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableBoolean(value, fallback = null) {
  if (value === "" || value == null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

async function getVehicleColumns(client = pool) {
  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vehicles'
  `);

  return new Set(rows.map((row) => row.column_name));
}

async function findVehicleBySelector(selector) {
  const normalized = normalizeSelector(selector);

  const query = `
    SELECT *
    FROM vehicles
    WHERE lower(trim(vin)) = $1
       OR lower(trim(nickname)) = $1
       OR lower(trim(COALESCE(license_plate, ''))) = $1
    LIMIT 1
  `;

  const { rows } = await pool.query(query, [normalized]);
  return rows[0] || null;
}

router.get("/status", async (req, res) => {
  try {
    const feed = await getVehicleStatusFeed();
    res.json(feed);
  } catch (err) {
    console.error("Vehicle status error:", err);
    res.status(500).json({ error: "Failed to fetch vehicle status" });
  }
});

router.get("/live-status", async (req, res) => {
  try {
    const feed = await getCombinedVehicleStatusFeed();
    res.json(feed);
  } catch (err) {
    console.error("Vehicle live status error:", err);
    res.status(500).json({ error: "Failed to fetch live vehicle status" });
  }
});

router.get("/cached-status", async (req, res) => {
  try {
    const feed = await getCachedVehicleStatusFeed();
    res.json(feed);
  } catch (err) {
    console.error("Vehicle cached status error:", err);
    res.status(500).json({ error: "Failed to fetch cached vehicle status" });
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        vin,
        nickname,
        year,
        make,
        model,
        standard_engine,
        license_plate,
        license_state,
        registration_month,
        registration_year,
        lockbox_pin,
        bouncie_vehicle_id,
        dimo_token_id,
        turo_vehicle_id,
        turo_vehicle_name,
        current_odometer_miles,
        rockauto_url,
        is_active
      FROM vehicles
      WHERE is_active = true
      ORDER BY nickname NULLS LAST, make NULLS LAST, model NULLS LAST, id ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/vehicles failed:", err);
    res.status(500).json({ error: "Failed to fetch vehicles" });
  }
});

router.get("/fmv-estimates/latest", async (req, res) => {
  try {
    const estimates = await getLatestVehicleFmvEstimates();
    res.json({ estimates });
  } catch (err) {
    console.error("GET /api/vehicles/fmv-estimates/latest failed:", err);
    res.status(500).json({ error: "Failed to load FMV estimates" });
  }
});

router.post("/fmv-estimates/run", async (req, res) => {
  try {
    const selector =
      typeof req.body?.selector === "string" ? req.body.selector.trim() : "";

    if (selector) {
      const estimate = await generateVehicleFmvEstimate(selector);
      return res.json({ ok: true, mode: "single", estimate });
    }

    const results = await generateFleetFmvEstimates();
    return res.json({ ok: true, mode: "fleet", results });
  } catch (err) {
    console.error("POST /api/vehicles/fmv-estimates/run failed:", err);
    res
      .status(err.statusCode || 500)
      .json({ error: err.message || "Failed to generate FMV estimate" });
  }
});

router.post("/", async (req, res) => {
  try {
    const nickname = toNullableText(req.body.nickname);
    const vin = toNullableText(req.body.vin)?.toUpperCase() || null;

    if (!vin) {
      return res.status(400).json({ error: "vin is required" });
    }

    const columns = await getVehicleColumns();
    const candidateValues = {
      vin,
      nickname,
      year: toNullableInt(req.body.year),
      make: toNullableText(req.body.make),
      model: toNullableText(req.body.model),
      standard_engine: toNullableText(req.body.standard_engine),
      license_plate: normalizePlate(req.body.license_plate),
      license_state:
        toNullableText(req.body.license_state)?.toUpperCase() || null,
      bouncie_vehicle_id: toNullableText(req.body.bouncie_vehicle_id),
      dimo_token_id: toNullableInt(req.body.dimo_token_id),
      provider_vehicle_id: toNullableText(req.body.provider_vehicle_id),
      external_vehicle_key: toNullableText(req.body.external_vehicle_key),
      imei: toNullableText(req.body.imei),
      turo_vehicle_id: toNullableText(req.body.turo_vehicle_id),
      turo_vehicle_name: toNullableText(req.body.turo_vehicle_name),
      oil_type: toNullableText(req.body.oil_type),
      oil_capacity_quarts: toNullableNumber(req.body.oil_capacity_quarts),
      oil_capacity_liters: toNullableNumber(req.body.oil_capacity_liters),
      rockauto_url: toNullableText(req.body.rockauto_url),
      is_active: toNullableBoolean(req.body.is_active, true),
    };

    if (candidateValues.dimo_token_id && !candidateValues.external_vehicle_key) {
      candidateValues.external_vehicle_key = `dimo:${candidateValues.dimo_token_id}`;
    }

    const insertColumns = [];
    const values = [];

    for (const [column, value] of Object.entries(candidateValues)) {
      if (!columns.has(column)) continue;
      insertColumns.push(column);
      values.push(value);
    }

    if (columns.has("created_at")) {
      insertColumns.push("created_at");
      values.push(new Date());
    }

    if (columns.has("updated_at")) {
      insertColumns.push("updated_at");
      values.push(new Date());
    }

    const placeholders = values.map((_, index) => `$${index + 1}`);

    const { rows } = await pool.query(
      `
      INSERT INTO vehicles (${insertColumns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
      `,
      values
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Vehicle already exists" });
    }

    console.error("POST /api/vehicles failed:", err);
    return res.status(500).json({ error: "Failed to create vehicle" });
  }
});

router.get("/:selector", async (req, res) => {
  try {
    const vehicle = await findVehicleBySelector(req.params.selector);

    if (!vehicle) {
      return res.status(404).json({ error: "Vehicle not found" });
    }

    res.json(vehicle);
  } catch (err) {
    console.error("GET /api/vehicle/:selector failed:", err);
    res.status(500).json({ error: "Failed to fetch vehicle" });
  }
});

router.get("/:selector/fmv-estimates", async (req, res) => {
  try {
    const payload = await getVehicleFmvEstimateHistory(req.params.selector);
    res.json(payload);
  } catch (err) {
    console.error("GET /api/vehicles/:selector/fmv-estimates failed:", err);
    res
      .status(err.statusCode || 500)
      .json({ error: err.message || "Failed to load vehicle FMV history" });
  }
});

router.patch("/:selector", async (req, res) => {
  const client = await pool.connect();

  function normalizeGuestVisibleNotes(value) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) return null;

    return value
      .map((note) => String(note || "").trim())
      .filter(Boolean);
  }

  async function findVehicleBySelectorWithClient(db, selector) {
    const normalized = normalizeSelector(selector);

    const query = `
      SELECT *
      FROM vehicles
      WHERE lower(trim(vin)) = $1
         OR lower(trim(nickname)) = $1
         OR lower(trim(COALESCE(license_plate, ''))) = $1
      LIMIT 1
    `;

    const { rows } = await db.query(query, [normalized]);
    return rows[0] || null;
  }

  try {
    await client.query("BEGIN");

    const existing = await findVehicleBySelectorWithClient(
      client,
      req.params.selector
    );

    if (!existing) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Vehicle not found" });
    }

    const license_plate =
      req.body.license_plate !== undefined
        ? normalizePlate(req.body.license_plate)
        : existing.license_plate;

    const license_state =
      req.body.license_state !== undefined
        ? toNullableText(req.body.license_state)?.toUpperCase() || null
        : existing.license_state;

    const registration_month =
      req.body.registration_month !== undefined
        ? toNullableInt(req.body.registration_month)
        : existing.registration_month;

    const registration_year =
      req.body.registration_year !== undefined
        ? toNullableInt(req.body.registration_year)
        : existing.registration_year;

    const oil_type =
      req.body.oil_type !== undefined
        ? toNullableText(req.body.oil_type)
        : existing.oil_type;

    const oil_capacity_quarts =
      req.body.oil_capacity_quarts !== undefined
        ? toNullableNumber(req.body.oil_capacity_quarts)
        : existing.oil_capacity_quarts;

    const oil_capacity_liters =
      req.body.oil_capacity_liters !== undefined
        ? toNullableNumber(req.body.oil_capacity_liters)
        : existing.oil_capacity_liters;

    const rockauto_url =
      req.body.rockauto_url !== undefined
        ? toNullableText(req.body.rockauto_url)
        : existing.rockauto_url;

    const lockbox_pin =
      req.body.lockbox_pin !== undefined
        ? toNullableText(req.body.lockbox_pin)
        : existing.lockbox_pin;

    const guestVisibleConditionNotes = normalizeGuestVisibleNotes(
      req.body.guest_visible_condition_notes
    );

    if (
      registration_month != null &&
      (registration_month < 1 || registration_month > 12)
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "registration_month must be 1-12" });
    }

    if (
      req.body.guest_visible_condition_notes !== undefined &&
      guestVisibleConditionNotes === null
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "guest_visible_condition_notes must be an array of strings",
      });
    }

    const vehicleQuery = `
      UPDATE vehicles
      SET
        license_plate = $1,
        license_state = $2,
        registration_month = $3,
        registration_year = $4,
        oil_type = $5,
        oil_capacity_quarts = $6,
        oil_capacity_liters = $7,
        rockauto_url = $8,
        lockbox_pin = $9,
        updated_at = NOW()
      WHERE id = $10
      RETURNING *
    `;

    const vehicleValues = [
      license_plate,
      license_state,
      registration_month,
      registration_year,
      oil_type,
      oil_capacity_quarts,
      oil_capacity_liters,
      rockauto_url,
      lockbox_pin,
      existing.id,
    ];

    const { rows } = await client.query(vehicleQuery, vehicleValues);
    const updatedVehicle = rows[0];

    if (guestVisibleConditionNotes !== undefined) {
      await client.query(
        `
          UPDATE vehicle_condition_notes
          SET
            active = false,
            resolved_at = NOW(),
            updated_at = NOW()
          WHERE vehicle_vin = $1
            AND guest_visible = true
            AND active = true
        `,
        [existing.vin]
      );

      for (const note of guestVisibleConditionNotes) {
        const title = note.length > 80 ? `${note.slice(0, 77)}...` : note;

        await client.query(
          `
            INSERT INTO vehicle_condition_notes (
              vehicle_vin,
              note_type,
              area,
              title,
              description,
              severity,
              guest_visible,
              active,
              recorded_at,
              created_at,
              updated_at
            )
            VALUES (
              $1,  -- vehicle_vin
              'other',
              'general',
              $2,  -- title
              $3,  -- description
              'minor',
              true,
              true,
              NOW(),
              NOW(),
              NOW()
            )
          `,
          [existing.vin, title, note]
        );
      }
    }

    await client.query("COMMIT");
    return res.json(updatedVehicle);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("PATCH /api/vehicles/:selector failed:", err);
    return res.status(500).json({ error: "Failed to update vehicle" });
  } finally {
    client.release();
  }
});

module.exports = router;
