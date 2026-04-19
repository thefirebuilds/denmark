const pool = require("../../db");
const { getVehicles } = require("./client");
const {
  maybeAutoStartReadyTripFromTelemetry,
} = require("../trips/autoStartReadyTrip");

function toIntegerOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function toTitleCase(value) {
  if (!value) return null;

  return String(value)
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolOrNull(value) {
  if (value === undefined || value === null) return null;
  return Boolean(value);
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeVehicle(vehicle) {
  const model = vehicle?.model || {};
  const stats = vehicle?.stats || {};
  const location = stats?.location || {};
  const mil = stats?.mil || {};
  const battery = stats?.battery || {};

  return {
    vin: vehicle?.vin || null,
    imei: vehicle?.imei || null,
    nickname: vehicle?.nickName || null,
    make: toTitleCase(model?.make),
    model: model?.name || null,
    year: toNumberOrNull(model?.year),
    standard_engine: vehicle?.standardEngine || null,
    bouncie_vehicle_id: vehicle?.id ? String(vehicle.id) : null,

    local_time_zone: stats?.localTimeZone || null,

    odometer: toNumberOrNull(stats?.odometer),
    current_odometer_miles: toIntegerOrNull(stats?.odometer),
    fuel_level: toNumberOrNull(stats?.fuelLevel),
    is_running: toBoolOrNull(stats?.isRunning),
    speed: toNumberOrNull(stats?.speed),

    latitude: toNumberOrNull(location?.lat),
    longitude: toNumberOrNull(location?.lon),
    heading: toNumberOrNull(location?.heading),
    address: location?.address || null,

    mil_on: toBoolOrNull(mil?.milOn),
    mil_last_updated: toTimestampOrNull(mil?.lastUpdated),
    qualified_dtc_list: Array.isArray(mil?.qualifiedDtcList)
      ? mil.qualifiedDtcList
      : [],

    battery_status: battery?.status || null,
    battery_last_updated: toTimestampOrNull(battery?.lastUpdated),

    vehicle_last_updated: toTimestampOrNull(stats?.lastUpdated),

    raw_payload: vehicle || {},
  };
}

async function insertOdometerHistory(client, snapshot) {
  if (!snapshot.vin || snapshot.current_odometer_miles == null) return;

  await client.query(
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
        'bouncie'
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
      snapshot.vin,
      snapshot.current_odometer_miles,
      snapshot.vehicle_last_updated,
    ]
  );
}

async function upsertVehicle(client, snapshot) {
  await client.query(
    `
      INSERT INTO vehicles (
        vin,
        imei,
        nickname,
        make,
        model,
        year,
        standard_engine,
        bouncie_vehicle_id,
        current_odometer_miles,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (vin)
      DO UPDATE SET
        imei = EXCLUDED.imei,
        nickname = EXCLUDED.nickname,
        make = EXCLUDED.make,
        model = EXCLUDED.model,
        year = EXCLUDED.year,
        standard_engine = EXCLUDED.standard_engine,
        bouncie_vehicle_id = COALESCE(EXCLUDED.bouncie_vehicle_id, vehicles.bouncie_vehicle_id),
        current_odometer_miles = COALESCE(EXCLUDED.current_odometer_miles, vehicles.current_odometer_miles),
        updated_at = NOW()
    `,
    [
      snapshot.vin,
      snapshot.imei,
      snapshot.nickname,
      snapshot.make,
      snapshot.model,
      snapshot.year,
      snapshot.standard_engine,
      snapshot.bouncie_vehicle_id,
      snapshot.current_odometer_miles,
    ]
  );
}

async function insertSnapshot(client, snapshot) {
  await client.query(
    `
      INSERT INTO vehicle_telemetry_snapshots (
        service_name,
        vin,
        imei,
        nickname,
        make,
        model,
        year,
        standard_engine,
        local_time_zone,
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
        vehicle_last_updated,
        raw_payload
      )
      VALUES (
        'bouncie',
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23
      )
    `,
    [
      snapshot.vin,
      snapshot.imei,
      snapshot.nickname,
      snapshot.make,
      snapshot.model,
      snapshot.year,
      snapshot.standard_engine,
      snapshot.local_time_zone,
      snapshot.odometer,
      snapshot.fuel_level,
      snapshot.is_running,
      snapshot.speed,
      snapshot.latitude,
      snapshot.longitude,
      snapshot.heading,
      snapshot.address,
      snapshot.mil_on,
      snapshot.mil_last_updated,
      snapshot.qualified_dtc_list,
      snapshot.battery_status,
      snapshot.battery_last_updated,
      snapshot.vehicle_last_updated,
      JSON.stringify(snapshot.raw_payload),
    ]
  );
}

function looksLikeRealTripStart(snapshot) {
  const speed = Number(snapshot?.speed || 0);
  return snapshot?.is_running === true || speed > 5;
}

async function findEligibleReadyTrip(client, snapshot) {
  if (!snapshot?.vin) return null;

  const vehicleResult = await client.query(
    `
      SELECT
        id,
        vin,
        nickname,
        turo_vehicle_id
      FROM vehicles
      WHERE LOWER(vin) = LOWER($1)
      LIMIT 1
    `,
    [snapshot.vin]
  );

  const dbVehicle = vehicleResult.rows[0];
  if (!dbVehicle?.turo_vehicle_id) return null;

  const eventTs = snapshot.vehicle_last_updated || new Date().toISOString();

  const tripResult = await client.query(
    `
      SELECT
        id,
        reservation_id,
        vehicle_name,
        guest_name,
        trip_start,
        trip_end,
        workflow_stage,
        starting_odometer,
        ending_odometer,
        closed_out,
        completed_at,
        canceled_at,
        turo_vehicle_id
      FROM trips
      WHERE CAST(turo_vehicle_id AS text) = $1
        AND workflow_stage = 'ready_for_handoff'
        AND canceled_at IS NULL
        AND completed_at IS NULL
        AND COALESCE(closed_out, false) = false
        AND trip_start IS NOT NULL
        AND $2::timestamptz >= trip_start - INTERVAL '2 hours'
        AND $2::timestamptz <= trip_start + INTERVAL '12 hours'
      ORDER BY trip_start ASC
      LIMIT 2
    `,
    [String(dbVehicle.turo_vehicle_id), eventTs]
  );

  if (tripResult.rows.length !== 1) {
    if (tripResult.rows.length > 1) {
      console.warn(
        `Skipping Bouncie auto-start for VIN ${snapshot.vin}: multiple eligible ready_for_handoff trips found`
      );
    }
    return null;
  }

  return tripResult.rows[0];
}

async function maybeAutoStartReadyTrip(client, snapshot) {
  return maybeAutoStartReadyTripFromTelemetry(client, {
    serviceName: "bouncie",
    vin: snapshot.vin,
    bouncieVehicleId: snapshot.bouncie_vehicle_id,
    isRunning: snapshot.is_running,
    speed: snapshot.speed,
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    odometer: snapshot.current_odometer_miles,
    eventTimestamp: snapshot.vehicle_last_updated,
  });
}

async function main() {
  console.log("Collecting Bouncie telemetry snapshot...");

  const vehicles = await getVehicles();

  if (!Array.isArray(vehicles)) {
    throw new Error("Bouncie vehicles response was not an array");
  }

  console.log(`Fetched ${vehicles.length} vehicle(s) from Bouncie.`);

  const dbClient = await pool.connect();

  try {
    await dbClient.query("BEGIN");

    let inserted = 0;
    let autoStarted = 0;

    for (const vehicle of vehicles) {
      const snapshot = normalizeVehicle(vehicle);

      if (!snapshot.vin) {
        console.warn("Skipping vehicle with no VIN:", {
          nickname: snapshot.nickname,
          imei: snapshot.imei,
        });
        continue;
      }

      await upsertVehicle(dbClient, snapshot);
      const autoStartResult = await maybeAutoStartReadyTrip(dbClient, snapshot);
      await insertSnapshot(dbClient, snapshot);
      await insertOdometerHistory(dbClient, snapshot);

      if (autoStartResult) autoStarted += 1;
      inserted += 1;
    }

    await dbClient.query("COMMIT");
    console.log(
      `Inserted ${inserted} telemetry snapshot row(s). Auto-started ${autoStarted} trip(s).`
    );
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }
}

module.exports = main;

if (require.main === module) {
  main().catch((err) => {
    console.error("collectBouncieSnapshot failed:", err.message);
    process.exit(1);
  });
}
