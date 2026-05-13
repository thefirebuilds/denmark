const pool = require("../../db");
const { getParkingSpotConfig } = require("../vehicles/parkingSpotUsage");
const {
  getCalendarDaysInRange,
  getDateRange,
  roundNumber,
  toNumber,
} = require("./metricHelpers");
const {
  getParkingEconomicsConfig,
  vehicleMatches,
} = require("./parkingMetricsService");

const DEFAULT_HOME_RADIUS_MILES = 0.15;
const DEFAULT_TIME_ZONE = "America/Chicago";
const DEFAULT_MAX_TRANSFER_HOURS = 1;
const DEFAULT_TRANSFER_MPG = 25;
const DEFAULT_FUEL_PRICE_PER_GALLON = 3.25;

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toOptionalNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toDateKey(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function toLocalDateKey(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseDateKey(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return text;
}

function addDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getMonthRange(monthValue) {
  const month = cleanText(monthValue);
  if (!/^\d{4}-\d{2}$/.test(month)) return null;

  const start = `${month}-01`;
  const daysInMonth = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)
  ).getUTCDate();

  return { start, end: addDateKeyDays(start, daysInMonth) };
}

function getMetricPeriod(options = {}) {
  const monthRange = options.month ? getMonthRange(options.month) : null;
  if (options.month && !monthRange) {
    const err = new Error("month must be in YYYY-MM format");
    err.status = 400;
    throw err;
  }

  if (options.start && !parseDateKey(options.start)) {
    const err = new Error("start must be in YYYY-MM-DD format");
    err.status = 400;
    throw err;
  }

  if (options.end && !parseDateKey(options.end)) {
    const err = new Error("end must be in YYYY-MM-DD format");
    err.status = 400;
    throw err;
  }

  if (monthRange || options.start || options.end) {
    const start = parseDateKey(options.start) || monthRange?.start;
    const end =
      parseDateKey(options.end) ||
      monthRange?.end ||
      (start ? addDateKeyDays(start, 1) : null);

    if (!start || !end || end <= start) {
      const err = new Error("end must be after start");
      err.status = 400;
      throw err;
    }

    return {
      key: options.month ? String(options.month) : "custom",
      start,
      end,
      endExclusive: true,
      days: Math.round(
        (new Date(`${end}T00:00:00Z`).getTime() -
          new Date(`${start}T00:00:00Z`).getTime()) /
          86400000
      ),
    };
  }

  const range = getDateRange(options.range || "30d");
  const startDate = range.startDate || new Date("2000-01-01T00:00:00");
  const endDate = range.endDate || new Date();

  return {
    key: range.key,
    start: toDateKey(startDate),
    end: toDateKey(addDays(endDate, 1)),
    endExclusive: true,
    days: getCalendarDaysInRange(startDate, endDate),
  };
}

function getHomeGeoConfig() {
  const lat = toNumber(
    process.env.HOME_SPOT_LAT ||
      process.env.HOME_SPOT_LAN ||
      process.env.HOME_BASE_LAT ||
      process.env.HOME_LAT ||
      process.env.FLEET_HOME_LAT
  );
  const lon = toNumber(
    process.env.HOME_SPOT_LON ||
      process.env.HOME_SPOT_LONGITUDE ||
      process.env.HOME_BASE_LON ||
      process.env.HOME_BASE_LONGITUDE ||
      process.env.HOME_LON ||
      process.env.HOME_LONGITUDE ||
      process.env.FLEET_HOME_LON ||
      process.env.FLEET_HOME_LONGITUDE
  );
  const radiusMiles =
    toOptionalNumber(process.env.HOME_SPOT_RADIUS_MILES) ??
    toOptionalNumber(process.env.HOME_BASE_RADIUS_MILES) ??
    toOptionalNumber(process.env.HOME_RADIUS_MILES) ??
    DEFAULT_HOME_RADIUS_MILES;

  return {
    lat,
    lon,
    radiusMiles,
    label:
      cleanText(process.env.HOME_SPOT_LABEL) ||
      cleanText(process.env.HOME_BASE_LABEL) ||
      cleanText(process.env.HOME_LABEL) ||
      "Home",
    configured: lat != null && lon != null,
  };
}

