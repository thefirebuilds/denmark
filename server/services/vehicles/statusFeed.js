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
  lockbox_pin: vehicle.lockbox_pin || null,

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

async function getCachedVehicleStatusFeed() {
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
      latest.raw_payload,
      NULL::jsonb AS engine_temp_range,
      NULL::jsonb AS engine_rpm_range
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT
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
      WHERE s.vin IS NOT NULL
        AND s.vin <> ''
        AND LOWER(s.vin) = LOWER(v.vin)
      ORDER BY COALESCE(s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) latest ON true
    WHERE v.is_active = true
    ORDER BY v.nickname NULLS LAST, v.make, v.model
  `);

  return rows.map((vehicle) => {
    const telemetry = {
      local_time_zone: vehicle.local_time_zone || null,
      last_comm: vehicle.vehicle_last_updated || vehicle.telemetry_captured_at || null,
      odometer: normalizeOdometer(
        vehicle.telemetry_odometer ?? vehicle.current_odometer_miles
      ),
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
        qualified_dtc_list: Array.isArray(vehicle.qualified_dtc_list)
          ? vehicle.qualified_dtc_list
          : [],
        dtc_count: Array.isArray(vehicle.qualified_dtc_list)
          ? vehicle.qualified_dtc_list.length
          : 0,
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
      nickname: toTitleCase(vehicle.nickname || null),
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

module.exports = {
  getVehicleStatusFeed,
  getCombinedVehicleStatusFeed,
  getCachedVehicleStatusFeed,
  getVehicleByVinOrNickname, 
  getVehicleBySelector
};
