const crypto = require("crypto");
const express = require("express");
const pool = require("../db");
const {
  syncTripToSelectedGoogleCalendars,
} = require("../services/googleCalendar/googleTripSync");

const router = express.Router();

let ensureNotificationEventsTablePromise = null;
let hasWarnedAboutMissingBridgeSecret = false;

function cleanString(value, { maxLength = 4000, allowEmpty = true } = {}) {
  if (value == null) return allowEmpty ? "" : null;

  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";

  const normalized = text.replace(/\u0000/g, "").trim();
  if (!normalized && !allowEmpty) return null;
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength);
}

function parsePostedAtMs(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function buildFallbackEventHash(payload) {
  const parts = [
    cleanString(payload?.package),
    cleanString(payload?.title),
    cleanString(payload?.body),
    cleanString(payload?.big_text),
    cleanString(payload?.sub_text),
    String(parsePostedAtMs(payload?.posted_at_ms) ?? ""),
    cleanString(payload?.notification_key),
  ];

  return crypto.createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function buildSearchText(event) {
  return [
    cleanString(event?.title),
    cleanString(event?.body),
    cleanString(event?.big_text),
    cleanString(event?.sub_text),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesAny(text, phrases = []) {
  return phrases.some((phrase) => text.includes(phrase));
}

function classifyTuroNotification(event) {
  const text = buildSearchText(event);
  const source = cleanString(event?.source).toLowerCase();

  if (source === "android_bridge_heartbeat") {
    return "bridge_heartbeat";
  }
  if (
    source === "android_notification_test" ||
    includesAny(text, ["denmark bridge test"])
  ) {
    return "bridge_test";
  }

  if (
    includesAny(text, [
      "partner offer",
      "your tint quote is ready",
      "review your options and enroll",
      "save up to",
      "as compared to personal insurance",
      "grow your business",
    ])
  ) {
    return "partner_offer";
  }

  if (
    includesAny(text, [
      "earnings payment",
      "your earnings are on the way",
      "cha-ching",
      "you’ve been paid",
      "you've been paid",
    ])
  ) {
    return "payment_notice";
  }

  if (
    includesAny(text, [
      "reimbursement invoice",
      "paid the invoice",
      "paid your reimbursement",
      "paid now",
    ])
  ) {
    return "reimbursement_invoice";
  }

  if (
    includesAny(text, [
      "booking request",
      "requested your car",
      "new request",
      "trip request",
    ])
  ) {
    return "booking_request";
  }

  if (includesAny(text, ["cancelled", "canceled"])) {
    return "trip_cancelled";
  }

  if (
    includesAny(text, [
      "changed",
      "updated",
      "modified",
      "new trip time",
      "trip update",
      "change requested",
    ])
  ) {
    return "trip_changed";
  }

  if (includesAny(text, ["rated their trip", "return the favor"])) {
    return "trip_rated";
  }

  if (
    includesAny(text, [
      "has added a driver",
      "additional driver",
      "added another driver",
    ])
  ) {
    return "secondary_driver_added";
  }

  if (
    includesAny(text, [
      "prepare for checkout",
      "complete checkout when your car is returned",
    ])
  ) {
    return "checkout_reminder";
  }

  if (includesAny(text, ["has returned", "view its exact location"])) {
    return "trip_returned";
  }

  if (includesAny(text, ["message", "sent you a message"])) {
    return "message";
  }

  if (
    includesAny(text, [
      "reminder",
      "starts soon",
      "ends soon",
      "check in",
      "check out",
    ])
  ) {
    return "reminder";
  }

  if (includesAny(text, ["booked", "confirmed", "new booking"])) {
    return "trip_booked";
  }

  return "unknown";
}

function extractReservationId(text) {
  const source = cleanString(text, { maxLength: 12000 });
  if (!source) return null;

  const patterns = [
    /\b(?:reservation|reservation id|reservation number|res)\s*(?:#|id|number|no\.?)?\s*(\d{6,12})\b/i,
    /\btrip\s*(?:#|id|number|no\.?)?\s*(\d{6,12})\b/i,
    /turo\.com\/reservation\/(\d{6,12})/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return Math.trunc(value);
    }
  }

  return null;
}

function extractVehicleName(text) {
  const source = cleanString(text, { maxLength: 4000 });
  if (!source) return null;

  const patterns = [
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+has returned your\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})\b/i,
    /\babout\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})\s+from\s+[A-Z][A-Za-z.'-]+/i,
    /\btrip with your\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})\b/i,
    /\babout your\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})$/i,
    /\brequested your\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})$/i,
    /\byour\s+([A-Z0-9][A-Za-z0-9 .'\-]{1,80})\s+has been\b/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) {
      return cleanString(match[2] || match[1], {
        maxLength: 120,
        allowEmpty: false,
      });
    }
  }

  return null;
}