async function getActiveVehicles() {
  const { rows } = await pool.query(
    `
      SELECT
        id,
        COALESCE(NULLIF(trim(nickname), ''), vin, 'Vehicle ' || id::text) AS vehicle_name,
        vin,
        dimo_token_id,
        turo_vehicle_id,
        license_plate
      FROM vehicles
      WHERE COALESCE(is_active, true) = true
      ORDER BY vehicle_name
    `
  );

  return rows.map((row) => ({
    vehicleId: row.id,
    vehicleName: row.vehicle_name,
    vin: row.vin,
    dimoTokenId: row.dimo_token_id,
    turoVehicleId: row.turo_vehicle_id,
    licensePlate: row.license_plate,
  }));
}

function getTransponderVehicles(vehicles, config) {
  if (config.transponderVehicles.length) {
    return vehicles.filter((vehicle) =>
      vehicleMatches(vehicle, config.transponderVehicles)
    );
  }

  return vehicles.filter(
    (vehicle) => !vehicleMatches(vehicle, config.transponderExemptVehicles)
  );
}

async function getHomeParkingTransfers(options = {}) {
  const period = getMetricPeriod(
    typeof options === "string" ? { range: options } : options
  );
  const parking = getParkingSpotConfig();
  const home = getHomeGeoConfig();
  const config = getParkingEconomicsConfig();
  const timeZone = cleanText(process.env.PARKING_TRANSFER_TIME_ZONE) || DEFAULT_TIME_ZONE;
  const maxTransferHours = toNumber(
    process.env.PARKING_TRANSFER_MAX_HOURS,
    DEFAULT_MAX_TRANSFER_HOURS
  );
  const transferMpg = toNumber(process.env.PARKING_TRANSFER_MPG, DEFAULT_TRANSFER_MPG);
  const fuelPricePerGallon = toNumber(
    process.env.PARKING_TRANSFER_FUEL_PRICE_PER_GALLON,
    DEFAULT_FUEL_PRICE_PER_GALLON
  );

  if (!parking.enabled) {
    const err = new Error("PARKING_SPOT_LAT and PARKING_SPOT_LON are required");
    err.status = 400;
    throw err;
  }

  if (!home.configured) {
    const err = new Error("HOME_SPOT_LAN/HOME_SPOT_LAT and HOME_SPOT_LON are required");
    err.status = 400;
    throw err;
  }

  const activeVehicles = await getActiveVehicles();
  const transponderVehicles = getTransponderVehicles(activeVehicles, config);
  const vehicleIds = transponderVehicles.map((vehicle) => Number(vehicle.vehicleId));
  const oneWayMiles = haversineMiles(parking.lat, parking.lon, home.lat, home.lon);

  if (!vehicleIds.length) {
    return {
      ok: true,
      period,
      parkingSpot: parking,
      home,
      assumptions: {
        oneWayMiles: roundNumber(oneWayMiles, 2),
        mpg: transferMpg,
        fuelPricePerGallon,
        maxTransferHours,
      },
      summary: {
        transfers: 0,
        totalHours: 0,
        totalMiles: 0,
        estimatedGallons: 0,
        estimatedFuelCost: 0,
        homeToParking: 0,
        parkingToHome: 0,
        vehicles: 0,
      },
      vehicles: [],
      transfers: [],
    };
  }

  const { rows } = await pool.query(
    `
      WITH matched AS (
        SELECT
          v.id AS vehicle_id,
          COALESCE(NULLIF(trim(v.nickname), ''), v.vin, 'Vehicle ' || v.id::text) AS vehicle_name,
          v.vin,
          v.dimo_token_id,
          s.service_name,
          COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at,
          timezone($10, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date AS local_date,
          CASE
            WHEN (
              3958.8 * 2 * atan2(
                sqrt(
                  power(sin(radians((s.latitude::double precision - $3::double precision) / 2)), 2) +
                  cos(radians($3::double precision)) *
                  cos(radians(s.latitude::double precision)) *
                  power(sin(radians((s.longitude::double precision - $4::double precision) / 2)), 2)
                ),
                sqrt(
                  1 - (
                    power(sin(radians((s.latitude::double precision - $3::double precision) / 2)), 2) +
                    cos(radians($3::double precision)) *
                    cos(radians(s.latitude::double precision)) *
                    power(sin(radians((s.longitude::double precision - $4::double precision) / 2)), 2)
                  )
                )
              )
            ) <= $5::double precision THEN 'parking'
            WHEN (
              3958.8 * 2 * atan2(
                sqrt(
                  power(sin(radians((s.latitude::double precision - $6::double precision) / 2)), 2) +
                  cos(radians($6::double precision)) *
                  cos(radians(s.latitude::double precision)) *
                  power(sin(radians((s.longitude::double precision - $7::double precision) / 2)), 2)
                ),
                sqrt(
                  1 - (
                    power(sin(radians((s.latitude::double precision - $6::double precision) / 2)), 2) +
                    cos(radians($6::double precision)) *
                    cos(radians(s.latitude::double precision)) *
                    power(sin(radians((s.longitude::double precision - $7::double precision) / 2)), 2)
                  )
                )
              )
            ) <= $8::double precision THEN 'home'
            ELSE 'other'
          END AS zone
        FROM vehicle_telemetry_snapshots s
        JOIN vehicles v
          ON (
            s.vin IS NOT NULL
            AND s.vin <> ''
            AND v.vin IS NOT NULL
            AND LOWER(s.vin) = LOWER(v.vin)
          )
          OR (
            s.dimo_token_id IS NOT NULL
            AND v.dimo_token_id IS NOT NULL
            AND s.dimo_token_id = v.dimo_token_id
          )
          OR (
            s.external_vehicle_key IS NOT NULL
            AND v.external_vehicle_key IS NOT NULL
            AND s.external_vehicle_key = v.external_vehicle_key
          )
        WHERE s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
          AND v.id = ANY($9::int[])
          AND timezone($10, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date >= $1::date
          AND timezone($10, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date < $2::date
      ),
      endpoint_visits AS (
        SELECT *
        FROM matched
        WHERE zone IN ('home', 'parking')
      ),
      sequenced AS (
        SELECT
          endpoint_visits.*,
          CASE
            WHEN LAG(zone) OVER (
              PARTITION BY vehicle_id
              ORDER BY seen_at
            ) IS DISTINCT FROM zone THEN 1
            ELSE 0
          END AS starts_new_run
        FROM endpoint_visits
      ),
      run_marked AS (
        SELECT
          sequenced.*,
          SUM(starts_new_run) OVER (
            PARTITION BY vehicle_id
            ORDER BY seen_at
            ROWS UNBOUNDED PRECEDING
          ) AS run_id
        FROM sequenced
      ),
      zone_runs AS (
        SELECT
          vehicle_id,
          vehicle_name,
          vin,
          dimo_token_id,
          zone,
          run_id,
          MIN(seen_at) AS first_seen_at,
          MAX(seen_at) AS last_seen_at,
          (array_agg(local_date ORDER BY seen_at ASC))[1] AS local_date,
          (array_agg(service_name ORDER BY seen_at DESC))[1] AS service_name
        FROM run_marked
        GROUP BY vehicle_id, vehicle_name, vin, dimo_token_id, zone, run_id
      ),
      transfers AS (
        SELECT *
        FROM (
          SELECT
            vehicle_id,
            vehicle_name,
            vin,
            dimo_token_id,
            LAG(zone) OVER (
              PARTITION BY vehicle_id
              ORDER BY run_id
            ) AS from_zone,
            zone AS to_zone,
            LAG(last_seen_at) OVER (
              PARTITION BY vehicle_id
              ORDER BY run_id
            ) AS from_seen_at,
            first_seen_at AS to_seen_at,
            local_date,
            service_name
          FROM zone_runs
        ) run_transfers
      )
      SELECT *
      FROM transfers
      WHERE from_zone IN ('home', 'parking')
        AND to_zone IN ('home', 'parking')
        AND from_zone <> to_zone
        AND (
          $11::numeric IS NULL
          OR EXTRACT(EPOCH FROM (to_seen_at - from_seen_at)) / 3600.0 <= $11::numeric
        )
      ORDER BY to_seen_at DESC, vehicle_name ASC
    `,
    [
      period.start,
      period.end,
      parking.lat,
      parking.lon,
      parking.radiusMiles,
      home.lat,
      home.lon,
      home.radiusMiles,
      vehicleIds,
      timeZone,
      maxTransferHours,
    ]
  );

  const transfers = rows.map((row) => {
    const durationHours =
      row.from_seen_at && row.to_seen_at
        ? (new Date(row.to_seen_at).getTime() -
            new Date(row.from_seen_at).getTime()) /
          3600000
        : null;

    return {
      vehicleId: row.vehicle_id,
      vehicleName: row.vehicle_name,
      vin: row.vin,
      dimoTokenId: row.dimo_token_id,
      direction:
        row.from_zone === "home" && row.to_zone === "parking"
          ? "home_to_parking"
          : "parking_to_home",
      fromZone: row.from_zone,
      toZone: row.to_zone,
      fromSeenAt: row.from_seen_at,
      toSeenAt: row.to_seen_at,
      durationHours:
        durationHours == null || !Number.isFinite(durationHours)
          ? null
          : roundNumber(durationHours, 2),
      estimatedMiles: roundNumber(oneWayMiles, 2),
      estimatedGallons: roundNumber(oneWayMiles / Math.max(transferMpg, 1), 3),
      estimatedFuelCost: roundNumber(
        (oneWayMiles / Math.max(transferMpg, 1)) * fuelPricePerGallon,
        2
      ),
      localDate: toLocalDateKey(row.local_date),
      source: row.service_name,
    };
  });

  const vehicleSummaries = new Map();
  for (const transfer of transfers) {
    const key = String(transfer.vehicleId);
    if (!vehicleSummaries.has(key)) {
      vehicleSummaries.set(key, {
        vehicleId: transfer.vehicleId,
        vehicleName: transfer.vehicleName,
        transfers: 0,
        homeToParking: 0,
        parkingToHome: 0,
        totalHours: 0,
        totalMiles: 0,
        estimatedGallons: 0,
        estimatedFuelCost: 0,
        firstTransferAt: transfer.toSeenAt,
        lastTransferAt: transfer.toSeenAt,
      });
    }
    const summary = vehicleSummaries.get(key);
    summary.transfers += 1;
    if (transfer.direction === "home_to_parking") summary.homeToParking += 1;
    if (transfer.direction === "parking_to_home") summary.parkingToHome += 1;
    summary.totalHours += toNumber(transfer.durationHours);
    summary.totalMiles += toNumber(transfer.estimatedMiles);
    summary.estimatedGallons += toNumber(transfer.estimatedGallons);
    summary.estimatedFuelCost += toNumber(transfer.estimatedFuelCost);

    if (new Date(transfer.toSeenAt).getTime() < new Date(summary.firstTransferAt).getTime()) {
      summary.firstTransferAt = transfer.toSeenAt;
    }
    if (new Date(transfer.toSeenAt).getTime() > new Date(summary.lastTransferAt).getTime()) {
      summary.lastTransferAt = transfer.toSeenAt;
    }
  }

  const vehicles = Array.from(vehicleSummaries.values())
    .map((vehicle) => ({
      ...vehicle,
      totalHours: roundNumber(vehicle.totalHours, 2),
      totalMiles: roundNumber(vehicle.totalMiles, 2),
      estimatedGallons: roundNumber(vehicle.estimatedGallons, 2),
      estimatedFuelCost: roundNumber(vehicle.estimatedFuelCost, 2),
    }))
    .sort((a, b) => {
      if (b.transfers !== a.transfers) return b.transfers - a.transfers;
      return String(a.vehicleName).localeCompare(String(b.vehicleName));
    });
  const totalHours = transfers.reduce(
    (sum, item) => sum + toNumber(item.durationHours),
    0
  );
  const totalMiles = transfers.reduce(
    (sum, item) => sum + toNumber(item.estimatedMiles),
    0
  );
  const estimatedGallons = totalMiles / Math.max(transferMpg, 1);
  const estimatedFuelCost = estimatedGallons * fuelPricePerGallon;

  return {
    ok: true,
    period: {
      ...period,
      timeZone,
    },
    parkingSpot: {
      label: parking.label,
      radiusMiles: parking.radiusMiles,
      configured: parking.enabled,
    },
    home: {
      label: home.label,
      radiusMiles: home.radiusMiles,
      configured: home.configured,
    },
    assumptions: {
      oneWayMiles: roundNumber(oneWayMiles, 2),
      mpg: transferMpg,
      fuelPricePerGallon,
      maxTransferHours,
    },
    summary: {
      transfers: transfers.length,
      totalHours: roundNumber(totalHours, 2),
      totalMiles: roundNumber(totalMiles, 2),
      estimatedGallons: roundNumber(estimatedGallons, 2),
      estimatedFuelCost: roundNumber(estimatedFuelCost, 2),
      homeToParking: transfers.filter((item) => item.direction === "home_to_parking").length,
      parkingToHome: transfers.filter((item) => item.direction === "parking_to_home").length,
      vehicles: vehicles.length,
      transponderVehiclePool: vehicleIds.length,
      transfersPerVehicle: roundNumber(transfers.length / Math.max(1, vehicleIds.length), 2),
    },
    vehicles,
    transfers,
  };
}

module.exports = {
  getHomeGeoConfig,
  getHomeParkingTransfers,
};
