// --------------------------------
// /server/routes/vehicles.js
// Express routes for fetching and updating vehicle data  
// --------------------------------

const express = require("express");
const pool = require("../db");
const {
  getCombinedVehicleStatusFeed,
  getCachedVehicleStatusFeed,
} = require("../services/vehicles/statusFeed");
const {
  getVehicleLocationHeatmap,
  getVehicleLocationTrail,
  getVehicleLocations,
} = require("../services/vehicles/locationFeed");
const { getParkingSpotUsage } = require("../services/vehicles/parkingSpotUsage");
const {
  addVehicleAlias,
  ensureVehicleAliasesTable,
} = require("../services/vehicles/vehicleAliases");
const {
  generateFleetFmvEstimates,
  generateVehicleFmvEstimate,
  getLatestVehicleFmvEstimates,
  getVehicleFmvEstimateHistory,
} = require("../services/vehicles/fmvEstimateService");
const { pushPublicAvailabilitySnapshotSafe } = require("../services/pushPublicAvailability");

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

function toNullableDate(value) {
  if (value === "" || value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return String(value).slice(0, 10);
}

function getAgeMinutes(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

const TELEMETRY_READING_DEFINITIONS = {
  battery_voltage: {
    label: "Battery voltage",
    valueSql: "s.battery_voltage::numeric",
    rawValueSql: "s.battery_voltage::numeric",
    recordedAtSql:
      "COALESCE(s.battery_voltage_last_updated, s.vehicle_last_updated, s.captured_at)::timestamptz",
    whereSql:
      "s.battery_voltage IS NOT NULL AND s.battery_voltage::numeric BETWEEN 5 AND 16",
    unit: "v",
  },
  coolant_temp: {
    label: "Engine temp",
    valueSql:
      "CASE WHEN s.coolant_temp::numeric <= 130 THEN s.coolant_temp::numeric * 9 / 5 + 32 ELSE s.coolant_temp::numeric END",
    rawValueSql: "s.coolant_temp::numeric",
    recordedAtSql: "COALESCE(s.vehicle_last_updated, s.captured_at)::timestamptz",
    whereSql: "s.coolant_temp IS NOT NULL",
    unit: "F",
  },
  engine_rpm: {
    label: "Tachometer",
    valueSql: "s.engine_rpm::numeric",
    rawValueSql: "s.engine_rpm::numeric",
    recordedAtSql: "COALESCE(s.vehicle_last_updated, s.captured_at)::timestamptz",
    whereSql: "s.engine_rpm IS NOT NULL AND s.engine_rpm::numeric >= 0",
    unit: "RPM",
  },
  speed_mph: {
    label: "Recorded speeds",
    valueSql: "s.speed::numeric",
    rawValueSql: "s.speed::numeric",
    recordedAtSql: "COALESCE(s.speed_last_updated, s.vehicle_last_updated, s.captured_at)::timestamptz",
    whereSql: "s.speed IS NOT NULL AND s.speed::numeric >= 0",
    unit: "mph",
  },
};

function getAgeDays(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function withStatusCompatibilityFields(vehicle) {
  const telemetry = vehicle?.telemetry || {};
  const fuelLevel = telemetry.fuel_level;
  const location = telemetry.location || {};
  const mil = telemetry.mil || {};
  const battery = telemetry.battery || {};

  return {
    ...vehicle,
    registration: {
      state: vehicle.license_state || null,
      month: vehicle.registration_month ?? null,
      year: vehicle.registration_year ?? null,
      code:
        vehicle.registration_month && vehicle.registration_year
          ? `${String(vehicle.registration_month).padStart(2, "0")}/${vehicle.registration_year}`
          : null,
    },
    oil: {
      type: vehicle.oil_type || null,
      capacity_quarts:
        vehicle.oil_capacity_quarts != null
          ? Number(vehicle.oil_capacity_quarts)
          : null,
      capacity_liters:
        vehicle.oil_capacity_liters != null
          ? Number(vehicle.oil_capacity_liters)
          : null,
    },
    battery: {
      installed_at: vehicle.battery_installed_at || null,
    },
    telemetry: {
      ...telemetry,
      last_comm_age_minutes: getAgeMinutes(telemetry.last_comm),
      has_fuel_level: fuelLevel !== undefined && fuelLevel !== null,
      location: {
        ...location,
        has_location: location.lat != null && location.lon != null,
        has_address: Boolean(location.address),
      },
      mil: {
        ...mil,
        has_dtc:
          Array.isArray(mil.qualified_dtc_list) &&
          mil.qualified_dtc_list.length > 0,
        dtc_count:
          mil.dtc_count ??
          (Array.isArray(mil.qualified_dtc_list)
            ? mil.qualified_dtc_list.length
            : 0),
      },
      battery: {
        ...battery,
        age_days: getAgeDays(battery.last_updated),
        is_stale: getAgeDays(battery.last_updated) > 14,
      },
    },
  };
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
       OR trim(CAST(id AS text)) = $1
       OR trim(CAST(COALESCE(turo_vehicle_id, '') AS text)) = $1
       OR lower(trim(COALESCE(license_plate, ''))) = $1
       OR EXISTS (
         SELECT 1
         FROM vehicle_aliases va
         WHERE va.vehicle_id = vehicles.id
           AND va.active = true
           AND lower(trim(va.alias)) = $1
       )
    LIMIT 1
  `;

  const { rows } = await pool.query(query, [normalized]);
  return rows[0] || null;
}

function selectCanonicalNicknameSql() {
  return `
    COALESCE(
      (
        SELECT va.alias
        FROM vehicle_aliases va
        WHERE va.vehicle_id = v.id
          AND va.active = true
          AND va.source = 'canonical'
        ORDER BY va.updated_at DESC, va.created_at DESC, va.id DESC
        LIMIT 1
      ),
      NULLIF(trim(v.nickname), '')
    )
  `;
}

router.get("/status", async (req, res) => {
  try {
    const feed = await getCachedVehicleStatusFeed();
    res.json(feed.map(withStatusCompatibilityFields));
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

router.get("/locations", async (req, res) => {
  const startedAt = Date.now();
  try {
    const locations = await getVehicleLocations();
    const durationMs = Date.now() - startedAt;
    if (durationMs > 750) {
      console.log(
        `[vehicles] locations feed slow durationMs=${durationMs} vehicles=${locations.length}`
      );
    }
    res.json(locations);
  } catch (err) {
    console.error("GET /api/vehicles/locations failed:", err);
    res.status(500).json({ error: "Failed to fetch vehicle locations" });
  }
});

router.get("/locations/trail", async (req, res) => {
  try {
    if (!req.query.vehicleId) {
      return res.status(400).json({ error: "vehicleId is required" });
    }

    const trail = await getVehicleLocationTrail(req.query.vehicleId, {
      minutes: req.query.minutes,
    });
    return res.json(trail);
  } catch (err) {
    console.error("GET /api/vehicles/locations/trail failed:", err);
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to fetch vehicle trail" });
  }
});

router.get("/locations/heatmap", async (req, res) => {
  try {
    if (!req.query.vehicleId) {
      return res.status(400).json({ error: "vehicleId is required" });
    }

    const heatmap = await getVehicleLocationHeatmap(req.query.vehicleId, {
      days: req.query.days,
    });
    return res.json(heatmap);
  } catch (err) {
    console.error("GET /api/vehicles/locations/heatmap failed:", err);
    return res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to fetch vehicle heatmap" });
  }
});

router.get("/locations/:vehicleId/heatmap", async (req, res) => {
  try {
    const heatmap = await getVehicleLocationHeatmap(req.params.vehicleId, {
      days: req.query.days,
    });
    res.json(heatmap);
  } catch (err) {
    console.error("GET /api/vehicles/locations/:vehicleId/heatmap failed:", err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to fetch vehicle heatmap" });
  }
});

router.get("/parking-spot-usage", async (req, res) => {
  try {
    const usage = await getParkingSpotUsage({
      month: req.query.month,
      start: req.query.start,
      end: req.query.end,
      vehicle: req.query.vehicle,
      timeZone: req.query.timeZone,
    });

    res.json(usage);
  } catch (err) {
    console.error("GET /api/vehicles/parking-spot-usage failed:", err);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Failed to calculate parking spot usage" });
  }
});

router.get("/", async (req, res) => {
  try {
    await ensureVehicleAliasesTable();

    const includeInactive =
      String(req.query.includeInactive || "").toLowerCase() === "true" ||
      String(req.query.include_inactive || "").toLowerCase() === "true";

    const result = await pool.query(`
      SELECT
        v.id,
        v.vin,
        ${selectCanonicalNicknameSql()} AS nickname,
        v.year,
        v.make,
        v.model,
        v.standard_engine,
        v.license_plate,
        v.license_state,
        v.registration_month,
        v.registration_year,
        v.lockbox_pin,
        v.bouncie_vehicle_id,
        v.dimo_token_id,
        v.turo_vehicle_id,
        v.turo_vehicle_name,
        v.current_odometer_miles,
        v.provider_vehicle_id,
        v.external_vehicle_key,
        COALESCE(alias_list.aliases, ARRAY[]::text[]) AS aliases,
        v.rockauto_url,
        v.oil_type,
        v.oil_capacity_quarts,
        v.oil_capacity_liters,
        v.battery_installed_at,
        v.onboarding_date,
        first_trip.first_trip_start::date AS first_trip_start,
        COALESCE(v.onboarding_date, first_trip.first_trip_start::date) AS effective_onboarding_date,
        CASE
          WHEN v.onboarding_date IS NOT NULL THEN 'manual'
          WHEN first_trip.first_trip_start IS NOT NULL THEN 'first_trip'
          ELSE NULL
        END AS onboarding_date_source,
        v.acquisition_cost,
        v.retired_at,
        v.in_service,
        v.is_active
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT array_agg(va.alias ORDER BY va.alias) AS aliases
        FROM vehicle_aliases va
        WHERE va.vehicle_id = v.id
          AND va.active = true
      ) alias_list ON true
      LEFT JOIN LATERAL (
        SELECT MIN(t.trip_start)::date AS first_trip_start
        FROM trips t
        WHERE t.trip_start IS NOT NULL
          AND (
            (
              v.turo_vehicle_id IS NOT NULL
              AND t.turo_vehicle_id IS NOT NULL
              AND v.turo_vehicle_id = t.turo_vehicle_id
            )
            OR (
              COALESCE(v.nickname, '') <> ''
              AND COALESCE(t.vehicle_name, '') <> ''
              AND LOWER(v.nickname) = LOWER(t.vehicle_name)
            )
            OR EXISTS (
              SELECT 1
              FROM vehicle_aliases va
              WHERE va.vehicle_id = v.id
                AND va.active = true
                AND COALESCE(t.vehicle_name, '') <> ''
                AND LOWER(va.alias) = LOWER(t.vehicle_name)
            )
          )
          AND (
            t.canceled_at IS NULL
            OR COALESCE(t.amount, 0) > 0
          )
      ) first_trip ON true
      WHERE ($1::boolean = true OR v.is_active = true)
      ORDER BY v.is_active DESC, v.in_service DESC, ${selectCanonicalNicknameSql()} NULLS LAST, v.make NULLS LAST, v.model NULLS LAST, v.id ASC
    `, [includeInactive]);

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
    await ensureVehicleAliasesTable();

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
      provider_vehicle_id:
        toNullableText(req.body.provider_vehicle_id) ||
        (toNullableInt(req.body.dimo_token_id) != null
          ? String(toNullableInt(req.body.dimo_token_id))
          : null),
      external_vehicle_key: toNullableText(req.body.external_vehicle_key),
      imei: toNullableText(req.body.imei),
      turo_vehicle_id: toNullableText(req.body.turo_vehicle_id),
      turo_vehicle_name: toNullableText(req.body.turo_vehicle_name),
      oil_type: toNullableText(req.body.oil_type),
      oil_capacity_quarts: toNullableNumber(req.body.oil_capacity_quarts),
      oil_capacity_liters: toNullableNumber(req.body.oil_capacity_liters),
      battery_installed_at: toNullableDate(req.body.battery_installed_at),
      rockauto_url: toNullableText(req.body.rockauto_url),
      onboarding_date: toNullableDate(req.body.onboarding_date),
      acquisition_cost: toNullableNumber(req.body.acquisition_cost),
      retired_at: toNullableDate(req.body.retired_at),
      in_service: toNullableBoolean(req.body.in_service, true),
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

    await addVehicleAlias(pool, rows[0].id, rows[0].nickname, "canonical");

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

router.get("/:selector/telemetry-readings", async (req, res) => {
  try {
    const signal = normalizeSelector(req.query.signal);
    const definition = TELEMETRY_READING_DEFINITIONS[signal];

    if (!definition) {
      return res.status(400).json({
        error: "Unsupported telemetry signal",
        supportedSignals: Object.keys(TELEMETRY_READING_DEFINITIONS),
      });
    }

    const vehicle = await findVehicleBySelector(req.params.selector);
    if (!vehicle) {
      return res.status(404).json({ error: "Vehicle not found" });
    }

    const limit = Math.max(
      1,
      Math.min(100, Number.parseInt(req.query.limit, 10) || 50)
    );
    const includeEngineOnContext = signal === "battery_voltage";
    const engineOnSelectSql = includeEngineOnContext
      ? `
          engine_context.snapshot_id AS engine_on_snapshot_id,
          engine_context.engine_on_at,
          engine_context.delta_minutes AS engine_on_delta_minutes,
          engine_context.match_basis AS engine_on_match_basis
        `
      : `
          NULL::bigint AS engine_on_snapshot_id,
          NULL::timestamptz AS engine_on_at,
          NULL::numeric AS engine_on_delta_minutes,
          NULL::text AS engine_on_match_basis
        `;
    const engineOnJoinSql = includeEngineOnContext
      ? `
        LEFT JOIN LATERAL (
          SELECT
            candidate.snapshot_id,
            candidate.engine_on_at,
            ROUND(
              (
                EXTRACT(
                  EPOCH FROM (candidate.engine_on_at - candidate.match_at)
                ) / 60.0
              )::numeric,
              1
            ) AS delta_minutes,
            candidate.match_basis
          FROM (
            SELECT
              engine.id AS snapshot_id,
              ref.match_at,
              ref.match_basis,
              COALESCE(
                engine.ignition_last_updated,
                engine.vehicle_last_updated,
                engine.captured_at
              ) AS engine_on_at
            FROM (
              VALUES
                (d.recorded_at, 'signal'::text),
                (d.captured_at, 'capture'::text)
            ) AS ref(match_at, match_basis)
            JOIN vehicle_telemetry_snapshots engine
              ON COALESCE(engine.is_running, false) = true
             AND COALESCE(
                engine.ignition_last_updated,
                engine.vehicle_last_updated,
                engine.captured_at
              ) BETWEEN ref.match_at - INTERVAL '5 minutes'
                AND ref.match_at + INTERVAL '5 minutes'
            WHERE ref.match_at IS NOT NULL
              AND d.value < 12
              AND (
                (
                  d.vin IS NOT NULL
                  AND d.vin <> ''
                  AND engine.vin IS NOT NULL
                  AND engine.vin <> ''
                  AND LOWER(engine.vin) = LOWER(d.vin)
                )
                OR (
                  d.dimo_token_id IS NOT NULL
                  AND engine.dimo_token_id = d.dimo_token_id
                )
                OR (
                  d.external_vehicle_key IS NOT NULL
                  AND d.external_vehicle_key <> ''
                  AND engine.external_vehicle_key = d.external_vehicle_key
                )
              )
          ) candidate
          ORDER BY CASE candidate.match_basis WHEN 'signal' THEN 0 ELSE 1 END ASC,
          ABS(
            EXTRACT(
              EPOCH FROM (candidate.engine_on_at - candidate.match_at)
            )
          ) ASC,
          candidate.snapshot_id DESC
          LIMIT 1
        ) engine_context ON TRUE
      `
      : "";
    const { rows } = await pool.query(
      `
        WITH candidates AS (
          SELECT
            s.id AS snapshot_id,
            s.service_name,
            ${definition.valueSql} AS value,
            ${definition.rawValueSql} AS raw_value,
            ${definition.recordedAtSql} AS recorded_at,
            s.captured_at,
            s.vehicle_last_updated,
            s.vin,
            s.dimo_token_id,
            s.external_vehicle_key
          FROM vehicle_telemetry_snapshots s
          WHERE ${definition.whereSql}
            AND (
              (
                $1::text IS NOT NULL
                AND $1::text <> ''
                AND s.vin IS NOT NULL
                AND s.vin <> ''
                AND LOWER(s.vin) = LOWER($1::text)
              )
              OR (
                $2::bigint IS NOT NULL
                AND s.dimo_token_id = $2::bigint
              )
              OR (
                $3::text IS NOT NULL
                AND $3::text <> ''
                AND s.external_vehicle_key = $3::text
              )
            )
        ),
        deduped AS (
          SELECT
            MAX(snapshot_id) AS snapshot_id,
            MAX(service_name) AS service_name,
            value,
            raw_value,
            recorded_at,
            MAX(captured_at) AS captured_at,
            MAX(vehicle_last_updated) AS vehicle_last_updated,
            MAX(vin) AS vin,
            MAX(dimo_token_id) AS dimo_token_id,
            MAX(external_vehicle_key) AS external_vehicle_key
          FROM candidates
          GROUP BY value, raw_value, recorded_at
        )
        SELECT
          d.snapshot_id,
          d.service_name,
          d.value,
          d.raw_value,
          d.recorded_at,
          d.captured_at,
          d.vehicle_last_updated,
          d.vin,
          d.dimo_token_id,
          d.external_vehicle_key,
          ${engineOnSelectSql}
        FROM deduped d
        ${engineOnJoinSql}
        ORDER BY d.recorded_at DESC NULLS LAST, d.snapshot_id DESC
        LIMIT $4
      `,
      [
        vehicle.vin || null,
        vehicle.dimo_token_id || null,
        vehicle.external_vehicle_key || null,
        limit,
      ]
    );

    return res.json({
      vehicle: {
        id: vehicle.id,
        nickname: vehicle.nickname,
        vin: vehicle.vin,
      },
      signal,
      label: definition.label,
      unit: definition.unit,
      limit,
      readings: rows.map((row) => ({
        snapshotId: row.snapshot_id,
        source: row.service_name || null,
        value: row.value == null ? null : Number(row.value),
        rawValue: row.raw_value == null ? null : Number(row.raw_value),
        recordedAt: row.recorded_at || row.captured_at || null,
        capturedAt: row.captured_at || null,
        vehicleLastUpdated: row.vehicle_last_updated || null,
        engineOnNearReading:
          row.engine_on_at == null
            ? null
            : {
                snapshotId: row.engine_on_snapshot_id,
                at: row.engine_on_at,
                deltaMinutes:
                  row.engine_on_delta_minutes == null
                    ? null
                    : Number(row.engine_on_delta_minutes),
                matchBasis: row.engine_on_match_basis || null,
              },
      })),
    });
  } catch (err) {
    console.error("GET /api/vehicles/:selector/telemetry-readings failed:", err);
    return res.status(500).json({
      error: "Failed to load telemetry readings",
      detail:
        process.env.NODE_ENV === "production"
          ? undefined
          : err.message || String(err),
    });
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
         OR EXISTS (
           SELECT 1
           FROM vehicle_aliases va
           WHERE va.vehicle_id = vehicles.id
             AND va.active = true
             AND lower(trim(va.alias)) = $1
         )
      LIMIT 1
    `;

    const { rows } = await db.query(query, [normalized]);
    return rows[0] || null;
  }

  try {
    await client.query("BEGIN");
    await ensureVehicleAliasesTable(client);

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

    const nickname =
      req.body.nickname !== undefined
        ? toNullableText(req.body.nickname)
        : existing.nickname;

    const vin =
      req.body.vin !== undefined
        ? toNullableText(req.body.vin)?.toUpperCase() || existing.vin
        : existing.vin;

    const year =
      req.body.year !== undefined
        ? toNullableInt(req.body.year)
        : existing.year;

    const make =
      req.body.make !== undefined ? toNullableText(req.body.make) : existing.make;

    const model =
      req.body.model !== undefined
        ? toNullableText(req.body.model)
        : existing.model;

    const standard_engine =
      req.body.standard_engine !== undefined
        ? toNullableText(req.body.standard_engine)
        : existing.standard_engine;

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

    const battery_installed_at =
      req.body.battery_installed_at !== undefined
        ? toNullableDate(req.body.battery_installed_at)
        : existing.battery_installed_at;

    const lockbox_pin =
      req.body.lockbox_pin !== undefined
        ? toNullableText(req.body.lockbox_pin)
        : existing.lockbox_pin;

    const bouncie_vehicle_id =
      req.body.bouncie_vehicle_id !== undefined
        ? toNullableText(req.body.bouncie_vehicle_id)
        : existing.bouncie_vehicle_id;

    const dimo_token_id =
      req.body.dimo_token_id !== undefined
        ? toNullableInt(req.body.dimo_token_id)
        : existing.dimo_token_id;

    const dimoTokenWasProvided = req.body.dimo_token_id !== undefined;

    const provider_vehicle_id =
      req.body.provider_vehicle_id !== undefined
        ? toNullableText(req.body.provider_vehicle_id)
        : dimo_token_id != null
        ? String(dimo_token_id)
        : existing.provider_vehicle_id;

    const external_vehicle_key =
      req.body.external_vehicle_key !== undefined
        ? toNullableText(req.body.external_vehicle_key)
        : dimo_token_id != null
        ? `dimo:${dimo_token_id}`
        : dimoTokenWasProvided
        ? null
        : existing.external_vehicle_key;

    const turo_vehicle_id =
      req.body.turo_vehicle_id !== undefined
        ? toNullableText(req.body.turo_vehicle_id)
        : existing.turo_vehicle_id;

    const turo_vehicle_name =
      req.body.turo_vehicle_name !== undefined
        ? toNullableText(req.body.turo_vehicle_name)
        : existing.turo_vehicle_name;

    const onboarding_date =
      req.body.onboarding_date !== undefined
        ? toNullableDate(req.body.onboarding_date)
        : existing.onboarding_date;

    const acquisition_cost =
      req.body.acquisition_cost !== undefined
        ? toNullableNumber(req.body.acquisition_cost)
        : existing.acquisition_cost;

    const retired_at =
      req.body.retired_at !== undefined
        ? toNullableDate(req.body.retired_at)
        : existing.retired_at;

    const in_service =
      req.body.in_service !== undefined
        ? toNullableBoolean(req.body.in_service, existing.in_service)
        : existing.in_service;

    const is_active =
      req.body.is_active !== undefined
        ? toNullableBoolean(req.body.is_active, existing.is_active)
        : existing.is_active;

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
        nickname = $1,
        vin = $2,
        year = $3,
        make = $4,
        model = $5,
        standard_engine = $6,
        license_plate = $7,
        license_state = $8,
        registration_month = $9,
        registration_year = $10,
        oil_type = $11,
        oil_capacity_quarts = $12,
        oil_capacity_liters = $13,
        rockauto_url = $14,
        battery_installed_at = $15,
        lockbox_pin = $16,
        bouncie_vehicle_id = $17,
        dimo_token_id = $18,
        provider_vehicle_id = $19,
        external_vehicle_key = COALESCE($20, CASE WHEN $18::bigint IS NOT NULL THEN 'dimo:' || $18::text ELSE NULL END),
        turo_vehicle_id = $21,
        turo_vehicle_name = $22,
        onboarding_date = $23,
        acquisition_cost = $24,
        retired_at = $25,
        in_service = $26,
        is_active = $27,
        updated_at = NOW()
      WHERE id = $28
      RETURNING *
    `;

    const vehicleValues = [
      nickname,
      vin,
      year,
      make,
      model,
      standard_engine,
      license_plate,
      license_state,
      registration_month,
      registration_year,
      oil_type,
      oil_capacity_quarts,
      oil_capacity_liters,
      rockauto_url,
      battery_installed_at,
      lockbox_pin,
      bouncie_vehicle_id,
      dimo_token_id,
      provider_vehicle_id,
      external_vehicle_key,
      turo_vehicle_id,
      turo_vehicle_name,
      onboarding_date,
      acquisition_cost,
      retired_at,
      in_service,
      is_active,
      existing.id,
    ];

    const { rows } = await client.query(vehicleQuery, vehicleValues);
    const updatedVehicle = rows[0];

    const oldNickname = toNullableText(existing.nickname);
    const newNickname = toNullableText(updatedVehicle.nickname);
    if (oldNickname && oldNickname.toLowerCase() !== newNickname?.toLowerCase()) {
      await addVehicleAlias(client, updatedVehicle.id, oldNickname, "rename");
    }
    if (newNickname) {
      await client.query(
        `
          UPDATE vehicle_aliases
          SET active = false, updated_at = NOW()
          WHERE vehicle_id = $1
            AND source = 'canonical'
            AND lower(trim(alias)) <> lower(trim($2))
        `,
        [updatedVehicle.id, newNickname]
      );
    }
    await addVehicleAlias(client, updatedVehicle.id, newNickname, "canonical");

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

    if (existing.in_service !== updatedVehicle.in_service) {
      void pushPublicAvailabilitySnapshotSafe("vehicle service status changed");
    }

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
