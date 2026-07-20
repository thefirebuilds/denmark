const pool = require("../../db");
const { sendSms } = require("./twilioSms");
const { getBridgeAlertSettings } = require("./bridgeAlertSettings");
const { getVoltageAlertSettings } = require("./voltageAlertSettings");
const {
  getEnabledLocations,
  getPrimaryParkingLocation,
} = require("../locations/locationSettings");
const { transitionTripStage } = require("../trips/transitionTripStage");
const { DateTime } = require("luxon");

let ensureFleetAlertTablesPromise = null;
let fleetAlertsInProgress = false;
const FUTURE_TELEMETRY_GRACE_MS = 5 * 60 * 1000;
const LOCATION_ENTRY_STALE_LOCATION_MS = 15 * 60 * 1000;
const DEVICE_STALE_HOURS = 24;
const DEVICE_STALE_SNOOZE_HOURS = 8;
const DEVICE_RECOVERY_FRESH_MINUTES = 90;

function normalizeDisplayTimestamp(value, fallback = null) {
  if (!value) return fallback;
  const text = String(value).trim();

  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    return value;
  }

  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)/
  );
  const naiveWallTime =
    value instanceof Date
      ? (() => {
          if (Number.isNaN(value.getTime())) return null;
          const pad = (part, size = 2) => String(part).padStart(size, "0");
          return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
            value.getDate()
          )}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(
            value.getSeconds()
          )}.${pad(value.getMilliseconds(), 3)}`;
        })()
      : match
      ? `${match[1]}T${match[2].includes(".") ? match[2] : `${match[2]}.000`}`
      : null;

  if (!naiveWallTime) return fallback || value;

  const nowParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const part = (type) => nowParts.find((item) => item.type === type)?.value;
  const hour = part("hour") === "24" ? "00" : part("hour");
  const nowWallTime = `${part("year")}-${part("month")}-${part("day")}T${hour}:${part(
    "minute"
  )}:${part("second")}.000`;

  const naiveWallDate = new Date(naiveWallTime);
  const nowWallDate = new Date(nowWallTime);
  if (
    !Number.isNaN(naiveWallDate.getTime()) &&
    !Number.isNaN(nowWallDate.getTime()) &&
    naiveWallDate.getTime() > nowWallDate.getTime() + FUTURE_TELEMETRY_GRACE_MS
  ) {
    return `${naiveWallTime}Z`;
  }

  return naiveWallTime;
}

function normalizeTelemetryTimestamp(value, serviceName, fallback = null) {
  if (!value) return fallback;
  const pad = (part, size = 2) => String(part).padStart(size, "0");
  const text =
    value instanceof Date && !Number.isNaN(value.getTime())
      ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
          value.getDate()
        )}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(
          value.getSeconds()
        )}.${pad(value.getMilliseconds(), 3)}`
      : String(value).trim();
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) return value;

  // Bouncie provider timestamps are UTC instants. PostgreSQL stores the
  // telemetry columns without a zone, so restore UTC before display/math.
  if (String(serviceName || "").toLowerCase() === "bouncie") {
    return `${text.replace(" ", "T")}Z`;
  }

  return normalizeDisplayTimestamp(value, fallback);
}

function formatChicago(value) {
  if (!value) return "unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function cleanPickupLocation(value) {
  const cleaned = cleanText(value)
    .replace(/[.,;:]+$/g, "")
    .trim();

  if (!cleaned) return null;
  if (/^(starting|from|to|is booked|will pick up)\b/i.test(cleaned)) return null;
  if (cleaned.length > 140) return null;
  return cleaned;
}

function extractPickupLocation(value) {
  const text = cleanText(value);
  const patterns = [
    /Map of\s+([^:\n]+):/i,
    /\btrip with your .+?\s+at\s+(.+?)\s+starting on\b/i,
    /\btrip with your .+?\s+at\s+(.+?)\s+is booked from\b/i,
    /\bdeliver the car to .+?\s+at\s+(.+?)\s+on\b/i,
    /\bpick up the car (?:at|from)\s+(.+?)\s+on\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const location = cleanPickupLocation(match?.[1]);
    if (location) return location;
  }

  return null;
}

