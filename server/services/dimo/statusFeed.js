const pool = require("../../db");
const collectDimoSnapshot = require("./collectDimoSnapshot");
const { getDimoFleetFromDb } = require("./client");

const LIVE_SIGNAL_MAX_AGE_MINUTES = 15;
const FUTURE_TELEMETRY_GRACE_MS = 5 * 60 * 1000;
const STATUS_FEED_CACHE_TTL_MS = Number(
  process.env.DIMO_STATUS_FEED_CACHE_TTL_MS || 30 * 1000
);

let dimoInProgress = false;
let cachedStatusFeed = null;
let cachedStatusFeedAt = 0;
let statusFeedInFlight = null;

function celsiusToFahrenheit(celsius) {
  if (celsius == null || celsius === "") return null;
  const num = Number(celsius);
  return Number.isFinite(num) ? (num * 9) / 5 + 32 : null;
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeEngineTempF(value) {
  const num = toNumberOrNull(value);
  if (num == null) return null;

  // DIMO integrations have historically reported some temperature signals in C
  // and some in F. Coolant values at or below 130 are treated as Celsius.
  return num <= 130 ? (num * 9) / 5 + 32 : num;
}

function firstNonNull(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function hasTimezoneDesignator(value) {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(String(value || "").trim());
}

function formatChicagoWallTime(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")}T${hour}:${part(
    "minute"
  )}:${part("second")}.000`;
}

function toNaiveWallTimeString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (part, size = 2) => String(part).padStart(size, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
      value.getDate()
    )}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(
      value.getSeconds()
    )}.${pad(value.getMilliseconds(), 3)}`;
  }

  const text = String(value).trim();
  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)/
  );
  if (match) {
    const time = match[2].includes(".") ? match[2] : `${match[2]}.000`;
    return `${match[1]}T${time}`;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace("Z", "");
}

function normalizeDisplayTimestamp(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "string" && hasTimezoneDesignator(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : formatChicagoWallTime(date);
  }

  const naiveWallTime = toNaiveWallTimeString(value);
  if (!naiveWallTime) return fallback;

  const nowWallTime = formatChicagoWallTime(new Date());
  const naiveWallDate = new Date(naiveWallTime);
  const nowWallDate = new Date(nowWallTime);

  if (
    !Number.isNaN(naiveWallDate.getTime()) &&
    !Number.isNaN(nowWallDate.getTime()) &&
    naiveWallDate.getTime() > nowWallDate.getTime() + FUTURE_TELEMETRY_GRACE_MS
  ) {
    return formatChicagoWallTime(new Date(`${naiveWallTime}Z`));
  }

  return naiveWallTime;
}

