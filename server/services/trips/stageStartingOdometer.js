function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeOdometer(value) {
  const n = toNumber(value);
  if (n == null || n < 0) return null;
  return Math.round(n);
}

function toIsoTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
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

async function stageStartingOdometerFromTelemetry(client, telemetry) {
  const odometer = normalizeOdometer(telemetry?.odometer);
  if (odometer == null) return null;

  const vehicle = await getVehicleForTelemetry(client, telemetry);
  if (!vehicle?.turo_vehicle_id) return null;

  const eventTimestamp = toIsoTimestamp(telemetry?.eventTimestamp);

  const result = await client.query(
    `
      WITH eligible_trip AS (
        SELECT id
        FROM trips
        WHERE CAST(turo_vehicle_id AS text) = $1
          AND starting_odometer IS NULL
          AND workflow_stage IN ('confirmed', 'ready_for_handoff')
          AND COALESCE(status, '') <> 'canceled'
          AND canceled_at IS NULL
          AND completed_at IS NULL
          AND COALESCE(closed_out, false) = false
          AND trip_start IS NOT NULL
          AND $3::timestamptz >= trip_start - INTERVAL '2 hours'
          AND $3::timestamptz <= trip_start + INTERVAL '12 hours'
        ORDER BY trip_start ASC, id ASC
        LIMIT 1
      )
      UPDATE trips t
      SET
        starting_odometer = $2::integer,
        updated_at = NOW()
      FROM eligible_trip e
      WHERE t.id = e.id
      RETURNING
        t.id,
        t.reservation_id,
        t.guest_name,
        t.vehicle_name,
        t.trip_start,
        t.workflow_stage,
        t.starting_odometer
    `,
    [String(vehicle.turo_vehicle_id), odometer, eventTimestamp]
  );

  const trip = result.rows[0] || null;
  if (trip) {
    console.log(
      `Staged starting odometer ${odometer} for trip ${trip.id} (${trip.guest_name || "unknown guest"} / ${
        trip.vehicle_name || vehicle.nickname || vehicle.vin
      }) from ${telemetry?.serviceName || "telemetry"}`
    );
  }

  return trip;
}

module.exports = {
  stageStartingOdometerFromTelemetry,
};
