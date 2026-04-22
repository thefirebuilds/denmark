const {
  fetchDimoAvailableSignals,
  fetchDimoEngineRpmSignals,
  fetchDimoSignalsLatest,
  fetchDimoVin,
  getDimoFleet,
} = require("./client");
const { getDimoVehicleAuthHeader } = require("./auth");
const pool = require("../../db");
const {
  ensureDefaultMaintenanceRulesForVehicle,
} = require("../maintenance/ruleTemplates");
const {
  maybeAutoStartReadyTripFromTelemetry,
} = require("../trips/autoStartReadyTrip");

let snapshotColumnCache = null;
let vehicleColumnCache = null;
let tripColumnCache = null;

const DIMO_RPM_HISTORY_INTERVAL = "5s";
const DEFAULT_RPM_HISTORY_LOOKBACK_MINUTES = 10;
const MAX_RPM_HISTORY_LOOKBACK_MINUTES = 24 * 60;

function cleanString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

async function getSnapshotColumns(client = pool) {
  if (snapshotColumnCache) return snapshotColumnCache;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'vehicle_telemetry_snapshots'
    `
  );

  snapshotColumnCache = new Set(result.rows.map((row) => row.column_name));
  return snapshotColumnCache;
}

async function getVehicleColumns(client = pool) {
  if (vehicleColumnCache) return vehicleColumnCache;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'vehicles'
    `
  );

  vehicleColumnCache = new Set(result.rows.map((row) => row.column_name));
  return vehicleColumnCache;
}