function normalizeDtcCodes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      return item?.code || item?.dtc || item?.name || JSON.stringify(item);
    })
    .map((item) => cleanText(item).toUpperCase())
    .filter(Boolean)
    .slice(0, 8);
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getChicagoDateKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function distanceMiles(aLat, aLon, bLat, bLon) {
  const earthRadiusMiles = 3958.8;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(bLat - aLat);
  const dLon = toRadians(bLon - aLon);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getEightHourBucketKey(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(Math.floor(date.getUTCHours() / 8) * 8);
  return date.toISOString();
}

function getTimestampMs(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function isStaleLocationEntrySignal(row) {
  const serviceName = String(row?.service_name || "").toLowerCase();
  if (serviceName !== "dimo") return false;

  const locationAt = getTimestampMs(row.location_last_updated);
  const capturedAt = getTimestampMs(row.captured_at);
  if (locationAt == null || capturedAt == null) return false;

  return capturedAt - locationAt > LOCATION_ENTRY_STALE_LOCATION_MS;
}

function normalizeLocationText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tripReturnLocationMatchesNamedLocation(tripReturnLocation, location) {
  const tripLocation = normalizeLocationText(tripReturnLocation);
  if (!tripLocation || !location) return false;

  return [location.label, location.id, location.kind]
    .map(normalizeLocationText)
    .filter(Boolean)
    .some(
      (candidate) =>
        candidate.length >= 3 &&
        (tripLocation.includes(candidate) || candidate.includes(tripLocation))
    );
}

function tripReturnLocationMatchesPrimaryParking(tripReturnLocation, location) {
  if (
    String(location?.kind || "").toLowerCase() !== "parking" &&
    location?.isPrimaryParking !== true
  ) return false;
  const tripLocation = normalizeLocationText(tripReturnLocation);
  if (!tripLocation) return false;

  // Turo commonly describes the configured home return as the city/ZIP while
  // Denmark's map uses the owner's friendly geofence label (for example,
  // "Buda, TX 78610" versus "Garlic Creek"). These are established home
  // aliases elsewhere in the Denmark UI, so treat them as the primary lot.
  return /(?:^| )(?:home|buda|78610)(?: |$)/.test(tripLocation);
}

function tripReturnLocationMatchesTelemetryAddress(tripReturnLocation, address) {
  const tripTokens = new Set(
    normalizeLocationText(tripReturnLocation)
      .split(" ")
      .filter((token) => token.length >= 3 || /^\d{5}$/.test(token))
  );
  const addressTokens = new Set(
    normalizeLocationText(address)
      .split(" ")
      .filter((token) => token.length >= 3 || /^\d{5}$/.test(token))
  );
  if (!tripTokens.size || !addressTokens.size) return false;

  const shared = [...tripTokens].filter((token) => addressTokens.has(token));
  if (shared.some((token) => /^\d{5}$/.test(token))) return true;
  return shared.length >= 2;
}

function getMatchedTripReturnGeoLocation(row, locations) {
  const lat = toNumber(row.latitude);
  const lon = toNumber(row.longitude);
  if (lat == null || lon == null) return null;

  for (const location of locations) {
    const matchesExpectedLocation =
      tripReturnLocationMatchesNamedLocation(row.return_location, location) ||
      tripReturnLocationMatchesPrimaryParking(row.return_location, location) ||
      tripReturnLocationMatchesTelemetryAddress(row.return_location, row.address);
    if (!matchesExpectedLocation) {
      continue;
    }

    const milesAway = distanceMiles(
      lat,
      lon,
      location.latitude,
      location.longitude
    );
    if (milesAway <= location.radiusMiles) {
      return { location, milesAway };
    }
  }

  return null;
}

function getReturnObservedAt(row) {
  const raw = row.location_last_updated || row.vehicle_last_updated || row.captured_at;
  if (!raw) return new Date();
  let observedAt;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    observedAt = raw;
  } else {
    const text = String(raw).trim();
    const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(text);
    const parsed = hasZone
      ? DateTime.fromISO(text, { setZone: true })
      : String(row.service_name || "").toLowerCase() === "bouncie"
        ? DateTime.fromISO(text, { zone: "utc" })
        : DateTime.fromISO(text, { zone: "America/Chicago" });
    observedAt = parsed.isValid ? parsed.toJSDate() : new Date();
  }
  const tripStartedAt = row.trip_start ? new Date(row.trip_start) : null;
  if (
    tripStartedAt &&
    !Number.isNaN(tripStartedAt.getTime()) &&
    observedAt.getTime() < tripStartedAt.getTime()
  ) {
    const detectedAt = row.captured_at ? new Date(row.captured_at) : new Date();
    return Number.isNaN(detectedAt.getTime()) ? new Date() : detectedAt;
  }
  return observedAt;
}

async function recordTripReturnObservation(row, match) {
  const observedAt = getReturnObservedAt(row);
  const dueAt = new Date(row.trip_end);
  const lateMinutes = Number.isNaN(dueAt.getTime())
    ? 0
    : Math.max(0, Math.round((observedAt.getTime() - dueAt.getTime()) / 60000));
  const result = await pool.query(`UPDATE trips SET
      returned_at=COALESCE(returned_at,$2::timestamptz),
      return_late_minutes=COALESCE(return_late_minutes,$3::integer),
      return_detection_source=COALESCE(return_detection_source,$4),
      return_detected_location=COALESCE(return_detected_location,$5),
      return_distance_miles=COALESCE(return_distance_miles,$6::numeric),
      updated_at=NOW()
    WHERE id=$1 RETURNING returned_at,return_late_minutes`, [
    row.id,
    observedAt.toISOString(),
    lateMinutes,
    `telemetry:${row.service_name || "unknown"}`,
    match.location.label || match.location.id || "return location",
    match.milesAway,
  ]);
  return result.rows[0] || { returned_at: observedAt, return_late_minutes: lateMinutes };
}

async function ensureFleetAlertTables(client = pool) {
  if (!ensureFleetAlertTablesPromise) {
    ensureFleetAlertTablesPromise = client
      .query(`
        CREATE TABLE IF NOT EXISTS public.fleet_alert_deliveries (
          id bigserial PRIMARY KEY,
          alert_key text NOT NULL UNIQUE,
          alert_type text NOT NULL,
          severity text NOT NULL DEFAULT 'info',
          body text NOT NULL,
          provider text NOT NULL DEFAULT 'twilio',
          provider_message_id text,
          status text NOT NULL DEFAULT 'sent',
          details jsonb DEFAULT '{}'::jsonb NOT NULL,
          sent_at timestamptz DEFAULT now() NOT NULL,
          created_at timestamptz DEFAULT now() NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_fleet_alert_deliveries_type_sent
          ON public.fleet_alert_deliveries (alert_type, sent_at DESC);

        CREATE TABLE IF NOT EXISTS public.vehicle_diagnostic_suppressions (
          id bigserial PRIMARY KEY,
          diagnostic_key text NOT NULL UNIQUE,
          action text NOT NULL DEFAULT 'acknowledged',
          acknowledged_at timestamptz,
          snoozed_until timestamptz,
          reason text,
          created_at timestamptz DEFAULT now() NOT NULL,
          updated_at timestamptz DEFAULT now() NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_vehicle_diagnostic_suppressions_snoozed
          ON public.vehicle_diagnostic_suppressions (snoozed_until);
      `)
      .catch((err) => {
        ensureFleetAlertTablesPromise = null;
        throw err;
      });
  }

  return ensureFleetAlertTablesPromise;
}

async function hasAlertBeenSent(alertKey) {
  const result = await pool.query(
    "SELECT 1 FROM public.fleet_alert_deliveries WHERE alert_key = $1 LIMIT 1",
    [alertKey]
  );
  return Boolean(result.rows[0]);
}

async function recordAlert({ alertKey, alertType, severity, body, delivery, details }) {
  await pool.query(
    `
      INSERT INTO public.fleet_alert_deliveries (
        alert_key,
        alert_type,
        severity,
        body,
        provider_message_id,
        status,
        details
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (alert_key) DO NOTHING
    `,
    [
      alertKey,
      alertType,
      severity || "info",
      body,
      delivery?.sid || null,
      delivery?.skipped ? "skipped" : "sent",
      JSON.stringify(details || {}),
    ]
  );
}

function isBridgeFreshnessAlert(alertType) {
  return [
    "bridge_heartbeat_stale",
    "bridge_turo_notifications_stale",
  ].includes(String(alertType || ""));
}

async function sendDedupedAlert(alert) {
  if (isBridgeFreshnessAlert(alert.alertType)) {
    const bridgeSettings = await getBridgeAlertSettings();
    if (!bridgeSettings.enabled) {
      return { sent: false, skipped: true, reason: "android_bridge_disabled" };
    }
  }

  if (await hasAlertBeenSent(alert.alertKey)) {
    return { sent: false, skipped: true, reason: "duplicate" };
  }

  const delivery = await sendSms(alert.body);
  await recordAlert({ ...alert, delivery });
  return {
    sent: delivery.ok === true,
    skipped: delivery.skipped === true,
    sid: delivery.sid || null,
  };
}

async function collectNewTripBookedAlerts() {
  const { rows } = await pool.query(`
    SELECT
      t.id,
      t.reservation_id,
      t.vehicle_name,
      v.nickname AS vehicle_nickname,
      t.guest_name,
      t.trip_start,
      t.created_at,
      t.created_from_message_id,
      m.normalized_text_body,
      m.subject
    FROM trips t
    LEFT JOIN vehicles v
      ON t.turo_vehicle_id IS NOT NULL
      AND v.turo_vehicle_id = t.turo_vehicle_id
    LEFT JOIN messages m
      ON m.message_id = t.created_from_message_id
    WHERE COALESCE(t.workflow_stage, '') <> 'canceled'
      AND COALESCE(t.status, '') <> 'canceled'
      AND t.created_at >= NOW() - INTERVAL '30 minutes'
      AND t.trip_start IS NOT NULL
    ORDER BY t.created_at DESC
    LIMIT 10
  `);

  return rows.map((row) => {
    const vehicle = row.vehicle_nickname || row.vehicle_name || "Unknown car";
    const location =
      extractPickupLocation(row.normalized_text_body || row.subject) ||
      "pickup location unknown";

    return {
      alertKey: `trip-booked:${row.id}`,
      alertType: "trip_booked",
      severity: "info",
      body: `Denmark: New trip booked for ${vehicle}. Starts ${formatChicago(
        row.trip_start
      )}. Pickup: ${location}.`,
      details: row,
    };
  });
}

async function collectBridgeHeartbeatAlerts() {
  const bridgeSettings = await getBridgeAlertSettings();
  if (!bridgeSettings.enabled) return [];

  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT
        MAX(received_at) FILTER (
          WHERE classification = 'bridge_heartbeat'
            OR source = 'android_bridge_heartbeat'
        ) AS last_heartbeat_at,
        MAX(received_at) FILTER (
          WHERE COALESCE(classification, '') NOT IN ('bridge_heartbeat', 'bridge_test')
            AND COALESCE(source, '') <> 'android_bridge_heartbeat'
            AND (
              LOWER(COALESCE(app, '')) LIKE '%turo%'
              OR LOWER(COALESCE(package_name, '')) LIKE '%turo%'
              OR COALESCE(classification, '') IN (
                'trip_booked',
                'trip_changed',
                'trip_canceled',
                'trip_cancelled',
                'guest_message',
                'payment_notice',
                'trip_rated',
                'return_location_check'
              )
            )
        ) AS last_turo_notification_at
      FROM notification_events
    )
    SELECT *
    FROM latest
  `);
  const lastSeen = rows[0]?.last_heartbeat_at;
  const lastTuroNotificationAt = rows[0]?.last_turo_notification_at;
  const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : NaN;
  const lastTuroNotificationMs = lastTuroNotificationAt
    ? new Date(lastTuroNotificationAt).getTime()
    : NaN;
  const staleMinutes = bridgeSettings.heartbeatStaleMinutes;
  const staleMs = staleMinutes * 60 * 1000;
  const turoFreshMs = bridgeSettings.turoNotificationStaleHours * 60 * 60 * 1000;

  if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= staleMs) {
    return [];
  }

  if (
    Number.isFinite(lastTuroNotificationMs) &&
    Date.now() - lastTuroNotificationMs <= turoFreshMs
  ) {
    return [];
  }

  const hourBucket = new Date();
  hourBucket.setMinutes(0, 0, 0);

  return [
    {
      alertKey: `bridge-heartbeat-stale:${hourBucket.toISOString()}`,
      alertType: "bridge_heartbeat_stale",
      severity: "urgent",
      body: `Denmark: Android bridge heartbeat is stale. Last seen ${
        lastSeen ? formatChicago(lastSeen) : "never"
      }.`,
      details: { lastSeen, lastTuroNotificationAt, staleMinutes },
    },
  ];
}

async function collectBridgeTuroNotificationAlerts() {
  const bridgeSettings = await getBridgeAlertSettings();
  if (!bridgeSettings.enabled) return [];

  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT
        MAX(received_at) FILTER (
          WHERE classification = 'bridge_heartbeat'
            OR source = 'android_bridge_heartbeat'
        ) AS last_heartbeat_at,
        MAX(received_at) FILTER (
          WHERE COALESCE(classification, '') NOT IN ('bridge_heartbeat', 'bridge_test')
            AND COALESCE(source, '') <> 'android_bridge_heartbeat'
            AND (
              LOWER(COALESCE(app, '')) LIKE '%turo%'
              OR LOWER(COALESCE(package_name, '')) LIKE '%turo%'
              OR COALESCE(classification, '') IN (
                'trip_booked',
                'trip_changed',
                'trip_canceled',
                'trip_cancelled',
                'guest_message',
                'payment_notice',
                'trip_rated',
                'return_location_check'
              )
            )
        ) AS last_turo_notification_at
      FROM notification_events
    )
    SELECT *
    FROM latest
  `);

  const row = rows[0] || {};
  const lastHeartbeatAt = row.last_heartbeat_at;
  const lastTuroNotificationAt = row.last_turo_notification_at;
  const lastHeartbeatMs = lastHeartbeatAt ? new Date(lastHeartbeatAt).getTime() : NaN;
  const lastTuroNotificationMs = lastTuroNotificationAt
    ? new Date(lastTuroNotificationAt).getTime()
    : NaN;
  const heartbeatFreshMinutes = bridgeSettings.heartbeatStaleMinutes;
  const notificationStaleHours = bridgeSettings.turoNotificationStaleHours;

  if (
    !Number.isFinite(lastHeartbeatMs) ||
    Date.now() - lastHeartbeatMs > heartbeatFreshMinutes * 60 * 1000
  ) {
    return [];
  }

  if (
    Number.isFinite(lastTuroNotificationMs) &&
    Date.now() - lastTuroNotificationMs <= notificationStaleHours * 60 * 60 * 1000
  ) {
    return [];
  }

  const alreadySent = await pool.query(
    `
      SELECT 1
      FROM public.fleet_alert_deliveries
      WHERE alert_type = 'bridge_turo_notifications_stale'
        AND sent_at > COALESCE($1::timestamptz, '-infinity'::timestamptz)
      LIMIT 1
    `,
    [lastTuroNotificationAt || null]
  );

  if (alreadySent.rowCount > 0) {
    return [];
  }

  const staleSince = Number.isFinite(lastTuroNotificationMs)
    ? new Date(lastTuroNotificationMs + notificationStaleHours * 60 * 60 * 1000)
    : null;

  return [
    {
      alertKey: `bridge-turo-notifications-stale:${
        lastTuroNotificationAt ? new Date(lastTuroNotificationAt).toISOString() : "never"
      }:${notificationStaleHours}h`,
      alertType: "bridge_turo_notifications_stale",
      severity: "urgent",
      body: `Denmark: Android bridge heartbeat is fresh, but no Turo notifications have arrived since ${
        lastTuroNotificationAt ? formatChicago(lastTuroNotificationAt) : "never"
      }. The phone may be signed out of Turo.`,
      details: {
        lastHeartbeatAt,
        lastTuroNotificationAt,
        notificationStaleHours,
        staleSince,
      },
    },
  ];
}

