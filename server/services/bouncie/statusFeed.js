const pool = require("../../db");
const { getVehicles } = require("./client");

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBooleanOrNull(value) {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function getVehicleLookupByVin() {
  const { rows } = await pool.query(`
    SELECT
      vin,
      imei,
      nickname,
      make,
      model,
      year,
      bouncie_vehicle_id
    FROM vehicles
  `);

  const lookup = new Map();

  for (const row of rows) {
    lookup.set(row.vin, row);
  }

  return lookup;
}

function buildBouncieVehicleUrl(bouncieVehicleId) {
  if (!bouncieVehicleId) return null;
  return `https://www.bouncie.app/vehicles/${bouncieVehicleId}/details`;
}

function mapVehicleStatus(vehicle, dbVehicle) {
  const model = vehicle?.model || {};
  const stats = vehicle?.stats || {};
  const location = stats?.location || {};
  const mil = stats?.mil || {};
  const battery = stats?.battery || {};

  const vin = vehicle?.vin || null;
  const imei = vehicle?.imei || null;

  const nickname = vehicle?.nickName || dbVehicle?.nickname || null;
  const make = model?.make || dbVehicle?.make || null;
  const modelName = model?.name || dbVehicle?.model || null;
  const year = toNumberOrNull(model?.year ?? dbVehicle?.year);
  const bouncieVehicleId = dbVehicle?.bouncie_vehicle_id || null;

  return {
    vin,
    imei,
    nickname,
    make,
    model: modelName,
    year,
    standard_engine: vehicle?.standardEngine || null,

    bouncie_vehicle_id: bouncieVehicleId,
    bouncie_url: buildBouncieVehicleUrl(bouncieVehicleId),

    telemetry: {
      local_time_zone: stats?.localTimeZone || null,
      last_comm: toIsoOrNull(stats?.lastUpdated),
      odometer: toNumberOrNull(stats?.odometer),
      fuel_level: toNumberOrNull(stats?.fuelLevel),

      engine_running: toBooleanOrNull(stats?.isRunning),
      speed: toNumberOrNull(stats?.speed),

      location: {
        lat: toNumberOrNull(location?.lat),
        lon: toNumberOrNull(location?.lon),
        heading: toNumberOrNull(location?.heading),
        address: location?.address || null,
      },

      mil: {
        mil_on:
          typeof mil?.milOn === "boolean" ? mil.milOn : null,
        last_updated: toIsoOrNull(mil?.lastUpdated),
        qualified_dtc_list: Array.isArray(mil?.qualifiedDtcList)
          ? mil.qualifiedDtcList
          : [],
      },

      battery: {
        status: battery?.status || null,
        last_updated: toIsoOrNull(battery?.lastUpdated),
      },
    },
  };
}

async function getBouncieStatusFeed() {
  const [vehicles, vehicleLookup] = await Promise.all([
    getVehicles(),
    getVehicleLookupByVin(),
  ]);

  if (!Array.isArray(vehicles)) {
    throw new Error("Bouncie vehicles response was not an array");
  }

  return vehicles.map((vehicle) => {
    const dbVehicle = vehicle?.vin ? vehicleLookup.get(vehicle.vin) : null;
    return mapVehicleStatus(vehicle, dbVehicle);
  });
}

module.exports = {
  getBouncieStatusFeed,
};