async function getTripColumns(client = pool) {
  if (tripColumnCache) return tripColumnCache;

  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'trips'
    `
  );

  tripColumnCache = new Set(result.rows.map((row) => row.column_name));
  return tripColumnCache;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function toBool(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getRpmHistoryLookbackMinutes() {
  const configured = toNumber(process.env.DIMO_RPM_HISTORY_LOOKBACK_MINUTES);
  if (configured == null || configured <= 0) {
    return DEFAULT_RPM_HISTORY_LOOKBACK_MINUTES;
  }
  return Math.min(configured, MAX_RPM_HISTORY_LOOKBACK_MINUTES);
}

function kmToMiles(km) {
  const num = toNumber(km);
  return num == null ? null : num * 0.621371;
}

function celsiusToFahrenheit(celsius) {
  const num = toNumber(celsius);
  return num == null ? null : (num * 9) / 5 + 32;
}

function parseDtcList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function newestTimestamp(...timestamps) {
  const valid = timestamps
    .filter(Boolean)
    .map((x) => new Date(x))
    .filter((d) => !Number.isNaN(d.getTime()));

  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime()))).toISOString();
}

function signalValue(signal) {
  if (signal == null) return null;
  if (typeof signal === "object" && Object.prototype.hasOwnProperty.call(signal, "value")) {
    return signal.value;
  }
  return signal;
}

function signalTimestamp(signal) {
  if (signal == null || typeof signal !== "object") return null;
  return cleanString(signal.timestamp);
}

function extractTypedValue(value) {
  if (value == null) {
    return {
      value_json: null,
      value_numeric: null,
      value_text: null,
      value_boolean: null,
    };
  }

  const valueType = typeof value;

  return {
    value_json: value,
    value_numeric: valueType === "number" && Number.isFinite(value) ? value : null,
    value_text:
      valueType === "string" || valueType === "number" || valueType === "boolean"
        ? String(value)
        : null,
    value_boolean: valueType === "boolean" ? value : toBool(value),
  };
}

function normalizeSignalValueForStorage(signalName, value) {
  if (signalName === "exteriorAirTemperature") {
    return celsiusToFahrenheit(value);
  }

  return value;
}

async function getLastKnownVinForToken(tokenId) {
  const result = await pool.query(
    `
      SELECT vin
      FROM vehicle_telemetry_snapshots
      WHERE service_name = 'dimo'
        AND dimo_token_id = $1
        AND vin IS NOT NULL
        AND vin <> ''
        AND vin !~* '^DIMO:'
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `,
    [tokenId]
  );

  return cleanString(result.rows[0]?.vin);
}

async function getLastDimoSnapshotCapturedAt(tokenId) {
  const result = await pool.query(
    `
      SELECT captured_at
      FROM vehicle_telemetry_snapshots
      WHERE service_name = 'dimo'
        AND dimo_token_id = $1
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `,
    [tokenId]
  );

  const capturedAt = result.rows[0]?.captured_at;
  if (!capturedAt) return null;

  const parsed = new Date(capturedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getRpmHistoryWindow(lastCapturedAt, capturedAt) {
  const to = new Date(capturedAt);
  const now = Number.isNaN(to.getTime()) ? new Date() : to;
  const defaultFrom = new Date(
    now.getTime() - getRpmHistoryLookbackMinutes() * 60 * 1000
  );

  let from = lastCapturedAt instanceof Date ? lastCapturedAt : defaultFrom;
  const maxFrom = new Date(now.getTime() - MAX_RPM_HISTORY_LOOKBACK_MINUTES * 60 * 1000);

  if (Number.isNaN(from.getTime())) {
    from = defaultFrom;
  }
  if (from < maxFrom) {
    from = maxFrom;
  }
  if (from >= now) {
    from = defaultFrom;
  }

  return {
    from: from.toISOString(),
    to: now.toISOString(),
  };
}

function summarizeRpmHistory(rawHistory) {
  const rows = Array.isArray(rawHistory?.data?.signals)
    ? rawHistory.data.signals
    : [];
  const rpmRows = rows
    .map((row) => ({
      timestamp: cleanString(row?.timestamp),
      rpm: toNumber(row?.powertrainCombustionEngineSpeed),
      speed: toNumber(row?.speed),
    }))
    .filter((row) => row.timestamp && row.rpm != null);

  if (!rpmRows.length) {
    return {
      sampleCount: rows.length,
      rpmSampleCount: 0,
      latestRpm: null,
      latestRpmAt: null,
      maxRpm: null,
      maxRpmAt: null,
    };
  }

  const latest = rpmRows[rpmRows.length - 1];
  const max = rpmRows.reduce((best, row) => (row.rpm > best.rpm ? row : best));

  return {
    sampleCount: rows.length,
    rpmSampleCount: rpmRows.length,
    latestRpm: latest.rpm,
    latestRpmAt: latest.timestamp,
    maxRpm: max.rpm,
    maxRpmAt: max.timestamp,
  };
}

async function fetchDimoRpmHistorySummary(tokenId, authHeader, capturedAt) {
  const lastCapturedAt = await getLastDimoSnapshotCapturedAt(tokenId);
  const window = getRpmHistoryWindow(lastCapturedAt, capturedAt);

  try {
    const raw = await fetchDimoEngineRpmSignals(tokenId, {
      authHeader,
      from: window.from,
      to: window.to,
      interval: DIMO_RPM_HISTORY_INTERVAL,
      filter: null,
    });

    return {
      ok: true,
      interval: DIMO_RPM_HISTORY_INTERVAL,
      window,
      ...summarizeRpmHistory(raw),
    };
  } catch (err) {
    return {
      ok: false,
      interval: DIMO_RPM_HISTORY_INTERVAL,
      window,
      error: err.message || String(err),
      sampleCount: 0,
      rpmSampleCount: 0,
      latestRpm: null,
      latestRpmAt: null,
      maxRpm: null,
      maxRpmAt: null,
    };
  }
}

async function resolveVin(tokenId, vehicleConfig, authHeader) {
  const vinLookup = await fetchDimoVin(tokenId, authHeader);
  if (vinLookup?.vin) {
    return {
      vin: vinLookup.vin,
      source: "vinVCLatest",
      degraded: false,
      missingPrivileges: vinLookup.missingPrivileges || [],
    };
  }

  const vinFromConfig = cleanString(vehicleConfig.vin);
  if (vinFromConfig) {
    return {
      vin: vinFromConfig,
      source: "config",
      degraded: Boolean(vinLookup?.degraded),
      missingPrivileges: vinLookup?.missingPrivileges || [],
    };
  }

  const vinFromDb = await getLastKnownVinForToken(tokenId);
  if (vinFromDb) {
    return {
      vin: vinFromDb,
      source: "database",
      degraded: Boolean(vinLookup?.degraded),
      missingPrivileges: vinLookup?.missingPrivileges || [],
    };
  }

  return {
    vin: null,
    source: "unavailable",
    degraded: Boolean(vinLookup?.degraded),
    missingPrivileges: vinLookup?.missingPrivileges || [],
  };
}

function normalizeDimoSnapshot(raw, vehicleConfig, options = {}) {
  const s = raw?.data?.signalsLatest ?? {};
  const odometerKm = signalValue(s.powertrainTransmissionTravelledDistance);
  const rpmHistory = options.rpmHistory || null;
  const fallbackLatestRpm =
    toNumber(signalValue(s.powertrainCombustionEngineSpeed));
  const seriesLatestRpm =
    rpmHistory?.latestRpm != null
      ? rpmHistory.latestRpm
      : fallbackLatestRpm;
  const rpmForStorage =
    rpmHistory?.maxRpm != null ? rpmHistory.maxRpm : seriesLatestRpm;
  const rpmForStorageAt =
    rpmHistory?.maxRpmAt ||
    rpmHistory?.latestRpmAt ||
    signalTimestamp(s.powertrainCombustionEngineSpeed);
  const coordinates =
    signalValue(s.currentLocationCoordinates) ||
    signalValue(s.currentLocationApproximateCoordinates) ||
    {};

  return {
    service_name: "dimo",
    vin: cleanString(vehicleConfig.vin),
    imei: null,
    nickname: cleanString(vehicleConfig.nickname),
    make: cleanString(vehicleConfig.make),
    model: cleanString(vehicleConfig.model),
    year: toNumber(vehicleConfig.year),
    standard_engine: cleanString(vehicleConfig.standard_engine),

    odometer: kmToMiles(odometerKm),
    fuel_level: toNumber(signalValue(s.powertrainFuelSystemRelativeLevel)),
    is_running: toBool(signalValue(s.isIgnitionOn)),
    speed: toNumber(signalValue(s.speed)),

    latitude: toNumber(coordinates.latitude),
    longitude: toNumber(coordinates.longitude),
    heading: toNumber(signalValue(s.currentLocationHeading)),
    address: null,

    mil_on:
      signalValue(s.obdStatusDTCCount) != null
        ? Number(signalValue(s.obdStatusDTCCount)) > 0
        : null,
    mil_last_updated: signalTimestamp(s.obdStatusDTCCount),

    battery_status: null,
    battery_last_updated: null,

    vehicle_last_updated: newestTimestamp(
      cleanString(s.lastSeen),
      signalTimestamp(s.speed),
      signalTimestamp(s.isIgnitionOn),
      signalTimestamp(s.currentLocationCoordinates),
      signalTimestamp(s.currentLocationHeading),
      signalTimestamp(s.powertrainTransmissionTravelledDistance),
      signalTimestamp(s.powertrainFuelSystemRelativeLevel),
      signalTimestamp(s.lowVoltageBatteryCurrentVoltage)
    ),

    raw_payload: {
      provider: "dimo",
      tokenId: vehicleConfig.tokenId,
      externalVehicleKey: vehicleConfig.external_vehicle_key,
      capturedAt: options.capturedAt,
      availableSignals: options.availableSignals || [],
      availableSignalsCount: options.availableSignalsCount ?? null,
      supportedSignalsCount: options.supportedSignalsCount ?? null,
      requestedSignals: options.requestedSignals || [],
      fetchedSignals: options.fetchedSignals || [],
      skippedSignals: options.skippedSignals || [],
      rpmHistory,
      blockedSignals: options.blockedSignals || [],
      missingPrivileges: options.missingPrivileges || [],
      degraded: Boolean(options.degraded),
      degradedReason: options.degradedReason || null,
      vinSource: options.vinSource || null,
      vehicleDefinition: vehicleConfig.vehicleDefinition || null,
      raw,
    },

    local_time_zone: "America/Chicago",
    qualified_dtc_list: parseDtcList(signalValue(s.obdDTCList)),

    dimo_token_id: vehicleConfig.tokenId,
    provider_vehicle_id: String(vehicleConfig.tokenId),
    external_vehicle_key: vehicleConfig.external_vehicle_key || `dimo:${vehicleConfig.tokenId}`,
    fuel_level_last_updated: signalTimestamp(s.powertrainFuelSystemRelativeLevel),
    odometer_last_updated: signalTimestamp(s.powertrainTransmissionTravelledDistance),
    speed_last_updated: signalTimestamp(s.speed),
    location_last_updated:
      signalTimestamp(s.currentLocationCoordinates) ||
      signalTimestamp(s.currentLocationApproximateCoordinates),
    heading_last_updated: signalTimestamp(s.currentLocationHeading),
    ignition_last_updated: signalTimestamp(s.isIgnitionOn),
    battery_voltage: toNumber(signalValue(s.lowVoltageBatteryCurrentVoltage)),
    battery_voltage_last_updated: signalTimestamp(s.lowVoltageBatteryCurrentVoltage),
    obd_plugged_in: toBool(signalValue(s.obdIsPluggedIn)),
    obd_plugged_in_last_updated: signalTimestamp(s.obdIsPluggedIn),
    dtc_count: toNumber(signalValue(s.obdStatusDTCCount)),
    distance_with_mil: toNumber(signalValue(s.obdDistanceWithMIL)),
    coolant_temp: toNumber(signalValue(s.powertrainCombustionEngineECT)),
    engine_rpm: rpmForStorage,
    engine_rpm_last_updated: rpmForStorageAt,
    engine_rpm_window_max: rpmHistory?.maxRpm ?? seriesLatestRpm,
    engine_rpm_window_max_at: rpmHistory?.maxRpmAt || rpmForStorageAt,
    throttle_position: toNumber(signalValue(s.powertrainCombustionEngineTPS)),
    runtime_minutes: toNumber(signalValue(s.obdRunTime)),
    def_level: toNumber(signalValue(s.powertrainCombustionEngineDieselExhaustFluidLevel)),
  };
}

async function upsertDimoVehicle(normalized, client = pool) {
  if (!normalized.vin) {
    return { rowCount: 0 };
  }

  const existingColumns = await getVehicleColumns(client);
  const currentOdometerMiles =
    normalized.odometer == null ? null : Math.round(Number(normalized.odometer));

  const fields = [
    ["vin", normalized.vin],
    ["imei", normalized.imei],
    ["nickname", normalized.nickname],
    ["make", normalized.make],
    ["model", normalized.model],
    ["year", normalized.year],
    ["standard_engine", normalized.standard_engine],
    ["current_odometer_miles", Number.isFinite(currentOdometerMiles) ? currentOdometerMiles : null],
    ["dimo_token_id", normalized.dimo_token_id],
    ["external_vehicle_key", normalized.external_vehicle_key],
    ["provider_vehicle_id", normalized.provider_vehicle_id],
    ["updated_at", new Date()],
  ].filter(([column]) => existingColumns.has(column));

  const columns = fields.map(([column]) => column);
  const values = fields.map(([, value]) => value);
  const placeholders = fields.map((_, index) => `$${index + 1}`);
  const updatableColumns = columns.filter((column) => column !== "vin");

  const assignments = updatableColumns.map((column) => {
    if (column === "updated_at") return "updated_at = NOW()";
    if (column === "current_odometer_miles") {
      return "current_odometer_miles = COALESCE(EXCLUDED.current_odometer_miles, vehicles.current_odometer_miles)";
    }
    return `${column} = COALESCE(EXCLUDED.${column}, vehicles.${column})`;
  });

  const sql = `
    INSERT INTO vehicles (${columns.join(", ")})
    VALUES (${placeholders.join(", ")})
    ON CONFLICT (vin)
    DO UPDATE SET
      ${assignments.join(",\n      ")}
  `;

  return client.query(sql, values);
}

async function insertDimoOdometerHistory(normalized, client = pool) {
  if (!normalized.vin || normalized.odometer == null) {
    return { rowCount: 0 };
  }

  const currentOdometerMiles = Math.round(Number(normalized.odometer));
  if (!Number.isFinite(currentOdometerMiles)) {
    return { rowCount: 0 };
  }

  return client.query(
    `
      INSERT INTO vehicle_odometer_history (
        vehicle_id,
        odometer_miles,
        recorded_at,
        source
      )
      SELECT
        v.id,
        $2,
        COALESCE($3::timestamp, NOW()),
        'dimo'
      FROM vehicles v
      LEFT JOIN LATERAL (
        SELECT h.odometer_miles
        FROM vehicle_odometer_history h
        WHERE h.vehicle_id = v.id
        ORDER BY h.recorded_at DESC
        LIMIT 1
      ) last_h ON true
      WHERE LOWER(v.vin) = LOWER($1)
        AND (
          last_h.odometer_miles IS NULL
          OR last_h.odometer_miles <> $2
        )
    `,
    [
      normalized.vin,
      currentOdometerMiles,
      normalized.vehicle_last_updated,
    ]
  );
}

async function insertVehicleTelemetrySnapshot(snapshot, client = pool) {
  const existingColumns = await getSnapshotColumns(client);
  const fields = [
    ["service_name", snapshot.service_name],
    ["vin", snapshot.vin],
    ["imei", snapshot.imei],
    ["nickname", snapshot.nickname],
    ["make", snapshot.make],
    ["model", snapshot.model],
    ["year", snapshot.year],
    ["standard_engine", snapshot.standard_engine],
    ["odometer", snapshot.odometer],
    ["fuel_level", snapshot.fuel_level],
    ["is_running", snapshot.is_running],
    ["speed", snapshot.speed],
    ["latitude", snapshot.latitude],
    ["longitude", snapshot.longitude],
    ["heading", snapshot.heading],
    ["address", snapshot.address],
    ["mil_on", snapshot.mil_on],
    ["mil_last_updated", snapshot.mil_last_updated],
    ["battery_status", snapshot.battery_status],
    ["battery_last_updated", snapshot.battery_last_updated],
    ["vehicle_last_updated", snapshot.vehicle_last_updated],
    ["raw_payload", JSON.stringify(snapshot.raw_payload), "::jsonb"],
    ["local_time_zone", snapshot.local_time_zone],
    ["qualified_dtc_list", JSON.stringify(snapshot.qualified_dtc_list), "::jsonb"],
    ["dimo_token_id", snapshot.dimo_token_id],
    ["provider_vehicle_id", snapshot.provider_vehicle_id],
    ["external_vehicle_key", snapshot.external_vehicle_key],
    ["fuel_level_last_updated", snapshot.fuel_level_last_updated],
    ["odometer_last_updated", snapshot.odometer_last_updated],
    ["speed_last_updated", snapshot.speed_last_updated],
    ["location_last_updated", snapshot.location_last_updated],
    ["heading_last_updated", snapshot.heading_last_updated],
    ["ignition_last_updated", snapshot.ignition_last_updated],
    ["battery_voltage", snapshot.battery_voltage],
    ["battery_voltage_last_updated", snapshot.battery_voltage_last_updated],
    ["obd_plugged_in", snapshot.obd_plugged_in],
    ["obd_plugged_in_last_updated", snapshot.obd_plugged_in_last_updated],
    ["dtc_count", snapshot.dtc_count],
    ["distance_with_mil", snapshot.distance_with_mil],
    ["coolant_temp", snapshot.coolant_temp],
    ["engine_rpm", snapshot.engine_rpm],
    ["throttle_position", snapshot.throttle_position],
    ["runtime_minutes", snapshot.runtime_minutes],
    ["def_level", snapshot.def_level],
  ].filter(([column]) => existingColumns.has(column));

  const columns = fields.map(([column]) => column);
  const values = fields.map(([, value]) => value);
  const placeholders = fields.map(([, , cast], index) => `$${index + 1}${cast || ""}`);

  const sql = `
    INSERT INTO vehicle_telemetry_snapshots (${columns.join(", ")})
    VALUES (${placeholders.join(", ")})
    RETURNING id, captured_at
  `;

  return client.query(sql, values);
}

async function updateActiveTripMaxEngineRpm(snapshot, client = pool) {
  const columns = await getTripColumns(client);
  if (!columns.has("max_engine_rpm")) {
    return { rowCount: 0 };
  }

  const rpm = toNumber(snapshot.engine_rpm_window_max ?? snapshot.engine_rpm);
  const vin = cleanString(snapshot.vin);
  if (!vin || rpm == null || rpm < 0) {
    return { rowCount: 0 };
  }

  const eventTimestamp =
    cleanString(snapshot.engine_rpm_window_max_at) ||
    cleanString(snapshot.engine_rpm_last_updated) ||
    cleanString(snapshot.vehicle_last_updated) ||
    cleanString(snapshot.ignition_last_updated) ||
    cleanString(snapshot.speed_last_updated) ||
    cleanString(snapshot.location_last_updated) ||
    new Date().toISOString();

  return client.query(
    `
      UPDATE trips t
      SET
        max_engine_rpm = GREATEST(COALESCE(t.max_engine_rpm, 0), $2::numeric),
        updated_at = NOW()
      FROM vehicles v
      WHERE v.vin = $1
        AND t.trip_start <= $3::timestamptz
        AND t.trip_end >= $3::timestamptz
        AND COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND (
          (
            t.turo_vehicle_id IS NOT NULL
            AND v.turo_vehicle_id IS NOT NULL
            AND CAST(t.turo_vehicle_id AS text) = CAST(v.turo_vehicle_id AS text)
          )
          OR (
            COALESCE(t.vehicle_name, '') <> ''
            AND LOWER(t.vehicle_name) = LOWER(v.nickname)
          )
        )
    `,
    [vin, rpm, eventTimestamp]
  );
}

function buildRawSignalRows({ snapshotId, capturedAt, tokenId, vin, raw }) {
  const latest = raw?.data?.signalsLatest || {};

  return Object.entries(latest)
    .filter(([, signal]) => signal !== undefined)
    .map(([signalName, signal]) => {
      const value = normalizeSignalValueForStorage(signalName, signalValue(signal));
      const typed = extractTypedValue(value);

      return {
        snapshot_id: snapshotId,
        captured_at: capturedAt,
        service_name: "dimo",
        dimo_token_id: tokenId,
        vin,
        signal_name: signalName,
        value_json: typed.value_json,
        value_numeric: typed.value_numeric,
        value_text: typed.value_text,
        value_boolean: typed.value_boolean,
        signal_timestamp:
          signalTimestamp(signal) ||
          (signalName === "lastSeen" ? cleanString(signal) : null),
      };
    });
}

async function insertVehicleTelemetrySignalValues(rows, client = pool) {
  if (!rows.length) {
    return { rowCount: 0 };
  }

  const columns = [
    "snapshot_id",
    "captured_at",
    "service_name",
    "dimo_token_id",
    "vin",
    "signal_name",
    "value_json",
    "value_numeric",
    "value_text",
    "value_boolean",
    "signal_timestamp",
  ];

  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const offset = rowIndex * columns.length;
    values.push(
      row.snapshot_id,
      row.captured_at,
      row.service_name,
      row.dimo_token_id,
      row.vin,
      row.signal_name,
      JSON.stringify(row.value_json),
      row.value_numeric,
      row.value_text,
      row.value_boolean,
      row.signal_timestamp
    );

    return `(${columns
      .map((column, columnIndex) => {
        const param = `$${offset + columnIndex + 1}`;
        return column === "value_json" ? `${param}::jsonb` : param;
      })
      .join(",")})`;
  });

  const sql = `
    INSERT INTO vehicle_telemetry_signal_values (
      ${columns.join(", ")}
    )
    VALUES ${placeholders.join(",")}
  `;

  return client.query(sql, values);
}

async function persistDimoTelemetry({ normalized, raw }) {
  const client = await pool.connect();

  await client.query("BEGIN");

  try {
    const vehicleResult = await upsertDimoVehicle(normalized, client);
    const autoStartResult = await maybeAutoStartReadyTripFromTelemetry(client, {
      serviceName: "dimo",
      vin: normalized.vin,
      dimoTokenId: normalized.dimo_token_id,
      isRunning: normalized.is_running,
      speed: normalized.speed,
      latitude: normalized.latitude,
      longitude: normalized.longitude,
      odometer:
        normalized.odometer == null ? null : Math.round(Number(normalized.odometer)),
      eventTimestamp:
        normalized.vehicle_last_updated ||
        normalized.ignition_last_updated ||
        normalized.location_last_updated ||
        normalized.speed_last_updated,
    });
    const snapshotResult = await insertVehicleTelemetrySnapshot(normalized, client);
    const tripRpmResult = await updateActiveTripMaxEngineRpm(normalized, client);
    const maintenanceRules = normalized.vin
      ? await ensureDefaultMaintenanceRulesForVehicle(client, normalized.vin)
      : [];
    const odometerResult = await insertDimoOdometerHistory(normalized, client);
    const snapshot = snapshotResult.rows[0];
    const rawRows = buildRawSignalRows({
      snapshotId: snapshot.id,
      capturedAt: snapshot.captured_at,
      tokenId: normalized.dimo_token_id,
      vin: normalized.vin,
      raw,
    });
    const rawResult = await insertVehicleTelemetrySignalValues(rawRows, client);

    await client.query("COMMIT");

    return {
      snapshotId: snapshot.id,
      capturedAt: snapshot.captured_at,
      vehicleRows: vehicleResult.rowCount,
      autoStartedTrip: autoStartResult?.id || null,
      tripRpmRows: tripRpmResult.rowCount,
      maintenanceRuleRows: maintenanceRules.length,
      odometerRows: odometerResult.rowCount,
      rawSignalRows: rawResult.rowCount,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function collectDimoVehicleSnapshot(vehicleConfig) {
  const tokenId = Number(vehicleConfig?.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    throw new Error("collectDimoVehicleSnapshot requires vehicleConfig.tokenId");
  }

  const startedAt = Date.now();
  const capturedAt = new Date().toISOString();
  const authHeader = await getDimoVehicleAuthHeader(tokenId);
  const availableSignals = await fetchDimoAvailableSignals(tokenId, authHeader);
  const raw = await fetchDimoSignalsLatest(tokenId, {
    authHeader,
    availableSignals,
  });
  const rpmHistory = await fetchDimoRpmHistorySummary(tokenId, authHeader, capturedAt);

  const vinResolution = await resolveVin(tokenId, vehicleConfig, authHeader);
  const mergedVehicleConfig = {
    ...vehicleConfig,
    tokenId,
    vin: vinResolution.vin,
    external_vehicle_key: vehicleConfig.external_vehicle_key || `dimo:${tokenId}`,
  };

  const normalized = normalizeDimoSnapshot(raw, mergedVehicleConfig, {
    capturedAt,
    availableSignals,
    availableSignalsCount: raw.meta?.availableSignalsCount ?? availableSignals.length,
    supportedSignalsCount: raw.meta?.supportedSignalsCount ?? null,
    requestedSignals: raw.meta?.requestedSignals || [],
    fetchedSignals: raw.meta?.fetchedSignals || [],
    skippedSignals: raw.meta?.skippedSignals || [],
    rpmHistory,
    blockedSignals: raw.meta?.blockedSignals || [],
    missingPrivileges: unique([
      ...(raw.meta?.missingPrivileges || []),
      ...(vinResolution.missingPrivileges || []),
    ]),
    degraded: Boolean(raw.meta?.degraded || vinResolution.degraded),
    degradedReason:
      raw.meta?.degradedReason ||
      (vinResolution.degraded ? "vin_unavailable_or_missing_privilege" : null),
    vinSource: vinResolution.source,
  });

  const persistResult = await persistDimoTelemetry({ normalized, raw });

  const summary = {
    ok: true,
    degraded: Boolean(normalized.raw_payload.degraded),
    tokenId,
    vin: normalized.vin,
    vinSource: vinResolution.source,
    nickname: normalized.nickname,
    make: normalized.make,
    model: normalized.model,
    year: normalized.year,
    availableSignalsCount: raw.meta?.availableSignalsCount ?? availableSignals.length,
    requestedSignalsCount: raw.meta?.requestedSignals?.length || 0,
    skippedSignals: normalized.raw_payload.skippedSignals,
    missingPrivileges: normalized.raw_payload.missingPrivileges,
    snapshotId: persistResult.snapshotId,
    vehicleRows: persistResult.vehicleRows,
    maintenanceRuleRows: persistResult.maintenanceRuleRows,
    odometerRows: persistResult.odometerRows,
    rawSignalRows: persistResult.rawSignalRows,
    durationMs: Date.now() - startedAt,
  };

  console.log(
    `[dimo] ${normalized.nickname || tokenId} ok | snapshot=${persistResult.snapshotId} signals=${summary.availableSignalsCount} rawRows=${persistResult.rawSignalRows} durationMs=${summary.durationMs}`
  );

  return {
    ok: true,
    degraded: summary.degraded,
    tokenId,
    vin: normalized.vin,
    nickname: normalized.nickname,
    make: normalized.make,
    model: normalized.model,
    year: normalized.year,
    availableSignalsCount: summary.availableSignalsCount,
    requestedSignalsCount: summary.requestedSignalsCount,
    skippedSignals: summary.skippedSignals,
    missingPrivileges: summary.missingPrivileges,
    summary,
    snapshot: normalized,
  };
}

async function collectDimoFleetSnapshots() {
  const startedAt = Date.now();
  const { fleet, sharedVehicles, localFleet } = await getDimoFleet();
  const results = [];

  console.log(
    `[dimo] fleet poll start | vehicles=${fleet.length} shared=${
      sharedVehicles?.totalCount ?? sharedVehicles?.nodes?.length ?? 0
    } localOverrides=${localFleet.length}`
  );

  for (const vehicle of fleet) {
    try {
      const result = await collectDimoVehicleSnapshot(vehicle);
      results.push(result);
    } catch (err) {
      const failure = {
        ok: false,
        degraded: false,
        tokenId: vehicle.tokenId,
        vin: vehicle.vin || null,
        nickname: vehicle.nickname || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
        year: vehicle.year || null,
        availableSignalsCount: 0,
        requestedSignalsCount: 0,
        skippedSignals: [],
        missingPrivileges: [],
        error: err.message || String(err),
        summary: {
          ok: false,
          degraded: false,
          tokenId: vehicle.tokenId,
          vin: vehicle.vin || null,
          nickname: vehicle.nickname || null,
          make: vehicle.make || null,
          model: vehicle.model || null,
          year: vehicle.year || null,
          availableSignalsCount: 0,
          requestedSignalsCount: 0,
          skippedSignals: [],
          missingPrivileges: [],
          error: err.message || String(err),
        },
      };

      console.error(
        `[dimo] ${vehicle.nickname || vehicle.tokenId} failed | ${failure.error}`
      );
      results.push(failure);
    }
  }

  const summary = {
    ok: results.every((result) => result.ok),
    total: results.length,
    succeeded: results.filter((result) => result.ok).length,
    degraded: results.filter((result) => result.ok && result.degraded).length,
    failed: results.filter((result) => !result.ok).length,
    durationMs: Date.now() - startedAt,
    vehicles: results.map((result) => result.summary),
  };

  console.log(
    `[dimo] fleet poll done | total=${summary.total} succeeded=${summary.succeeded} degraded=${summary.degraded} failed=${summary.failed} durationMs=${summary.durationMs}`
  );

  return summary;
}

module.exports = collectDimoFleetSnapshots;
module.exports.collectDimoFleetSnapshots = collectDimoFleetSnapshots;
module.exports.collectDimoVehicleSnapshot = collectDimoVehicleSnapshot;
module.exports.normalizeDimoSnapshot = normalizeDimoSnapshot;
module.exports.insertVehicleTelemetrySnapshot = insertVehicleTelemetrySnapshot;
module.exports.insertVehicleTelemetrySignalValues = insertVehicleTelemetrySignalValues;
