// ------------------------------------------------------------
// /server/services/vehicles/statusFeed.js
// This service fetches the list of active vehicles from the database,
// retrieves live telemetry data for those vehicles from the Bouncie API,
// and combines the data into a unified feed that can be used by the frontend
// to display the current status of each vehicle in the fleet.
// ------------------------------------------------------------


const pool = require("../../db");
const { getVehicles } = require("../bouncie/client");
const { getBouncieStatusFeed } = require("../bouncie/statusFeed");
const { getDimoStatusFeed } = require("../dimo/statusFeed");

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
  const primary = bouncieVehicle || dimoVehicle || {};
  const fallback = dimoVehicle && bouncieVehicle ? dimoVehicle : null;
  const telemetrySource = [
    bouncieVehicle ? "bouncie" : null,
    dimoVehicle ? "dimo" : null,
  ].filter(Boolean);

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
    telemetry_source: telemetrySource,
    telemetry: mergeTelemetry(primary?.telemetry, fallback?.telemetry),
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

async function getCombinedVehicleStatusFeed() {
  const [dbVehiclesResult, bouncieVehicles, dimoVehicles] = await Promise.all([
    pool.query(`
      SELECT *
      FROM vehicles
      WHERE is_active = true
      ORDER BY nickname NULLS LAST, make, model
    `),
    getBouncieStatusFeed().catch((err) => {
      console.warn("Combined status: Bouncie feed unavailable:", err.message || err);
      return [];
    }),
    getDimoStatusFeed().catch((err) => {
      console.warn("Combined status: DIMO feed unavailable:", err.message || err);
      return [];
    }),
  ]);

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

module.exports = {
  getVehicleStatusFeed,
  getCombinedVehicleStatusFeed,
  getVehicleByVinOrNickname, 
  getVehicleBySelector
};
