const pool = require("../../db");
const collectDimoSnapshot = require("./collectDimoSnapshot");
const { getDimoFleetFromEnv } = require("./client");

let dimoInProgress = false;

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

function firstNonNull(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
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

async function getDimoStatusFeed() {
  const activeTokenIds = getDimoFleetFromEnv()
    .filter((vehicle) => vehicle.active !== false)
    .map((vehicle) => Number(vehicle.tokenId))
    .filter((tokenId) => Number.isInteger(tokenId) && tokenId > 0);

  if (!activeTokenIds.length) {
    return [];
  }

  const sql = `
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
      raw_payload,
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
      def_level
    FROM vehicle_telemetry_snapshots
    WHERE service_name = 'dimo'
      AND dimo_token_id IS NOT NULL
      AND dimo_token_id = ANY($1::bigint[])
    ORDER BY dimo_token_id, captured_at DESC
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
    const locationLastUpdated = firstNonNull(
      row.location_last_updated,
      rawSignals.currentLocationCoordinates?.timestamp,
      rawSignals.currentLocationApproximateCoordinates?.timestamp
    );
    const headingLastUpdated = firstNonNull(
      row.heading_last_updated,
      rawSignals.currentLocationHeading?.timestamp
    );
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
      telemetry: {
        local_time_zone: row.local_time_zone,
        last_comm: row.vehicle_last_updated || row.captured_at,
        odometer: row.odometer,
        fuel_level: row.fuel_level,
        engine_running: row.is_running,
        speed: row.speed,
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
          last_updated: row.mil_last_updated,
          qualified_dtc_list: row.qualified_dtc_list || [],
          dtc_count: row.dtc_count,
          distance_with_mil: row.distance_with_mil,
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
          coolant_temp: row.coolant_temp,
          rpm: row.engine_rpm,
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
          speed_last_updated: row.speed_last_updated,
          location_last_updated: locationLastUpdated,
          heading_last_updated: headingLastUpdated,
          ignition_last_updated: row.ignition_last_updated,
        },
        dimo: {
          degraded: Boolean(row.raw_payload?.degraded),
          degraded_reason: row.raw_payload?.degradedReason || null,
          missing_privileges: missingPrivileges,
          blocked_signals: blockedSignals,
          skipped_signals: row.raw_payload?.skippedSignals || [],
          requested_signals: row.raw_payload?.requestedSignals || [],
          available_signals_count: row.raw_payload?.availableSignalsCount ?? null,
          supported_signals_count: row.raw_payload?.supportedSignalsCount ?? null,
        },
      },
    };
  });
}

module.exports = {
  runDimo,
  getDimoStatusFeed,
};
