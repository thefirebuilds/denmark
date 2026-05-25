const pool = require("../../db");

const RUNNING_FRESH_MS = 15 * 60 * 1000;
const CLOCK_SKEW_GRACE_MS = 2 * 60 * 1000;

function toNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isFreshTimestamp(value, maxAgeMs = RUNNING_FRESH_MS) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Date.now() - timestamp;
  if (ageMs < -CLOCK_SKEW_GRACE_MS) return false;
  return ageMs <= maxAgeMs;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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

function normalizeHeatmapRow(row) {
  const lat = toNumber(row.lat);
  const lon = toNumber(row.lon);
  if (lat == null || lon == null) return null;

  return {
    lat,
    lon,
    count: Number(row.point_count || 0),
    intensity: toNumber(row.intensity) || 0,
    latestSeen: row.latest_seen || null,
  };
}

function mapLocationRow(row) {
  const lat = toNumber(row.latitude);
  const lon = toNumber(row.longitude);
  if (lat == null || lon == null) return null;
  const runningLastSeen = row.running_last_seen || row.last_seen || null;
  const isRunning =
    row.is_running === true && isFreshTimestamp(runningLastSeen)
      ? true
      : row.is_running === false
        ? false
        : null;

  return {
    id: String(row.id),
    name: row.name || `Vehicle ${row.id}`,
    vin: row.vin || null,
    make: row.make || null,
    model: row.model || null,
    year: row.year || null,
    nickname: row.name || null,
    source: normalizeSource(row.source),
    lat,
    lon,
    heading: toNumber(row.heading),
    lastSeen: row.last_seen || null,
    lastSeenType: row.last_seen_type || "telemetry_snapshot",
    isRunning,
    runningLastSeen,
    speed: toNumber(row.speed),
    googleMapsUrl: buildGoogleMapsUrl(lat, lon),
    telemetryDiagnostics: {
      provider: row.source || null,
      latestPollAt: row.latest_poll_at || null,
      locationSignalAt: row.location_signal_at || row.last_seen || null,
      availableSignalsCount: toNumber(row.available_signals_count),
      fetchedSignals: toArray(row.fetched_signals),
      skippedSignals: toArray(row.skipped_signals),
      blockedSignals: toArray(row.blocked_signals),
      missingPrivileges: toArray(row.missing_privileges),
      degradedReason: row.degraded_reason || null,
      locationIssue: row.location_issue || null,
    },
  };
}

function normalizeTrailRow(row) {
  const lat = toNumber(row.lat);
  const lon = toNumber(row.lon);
  if (lat == null || lon == null) return null;

  return {
    lat,
    lon,
    seenAt: row.seen_at || null,
    speed: toNumber(row.speed),
    heading: toNumber(row.heading),
  };
}

