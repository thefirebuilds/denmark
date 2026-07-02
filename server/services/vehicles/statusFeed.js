// ------------------------------------------------------------
// /server/services/vehicles/statusFeed.js
// This service fetches the canonical fleet from the database, retrieves
// telemetry from available providers, and combines it into a source-aware feed
// for the frontend fleet status views.
// ------------------------------------------------------------


const pool = require("../../db");
const { getVehicles } = require("../bouncie/client");
const { getBouncieStatusFeed } = require("../bouncie/statusFeed");
const { getDimoStatusFeed } = require("../dimo/statusFeed");

const COMBINED_STATUS_CACHE_TTL_MS = Number(
  process.env.VEHICLE_STATUS_FEED_CACHE_TTL_MS || 30 * 1000
);
const CACHED_STATUS_CACHE_TTL_MS = Number(
  process.env.VEHICLE_CACHED_STATUS_FEED_CACHE_TTL_MS || 15 * 1000
);

let combinedStatusCache = null;
let combinedStatusCacheAt = 0;
let combinedStatusInFlight = null;
let cachedStatusCache = null;
let cachedStatusCacheAt = 0;
let cachedStatusInFlight = null;

function normalizeVehicleSelector(value) {
  return String(value || "").trim().toLowerCase();
}

async function getVehicleByVinOrNickname(selector) {
  const normalized = normalizeVehicleSelector(selector);

  const query = `
    SELECT *
    FROM vehicles
    WHERE lower(trim(vin)) = $1
       OR lower(trim(nickname)) = $1
    LIMIT 1
  `;

  const { rows } = await pool.query(query, [normalized]);
  return rows[0] || null;
}

function normalizePlate(value) {
  if (!value) return null;
  return String(value).trim().toUpperCase();
}

function buildRegistrationCode(month, year) {
  if (!month || !year) return null;
  return `${String(month).padStart(2, "0")}/${year}`;
}
function getAgeMinutes(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((Date.now() - d.getTime()) / 60000);
}

