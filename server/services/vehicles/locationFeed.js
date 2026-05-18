const pool = require("../../db");

function toNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (!source) return "Stored telemetry";
  if (source.toLowerCase() === "dimo") return "DIMO";
  if (source.toLowerCase() === "bouncie") return "Bouncie";
  return source;
}

function buildGoogleMapsUrl(lat, lon) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

function mapLocationRow(row) {
  const lat = toNumber(row.latitude);
  const lon = toNumber(row.longitude);
  if (lat == null || lon == null) return null;

  return {
    id: String(row.id),
    name: row.name || `Vehicle ${row.id}`,
    source: normalizeSource(row.source),
    lat,
    lon,
    lastSeen: row.last_seen || null,
    lastSeenType: row.last_seen_type || "telemetry_snapshot",
    isRunning:
      typeof row.is_running === "boolean" ? row.is_running : null,
    speed: toNumber(row.speed),
    googleMapsUrl: buildGoogleMapsUrl(lat, lon),
  };
}

async function getStoredVehicleLocations(client = pool) {
  const { rows } = await client.query(`
    SELECT
      v.id,
      COALESCE(
        NULLIF(trim(v.nickname), ''),
        NULLIF(trim(v.turo_vehicle_name), ''),
        NULLIF(trim(CONCAT_WS(' ', v.year, v.make, v.model)), ''),
        v.vin,
        CONCAT('Vehicle ', v.id)
      ) AS name,
      latest.service_name AS source,
      latest.latitude,
      latest.longitude,
      latest.is_running,
      latest.speed,
      COALESCE(
        latest.location_last_updated AT TIME ZONE 'UTC',
        latest.vehicle_last_updated AT TIME ZONE 'UTC',
        latest.captured_at AT TIME ZONE 'UTC'
      ) AS last_seen,
      CASE
        WHEN latest.location_last_updated IS NOT NULL THEN 'location_fix'
        WHEN latest.vehicle_last_updated IS NOT NULL THEN 'vehicle_update'
        WHEN latest.captured_at IS NOT NULL THEN 'telemetry_snapshot'
        ELSE NULL
      END AS last_seen_type
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT
        s.service_name,
        s.latitude,
        s.longitude,
        s.is_running,
        s.speed,
        s.location_last_updated,
        s.vehicle_last_updated,
        s.captured_at
      FROM vehicle_telemetry_snapshots s
      WHERE (
          s.vin IS NOT NULL
          AND s.vin <> ''
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
      ORDER BY COALESCE(
        s.location_last_updated,
        s.vehicle_last_updated,
        s.captured_at
      ) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) latest ON true
    WHERE v.is_active = true
    ORDER BY v.nickname NULLS LAST, v.make NULLS LAST, v.model NULLS LAST, v.id ASC
  `);

  return rows.map(mapLocationRow).filter(Boolean);
}

async function getDimoLiveVehicleLocations() {
  // Placeholder adapter: keep the frontend away from DIMO JWTs/tokens while
  // leaving a small seam for future DIMO Telemetry API live-location calls.
  return [];
}

async function getVehicleLocations(client = pool) {
  const [storedLocations, dimoLiveLocations] = await Promise.all([
    getStoredVehicleLocations(client),
    getDimoLiveVehicleLocations(),
  ]);

  return [...storedLocations, ...dimoLiveLocations];
}

module.exports = {
  getDimoLiveVehicleLocations,
  getStoredVehicleLocations,
  getVehicleLocations,
};