async function getStoredVehicleLocations(client = pool) {
  const { rows } = await client.query(`
    SELECT
      v.id,
      v.vin,
      v.make,
      v.model,
      v.year,
      COALESCE(
        canonical_alias.alias,
        NULLIF(trim(v.nickname), ''),
        NULLIF(trim(v.turo_vehicle_name), ''),
        NULLIF(trim(CONCAT_WS(' ', v.year, v.make, v.model)), ''),
        v.vin,
        CONCAT('Vehicle ', v.id)
      ) AS name,
      latest.service_name AS source,
      latest.latitude,
      latest.longitude,
      latest.heading,
      latest.is_running,
      latest.speed,
      latest.captured_at AT TIME ZONE 'UTC' AS latest_poll_at,
      latest.available_signals_count,
      latest.fetched_signals,
      latest.skipped_signals,
      latest.blocked_signals,
      latest.missing_privileges,
      latest.degraded_reason,
      latest.location_last_updated AT TIME ZONE 'UTC' AS location_signal_at,
      CASE
        WHEN latest.service_name = 'dimo'
          AND latest.location_last_updated IS NOT NULL
          AND latest.captured_at - latest.location_last_updated > INTERVAL '15 minutes'
          THEN 'dimo_location_signal_stale'
        WHEN latest.service_name = 'dimo'
          AND latest.missing_privileges ? 'GetLocationHistory'
          THEN 'missing_privilege:GetLocationHistory'
        WHEN latest.service_name = 'dimo'
          AND NOT (latest.fetched_signals ? 'currentLocationCoordinates')
          AND NOT (latest.fetched_signals ? 'currentLocationApproximateCoordinates')
          THEN 'dimo_location_signal_not_fetched'
        ELSE NULL
      END AS location_issue,
      COALESCE(
        latest.location_last_updated AT TIME ZONE 'UTC',
        latest.vehicle_last_updated AT TIME ZONE 'UTC',
        latest.captured_at AT TIME ZONE 'UTC'
      ) AS last_seen,
      COALESCE(
        latest.ignition_last_updated AT TIME ZONE 'UTC',
        latest.vehicle_last_updated AT TIME ZONE 'UTC',
        latest.captured_at AT TIME ZONE 'UTC'
      ) AS running_last_seen,
      CASE
        WHEN latest.location_last_updated IS NOT NULL THEN 'location_fix'
        WHEN latest.vehicle_last_updated IS NOT NULL THEN 'vehicle_update'
        WHEN latest.captured_at IS NOT NULL THEN 'telemetry_snapshot'
        ELSE NULL
      END AS last_seen_type
    FROM vehicles v
    LEFT JOIN LATERAL (
      SELECT va.alias
      FROM vehicle_aliases va
      WHERE va.vehicle_id = v.id
        AND va.active = true
        AND va.source = 'canonical'
      ORDER BY va.updated_at DESC, va.created_at DESC, va.id DESC
      LIMIT 1
    ) canonical_alias ON true
    LEFT JOIN LATERAL (
      SELECT
        s.service_name,
        s.latitude,
        s.longitude,
        s.heading,
        s.is_running,
        s.speed,
        s.location_last_updated,
        s.ignition_last_updated,
        s.vehicle_last_updated,
        s.captured_at,
        COALESCE(raw.raw_payload, s.raw_payload) AS raw_payload,
        ((COALESCE(raw.raw_payload, s.raw_payload) ->> 'availableSignalsCount')::int) AS available_signals_count,
        COALESCE(COALESCE(raw.raw_payload, s.raw_payload) -> 'fetchedSignals', '[]'::jsonb) AS fetched_signals,
        COALESCE(COALESCE(raw.raw_payload, s.raw_payload) -> 'skippedSignals', '[]'::jsonb) AS skipped_signals,
        COALESCE(COALESCE(raw.raw_payload, s.raw_payload) -> 'blockedSignals', '[]'::jsonb) AS blocked_signals,
        COALESCE(COALESCE(raw.raw_payload, s.raw_payload) -> 'missingPrivileges', '[]'::jsonb) AS missing_privileges,
        COALESCE(raw.raw_payload, s.raw_payload) ->> 'degradedReason' AS degraded_reason,
        s.location_last_updated AS location_signal_at
      FROM vehicle_telemetry_snapshots s
      LEFT JOIN vehicle_telemetry_raw_payloads raw
        ON raw.snapshot_id = s.id
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          (
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

async function getVehicleLocationTrail(vehicleId, options = {}, client = pool) {
  const id = Number(vehicleId);
  if (!Number.isInteger(id)) {
    const err = new Error("Invalid vehicle id");
    err.status = 400;
    throw err;
  }

  const minutes = Math.min(
    12 * 60,
    Math.max(15, Number.parseInt(options.minutes, 10) || 90)
  );

  const { rows } = await client.query(
    `
    WITH vehicle AS (
      SELECT id, vin, dimo_token_id, external_vehicle_key
      FROM vehicles
      WHERE id = $1
      LIMIT 1
    ),
    latest AS (
      SELECT COALESCE(
        s.location_last_updated,
        s.vehicle_last_updated,
        s.captured_at
      ) AS seen_at
      FROM vehicle_telemetry_snapshots s
      CROSS JOIN vehicle v
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          (
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
        )
      ORDER BY COALESCE(
        s.location_last_updated,
        s.vehicle_last_updated,
        s.captured_at
      ) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ),
    recent AS (
      SELECT
        s.id,
        s.latitude AS lat,
        s.longitude AS lon,
        s.speed,
        s.heading,
        COALESCE(
          s.location_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        ) AS seen_at
      FROM vehicle_telemetry_snapshots s
      CROSS JOIN vehicle v
      CROSS JOIN latest
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          (
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
        )
        AND COALESCE(
          s.location_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        ) >= latest.seen_at - ($2::int * INTERVAL '1 minute')
      ORDER BY COALESCE(
        s.location_last_updated,
        s.vehicle_last_updated,
        s.captured_at
      ) DESC NULLS LAST, s.id DESC
      LIMIT 24
    )
    SELECT
      lat,
      lon,
      speed,
      heading,
      seen_at AT TIME ZONE 'UTC' AS seen_at
    FROM recent
    ORDER BY seen_at ASC, id ASC
    `,
    [id, minutes]
  );

  return {
    vehicleId: id,
    minutes,
    points: rows.map(normalizeTrailRow).filter(Boolean),
  };
}

async function getVehicleLocationHeatmap(vehicleId, options = {}, client = pool) {
  const id = Number(vehicleId);
  if (!Number.isInteger(id)) {
    const err = new Error("Invalid vehicle id");
    err.status = 400;
    throw err;
  }

  const days = Math.min(
    180,
    Math.max(7, Number.parseInt(options.days, 10) || 90)
  );

  const { rows } = await client.query(
    `
    WITH vehicle AS (
      SELECT id, vin, dimo_token_id, external_vehicle_key
      FROM vehicles
      WHERE id = $1
      LIMIT 1
    ),
    points AS (
      SELECT
        s.id,
        s.latitude,
        s.longitude,
        COALESCE(
          s.location_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        ) AS seen_at
      FROM vehicle_telemetry_snapshots s
      CROSS JOIN vehicle v
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND COALESCE(
          s.location_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        ) >= NOW() - ($2::int * INTERVAL '1 day')
        AND (
          (
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
        )
    ),
    buckets AS (
      SELECT
        ROUND(latitude::numeric, 3) AS lat_bucket,
        ROUND(longitude::numeric, 3) AS lon_bucket,
        AVG(latitude)::float AS lat,
        AVG(longitude)::float AS lon,
        COUNT(*)::int AS point_count,
        MAX(seen_at) AT TIME ZONE 'UTC' AS latest_seen
      FROM points
      GROUP BY 1, 2
    ),
    max_bucket AS (
      SELECT GREATEST(MAX(point_count), 1)::float AS max_count
      FROM buckets
    )
    SELECT
      buckets.lat,
      buckets.lon,
      buckets.point_count,
      ROUND((buckets.point_count::numeric / max_bucket.max_count::numeric), 4)::float AS intensity,
      buckets.latest_seen
    FROM buckets, max_bucket
    ORDER BY buckets.point_count DESC, buckets.latest_seen DESC NULLS LAST
    LIMIT 150
    `,
    [id, days]
  );

  return {
    vehicleId: id,
    days,
    points: rows.map(normalizeHeatmapRow).filter(Boolean),
  };
}

module.exports = {
  getDimoLiveVehicleLocations,
  getVehicleLocationHeatmap,
  getVehicleLocationTrail,
  getStoredVehicleLocations,
  getVehicleLocations,
};
