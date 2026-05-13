const pool = require("../../db");

const DEFAULT_RADIUS_MILES = 0.15;
const DEFAULT_TIME_ZONE = "America/Chicago";

function cleanText(value) {
  if (value == null) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDateKey(value) {
  const text = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return text;
}

function toDateKey(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getMonthRange(monthValue) {
  const month = cleanText(monthValue);
  if (!/^\d{4}-\d{2}$/.test(month)) return null;

  const start = `${month}-01`;
  const end = addDays(
    new Date(`${start}T00:00:00Z`).toISOString().slice(0, 10),
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
  );

  return { start, end };
}

function getCurrentMonthRange() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return getMonthRange(month);
}

function getPeriodFromQuery(query = {}) {
  const monthRange = query.month ? getMonthRange(query.month) : null;
  if (query.month && !monthRange) {
    const err = new Error("month must be in YYYY-MM format");
    err.status = 400;
    throw err;
  }

  if (query.start && !parseDateKey(query.start)) {
    const err = new Error("start must be in YYYY-MM-DD format");
    err.status = 400;
    throw err;
  }

  if (query.end && !parseDateKey(query.end)) {
    const err = new Error("end must be in YYYY-MM-DD format");
    err.status = 400;
    throw err;
  }

  const defaultRange = getCurrentMonthRange();
  const start = parseDateKey(query.start) || monthRange?.start || defaultRange.start;
  const end =
    parseDateKey(query.end) ||
    monthRange?.end ||
    (query.start ? addDays(start, 1) : defaultRange.end);

  if (end <= start) {
    const err = new Error("end must be after start");
    err.status = 400;
    throw err;
  }

  return { start, end };
}

function getParkingSpotConfig() {
  const lat = toNumber(
    process.env.PARKING_SPOT_LAT ||
      process.env.FLEET_PARKING_LAT ||
      process.env.HOME_BASE_LAT
  );
  const lon = toNumber(
    process.env.PARKING_SPOT_LON ||
      process.env.PARKING_SPOT_LONGITUDE ||
      process.env.FLEET_PARKING_LON ||
      process.env.FLEET_PARKING_LONGITUDE ||
      process.env.HOME_BASE_LON ||
      process.env.HOME_BASE_LONGITUDE
  );
  const radiusMiles =
    toNumber(process.env.PARKING_SPOT_RADIUS_MILES) ??
    toNumber(process.env.FLEET_PARKING_RADIUS_MILES) ??
    DEFAULT_RADIUS_MILES;

  return {
    lat,
    lon,
    radiusMiles,
    label:
      cleanText(process.env.PARKING_SPOT_LABEL) ||
      cleanText(process.env.FLEET_PARKING_LABEL) ||
      "Parking Spot",
    enabled: lat != null && lon != null,
  };
}

function getPeriodDayCount(start, end) {
  return Math.round(
    (new Date(`${end}T00:00:00Z`).getTime() -
      new Date(`${start}T00:00:00Z`).getTime()) /
      86400000
  );
}

async function getParkingSpotUsage(options = {}) {
  const period = getPeriodFromQuery(options);
  const parking = getParkingSpotConfig();
  const timeZone = cleanText(options.timeZone) || DEFAULT_TIME_ZONE;
  const vehicleFilter = cleanText(options.vehicle);

  if (!parking.enabled) {
    const err = new Error("PARKING_SPOT_LAT and PARKING_SPOT_LON are required");
    err.status = 400;
    throw err;
  }

  const params = [
    period.start,
    period.end,
    parking.lat,
    parking.lon,
    parking.radiusMiles,
    timeZone,
    vehicleFilter || null,
  ];

  const { rows } = await pool.query(
    `
      WITH matched AS (
        SELECT
          v.id AS vehicle_id,
          COALESCE(NULLIF(trim(v.nickname), ''), v.vin, 'Vehicle ' || v.id::text) AS vehicle_name,
          v.vin,
          v.dimo_token_id,
          s.service_name,
          timezone($6, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date AS local_date,
          COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at,
          s.latitude,
          s.longitude,
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
          ) AS distance_miles
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
          AND COALESCE(v.is_active, true) = true
          AND timezone($6, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date >= $1::date
          AND timezone($6, COALESCE(
            s.location_last_updated,
            s.vehicle_last_updated,
            s.captured_at
          ) AT TIME ZONE 'UTC')::date < $2::date
          AND (
            $7::text IS NULL
            OR LOWER(v.vin) = LOWER($7::text)
            OR LOWER(v.nickname) = LOWER($7::text)
            OR v.id::text = $7::text
            OR v.dimo_token_id::text = $7::text
          )
      ),
      parked AS (
        SELECT *
        FROM matched
        WHERE distance_miles <= $5::double precision
      ),
      parked_days AS (
        SELECT
          vehicle_id,
          vehicle_name,
          vin,
          dimo_token_id,
          local_date,
          MIN(seen_at) AS first_seen_at,
          MAX(seen_at) AS last_seen_at,
          MIN(distance_miles) AS closest_distance_miles,
          array_agg(DISTINCT service_name ORDER BY service_name) AS sources,
          COUNT(*)::int AS sample_count
        FROM parked
        GROUP BY vehicle_id, vehicle_name, vin, dimo_token_id, local_date
      )
      SELECT
        vehicle_id,
        vehicle_name,
        vin,
        dimo_token_id,
        COUNT(*)::int AS parking_days,
        MIN(local_date) AS first_parking_day,
        MAX(local_date) AS last_parking_day,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'date', local_date,
              'firstSeenAt', first_seen_at,
              'lastSeenAt', last_seen_at,
              'closestDistanceMiles', ROUND(closest_distance_miles::numeric, 4),
              'sources', sources,
              'sampleCount', sample_count
            )
            ORDER BY local_date
          ),
          '[]'::jsonb
        ) AS days
      FROM parked_days
      GROUP BY vehicle_id, vehicle_name, vin, dimo_token_id
      ORDER BY vehicle_name
    `,
    params
  );

  const vehicles = rows.map((row) => ({
    vehicleId: row.vehicle_id,
    vehicleName: row.vehicle_name,
    vin: row.vin,
    dimoTokenId: row.dimo_token_id,
    parkingDays: Number(row.parking_days || 0),
    firstParkingDay: toDateKey(row.first_parking_day),
    lastParkingDay: toDateKey(row.last_parking_day),
    days: Array.isArray(row.days) ? row.days : [],
  }));

  const fleetVehicleDays = vehicles.reduce(
    (sum, vehicle) => sum + vehicle.parkingDays,
    0
  );
  const datesWithAnyVehicle = new Set(
    vehicles.flatMap((vehicle) => vehicle.days.map((day) => day.date))
  );

  return {
    ok: true,
    period: {
      start: period.start,
      end: period.end,
      endExclusive: true,
      days: getPeriodDayCount(period.start, period.end),
      timeZone,
    },
    parkingSpot: {
      label: parking.label,
      radiusMiles: parking.radiusMiles,
      configured: true,
    },
    summary: {
      vehicles: vehicles.length,
      fleetVehicleDays,
      daysWithAnyVehicle: datesWithAnyVehicle.size,
    },
    vehicles,
  };
}

module.exports = {
  getParkingSpotUsage,
  getParkingSpotConfig,
};