function extractGuestName(text) {
  const source = cleanString(text, { maxLength: 4000 });
  if (!source) return null;

  const patterns = [
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+has returned your\b/i,
    /^Your trip with\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+starts soon\b/i,
    /\bfrom\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*:/i,
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+paid\b/i,
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+rated\b/i,
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+sent you a message\b/,
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+requested your car\b/,
    /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s+(?:booked|confirmed)\b/,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return cleanString(match[1], { maxLength: 120, allowEmpty: false });
  }

  return null;
}

function buildStoredEvent(payload = {}) {
  const source = cleanString(payload.source, {
    maxLength: 120,
    allowEmpty: false,
  });
  const app = cleanString(payload.app, { maxLength: 120, allowEmpty: false });
  const packageName = cleanString(payload.package, { maxLength: 255, allowEmpty: false });
  const title = cleanString(payload.title, { maxLength: 500 });
  const body = cleanString(payload.body, { maxLength: 4000 });
  const bigText = cleanString(payload.big_text, { maxLength: 12000 });
  const subText = cleanString(payload.sub_text, { maxLength: 1000 });
  const device = cleanString(payload.device, { maxLength: 255, allowEmpty: false });
  const notificationKey = cleanString(payload.notification_key, {
    maxLength: 1000,
    allowEmpty: false,
  });
  const postedAtMs = parsePostedAtMs(payload.posted_at_ms);

  if (!source) {
    return { error: "source is required" };
  }

  const raw = {
    ...payload,
    source,
    app,
    package: packageName,
    title,
    body,
    big_text: bigText,
    sub_text: subText,
    posted_at_ms: postedAtMs,
    device,
    notification_key: notificationKey,
  };

  const eventHash = cleanString(payload.event_hash, {
    maxLength: 128,
    allowEmpty: false,
  }) || buildFallbackEventHash(raw);

  const searchText = [title, body, bigText, subText].filter(Boolean).join(" ");
  const classification = classifyTuroNotification(raw);

  return {
    event: {
      source,
      app,
      packageName,
      title,
      body,
      bigText,
      subText,
      postedAtMs,
      postedAt: postedAtMs != null ? new Date(postedAtMs).toISOString() : null,
      device,
      notificationKey,
      eventHash,
      raw,
      classification,
      reservationId: extractReservationId(searchText),
      vehicleName: extractVehicleName(searchText),
      guestName: extractGuestName(searchText),
    },
  };
}