async function collectDtcAlerts() {
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (COALESCE(NULLIF(latest_snapshot.vin, ''), latest_snapshot.external_vehicle_key, latest_snapshot.dimo_token_id::text))
        latest_snapshot.id,
        latest_snapshot.service_name,
        latest_snapshot.vin,
        latest_snapshot.nickname,
        latest_snapshot.captured_at,
        latest_snapshot.vehicle_last_updated,
        latest_snapshot.mil_on,
        latest_snapshot.qualified_dtc_list,
        latest_snapshot.dtc_count,
        first_seen.diagnostic_first_reported_at
      FROM vehicle_telemetry_snapshots latest_snapshot
      LEFT JOIN LATERAL (
        SELECT MIN(COALESCE(hist.vehicle_last_updated, hist.mil_last_updated, hist.captured_at)) AS diagnostic_first_reported_at
        FROM vehicle_telemetry_snapshots hist
        WHERE hist.service_name = latest_snapshot.service_name
          AND COALESCE(NULLIF(hist.vin, ''), hist.external_vehicle_key, hist.dimo_token_id::text)
            = COALESCE(NULLIF(latest_snapshot.vin, ''), latest_snapshot.external_vehicle_key, latest_snapshot.dimo_token_id::text)
          AND hist.captured_at >= NOW() - INTERVAL '24 hours'
          AND (
            COALESCE(hist.mil_on, false) = true
            OR
            COALESCE(hist.dtc_count, 0) > 0
            OR (
              jsonb_typeof(COALESCE(hist.qualified_dtc_list, '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(hist.qualified_dtc_list, '[]'::jsonb)) > 0
            )
          )
      ) first_seen ON true
      WHERE latest_snapshot.captured_at >= NOW() - INTERVAL '24 hours'
        AND (
          COALESCE(latest_snapshot.mil_on, false) = true
          OR
          COALESCE(latest_snapshot.dtc_count, 0) > 0
          OR (
            jsonb_typeof(COALESCE(latest_snapshot.qualified_dtc_list, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(latest_snapshot.qualified_dtc_list, '[]'::jsonb)) > 0
          )
        )
      ORDER BY
        COALESCE(NULLIF(latest_snapshot.vin, ''), latest_snapshot.external_vehicle_key, latest_snapshot.dimo_token_id::text),
        COALESCE(latest_snapshot.vehicle_last_updated, latest_snapshot.captured_at) DESC NULLS LAST,
        latest_snapshot.id DESC
    )
    SELECT
      latest.*,
      v.nickname AS vehicle_nickname
    FROM latest
    LEFT JOIN vehicles v
      ON latest.vin IS NOT NULL
      AND LOWER(v.vin) = LOWER(latest.vin)
  `);

  return rows.map((row) => {
    const vehicle = row.vehicle_nickname || row.nickname || row.vin || "vehicle";
    const codes = normalizeDtcCodes(row.qualified_dtc_list);
    const codeLabel = codes.length
      ? codes.join(", ")
      : row.mil_on
      ? "MIL/check-engine light on; no decoded DTCs"
      : `${row.dtc_count || 1} DTC`;
    const dtcKey = codes.length
      ? codes.join("-")
      : row.mil_on
      ? "mil-on-no-codes"
      : `count-${row.dtc_count || 1}`;
    const firstReported = row.diagnostic_first_reported_at
      ? ` First reported ${formatChicago(
          normalizeDisplayTimestamp(row.diagnostic_first_reported_at, row.captured_at)
        )}.`
      : "";
    const lastSeen = normalizeDisplayTimestamp(
      row.vehicle_last_updated || row.captured_at,
      row.captured_at
    );

    return {
      alertKey: `dtc:${row.service_name}:${row.vin || row.id}:${dtcKey}`,
      alertType: "dtc_received",
      severity: "urgent",
      body: `Denmark: ${vehicle} reported ${codeLabel} from ${row.service_name}. Seen ${formatChicago(
        lastSeen
      )}.${firstReported}`,
      details: row,
    };
  });
}

async function collectLowVoltageAlerts() {
  const settings = await getVoltageAlertSettings();
  if (settings.enabled === false || settings.smsEnabled === false) return [];

  const threshold = Number(settings.lowVoltageThreshold || 11.9);
  const { rows } = await pool.query(
    `
      SELECT
        v.id AS vehicle_id,
        v.vin,
        COALESCE(v.nickname, latest.nickname, v.vin, CONCAT('Vehicle ', v.id)) AS vehicle_name,
        latest.id AS snapshot_id,
        latest.service_name,
        latest.battery_voltage,
        latest.battery_voltage_last_updated,
        latest.vehicle_last_updated,
        latest.captured_at,
        COALESCE(
          latest.battery_voltage_last_updated,
          latest.vehicle_last_updated,
          latest.captured_at
        ) AS recorded_at
      FROM vehicles v
      JOIN LATERAL (
        SELECT
          s.id,
          s.service_name,
          s.nickname,
          s.battery_voltage,
          s.battery_voltage_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.battery_voltage IS NOT NULL
          AND s.battery_voltage BETWEEN 5 AND 16
          AND (
            (
              v.vin IS NOT NULL
              AND v.vin <> ''
              AND s.vin IS NOT NULL
              AND s.vin <> ''
              AND LOWER(s.vin) = LOWER(v.vin)
            )
            OR (
              v.dimo_token_id IS NOT NULL
              AND s.dimo_token_id = v.dimo_token_id
            )
            OR (
              v.external_vehicle_key IS NOT NULL
              AND v.external_vehicle_key <> ''
              AND s.external_vehicle_key = v.external_vehicle_key
            )
          )
        ORDER BY COALESCE(
          s.battery_voltage_last_updated,
          s.vehicle_last_updated,
          s.captured_at
        ) DESC NULLS LAST,
        s.id DESC
        LIMIT 1
      ) latest ON true
      WHERE COALESCE(v.is_active, true) = true
        AND latest.battery_voltage < $1::numeric
      ORDER BY latest.battery_voltage ASC, recorded_at DESC NULLS LAST
    `,
    [threshold]
  );

  return rows.map((row) => {
    const voltage = Number(row.battery_voltage);
    const roundedVoltage = Number.isFinite(voltage) ? voltage.toFixed(2) : "unknown";
    const recordedAt = normalizeDisplayTimestamp(
      row.recorded_at || row.captured_at,
      row.captured_at
    );
    const dateKey = getChicagoDateKey(recordedAt);

    return {
      alertKey: `battery-voltage-low:${row.vehicle_id}:${dateKey}:${threshold.toFixed(
        2
      )}`,
      alertType: "battery_voltage_low",
      severity: "urgent",
      body: `Denmark: ${row.vehicle_name} battery voltage is ${roundedVoltage}v, below the ${threshold.toFixed(
        2
      )}v alert threshold. Seen ${formatChicago(recordedAt)} via ${
        row.service_name || "telematics"
      }.`,
      details: {
        ...row,
        threshold,
      },
    };
  });
}

async function collectOverdueReturnAlerts() {
  const { rows } = await pool.query(`
    SELECT
      t.id,
      t.reservation_id,
      t.vehicle_name,
      v.nickname AS vehicle_nickname,
      v.vin AS vehicle_vin,
      t.guest_name,
      t.trip_end,
      t.return_location,
      t.workflow_stage,
      t.status,
      latest.service_name,
      latest.latitude,
      latest.longitude,
      latest.vehicle_last_updated,
      latest.location_last_updated,
      latest.captured_at
    FROM trips t
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM vehicles candidate
      WHERE (
          t.turo_vehicle_id IS NOT NULL
          AND candidate.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) IN (
            LOWER(COALESCE(candidate.nickname, '')),
            LOWER(COALESCE(candidate.turo_vehicle_name, ''))
          )
        )
      ORDER BY
        (t.turo_vehicle_id IS NOT NULL AND candidate.turo_vehicle_id = t.turo_vehicle_id) DESC,
        candidate.id ASC
      LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT
        s.service_name,
        s.latitude,
        s.longitude,
        s.vehicle_last_updated,
        s.location_last_updated,
        s.captured_at
      FROM vehicle_telemetry_snapshots s
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          s.captured_at >= t.trip_end - INTERVAL '6 hours'
          OR COALESCE(s.location_last_updated, s.vehicle_last_updated) >= t.trip_end - INTERVAL '6 hours'
        )
        AND (
          (
            v.vin IS NOT NULL
            AND s.vin IS NOT NULL
            AND LOWER(s.vin) = LOWER(v.vin)
          )
          OR (
            v.nickname IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(v.nickname)
          )
          OR (
            t.vehicle_name IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(t.vehicle_name)
          )
          OR (
            v.dimo_token_id IS NOT NULL
            AND s.dimo_token_id = v.dimo_token_id
          )
          OR (
            v.bouncie_vehicle_id IS NOT NULL
            AND s.provider_vehicle_id = v.bouncie_vehicle_id
          )
          OR (
            v.external_vehicle_key IS NOT NULL
            AND s.external_vehicle_key = v.external_vehicle_key
          )
        )
      ORDER BY COALESCE(s.captured_at, s.location_last_updated, s.vehicle_last_updated) DESC NULLS LAST,
        s.id DESC
      LIMIT 1
    ) latest ON true
    WHERE t.trip_end < NOW() - INTERVAL '30 minutes'
      AND t.trip_end >= NOW() - INTERVAL '24 hours'
      AND COALESCE(t.closed_out, false) = false
      AND COALESCE(t.workflow_stage, '') IN (
        'booked',
        'confirmed',
        'ready_for_handoff',
        'in_progress'
      )
      AND COALESCE(t.status, '') <> 'canceled'
      AND NOT EXISTS (
        SELECT 1
        FROM notification_events ne
        WHERE ne.classification = 'trip_returned'
          AND COALESCE(t.guest_name, '') <> ''
          AND COALESCE(ne.posted_at, ne.received_at) BETWEEN
            t.trip_end - INTERVAL '12 hours'
            AND NOW() + INTERVAL '1 hour'
          AND LOWER(COALESCE(ne.title, '')) LIKE
            '%' || LOWER(COALESCE(t.guest_name, '')) || '%'
          AND (
            COALESCE(t.vehicle_name, '') = ''
            OR LOWER(COALESCE(ne.title, '')) LIKE '%' || LOWER(COALESCE(t.vehicle_name, '')) || '%'
            OR LOWER(COALESCE(ne.title, '')) LIKE '%' || LOWER(split_part(COALESCE(t.vehicle_name, ''), ' ', 1)) || '%'
          )
      )
    ORDER BY t.trip_end ASC
    LIMIT 10
  `);

  const parking = await getPrimaryParkingLocation();
  const returnLocations = await getEnabledLocations();

  return rows
    .map((row) => {
      if (getMatchedTripReturnGeoLocation(row, returnLocations)) return null;

      if (parking.enabled) {
        const lat = toNumber(row.latitude);
        const lon = toNumber(row.longitude);
        if (lat != null && lon != null) {
          const milesAway = distanceMiles(lat, lon, parking.lat, parking.lon);
          if (milesAway <= parking.radiusMiles) return null;
        }
      }

      const vehicle = row.vehicle_nickname || row.vehicle_name || "vehicle";
      const guest = row.guest_name || "guest";
      return {
        alertKey: `return-overdue:${row.id}`,
        alertType: "return_overdue",
        severity: "urgent",
        body: `Denmark: ${vehicle} return is overdue from ${guest}. Due ${formatChicago(
          row.trip_end
        )}.`,
        details: row,
      };
    })
    .filter(Boolean);
}

async function collectDeviceConnectivityAlerts() {
  const staleCutoffHours = DEVICE_STALE_HOURS;
  const snoozeHours = DEVICE_STALE_SNOOZE_HOURS;
  const recoveryFreshMinutes = DEVICE_RECOVERY_FRESH_MINUTES;

  const { rows } = await pool.query(
    `
      WITH latest AS (
        SELECT
          v.id AS vehicle_id,
          v.vin,
          v.nickname AS vehicle_name,
          v.dimo_token_id,
          v.bouncie_vehicle_id,
          s.id AS snapshot_id,
          s.service_name,
          s.vehicle_last_updated,
          s.ignition_last_updated,
          s.location_last_updated,
          s.speed_last_updated,
          s.odometer_last_updated,
          s.fuel_level_last_updated,
          s.captured_at,
          CASE
            WHEN s.service_name = 'dimo' THEN COALESCE(
              s.vehicle_last_updated,
              s.ignition_last_updated,
              s.location_last_updated,
              s.speed_last_updated,
              s.odometer_last_updated,
              s.fuel_level_last_updated
            )
            ELSE COALESCE(
              s.vehicle_last_updated,
              s.ignition_last_updated,
              s.location_last_updated,
              s.speed_last_updated,
              s.odometer_last_updated,
              s.fuel_level_last_updated,
              s.captured_at
            )
          END AS last_comm_at
        FROM vehicles v
        LEFT JOIN LATERAL (
          SELECT s.*
          FROM vehicle_telemetry_snapshots s
          WHERE (
            (
              v.vin IS NOT NULL
              AND v.vin <> ''
              AND s.vin IS NOT NULL
              AND s.vin <> ''
              AND LOWER(s.vin) = LOWER(v.vin)
            )
            OR (
              v.dimo_token_id IS NOT NULL
              AND s.dimo_token_id = v.dimo_token_id
            )
            OR (
              v.bouncie_vehicle_id IS NOT NULL
              AND v.bouncie_vehicle_id <> ''
              AND s.external_vehicle_key = v.bouncie_vehicle_id
            )
            OR (
              v.external_vehicle_key IS NOT NULL
              AND v.external_vehicle_key <> ''
              AND s.external_vehicle_key = v.external_vehicle_key
            )
          )
          ORDER BY COALESCE(
            s.vehicle_last_updated,
            s.ignition_last_updated,
            s.location_last_updated,
            s.speed_last_updated,
            s.odometer_last_updated,
            s.fuel_level_last_updated,
            s.captured_at
          ) DESC NULLS LAST,
          s.id DESC
          LIMIT 1
        ) s ON true
        WHERE COALESCE(v.is_active, true) = true
          AND (
            v.dimo_token_id IS NOT NULL
            OR COALESCE(v.bouncie_vehicle_id, '') <> ''
            OR COALESCE(v.external_vehicle_key, '') <> ''
          )
      ),
      stale AS (
        SELECT latest.*
        FROM latest
        WHERE latest.last_comm_at IS NULL
          OR latest.last_comm_at < NOW() - ($1::int * INTERVAL '1 hour')
      ),
      recovered AS (
        SELECT
          latest.*,
          stale_delivery.id AS recovered_from_alert_id,
          stale_delivery.sent_at AS recovered_from_alert_sent_at
        FROM latest
        JOIN LATERAL (
          SELECT delivery.id, delivery.sent_at
          FROM public.fleet_alert_deliveries delivery
          WHERE delivery.alert_type = 'device_connectivity_stale'
            AND CASE
              WHEN delivery.details->>'vehicleId' ~ '^[0-9]+$'
                THEN (delivery.details->>'vehicleId')::int
              ELSE NULL
            END = latest.vehicle_id
          ORDER BY delivery.sent_at DESC, delivery.id DESC
          LIMIT 1
        ) stale_delivery ON true
        WHERE latest.last_comm_at >= NOW() - ($2::int * INTERVAL '1 minute')
          AND stale_delivery.sent_at < latest.last_comm_at
          AND NOT EXISTS (
            SELECT 1
            FROM public.fleet_alert_deliveries delivery
            WHERE delivery.alert_type = 'device_connectivity_recovered'
              AND CASE
                WHEN delivery.details->>'vehicleId' ~ '^[0-9]+$'
                  THEN (delivery.details->>'vehicleId')::int
              ELSE NULL
            END = latest.vehicle_id
              AND delivery.sent_at > stale_delivery.sent_at
          )
      )
      SELECT
        'stale' AS alert_kind,
        stale.*,
        NULL::bigint AS recovered_from_alert_id,
        NULL::timestamptz AS recovered_from_alert_sent_at
      FROM stale
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.vehicle_diagnostic_suppressions suppression
        WHERE suppression.diagnostic_key = CONCAT(
            'device_connectivity:',
            stale.vehicle_id,
            ':',
            COALESCE(
              to_char(stale.last_comm_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS'),
              'never'
            )
          )
          AND (
            suppression.action = 'acknowledge'
            OR suppression.snoozed_until > NOW()
          )
      )
      UNION ALL
      SELECT 'recovered' AS alert_kind, recovered.*
      FROM recovered
    `,
    [staleCutoffHours, recoveryFreshMinutes]
  );

  const bucket = getEightHourBucketKey();

  return rows.map((row) => {
    const vehicle = row.vehicle_name || row.vin || `Vehicle ${row.vehicle_id}`;
    const source = row.service_name || (row.dimo_token_id ? "dimo" : "telematics");
    const lastSeen = row.last_comm_at
      ? normalizeDisplayTimestamp(row.last_comm_at, row.captured_at)
      : null;
    const details = {
      ...row,
      vehicleId: row.vehicle_id,
      vehicle,
      source,
      lastSeen,
      diagnosticKey: `device_connectivity:${row.vehicle_id}:${
        row.last_comm_at
          ? new Date(row.last_comm_at).toISOString().replace(/[^0-9]/g, "").slice(0, 14)
          : "never"
      }`,
      staleCutoffHours,
      snoozeHours,
      recoveryFreshMinutes,
    };

    if (row.alert_kind === "recovered") {
      return {
        alertKey: `device-connectivity-recovered:${row.vehicle_id}:${
          row.recovered_from_alert_id || row.snapshot_id || bucket
        }`,
        alertType: "device_connectivity_recovered",
        severity: "info",
        body: `Denmark: ${vehicle} is reporting again via ${source}. Last heard ${formatChicago(
          lastSeen
        )}.`,
        details,
      };
    }

    return {
      alertKey: `device-connectivity-stale:${row.vehicle_id}:${bucket}`,
      alertType: "device_connectivity_stale",
      severity: "urgent",
      body: `Denmark: ${vehicle} has not reported via ${source} in ${staleCutoffHours}+ hours. Last heard ${
        lastSeen ? formatChicago(lastSeen) : "never"
      }. Snooze from Messages to recheck in ${snoozeHours} hours.`,
      details,
    };
  });
}

async function recordTripReturnGeoMessage(row, match) {
  const observedAt = normalizeTelemetryTimestamp(
    row.location_last_updated || row.vehicle_last_updated || row.captured_at,
    row.service_name,
    row.captured_at
  );
  const vehicle = row.vehicle_nickname || row.vehicle_name || "Vehicle";
  const locationLabel =
    match.location.label || match.location.address || "return location";
  const distance = match.milesAway.toFixed(2);
  const source = row.service_name || "vehicle telemetry";
  const subject = `${vehicle} returned to ${locationLabel}`;
  const body = `${vehicle} was observed within ${distance} mi of ${locationLabel} at ${formatChicago(
    observedAt
  )}. Source: ${source}.`;

  await pool.query(
    `
      INSERT INTO messages (
        message_id,
        subject,
        status,
        mailbox,
        from_header,
        message_timestamp,
        text_body,
        normalized_text_body,
        guest_name,
        vehicle_name,
        reservation_id,
        message_type,
        trip_id
      )
      VALUES ($1, $2, 'read', 'system', 'Denmark automation', $3, $4, $4, $5, $6, $7, 'return_geo_observed', $8)
      ON CONFLICT (message_id) DO NOTHING
    `,
    [
      `system:return-geo:${row.id}:${match.location.id || locationLabel}`,
      subject,
      observedAt,
      body,
      row.guest_name || null,
      vehicle,
      row.reservation_id || null,
      row.id,
    ]
  );
}

async function autoAdvanceReturnedTripsAtExpectedGeoLocations() {
  const enabledLocations = await getEnabledLocations();
  const primaryParking = await getPrimaryParkingLocation();
  const returnLocations = enabledLocations.map((location) => ({
    ...location,
    isPrimaryParking: location.id === primaryParking?.id,
  }));
  if (!returnLocations.length) return { advanced: 0 };

  const { rows } = await pool.query(`
    SELECT
      t.id,
      t.reservation_id,
      t.vehicle_name,
      v.nickname AS vehicle_nickname,
      v.vin AS vehicle_vin,
      t.guest_name,
      t.trip_start,
      t.trip_end,
      COALESCE(NULLIF(t.return_location,''),NULLIF(t.pickup_location,'')) AS return_location,
      latest.service_name,
      latest.latitude,
      latest.longitude,
      latest.address,
      latest.vehicle_last_updated,
      latest.location_last_updated,
      latest.captured_at
    FROM trips t
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM vehicles candidate
      WHERE (
          t.turo_vehicle_id IS NOT NULL
          AND candidate.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(t.vehicle_name) IN (
            LOWER(COALESCE(candidate.nickname, '')),
            LOWER(COALESCE(candidate.turo_vehicle_name, ''))
          )
        )
      ORDER BY
        (t.turo_vehicle_id IS NOT NULL AND candidate.turo_vehicle_id = t.turo_vehicle_id) DESC,
        candidate.id ASC
      LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT
        s.service_name,
        s.latitude,
        s.longitude,
        s.address,
        s.vehicle_last_updated,
        s.location_last_updated,
        s.captured_at
      FROM vehicle_telemetry_snapshots s
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND COALESCE(s.captured_at,s.vehicle_last_updated) >= NOW() - INTERVAL '30 minutes'
        AND (
          s.captured_at >= t.trip_end - INTERVAL '6 hours'
          OR COALESCE(s.location_last_updated, s.vehicle_last_updated) >= t.trip_end - INTERVAL '6 hours'
        )
        AND (
          s.trip_id = t.id
          OR
          (
            v.vin IS NOT NULL
            AND s.vin IS NOT NULL
            AND LOWER(s.vin) = LOWER(v.vin)
          )
          OR (
            v.nickname IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(v.nickname)
          )
          OR (
            t.vehicle_name IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(t.vehicle_name)
          )
          OR (
            v.dimo_token_id IS NOT NULL
            AND s.dimo_token_id = v.dimo_token_id
          )
          OR (
            v.bouncie_vehicle_id IS NOT NULL
            AND s.provider_vehicle_id = v.bouncie_vehicle_id
          )
          OR (
            v.external_vehicle_key IS NOT NULL
            AND s.external_vehicle_key = v.external_vehicle_key
          )
        )
      ORDER BY COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST,
        s.id DESC
      LIMIT 1
    ) latest ON true
    WHERE t.trip_end < NOW()
      AND COALESCE(t.closed_out, false) = false
      AND COALESCE(t.workflow_stage, '') = 'in_progress'
      AND COALESCE(t.status, '') <> 'canceled'
      AND COALESCE(NULLIF(t.return_location,''),NULLIF(t.pickup_location,'')) IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM trips newer
        WHERE newer.id <> t.id
          AND COALESCE(newer.closed_out, false) = false
          AND COALESCE(newer.workflow_stage, '') = 'in_progress'
          AND COALESCE(newer.status, '') <> 'canceled'
          AND newer.trip_end > t.trip_end
          AND (
            (
              t.turo_vehicle_id IS NOT NULL
              AND newer.turo_vehicle_id = t.turo_vehicle_id
            )
            OR (
              COALESCE(t.vehicle_name, '') <> ''
              AND LOWER(COALESCE(newer.vehicle_name, '')) = LOWER(t.vehicle_name)
            )
          )
      )
    ORDER BY t.trip_end ASC
    LIMIT 20
  `);

  let advanced = 0;
  for (const row of rows) {
    const match = getMatchedTripReturnGeoLocation(row, returnLocations);
    if (!match) continue;

    try {
      const observation = await recordTripReturnObservation(row, match);
      await recordTripReturnGeoMessage(row, match);
      await transitionTripStage(row.id, "turnaround", {
        changedBy: "system:return-geo-location",
        changedAt: observation.returned_at,
        reason: `return GPS verified within ${match.milesAway.toFixed(2)} mi of ${match.location.label}; ${observation.return_late_minutes || 0} minute(s) late`,
      });
      await transitionTripStage(row.id, "awaiting_expenses", {
        changedBy: "system:return-geo-location",
        changedAt: observation.returned_at,
        reason: `trip ended and return GPS verified within ${match.milesAway.toFixed(2)} mi of ${match.location.label}; ${observation.return_late_minutes || 0} minute(s) late`,
      });
      advanced += 1;
    } catch (err) {
      console.warn(
        `[alerts] return geo auto-stage skipped for trip ${row.id}: ${
          err.message || err
        }`
      );
    }
  }

  return { advanced };
}

async function collectReturnedToParkingSpotAlerts() {
  const parking = await getPrimaryParkingLocation();
  if (!parking.enabled) return [];

  const { rows } = await pool.query(`
    WITH return_day_trips AS (
      SELECT
        t.id,
        t.reservation_id,
        t.vehicle_name,
        v.nickname AS vehicle_nickname,
        v.vin AS vehicle_vin,
        t.guest_name,
        t.trip_end,
        t.turo_vehicle_id
      FROM trips t
      LEFT JOIN vehicles v
        ON (
          t.turo_vehicle_id IS NOT NULL
          AND v.turo_vehicle_id = t.turo_vehicle_id
        )
        OR (
          COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(v.nickname) = LOWER(t.vehicle_name)
        )
      WHERE t.trip_end >= NOW() - INTERVAL '12 hours'
        AND t.trip_end <= NOW() + INTERVAL '18 hours'
        AND COALESCE(t.workflow_stage, '') NOT IN ('canceled')
        AND COALESCE(t.status, '') <> 'canceled'
        AND t.trip_end IS NOT NULL
    )
    SELECT
      t.*,
      latest.service_name,
      latest.latitude,
      latest.longitude,
      latest.vehicle_last_updated,
      latest.location_last_updated,
      latest.captured_at
    FROM return_day_trips t
    LEFT JOIN LATERAL (
      SELECT
        s.service_name,
        s.latitude,
        s.longitude,
        s.vehicle_last_updated,
        s.location_last_updated,
        s.captured_at
      FROM vehicle_telemetry_snapshots s
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          s.captured_at >= t.trip_end - INTERVAL '6 hours'
          OR COALESCE(s.location_last_updated, s.vehicle_last_updated) >= t.trip_end - INTERVAL '6 hours'
        )
        AND (
          (
            t.vehicle_vin IS NOT NULL
            AND s.vin IS NOT NULL
            AND LOWER(s.vin) = LOWER(t.vehicle_vin)
          )
          OR (
            t.vehicle_nickname IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(t.vehicle_nickname)
          )
          OR (
            t.vehicle_name IS NOT NULL
            AND s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(t.vehicle_name)
          )
        )
      ORDER BY COALESCE(s.captured_at, s.location_last_updated, s.vehicle_last_updated) DESC NULLS LAST,
        s.id DESC
      LIMIT 1
    ) latest ON true
    WHERE latest.latitude IS NOT NULL
      AND latest.longitude IS NOT NULL
  `);

  return rows
    .map((row) => {
      const lat = toNumber(row.latitude);
      const lon = toNumber(row.longitude);
      if (lat == null || lon == null) return null;

      const milesAway = distanceMiles(lat, lon, parking.lat, parking.lon);
      if (milesAway > parking.radiusMiles) return null;

      const vehicle = row.vehicle_nickname || row.vehicle_name || "vehicle";
      const guest = row.guest_name || "guest";
      const seenAt =
        row.location_last_updated || row.vehicle_last_updated || row.captured_at;

      return {
        alertKey: `return-parking:${row.id}`,
        alertType: "return_to_parking",
        severity: "info",
        body: `Denmark: ${vehicle} appears back at ${parking.label} on return day after ${guest}'s trip. Seen ${formatChicago(
          seenAt
        )}.`,
        details: {
          ...row,
          parking,
          milesAway,
        },
      };
    })
    .filter(Boolean);
}

async function collectLocationEntryAlerts() {
  const locations = (await getEnabledLocations()).filter(
    (location) => location.alertOnEntry !== false
  );
  if (!locations.length) return [];

  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (v.id)
        v.id AS vehicle_id,
        COALESCE(NULLIF(trim(v.nickname), ''), s.nickname, v.vin, 'vehicle') AS vehicle_name,
        v.vin AS vehicle_vin,
        s.id AS snapshot_id,
        s.service_name,
        s.latitude,
        s.longitude,
        s.location_last_updated,
        s.captured_at,
        COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at
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
        AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) >= NOW() - INTERVAL '2 hours'
      ORDER BY v.id, COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
    )
    SELECT
      latest.*,
      previous.latitude AS previous_latitude,
      previous.longitude AS previous_longitude,
      previous.seen_at AS previous_seen_at
    FROM latest
    LEFT JOIN LATERAL (
      SELECT
        s.latitude,
        s.longitude,
        COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at
      FROM vehicle_telemetry_snapshots s
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) < latest.seen_at
        AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) >= latest.seen_at - INTERVAL '24 hours'
        AND (
          (
            latest.vehicle_vin IS NOT NULL
            AND s.vin IS NOT NULL
            AND LOWER(s.vin) = LOWER(latest.vehicle_vin)
          )
          OR (
            s.dimo_token_id IS NOT NULL
            AND s.dimo_token_id IN (
              SELECT dimo_token_id
              FROM vehicles
              WHERE id = latest.vehicle_id
                AND dimo_token_id IS NOT NULL
            )
          )
          OR (
            s.external_vehicle_key IS NOT NULL
            AND s.external_vehicle_key IN (
              SELECT external_vehicle_key
              FROM vehicles
              WHERE id = latest.vehicle_id
                AND external_vehicle_key IS NOT NULL
            )
          )
          OR (
            s.nickname IS NOT NULL
            AND LOWER(s.nickname) = LOWER(latest.vehicle_name)
          )
        )
      ORDER BY COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) previous ON true
  `);

  const alerts = [];

  for (const row of rows) {
    const lat = toNumber(row.latitude);
    const lon = toNumber(row.longitude);
    if (lat == null || lon == null) continue;
    if (isStaleLocationEntrySignal(row)) continue;

    for (const location of locations) {
      const milesAway = distanceMiles(
        lat,
        lon,
        location.latitude,
        location.longitude
      );
      if (milesAway > location.radiusMiles) continue;

      const previousLat = toNumber(row.previous_latitude);
      const previousLon = toNumber(row.previous_longitude);
      if (previousLat == null || previousLon == null) continue;

      const wasAlreadyInside =
        distanceMiles(
          previousLat,
          previousLon,
          location.latitude,
          location.longitude
        ) <= location.radiusMiles;

      if (wasAlreadyInside) continue;

      const seenAt = normalizeTelemetryTimestamp(
        row.seen_at,
        row.service_name,
        row.captured_at || new Date().toISOString()
      );
      const seenHour = new Date(seenAt);
      if (!Number.isNaN(seenHour.getTime())) {
        seenHour.setMinutes(0, 0, 0);
      }
      const bucket = Number.isNaN(seenHour.getTime())
        ? String(row.snapshot_id)
        : seenHour.toISOString();
      const vehicle = row.vehicle_name || "vehicle";

      alerts.push({
        alertKey: `location-entry:${location.id}:${row.vehicle_id}:${bucket}`,
        alertType: "location_entry",
        severity: "info",
        body: `Denmark: ${vehicle} entered ${location.label}. Seen ${formatChicago(
          seenAt
        )}.`,
        details: {
          vehicleId: row.vehicle_id,
          vehicle,
          snapshotId: row.snapshot_id,
          serviceName: row.service_name,
          seenAt,
          location,
          milesAway,
          previousSeenAt: row.previous_seen_at,
        },
      });
    }
  }

  return alerts;
}

