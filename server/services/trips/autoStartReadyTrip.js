const { transitionTripStage } = require("./transitionTripStage");

function toNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function distanceMiles(aLat, aLon, bLat, bLon) {
  const lat1 = toNumber(aLat);
  const lon1 = toNumber(aLon);
  const lat2 = toNumber(bLat);
  const lon2 = toNumber(bLon);

  if ([lat1, lon1, lat2, lon2].some((value) => value == null)) return 0;

  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const rLat1 = lat1 * rad;
  const rLat2 = lat2 * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;

  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getVehicleForTelemetry(client, telemetry) {
  const vin = String(telemetry?.vin || "").trim();
  const tokenId = telemetry?.dimoTokenId == null ? null : String(telemetry.dimoTokenId);
  const bouncieId =
    telemetry?.bouncieVehicleId == null ? null : String(telemetry.bouncieVehicleId);

  const result = await client.query(
    `
      SELECT id, vin, nickname, turo_vehicle_id, bouncie_vehicle_id, dimo_token_id
      FROM vehicles
      WHERE ($1 <> '' AND LOWER(vin) = LOWER($1))
        OR ($2::text IS NOT NULL AND CAST(dimo_token_id AS text) = $2)
        OR ($3::text IS NOT NULL AND CAST(bouncie_vehicle_id AS text) = $3)
      ORDER BY
        CASE WHEN $1 <> '' AND LOWER(vin) = LOWER($1) THEN 0 ELSE 1 END
      LIMIT 1
    `,
    [vin, tokenId, bouncieId]
  );

  return result.rows[0] || null;
}

async function getPreviousLocation(client, telemetry) {
  const vin = String(telemetry?.vin || "").trim();
  const tokenId = telemetry?.dimoTokenId == null ? null : String(telemetry.dimoTokenId);
  const serviceName = String(telemetry?.serviceName || "").trim();

  if (!vin && !tokenId) return null;

  const result = await client.query(
    `
      SELECT latitude, longitude, captured_at, vehicle_last_updated
      FROM vehicle_telemetry_snapshots
      WHERE (
          ($1 <> '' AND LOWER(vin) = LOWER($1))
          OR ($2::text IS NOT NULL AND CAST(dimo_token_id AS text) = $2)
        )
        AND ($3 = '' OR service_name = $3)
      ORDER BY COALESCE(vehicle_last_updated, captured_at) DESC NULLS LAST, id DESC
      LIMIT 1
    `,
    [vin, tokenId, serviceName]
  );

  return result.rows[0] || null;
}

async function telemetryIndicatesTripStart(client, telemetry) {
  const isRunning = telemetry?.isRunning === true;
  const speed = toNumber(telemetry?.speed);

  if (isRunning || (speed != null && speed > 2)) {
    return {
      started: true,
      reason: isRunning ? "engine running" : `speed ${speed}`,
    };
  }

  const lat = toNumber(telemetry?.latitude);
  const lon = toNumber(telemetry?.longitude);
  if (lat == null || lon == null) return { started: false, reason: "no movement" };

  const previous = await getPreviousLocation(client, telemetry);
  if (!previous?.latitude || !previous?.longitude) {
    return { started: false, reason: "no previous location" };
  }

  const movedMiles = distanceMiles(previous.latitude, previous.longitude, lat, lon);

  if (movedMiles >= 0.1) {
    return {
      started: true,
      reason: `gps moved ${movedMiles.toFixed(2)} mi`,
    };
  }

  return { started: false, reason: "gps movement below threshold" };
}

async function findEligibleReadyTrip(client, vehicle, eventTimestamp) {
  if (!vehicle?.turo_vehicle_id) return null;

  const result = await client.query(
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
        AND $2::timestamptz >= trip_start - INTERVAL '12 hours'
        AND $2::timestamptz <= trip_start + INTERVAL '12 hours'
      ORDER BY trip_start ASC
      LIMIT 2
    `,
    [String(vehicle.turo_vehicle_id), eventTimestamp]
  );

  if (result.rows.length !== 1) {
    if (result.rows.length > 1) {
      console.warn(
        `Skipping telemetry auto-start for vehicle ${vehicle.nickname || vehicle.vin}: multiple eligible ready_for_handoff trips found`
      );
    }
    return null;
  }

  return result.rows[0];
}

async function maybeAutoStartReadyTripFromTelemetry(client, telemetry) {
  const vehicle = await getVehicleForTelemetry(client, telemetry);
  if (!vehicle?.turo_vehicle_id) return null;

  const signal = await telemetryIndicatesTripStart(client, telemetry);
  if (!signal.started) return null;

  const eventTimestamp = toTimestamp(telemetry?.eventTimestamp);
  const trip = await findEligibleReadyTrip(client, vehicle, eventTimestamp);
  if (!trip) return null;

  console.log(
    `Auto-starting trip ${trip.id} (${trip.guest_name || "unknown guest"} / ${
      trip.vehicle_name || vehicle.nickname || vehicle.vin
    }) from ${telemetry.serviceName || "telemetry"}: ${signal.reason}`
  );

  return transitionTripStage(trip.id, "in_progress", {
    changedBy: `system:${telemetry.serviceName || "telemetry"}`,
    reason: `auto-start from ${telemetry.serviceName || "telemetry"} telemetry near scheduled trip start: ${signal.reason}`,
    currentOdometer: telemetry?.odometer,
  });
}

module.exports = {
  maybeAutoStartReadyTripFromTelemetry,
};