function getAgeMinutes(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function isFreshLiveSignal(value) {
  const ageMinutes = getAgeMinutes(value);
  return ageMinutes != null && ageMinutes <= LIVE_SIGNAL_MAX_AGE_MINUTES;
}

async function runDimo(reason = "interval") {
  if (dimoInProgress) {
    console.log(`Skipping DIMO snapshot (${reason}) because one is already running`);
    return;
  }

  dimoInProgress = true;
  const startedAt = Date.now();

  try {
    console.log(`Running DIMO snapshot (${reason})`);
    const summary = await collectDimoSnapshot();
    console.log(
      `DIMO fleet snapshot stored (${reason}) | total=${summary.total} succeeded=${summary.succeeded} degraded=${summary.degraded} failed=${summary.failed}`
    );
  } catch (err) {
    console.error(`DIMO snapshot failed (${reason}):`, err.message || err);
  } finally {
    console.log(
      `DIMO snapshot finished (${reason}) in ${Date.now() - startedAt}ms`
    );
    dimoInProgress = false;
  }
}

async function loadDimoStatusFeed() {
  const configuredFleet = await getDimoFleetFromDb();
  const source = "database";

  const activeTokenIds = configuredFleet
    .filter((vehicle) => vehicle.active !== false)
    .map((vehicle) => Number(vehicle.tokenId || vehicle.dimo_token_id))
    .filter((tokenId) => Number.isInteger(tokenId) && tokenId > 0);

  if (!activeTokenIds.length) {
    return [];
  }

  const sql = `
    WITH latest AS (
      SELECT DISTINCT ON (dimo_token_id)
        id,
        service_name,
        vin,
        nickname,
        make,
        model,
        year,
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
        battery_status,
        battery_last_updated,
        battery_voltage,
        battery_voltage_last_updated,
        vehicle_last_updated,
        captured_at,
        COALESCE(raw.raw_payload, s.raw_payload) AS raw_payload,
        local_time_zone,
        qualified_dtc_list,
        dimo_token_id,
        fuel_level_last_updated,
        odometer_last_updated,
        speed_last_updated,
        location_last_updated,
        heading_last_updated,
        ignition_last_updated,
        obd_plugged_in,
        obd_plugged_in_last_updated,
        dtc_count,
        distance_with_mil,
        coolant_temp,
        engine_rpm,
        throttle_position,
        runtime_minutes,
        def_level,
        first_seen.diagnostic_first_reported_at
      FROM vehicle_telemetry_snapshots s
      LEFT JOIN vehicle_telemetry_raw_payloads raw
        ON raw.snapshot_id = s.id
      LEFT JOIN LATERAL (
        SELECT MIN(COALESCE(hist.vehicle_last_updated, hist.mil_last_updated, hist.captured_at)) AS diagnostic_first_reported_at
        FROM vehicle_telemetry_snapshots hist
        WHERE hist.service_name = s.service_name
          AND hist.dimo_token_id = s.dimo_token_id
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
      WHERE s.service_name = 'dimo'
        AND s.dimo_token_id IS NOT NULL
        AND s.dimo_token_id = ANY($1::bigint[])
      ORDER BY dimo_token_id, captured_at DESC
    ),
    engine_temp AS (
      SELECT
        hist.dimo_token_id,
        jsonb_build_object(
          'min_f', MIN(
            CASE
              WHEN hist.coolant_temp <= 130 THEN hist.coolant_temp * 9 / 5 + 32
              ELSE hist.coolant_temp
            END
          ),
          'max_f', MAX(
            CASE
              WHEN hist.coolant_temp <= 130 THEN hist.coolant_temp * 9 / 5 + 32
              ELSE hist.coolant_temp
            END
          ),
          'sample_count', COUNT(*),
          'since', MIN(hist.captured_at),
          'last_overtemp_at', MAX(hist.captured_at) FILTER (
            WHERE CASE
              WHEN hist.coolant_temp <= 130 THEN hist.coolant_temp * 9 / 5 + 32
              ELSE hist.coolant_temp
            END >= 240
          )
        ) AS engine_temp_range
      FROM vehicle_telemetry_snapshots hist
      WHERE hist.service_name = 'dimo'
        AND hist.dimo_token_id = ANY($1::bigint[])
        AND hist.coolant_temp IS NOT NULL
        AND hist.captured_at >= NOW() - INTERVAL '14 days'
      GROUP BY hist.dimo_token_id
    ),
    engine_rpm AS (
      SELECT
        hist.dimo_token_id,
        jsonb_build_object(
          'max_rpm', MAX(
            COALESCE(
              (COALESCE(raw.raw_payload, hist.raw_payload) -> 'rpmHistory' ->> 'maxRpm')::numeric,
              hist.engine_rpm
            )
          ),
          'sample_count', COUNT(*),
          'since', MIN(hist.captured_at),
          'last_recorded_at', MAX(hist.captured_at)
        ) AS engine_rpm_range
      FROM vehicle_telemetry_snapshots hist
      LEFT JOIN vehicle_telemetry_raw_payloads raw
        ON raw.snapshot_id = hist.id
      WHERE hist.service_name = 'dimo'
        AND hist.dimo_token_id = ANY($1::bigint[])
        AND (
          hist.engine_rpm IS NOT NULL
          OR COALESCE(raw.raw_payload, hist.raw_payload) -> 'rpmHistory' ->> 'maxRpm' IS NOT NULL
        )
        AND hist.captured_at >= NOW() - INTERVAL '14 days'
      GROUP BY hist.dimo_token_id
    ),
    active_trips AS (
      SELECT DISTINCT ON (v.dimo_token_id)
        v.dimo_token_id,
        jsonb_build_object(
          'id', t.id,
          'guest_name', t.guest_name,
          'trip_start', t.trip_start,
          'trip_end', t.trip_end,
          'workflow_stage', t.workflow_stage,
          'max_speed_mph', t.max_speed_mph,
          'speed_over_80_count', t.speed_over_80_count
        ) AS active_trip
      FROM vehicles v
      JOIN trips t
        ON v.turo_vehicle_id IS NOT NULL
        AND t.turo_vehicle_id IS NOT NULL
        AND CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
      WHERE v.dimo_token_id = ANY($1::bigint[])
        AND COALESCE(t.workflow_stage, '') = 'in_progress'
        AND COALESCE(t.status, '') <> 'canceled'
        AND COALESCE(t.closed_out, false) = false
      ORDER BY v.dimo_token_id, t.trip_end DESC NULLS LAST, t.id DESC
    )
    SELECT
      latest.*,
      engine_temp.engine_temp_range,
      engine_rpm.engine_rpm_range,
      active_trips.active_trip
    FROM latest
    LEFT JOIN engine_temp
      ON engine_temp.dimo_token_id = latest.dimo_token_id
    LEFT JOIN engine_rpm
      ON engine_rpm.dimo_token_id = latest.dimo_token_id
    LEFT JOIN active_trips
      ON active_trips.dimo_token_id = latest.dimo_token_id
    ORDER BY latest.dimo_token_id
  `;

  const { rows } = await pool.query(sql, [activeTokenIds]);

  return rows.map((row) => {
    const rawSignals = row.raw_payload?.raw?.data?.signalsLatest || {};
    const preciseCoordinates = rawSignals.currentLocationCoordinates?.value || null;
    const approximateCoordinates =
      rawSignals.currentLocationApproximateCoordinates?.value || null;
    const coordinates = preciseCoordinates || approximateCoordinates || {};
    const latitude = firstNonNull(row.latitude, toNumberOrNull(coordinates.latitude));
    const longitude = firstNonNull(row.longitude, toNumberOrNull(coordinates.longitude));
    const heading = firstNonNull(
      row.heading,
      toNumberOrNull(rawSignals.currentLocationHeading?.value)
    );
    const altitude = toNumberOrNull(rawSignals.currentLocationAltitude?.value);
    const hdop = toNumberOrNull(coordinates.hdop);
    const locationLastUpdated = normalizeDisplayTimestamp(firstNonNull(
      row.location_last_updated,
      rawSignals.currentLocationCoordinates?.timestamp,
      rawSignals.currentLocationApproximateCoordinates?.timestamp
    ), row.captured_at);
    const headingLastUpdated = normalizeDisplayTimestamp(firstNonNull(
      row.heading_last_updated,
      rawSignals.currentLocationHeading?.timestamp
    ), row.captured_at);
    const ignitionLastUpdated = normalizeDisplayTimestamp(firstNonNull(
      row.ignition_last_updated,
      rawSignals.isIgnitionOn?.timestamp
    ), row.captured_at);
    const speedLastUpdated = normalizeDisplayTimestamp(firstNonNull(
      row.speed_last_updated,
      rawSignals.speed?.timestamp
    ), row.captured_at);
    const rpmLastUpdated = normalizeDisplayTimestamp(firstNonNull(
      rawSignals.powertrainCombustionEngineSpeed?.timestamp,
      ignitionLastUpdated
    ), row.captured_at);
    const ignitionFresh = isFreshLiveSignal(ignitionLastUpdated);
    const speedFresh = isFreshLiveSignal(speedLastUpdated);
    const rpmFresh = isFreshLiveSignal(rpmLastUpdated);
    const hasLocation = latitude != null && longitude != null;
    const missingPrivileges = Array.isArray(row.raw_payload?.missingPrivileges)
      ? row.raw_payload.missingPrivileges
      : [];
    const blockedSignals = Array.isArray(row.raw_payload?.blockedSignals)
      ? row.raw_payload.blockedSignals
      : [];

    return {
      vin: row.vin,
      nickname: row.nickname,
      make: row.make,
      model: row.model,
      year: row.year,
      dimo_token_id: row.dimo_token_id,
      active_trip: row.active_trip || null,
      telemetry: {
        active_trip: row.active_trip || null,
        local_time_zone: row.local_time_zone,
        last_comm: normalizeDisplayTimestamp(
          row.vehicle_last_updated || row.captured_at,
          row.captured_at
        ),
        odometer: row.odometer,
        fuel_level: row.fuel_level,
        engine_running: ignitionFresh ? row.is_running : null,
        speed: speedFresh ? row.speed : null,
        location: {
          lat: latitude,
          lon: longitude,
          heading,
          altitude,
          hdop,
          address: row.address,
          unavailable_reason: !hasLocation && missingPrivileges.includes("GetLocationHistory")
            ? "missing_privilege:GetLocationHistory"
            : null,
        },
        mil: {
          mil_on: row.mil_on,
          last_updated: normalizeDisplayTimestamp(
            row.mil_last_updated || row.vehicle_last_updated,
            row.captured_at
          ),
          qualified_dtc_list: row.qualified_dtc_list || [],
          dtc_count: row.dtc_count,
          distance_with_mil: row.distance_with_mil,
          first_reported_at: normalizeDisplayTimestamp(
            row.diagnostic_first_reported_at,
            row.captured_at
          ),
        },
        battery: {
          status: row.battery_status,
          voltage: row.battery_voltage,
          last_updated: row.battery_voltage_last_updated || row.battery_last_updated,
        },
        obd: {
          plugged_in: row.obd_plugged_in,
          last_updated: row.obd_plugged_in_last_updated,
          run_time_minutes: row.runtime_minutes,
        },
        engine: {
          coolant_temp: normalizeEngineTempF(row.coolant_temp),
          coolant_temp_raw: row.coolant_temp,
          coolant_temp_unit: "F",
          coolant_temp_range: row.engine_temp_range || null,
          overtemp: Boolean(
            row.engine_temp_range?.last_overtemp_at ||
              normalizeEngineTempF(row.coolant_temp) >= 240
          ),
          rpm: rpmFresh ? row.engine_rpm : null,
          rpm_range: row.engine_rpm_range || null,
          throttle_position: row.throttle_position,
        },
        diesel: {
          def_level: row.def_level,
        },
        environment: {
          exterior_air_temp: celsiusToFahrenheit(
            rawSignals.exteriorAirTemperature?.value
          ),
          exterior_air_temp_last_updated:
            rawSignals.exteriorAirTemperature?.timestamp ?? null,
        },
        timestamps: {
          fuel_level_last_updated: row.fuel_level_last_updated,
          odometer_last_updated: row.odometer_last_updated,
          speed_last_updated: speedLastUpdated,
          location_last_updated: locationLastUpdated,
          heading_last_updated: headingLastUpdated,
          ignition_last_updated: ignitionLastUpdated,
        },
        dimo: {
          degraded: Boolean(row.raw_payload?.degraded),
          degraded_reason: row.raw_payload?.degradedReason || null,
          config_source: source,
          missing_privileges: missingPrivileges,
          blocked_signals: blockedSignals,
          skipped_signals: row.raw_payload?.skippedSignals || [],
          requested_signals: row.raw_payload?.requestedSignals || [],
          available_signals_count: row.raw_payload?.availableSignalsCount ?? null,
          supported_signals_count: row.raw_payload?.supportedSignalsCount ?? null,
          live_signal_max_age_minutes: LIVE_SIGNAL_MAX_AGE_MINUTES,
          stale_signals: {
            ignition: !ignitionFresh,
            speed: !speedFresh,
            rpm: !rpmFresh,
          },
          signal_ages_minutes: {
            ignition: getAgeMinutes(ignitionLastUpdated),
            speed: getAgeMinutes(speedLastUpdated),
            rpm: getAgeMinutes(rpmLastUpdated),
          },
        },
      },
    };
  });
}

async function getDimoStatusFeed(options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (
    !force &&
    cachedStatusFeed &&
    now - cachedStatusFeedAt <= STATUS_FEED_CACHE_TTL_MS
  ) {
    return cachedStatusFeed;
  }

  if (statusFeedInFlight) {
    if (cachedStatusFeed) return cachedStatusFeed;
    return statusFeedInFlight;
  }

  statusFeedInFlight = loadDimoStatusFeed()
    .then((feed) => {
      cachedStatusFeed = feed;
      cachedStatusFeedAt = Date.now();
      return feed;
    })
    .finally(() => {
      statusFeedInFlight = null;
    });

  return statusFeedInFlight;
}

module.exports = {
  runDimo,
  getDimoStatusFeed,
};