async function sendLocationEntryAlertsForSnapshot(snapshotId) {
  const normalizedSnapshotId = Number(snapshotId);
  if (!Number.isInteger(normalizedSnapshotId) || normalizedSnapshotId <= 0) {
    return { checked: false, sent: 0, skipped: 0, reason: "invalid_snapshot" };
  }

  const locations = (await getEnabledLocations()).filter(
    (location) => location.alertOnEntry !== false
  );
  if (!locations.length) {
    return { checked: true, sent: 0, skipped: 0, reason: "no_locations" };
  }

  await ensureFleetAlertTables();

  const { rows } = await pool.query(
    `
      WITH current_snapshot AS (
        SELECT
          s.id AS snapshot_id,
          s.service_name,
          s.vin,
          s.dimo_token_id,
          s.external_vehicle_key,
          s.provider_vehicle_id,
          s.imei,
          s.nickname,
          s.latitude,
          s.longitude,
          s.location_last_updated,
          s.captured_at,
          COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.id = $1
          AND s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
      ),
      matched_vehicle AS (
        SELECT
          v.id AS vehicle_id,
          COALESCE(NULLIF(trim(v.nickname), ''), cs.nickname, v.vin, 'vehicle') AS vehicle_name,
          v.vin AS vehicle_vin,
          v.dimo_token_id AS vehicle_dimo_token_id,
          v.external_vehicle_key AS vehicle_external_vehicle_key,
          v.bouncie_vehicle_id AS vehicle_bouncie_vehicle_id,
          cs.*
        FROM current_snapshot cs
        JOIN vehicles v
          ON (
            cs.vin IS NOT NULL
            AND cs.vin <> ''
            AND v.vin IS NOT NULL
            AND LOWER(cs.vin) = LOWER(v.vin)
          )
          OR (
            cs.dimo_token_id IS NOT NULL
            AND v.dimo_token_id IS NOT NULL
            AND cs.dimo_token_id = v.dimo_token_id
          )
          OR (
            cs.external_vehicle_key IS NOT NULL
            AND v.external_vehicle_key IS NOT NULL
            AND cs.external_vehicle_key = v.external_vehicle_key
          )
          OR (
            cs.provider_vehicle_id IS NOT NULL
            AND v.bouncie_vehicle_id IS NOT NULL
            AND cs.provider_vehicle_id = v.bouncie_vehicle_id
          )
          OR (
            cs.nickname IS NOT NULL
            AND v.nickname IS NOT NULL
            AND LOWER(cs.nickname) = LOWER(v.nickname)
          )
        WHERE COALESCE(v.is_active, true) = true
        ORDER BY
          CASE
            WHEN cs.vin IS NOT NULL AND v.vin IS NOT NULL AND LOWER(cs.vin) = LOWER(v.vin) THEN 0
            WHEN cs.dimo_token_id IS NOT NULL AND v.dimo_token_id IS NOT NULL AND cs.dimo_token_id = v.dimo_token_id THEN 1
            ELSE 2
          END
        LIMIT 1
      )
      SELECT
        mv.*,
        previous.latitude AS previous_latitude,
        previous.longitude AS previous_longitude,
        previous.seen_at AS previous_seen_at
      FROM matched_vehicle mv
      LEFT JOIN LATERAL (
        SELECT
          s.latitude,
          s.longitude,
          COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at
        FROM vehicle_telemetry_snapshots s
        WHERE s.id <> mv.snapshot_id
          AND s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
          AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) < mv.seen_at
          AND COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) >= mv.seen_at - INTERVAL '24 hours'
          AND (
            (
              mv.vehicle_vin IS NOT NULL
              AND s.vin IS NOT NULL
              AND LOWER(s.vin) = LOWER(mv.vehicle_vin)
            )
            OR (
              mv.vehicle_dimo_token_id IS NOT NULL
              AND s.dimo_token_id IS NOT NULL
              AND s.dimo_token_id = mv.vehicle_dimo_token_id
            )
            OR (
              mv.vehicle_external_vehicle_key IS NOT NULL
              AND s.external_vehicle_key IS NOT NULL
              AND s.external_vehicle_key = mv.vehicle_external_vehicle_key
            )
            OR (
              mv.vehicle_bouncie_vehicle_id IS NOT NULL
              AND s.provider_vehicle_id IS NOT NULL
              AND s.provider_vehicle_id = mv.vehicle_bouncie_vehicle_id
            )
            OR (
              mv.vehicle_name IS NOT NULL
              AND s.nickname IS NOT NULL
              AND LOWER(s.nickname) = LOWER(mv.vehicle_name)
            )
          )
        ORDER BY COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
        LIMIT 1
      ) previous ON true
    `,
    [normalizedSnapshotId]
  );

  const row = rows[0];
  if (!row) {
    return { checked: true, sent: 0, skipped: 0, reason: "no_matched_vehicle" };
  }

  const lat = toNumber(row.latitude);
  const lon = toNumber(row.longitude);
  if (lat == null || lon == null) {
    return { checked: true, sent: 0, skipped: 0, reason: "no_coordinates" };
  }
  if (isStaleLocationEntrySignal(row)) {
    return { checked: true, sent: 0, skipped: 0, reason: "stale_location_signal" };
  }

  let sent = 0;
  let skipped = 0;

  for (const location of locations) {
    const milesAway = distanceMiles(lat, lon, location.latitude, location.longitude);
    if (milesAway > location.radiusMiles) continue;

    const previousLat = toNumber(row.previous_latitude);
    const previousLon = toNumber(row.previous_longitude);
    if (previousLat == null || previousLon == null) {
      skipped += 1;
      continue;
    }

    const wasAlreadyInside =
      distanceMiles(
        previousLat,
        previousLon,
        location.latitude,
        location.longitude
      ) <= location.radiusMiles;

    if (wasAlreadyInside) {
      skipped += 1;
      continue;
    }

    const seenAt = normalizeTelemetryTimestamp(
      row.seen_at,
      row.service_name,
      row.captured_at || new Date().toISOString()
    );
    const seenHour = new Date(seenAt);
    if (!Number.isNaN(seenHour.getTime())) {
      seenHour.setMinutes(0, 0, 0);
    }
    const bucket = Number.isNaN(seenHour.getTime())
      ? String(row.snapshot_id)
      : seenHour.toISOString();
    const vehicle = row.vehicle_name || "vehicle";

    const result = await sendDedupedAlert({
      alertKey: `location-entry:${location.id}:${row.vehicle_id}:${bucket}`,
      alertType: "location_entry",
      severity: "info",
      body: `Denmark: ${vehicle} entered ${location.label}. Seen ${formatChicago(
        seenAt
      )}.`,
      details: {
        vehicleId: row.vehicle_id,
        vehicle,
        snapshotId: row.snapshot_id,
        serviceName: row.service_name,
        seenAt,
        location,
        milesAway,
        previousSeenAt: row.previous_seen_at,
        trigger: "telemetry_insert",
      },
    });

    if (result.sent) sent += 1;
    else skipped += 1;
  }

  return { checked: true, sent, skipped };
}