function summarizeForLog(value, maxLength = 90) {
  const text = cleanString(value, { maxLength: 1000 });
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ");
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

async function ensureNotificationEventsTable() {
  if (!ensureNotificationEventsTablePromise) {
    ensureNotificationEventsTablePromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS public.notification_events (
          id BIGSERIAL PRIMARY KEY,
          source TEXT NOT NULL,
          app TEXT,
          package_name TEXT,
          title TEXT,
          body TEXT,
          big_text TEXT,
          sub_text TEXT,
          posted_at_ms BIGINT,
          posted_at TIMESTAMPTZ,
          device TEXT,
          notification_key TEXT,
          event_hash TEXT UNIQUE,
          raw JSONB NOT NULL,
          classification TEXT,
          reservation_id BIGINT,
          vehicle_name TEXT,
          guest_name TEXT,
          processed_at TIMESTAMPTZ,
          acknowledged_at TIMESTAMPTZ,
          acknowledged_by TEXT,
          acknowledged_reason TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;

        ALTER TABLE public.notification_events
          ADD COLUMN IF NOT EXISTS acknowledged_reason TEXT;

        CREATE INDEX IF NOT EXISTS idx_notification_events_received_at
          ON public.notification_events (received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_notification_events_classification
          ON public.notification_events (classification);

        CREATE INDEX IF NOT EXISTS idx_notification_events_reservation_id
          ON public.notification_events (reservation_id);
      `)
      .catch((err) => {
        ensureNotificationEventsTablePromise = null;
        throw err;
      });
  }

  await ensureNotificationEventsTablePromise;
}

async function upsertTuroNotificationEvent(event) {
  await ensureNotificationEventsTable();

  const insertResult = await pool.query(
    `
      INSERT INTO public.notification_events (
        source,
        app,
        package_name,
        title,
        body,
        big_text,
        sub_text,
        posted_at_ms,
        posted_at,
        device,
        notification_key,
        event_hash,
        raw,
        classification,
        reservation_id,
        vehicle_name,
        guest_name,
        processed_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, NULL
      )
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING id
    `,
    [
      event.source,
      event.app,
      event.packageName,
      event.title,
      event.body,
      event.bigText,
      event.subText,
      event.postedAtMs,
      event.postedAt,
      event.device,
      event.notificationKey,
      event.eventHash,
      JSON.stringify(event.raw),
      event.classification,
      event.reservationId,
      event.vehicleName,
      event.guestName,
    ]
  );

  if (insertResult.rows[0]?.id) {
    return {
      ok: true,
      inserted: true,
      duplicate: false,
      id: insertResult.rows[0].id,
      classification: event.classification,
    };
  }

  const existingResult = await pool.query(
    `
      SELECT id, classification
      FROM public.notification_events
      WHERE event_hash = $1
      LIMIT 1
    `,
    [event.eventHash]
  );

  return {
    ok: true,
    inserted: false,
    duplicate: true,
    id: existingResult.rows[0]?.id ?? null,
    classification:
      existingResult.rows[0]?.classification || event.classification,
  };
}

async function findTripForReturnedNotification(event) {
  if (event.classification !== "trip_returned") return null;

  const guestName = cleanString(event.guestName, {
    maxLength: 120,
    allowEmpty: false,
  });
  const vehicleName = cleanString(event.vehicleName, {
    maxLength: 120,
    allowEmpty: false,
  });

  if (!guestName && !vehicleName && !event.reservationId) return null;

  const eventAt = event.postedAt || new Date().toISOString();

  const result = await pool.query(
    `
      SELECT t.id
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
      WHERE COALESCE(t.workflow_stage, '') <> 'canceled'
        AND COALESCE(t.status, '') <> 'canceled'
        AND (
          $1::bigint IS NOT NULL
          AND t.reservation_id = $1::bigint
          OR (
            $2::text <> ''
            AND (
              LOWER(COALESCE(t.guest_name, '')) = LOWER($2::text)
              OR LOWER(COALESCE(t.guest_name, '')) LIKE LOWER($2::text) || ' %'
            )
            AND t.trip_end BETWEEN $4::timestamptz - INTERVAL '3 days'
              AND $4::timestamptz + INTERVAL '36 hours'
            AND (
              $3::text = ''
              OR LOWER($3::text) LIKE '%' || LOWER(COALESCE(t.vehicle_name, '')) || '%'
              OR LOWER(COALESCE(t.vehicle_name, '')) LIKE '%' || LOWER(regexp_replace($3::text, '\\s+\\d{4}$', '')) || '%'
              OR LOWER($3::text) LIKE '%' || LOWER(COALESCE(v.nickname, '')) || '%'
              OR LOWER(COALESCE(v.nickname, '')) LIKE '%' || LOWER(regexp_replace($3::text, '\\s+\\d{4}$', '')) || '%'
            )
          )
        )
      ORDER BY
        CASE WHEN $1::bigint IS NOT NULL AND t.reservation_id = $1::bigint THEN 0 ELSE 1 END,
        t.trip_end DESC NULLS LAST,
        t.id DESC
      LIMIT 1
    `,
    [event.reservationId, guestName || "", vehicleName || "", eventAt]
  );

  return result.rows[0] || null;
}

function syncReturnedTripCalendarNotice(event, notificationId) {
  void findTripForReturnedNotification(event)
    .then(async (trip) => {
      if (!trip?.id) return;

      const result = await syncTripToSelectedGoogleCalendars(trip.id, {
        retryDeletedEvents: true,
        forceDeleteEventTypes: ["return"],
      });

      await pool.query(
        `
          UPDATE notification_events
          SET processed_at = NOW()
          WHERE id = $1
        `,
        [notificationId]
      );

      if (!result.ok) {
        console.warn(
          `[notifications/turo] returned trip ${trip.id} calendar return cleanup completed with failures`,
          result.results
        );
      }
    })
    .catch((err) => {
      console.warn(
        "[notifications/turo] returned trip calendar cleanup failed:",
        err.message || err
      );
    });
}

router.post("/turo", async (req, res) => {
  const secretHeader = cleanString(req.get("X-Denmark-Bridge-Secret"), {
    maxLength: 500,
    allowEmpty: false,
  });
  const configuredSecret = cleanString(process.env.DENMARK_BRIDGE_SECRET, {
    maxLength: 500,
    allowEmpty: false,
  });

  if (configuredSecret && secretHeader !== configuredSecret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!configuredSecret && !hasWarnedAboutMissingBridgeSecret) {
    hasWarnedAboutMissingBridgeSecret = true;
    console.warn(
      "[notifications/turo] DENMARK_BRIDGE_SECRET is not set; endpoint is unsecured"
    );
  }

  if (!req.is("application/json")) {
    return res.status(400).json({ ok: false, error: "Expected application/json payload" });
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: "Invalid notification payload" });
  }

  try {
    const { event, error } = buildStoredEvent(req.body);
    if (error) {
      return res.status(400).json({ ok: false, error });
    }

    const result = await upsertTuroNotificationEvent(event);

    if (result.inserted && result.id && result.classification === "trip_returned") {
      syncReturnedTripCalendarNotice(event, result.id);
    }

    console.log(
      `[notifications/turo] inserted=${result.inserted} duplicate=${result.duplicate} id=${result.id} class=${result.classification} device=${summarizeForLog(
        event.device || "unknown",
        40
      )} title="${summarizeForLog(event.title, 70)}" body="${summarizeForLog(
        event.body,
        90
      )}"`
    );

    return res.json(result);
  } catch (err) {
    console.error("[notifications/turo] failed:", err.message || err);
    return res.status(500).json({ ok: false, error: "Failed to store notification event" });
  }
});

module.exports = {
  router,
  ensureNotificationEventsTable,
  classifyTuroNotification,
  extractReservationId,
  extractVehicleName,
  extractGuestName,
  buildFallbackEventHash,
  upsertTuroNotificationEvent,
};