function getAgeDays(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function normalizeOdometer(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

function normalizeFuel(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.round(n);
}

function normalizeEngineTempF(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 130 ? (n * 9) / 5 + 32 : n;
}

function toTitleCase(value) {
  if (!value) return value;

  return String(value)
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeTelemetry(primary, fallback) {
  if (!fallback) return primary || null;
  if (!primary) return fallback;

  return {
    ...fallback,
    ...primary,
    location: {
      ...(fallback.location || {}),
      ...(primary.location || {}),
    },
    mil: {
      ...(fallback.mil || {}),
      ...(primary.mil || {}),
    },
    battery: {
      ...(fallback.battery || {}),
      ...(primary.battery || {}),
    },
    obd: {
      ...(fallback.obd || {}),
      ...(primary.obd || {}),
    },
    engine: {
      ...(fallback.engine || {}),
      ...(primary.engine || {}),
    },
    diesel: {
      ...(fallback.diesel || {}),
      ...(primary.diesel || {}),
    },
    environment: {
      ...(fallback.environment || {}),
      ...(primary.environment || {}),
    },
    timestamps: {
      ...(fallback.timestamps || {}),
      ...(primary.timestamps || {}),
    },
  };
}

function getTelemetryTimeMs(vehicle) {
  const telemetry = vehicle?.telemetry || {};
  const candidates = [
    telemetry.last_comm,
    telemetry.timestamps?.location_last_updated,
    telemetry.timestamps?.ignition_last_updated,
    telemetry.timestamps?.speed_last_updated,
    telemetry.timestamps?.vehicle_last_updated,
    telemetry.timestamps?.captured_at,
  ];

  for (const value of candidates) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) return time;
  }

  return 0;
}

function choosePrimaryTelemetryVehicle(bouncieVehicle, dimoVehicle) {
  if (!bouncieVehicle) return dimoVehicle || {};
  if (!dimoVehicle) return bouncieVehicle || {};

  const bouncieTime = getTelemetryTimeMs(bouncieVehicle);
  const dimoTime = getTelemetryTimeMs(dimoVehicle);

  return dimoTime > bouncieTime ? dimoVehicle : bouncieVehicle;
}

function getTelemetryProvider(vehicle) {
  if (!vehicle) return null;
  if (vehicle.dimo_token_id) return "dimo";
  if (vehicle.bouncie_vehicle_id || vehicle.bouncie_url) return "bouncie";
  return null;
}

function buildLiveVehicleKey(vehicle) {
  return (
    normalizeKey(vehicle?.turo_vehicle_id) ||
    normalizeKey(vehicle?.vin) ||
    normalizeKey(vehicle?.nickname) ||
    normalizeKey(vehicle?.dimo_token_id) ||
    normalizeKey(vehicle?.bouncie_vehicle_id) ||
    normalizeKey(vehicle?.imei)
  );
}

function buildLookupKeys(vehicle) {
  return [
    vehicle?.turo_vehicle_id,
    vehicle?.vin,
    vehicle?.nickname,
    vehicle?.dimo_token_id,
    vehicle?.bouncie_vehicle_id,
    vehicle?.imei,
  ]
    .map(normalizeKey)
    .filter(Boolean);
}

function indexVehicles(vehicles) {
  const index = new Map();

  for (const vehicle of vehicles || []) {
    for (const key of buildLookupKeys(vehicle)) {
      if (!index.has(key)) index.set(key, vehicle);
    }
  }

  return index;
}

function mergeVehicleTelemetry(baseVehicle, bouncieVehicle, dimoVehicle) {
  const primary = choosePrimaryTelemetryVehicle(bouncieVehicle, dimoVehicle);
  const fallback =
    primary === dimoVehicle
      ? bouncieVehicle || null
      : dimoVehicle || null;
  const activeTelemetrySource = getTelemetryProvider(primary);
  const telemetrySource = [
    activeTelemetrySource,
    activeTelemetrySource !== "bouncie" && bouncieVehicle ? "bouncie" : null,
    activeTelemetrySource !== "dimo" && dimoVehicle ? "dimo" : null,
  ].filter(Boolean);
  const telemetry = mergeTelemetry(primary?.telemetry, fallback?.telemetry);
  const currentOdometerMiles = normalizeOdometer(
    baseVehicle?.current_odometer_miles ??
      primary?.current_odometer_miles ??
      fallback?.current_odometer_miles
  );
  return {
    ...baseVehicle,
    ...primary,
    id: baseVehicle?.id ?? primary?.id ?? null,
    vin: baseVehicle?.vin || primary?.vin || fallback?.vin || null,
    imei: primary?.imei || baseVehicle?.imei || null,
    nickname: toTitleCase(
      baseVehicle?.nickname || primary?.nickname || fallback?.nickname || null
    ),
    year: baseVehicle?.year || primary?.year || fallback?.year || null,
    make: toTitleCase(baseVehicle?.make || primary?.make || fallback?.make || null),
    model: toTitleCase(baseVehicle?.model || primary?.model || fallback?.model || null),
    standard_engine:
      baseVehicle?.standard_engine ||
      primary?.standard_engine ||
      fallback?.standard_engine ||
      null,
    turo_vehicle_id:
      baseVehicle?.turo_vehicle_id ||
      primary?.turo_vehicle_id ||
      fallback?.turo_vehicle_id ||
      null,
    turo_vehicle_name:
      baseVehicle?.turo_vehicle_name ||
      primary?.turo_vehicle_name ||
      fallback?.turo_vehicle_name ||
      null,
    bouncie_vehicle_id:
      baseVehicle?.bouncie_vehicle_id || bouncieVehicle?.bouncie_vehicle_id || null,
    bouncie_url: bouncieVehicle?.bouncie_url || null,
    dimo_token_id: dimoVehicle?.dimo_token_id || null,
    dimo_active: Boolean(dimoVehicle),
    active_telemetry_source: activeTelemetrySource,
    telemetry_source: telemetrySource,
    current_odometer_miles: currentOdometerMiles,
    telemetry: telemetry
      ? {
          ...telemetry,
          odometer: normalizeOdometer(telemetry.odometer),
          source: activeTelemetrySource,
          fallback_sources: telemetrySource.filter(
            (source) => source !== activeTelemetrySource
          ),
        }
      : null,
  };
}

async function getVehicleBySelector(selector) {
  const normalized = normalizeVehicleSelector(selector);

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

async function getVehicleStatusFeed() {
  // DB vehicles (your canonical fleet)
  const dbVehicles = await pool.query(`
    SELECT *
    FROM vehicles
    WHERE is_active = true
    ORDER BY nickname NULLS LAST, make, model
  `);

  // Live telemetry from Bouncie
  const bouncieVehicles = await getVehicles();

  const bouncieByVin = new Map(
    (Array.isArray(bouncieVehicles) ? bouncieVehicles : [])
      .filter((v) => v?.vin)
      .map((v) => [v.vin, v])
  );

  const result = dbVehicles.rows.map((vehicle) => {
    const live = bouncieByVin.get(vehicle.vin) || null;

    const stats = live?.stats || {};
    const loc = stats?.location || {};
    const mil = stats?.mil || {};
    const battery = stats?.battery || {};

    return {
  id: vehicle.id,
  vin: vehicle.vin,
  imei: live?.imei || vehicle.imei,

  nickname: toTitleCase(vehicle.nickname || live?.nickName || null),
  year: vehicle.year || live?.model?.year || null,
  make: toTitleCase(vehicle.make || live?.model?.make || null),
  model: toTitleCase(vehicle.model || live?.model?.name || null),
  standard_engine: vehicle.standard_engine || live?.standardEngine || null,

  license_plate: normalizePlate(vehicle.license_plate),
  lockbox_pin: vehicle.lockbox_pin || null,
  lockbox_pin_public: vehicle.lockbox_pin_public !== false,
  lockboxPinPublic: vehicle.lockbox_pin_public !== false,

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

  bouncie_vehicle_id: vehicle.bouncie_vehicle_id,
  turo_vehicle_name: vehicle.turo_vehicle_name,
  turo_vehicle_id: vehicle.turo_vehicle_id,

  service_due: vehicle.service_due,

  telemetry: {
    local_time_zone: stats?.localTimeZone || null,
    last_comm: stats?.lastUpdated || null,
    last_comm_age_minutes: Math.max(0, getAgeMinutes(stats?.lastUpdated) ?? 0),

    odometer: normalizeOdometer(stats?.odometer),
    fuel_level: normalizeFuel(stats?.fuelLevel),
    has_fuel_level: stats?.fuelLevel !== undefined && stats?.fuelLevel !== null,

    engine_running: stats?.isRunning ?? null,
    speed: stats?.speed ?? null,

    location: {
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
      heading: loc?.heading ?? null,
      address: loc?.address || null,
      has_location: loc?.lat != null && loc?.lon != null,
      has_address: !!loc?.address,
    },

    mil: {
      mil_on: mil?.milOn ?? null,
      last_updated: mil?.lastUpdated || null,
      qualified_dtc_list: Array.isArray(mil?.qualifiedDtcList)
        ? mil.qualifiedDtcList
        : [],
      has_dtc:
        Array.isArray(mil?.qualifiedDtcList) &&
        mil.qualifiedDtcList.length > 0,
      dtc_count: Array.isArray(mil?.qualifiedDtcList)
        ? mil.qualifiedDtcList.length
        : 0,
    },

    battery: {
      status: battery?.status || null,
      last_updated: battery?.lastUpdated || null,
      age_days: getAgeDays(battery?.lastUpdated),
      is_stale: getAgeDays(battery?.lastUpdated) > 14,
    },
  },
};
  });
  return result;
}

async function loadCombinedVehicleStatusFeed() {
  const dbVehiclesResult = await pool.query(`
      SELECT *
      FROM vehicles
      WHERE is_active = true
      ORDER BY nickname NULLS LAST, make, model
    `);
  const bouncieVehicles = await getBouncieStatusFeed().catch((err) => {
    console.warn("Combined status: Bouncie feed unavailable:", err.message || err);
    return [];
  });
  const dimoVehicles = await getDimoStatusFeed().catch((err) => {
    console.warn("Combined status: DIMO feed unavailable:", err.message || err);
    return [];
  });

  const bouncieIndex = indexVehicles(bouncieVehicles);
  const dimoIndex = indexVehicles(dimoVehicles);
  const usedKeys = new Set();

  const rows = dbVehiclesResult.rows.map((vehicle) => {
    const keys = buildLookupKeys(vehicle);
    const bouncieVehicle = keys.map((key) => bouncieIndex.get(key)).find(Boolean);
    const dimoVehicle = keys.map((key) => dimoIndex.get(key)).find(Boolean);

    if (bouncieVehicle) {
      buildLookupKeys(bouncieVehicle).forEach((key) => usedKeys.add(`b:${key}`));
    }
    if (dimoVehicle) {
      buildLookupKeys(dimoVehicle).forEach((key) => usedKeys.add(`d:${key}`));
    }

    return mergeVehicleTelemetry(vehicle, bouncieVehicle, dimoVehicle);
  });

  for (const vehicle of bouncieVehicles || []) {
    const key = buildLiveVehicleKey(vehicle);
    if (!key || usedKeys.has(`b:${key}`)) continue;
    rows.push(mergeVehicleTelemetry(null, vehicle, null));
  }

  for (const vehicle of dimoVehicles || []) {
    const key = buildLiveVehicleKey(vehicle);
    if (!key || usedKeys.has(`d:${key}`)) continue;
    rows.push(mergeVehicleTelemetry(null, null, vehicle));
  }

  return rows;
}

async function getCombinedVehicleStatusFeed(options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (
    !force &&
    combinedStatusCache &&
    now - combinedStatusCacheAt <= COMBINED_STATUS_CACHE_TTL_MS
  ) {
    return combinedStatusCache;
  }

  if (combinedStatusInFlight) {
    if (combinedStatusCache) return combinedStatusCache;
    return combinedStatusInFlight;
  }

  combinedStatusInFlight = loadCombinedVehicleStatusFeed()
    .then((feed) => {
      combinedStatusCache = feed;
      combinedStatusCacheAt = Date.now();
      return feed;
    })
    .finally(() => {
      combinedStatusInFlight = null;
    });

  return combinedStatusInFlight;
}

async function loadCachedVehicleStatusFeed() {
  const { rows } = await pool.query(`
    SELECT
      v.*,
      latest.service_name AS telemetry_service_name,
      latest.odometer AS telemetry_odometer,
      latest.fuel_level,
      latest.is_running,
      latest.speed,
      latest.latitude,
      latest.longitude,
      latest.heading,
      latest.address,
      latest.mil_on,
      latest.mil_last_updated,
      latest.diagnostic_first_reported_at,
      latest.qualified_dtc_list,
      latest.battery_status,
      latest.battery_last_updated,
      latest.battery_voltage,
      latest.battery_voltage_last_updated,
      latest.vehicle_last_updated,
      latest.captured_at AS telemetry_captured_at,
      latest.local_time_zone,
      latest.engine_rpm,
      latest.coolant_temp,
      COALESCE(latest_raw.raw_payload, latest.raw_payload) AS raw_payload,
      canonical_alias.alias AS canonical_nickname,
      NULL::jsonb AS engine_temp_range,
      NULL::jsonb AS engine_rpm_range
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT va.alias
      FROM vehicle_aliases va
      WHERE va.vehicle_id = v.id
        AND va.active = true
        AND va.source = 'canonical'
      ORDER BY va.updated_at DESC, va.created_at DESC, va.id DESC
      LIMIT 1
    ) canonical_alias ON true
    LEFT JOIN LATERAL (
      SELECT
        id,
        service_name,
        odometer,
        fuel_level,
        is_running,
        speed,
        latitude,
        longitude,
        heading,
        address,
        mil_on,
        mil_last_updated,
        first_seen.diagnostic_first_reported_at,
        qualified_dtc_list,
        battery_status,
        battery_last_updated,
        battery_voltage,
        battery_voltage_last_updated,
        vehicle_last_updated,
        captured_at,
        local_time_zone,
        engine_rpm,
        coolant_temp,
        raw_payload
      FROM vehicle_telemetry_snapshots s
      LEFT JOIN LATERAL (
        SELECT MIN(COALESCE(hist.vehicle_last_updated, hist.mil_last_updated, hist.captured_at)) AS diagnostic_first_reported_at
        FROM vehicle_telemetry_snapshots hist
        WHERE hist.service_name = s.service_name
          AND hist.vin IS NOT NULL
          AND hist.vin <> ''
          AND LOWER(hist.vin) = LOWER(s.vin)
          AND hist.captured_at >= NOW() - INTERVAL '24 hours'
          AND (
            COALESCE(hist.mil_on, false) = true
            OR COALESCE(hist.dtc_count, 0) > 0
            OR (
              jsonb_typeof(COALESCE(hist.qualified_dtc_list, '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(hist.qualified_dtc_list, '[]'::jsonb)) > 0
            )
          )
      ) first_seen ON true
      WHERE s.vin IS NOT NULL
        AND s.vin <> ''
        AND LOWER(s.vin) = LOWER(v.vin)
      ORDER BY COALESCE(s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN vehicle_telemetry_raw_payloads latest_raw
      ON latest_raw.snapshot_id = latest.id
    WHERE v.is_active = true
    ORDER BY v.nickname NULLS LAST, v.make, v.model
  `);

  return rows.map((vehicle) => {
    const telemetry = {
      local_time_zone: vehicle.local_time_zone || null,
      last_comm: vehicle.vehicle_last_updated || vehicle.telemetry_captured_at || null,
      odometer: normalizeOdometer(vehicle.telemetry_odometer),
      fuel_level: normalizeFuel(vehicle.fuel_level),
      engine_running:
        typeof vehicle.is_running === "boolean" ? vehicle.is_running : null,
      speed: vehicle.speed == null ? null : Number(vehicle.speed),
      location: {
        lat: vehicle.latitude == null ? null : Number(vehicle.latitude),
        lon: vehicle.longitude == null ? null : Number(vehicle.longitude),
        heading: vehicle.heading == null ? null : Number(vehicle.heading),
        address: vehicle.address || null,
      },
      mil: {
        mil_on:
          typeof vehicle.mil_on === "boolean" ? vehicle.mil_on : null,
        last_updated: vehicle.mil_last_updated || null,
        first_reported_at: vehicle.diagnostic_first_reported_at || null,
        qualified_dtc_list:
          Number(vehicle.dtc_count ?? 0) === 0
            ? []
            : Array.isArray(vehicle.qualified_dtc_list)
          ? vehicle.qualified_dtc_list
          : [],
        dtc_count: Number(vehicle.dtc_count ?? 0),
      },
      battery: {
        status: vehicle.battery_status || null,
        voltage:
          vehicle.battery_voltage == null ? null : Number(vehicle.battery_voltage),
        last_updated:
          vehicle.battery_voltage_last_updated ||
          vehicle.battery_last_updated ||
          null,
      },
      engine: {
        coolant_temp: normalizeEngineTempF(vehicle.coolant_temp),
        coolant_temp_raw: vehicle.coolant_temp,
        coolant_temp_unit: "F",
        coolant_temp_range: vehicle.engine_temp_range || null,
        overtemp: Boolean(
          vehicle.engine_temp_range?.last_overtemp_at ||
            normalizeEngineTempF(vehicle.coolant_temp) >= 240
        ),
        rpm: vehicle.engine_rpm == null ? null : Number(vehicle.engine_rpm),
        rpm_range: vehicle.engine_rpm_range || null,
      },
      timestamps: {
        captured_at: vehicle.telemetry_captured_at || null,
        vehicle_last_updated: vehicle.vehicle_last_updated || null,
      },
      source: vehicle.telemetry_service_name || null,
    };

    return {
      ...vehicle,
      nickname: toTitleCase(vehicle.canonical_nickname || vehicle.nickname || null),
      make: toTitleCase(vehicle.make || null),
      model: toTitleCase(vehicle.model || null),
      current_odometer_miles: normalizeOdometer(
        vehicle.current_odometer_miles ?? telemetry.odometer
      ),
      telemetry_source: vehicle.telemetry_service_name
        ? [vehicle.telemetry_service_name]
        : [],
      telemetry,
    };
  });
}

async function getCachedVehicleStatusFeed(options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (
    !force &&
    cachedStatusCache &&
    now - cachedStatusCacheAt <= CACHED_STATUS_CACHE_TTL_MS
  ) {
    return cachedStatusCache;
  }

  if (cachedStatusInFlight) {
    if (cachedStatusCache) return cachedStatusCache;
    return cachedStatusInFlight;
  }

  cachedStatusInFlight = loadCachedVehicleStatusFeed()
    .then((feed) => {
      cachedStatusCache = feed;
      cachedStatusCacheAt = Date.now();
      return feed;
    })
    .finally(() => {
      cachedStatusInFlight = null;
    });

  return cachedStatusInFlight;
}

module.exports = {
  getVehicleStatusFeed,
  getCombinedVehicleStatusFeed,
  getCachedVehicleStatusFeed,
  getVehicleByVinOrNickname, 
  getVehicleBySelector
};