async function sendTripUnderwayAlert(trip, options = {}) {
  if (!trip?.id) {
    return { sent: false, skipped: true, reason: "missing_trip" };
  }

  await ensureFleetAlertTables();

  const guest = cleanText(trip.guest_name, "Guest");
  const vehicle = cleanText(trip.vehicle_name, "vehicle");
  const source = cleanText(options.source || options.serviceName, "telemetry");
  const signal = cleanText(options.reason || options.signal, "engine started");
  const startedAt = options.startedAt || trip.stage_updated_at || new Date().toISOString();

  return sendDedupedAlert({
    alertKey: `trip-underway:${trip.id}`,
    alertType: "trip_underway",
    severity: "info",
    body: `Denmark: ${guest}'s trip with ${vehicle} is underway. ${signal}. Seen ${formatChicago(
      startedAt
    )}.`,
    details: {
      tripId: trip.id,
      reservationId: trip.reservation_id || null,
      guest,
      vehicle,
      source,
      signal,
      startedAt,
    },
  });
}

async function collectFleetAlerts() {
  const groups = [];

  for (const collect of [
    collectNewTripBookedAlerts,
    collectBridgeHeartbeatAlerts,
    collectBridgeTuroNotificationAlerts,
    collectDtcAlerts,
    collectLowVoltageAlerts,
    collectDeviceConnectivityAlerts,
    collectOverdueReturnAlerts,
    collectReturnedToParkingSpotAlerts,
    collectLocationEntryAlerts,
  ]) {
    groups.push(await collect());
  }

  return groups.flat();
}

