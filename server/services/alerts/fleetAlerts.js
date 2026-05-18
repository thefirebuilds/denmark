const pool = require("../../db");
const { sendSms } = require("./twilioSms");

let ensureFleetAlertTablesPromise = null;
let fleetAlertsInProgress = false;

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
    0.15;

  return {
    lat,
    lon,
    radiusMiles,
    label:
      cleanText(process.env.PARKING_SPOT_LABEL) ||
      cleanText(process.env.FLEET_PARKING_LABEL) ||
      "parking spot",
    enabled: lat != null && lon != null,
  };
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

async function sendDedupedAlert(alert) {
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
  const { rows } = await pool.query(`
    SELECT MAX(received_at) AS last_seen
    FROM notification_events
    WHERE classification = 'bridge_heartbeat'
      OR source = 'android_bridge_heartbeat'
  `);
  const lastSeen = rows[0]?.last_seen;
  const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : NaN;
  const staleMinutes = Number(process.env.BRIDGE_HEARTBEAT_STALE_MINUTES || 25);
  const staleMs = staleMinutes * 60 * 1000;

  if (Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= staleMs) {
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
      details: { lastSeen, staleMinutes },
    },
  ];
}

async function collectBridgeTuroNotificationAlerts() {
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
  const heartbeatFreshMinutes = Number(
    process.env.BRIDGE_HEARTBEAT_STALE_MINUTES || 25
  );
  const notificationStaleHours = Number(
    process.env.BRIDGE_TURO_NOTIFICATION_STALE_HOURS || 12
  );

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

  const hourBucket = new Date();
  hourBucket.setMinutes(0, 0, 0);

  return [
    {
      alertKey: `bridge-turo-notifications-stale:${hourBucket.toISOString()}`,
      alertType: "bridge_turo_notifications_stale",
      severity: "urgent",
      body: `Denmark: Android bridge heartbeat is fresh, but no Turo notifications have arrived since ${
        lastTuroNotificationAt ? formatChicago(lastTuroNotificationAt) : "never"
      }. The phone may be signed out of Turo.`,
      details: {
        lastHeartbeatAt,
        lastTuroNotificationAt,
        notificationStaleHours,
      },
    },
  ];
}

async function collectDtcAlerts() {
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT DISTINCT ON (COALESCE(NULLIF(vin, ''), external_vehicle_key, dimo_token_id::text))
        id,
        service_name,
        vin,
        nickname,
        captured_at AT TIME ZONE 'America/Chicago' AS captured_at,
        vehicle_last_updated AT TIME ZONE 'America/Chicago' AS vehicle_last_updated,
        mil_on,
        qualified_dtc_list,
        dtc_count
      FROM vehicle_telemetry_snapshots
      WHERE (captured_at AT TIME ZONE 'America/Chicago') >= NOW() - INTERVAL '24 hours'
        AND (
          COALESCE(mil_on, false) = true
          OR
          COALESCE(dtc_count, 0) > 0
          OR (
            jsonb_typeof(COALESCE(qualified_dtc_list, '[]'::jsonb)) = 'array'
            AND jsonb_array_length(COALESCE(qualified_dtc_list, '[]'::jsonb)) > 0
          )
        )
      ORDER BY
        COALESCE(NULLIF(vin, ''), external_vehicle_key, dimo_token_id::text),
        COALESCE(vehicle_last_updated, captured_at) DESC NULLS LAST,
        id DESC
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

    return {
      alertKey: `dtc:${row.service_name}:${row.vin || row.id}:${dtcKey}`,
      alertType: "dtc_received",
      severity: "urgent",
      body: `Denmark: ${vehicle} reported ${codeLabel} from ${row.service_name}. Seen ${formatChicago(
        row.vehicle_last_updated || row.captured_at
      )}.`,
      details: row,
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
      t.guest_name,
      t.trip_end,
      t.workflow_stage,
      t.status
    FROM trips t
    LEFT JOIN vehicles v
      ON t.turo_vehicle_id IS NOT NULL
      AND v.turo_vehicle_id = t.turo_vehicle_id
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
    ORDER BY t.trip_end ASC
    LIMIT 10
  `);

  return rows.map((row) => {
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
  });
}

async function collectReturnedToParkingSpotAlerts() {
  const parking = getParkingSpotConfig();
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
        s.vehicle_last_updated AT TIME ZONE 'America/Chicago' AS vehicle_last_updated,
        s.location_last_updated AT TIME ZONE 'America/Chicago' AS location_last_updated,
        s.captured_at AT TIME ZONE 'America/Chicago' AS captured_at
      FROM vehicle_telemetry_snapshots s
      WHERE s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
        AND (
          COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at)
            AT TIME ZONE 'America/Chicago'
        ) >= t.trip_end - INTERVAL '6 hours'
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
      ORDER BY COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) DESC NULLS LAST,
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

async function collectFleetAlerts() {
  const groups = await Promise.all([
    collectNewTripBookedAlerts(),
    collectBridgeHeartbeatAlerts(),
    collectBridgeTuroNotificationAlerts(),
    collectDtcAlerts(),
    collectOverdueReturnAlerts(),
    collectReturnedToParkingSpotAlerts(),
  ]);
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
      `[alerts] checked reason=${reason} candidates=${alerts.length} sent=${sent} durationMs=${
        Date.now() - startedAt
      }`
    );

    return { ran: true, candidates: alerts.length, sent, results };
  } finally {
    fleetAlertsInProgress = false;
  }
}

module.exports = {
  ensureFleetAlertTables,
  runFleetAlerts,
};