async function runFleetAlerts(reason = "interval") {
  if (fleetAlertsInProgress) {
    return { ran: false, skipped: true, reason: "already_running" };
  }

  fleetAlertsInProgress = true;
  const startedAt = Date.now();

  try {
    await ensureFleetAlertTables();
    const returnedTripResult = await autoAdvanceReturnedTripsAtExpectedGeoLocations();
    const alerts = await collectFleetAlerts();
    const results = [];

    for (const alert of alerts) {
      try {
        results.push({
          alertKey: alert.alertKey,
          ...(await sendDedupedAlert(alert)),
        });
      } catch (err) {
        console.error(
          `[alerts] failed alertKey=${alert.alertKey} error=${err.message || err}`
        );
        results.push({
          alertKey: alert.alertKey,
          sent: false,
          error: err.message || String(err),
        });
      }
    }

    const sent = results.filter((item) => item.sent).length;
    console.log(
      `[alerts] checked reason=${reason} candidates=${alerts.length} sent=${sent} returnedTripsAdvanced=${
        returnedTripResult.advanced || 0
      } durationMs=${
        Date.now() - startedAt
      }`
    );

    return {
      ran: true,
      candidates: alerts.length,
      sent,
      returnedTripsAdvanced: returnedTripResult.advanced || 0,
      results,
    };
  } finally {
    fleetAlertsInProgress = false;
  }
}

module.exports = {
  ensureFleetAlertTables,
  runFleetAlerts,
  sendLocationEntryAlertsForSnapshot,
  sendTripUnderwayAlert,
};
