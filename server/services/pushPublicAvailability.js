const crypto = require("crypto");
const { getPublicAvailability } = require("./publicAvailability");

function maskSecret(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return "configured";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function getPublicAvailabilityIngestLabel(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "configured ingest URL";
  }
}

function createAvailabilityPushError(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  return error;
}

function getPublicAvailabilityExportConfig() {
  const ingestUrl = process.env.PUBLIC_AVAILABILITY_INGEST_URL || "";
  const bearerToken = process.env.PUBLIC_AVAILABILITY_BEARER_TOKEN || "";
  const hmacSecret = process.env.PUBLIC_AVAILABILITY_HMAC_SECRET || "";

  return {
    pull: {
      enabled: true,
      method: "GET",
      endpoint: "/api/public/availability",
      auth: "public route",
      payloadShape: {
        ok: "boolean",
        updatedAt: "ISO timestamp",
        vehicles: "VehicleAvailability[]",
      },
    },
    push: {
      enabled: Boolean(ingestUrl && bearerToken && hmacSecret),
      method: "POST",
      ingestUrl: ingestUrl || null,
      configured: {
        PUBLIC_AVAILABILITY_INGEST_URL: Boolean(ingestUrl),
        PUBLIC_AVAILABILITY_BEARER_TOKEN: Boolean(bearerToken),
        PUBLIC_AVAILABILITY_HMAC_SECRET: Boolean(hmacSecret),
      },
      secrets: {
        bearerToken: maskSecret(bearerToken),
        hmacSecret: maskSecret(hmacSecret),
      },
      headers: [
        "Content-Type: application/json",
        "Authorization: Bearer <PUBLIC_AVAILABILITY_BEARER_TOKEN>",
        "X-Denmark-Timestamp: <ISO timestamp>",
        "X-Denmark-Signature: sha256=<HMAC(timestamp.body)>",
      ],
      payloadShape: {
        updatedAt: "ISO timestamp",
        source: "denmark-node",
        vehicles: "VehicleAvailability[]",
      },
    },
    cadence: [
      {
        trigger: "server startup",
        mode: "push",
        note: "Runs once during scheduler startup when push env vars are configured.",
      },
      {
        trigger: "trip status or workflow stage changes",
        mode: "push",
        note: "Runs after trip updates that can affect public availability.",
      },
      {
        trigger: "manual trip creation",
        mode: "push",
        note: "Runs after a trip is created from the trip summary tools.",
      },
      {
        trigger: "vehicle service status changes",
        mode: "push",
        note: "Runs when a vehicle is marked in or out of service.",
      },
      {
        trigger: "website request",
        mode: "pull",
        note: "A website can request the live JSON endpoint at any time.",
      },
    ],
    vehicleShape: {
      vehicleId: "string | number | null",
      turoVehicleId: "string | number | null",
      nickname: "string | null",
      displayName: "string",
      imageUrl: "string | null",
      imageAlt: "string | null",
      status: "available_now | available_until_next_booking | unavailable_until_current_trip_ends | unavailable | fully_unavailable_in_window",
      label: "string",
      nextAvailableDate: "YYYY-MM-DD | null",
      nextAvailableLabel: "string | null",
      nextBookedStart: "YYYY-MM-DD | null",
      nextBookedDateTime: "ISO timestamp | null",
      nextBookedLabel: "string | null",
      availableDates: "YYYY-MM-DD[]",
      unavailableDates: "YYYY-MM-DD[]",
      unavailableRanges: "{ start, end, reason }[]",
      publicAdvanceNoticeHours: "number | null",
      shortPreBookingWindow: "boolean | null",
      typicalDailyRate:
        "{ low, high, label, sampleSize, rawSampleSize, filteredOutlierCount, lookbackDays, method, guestPriceMultiplier } | null",
      updatedAt: "ISO timestamp",
    },
  };
}

async function pushPublicAvailabilitySnapshot() {
  const url = process.env.PUBLIC_AVAILABILITY_INGEST_URL;
  const bearerToken = process.env.PUBLIC_AVAILABILITY_BEARER_TOKEN;
  const hmacSecret = process.env.PUBLIC_AVAILABILITY_HMAC_SECRET;

  if (!url || !bearerToken || !hmacSecret) {
    throw createAvailabilityPushError(
      "Missing PUBLIC_AVAILABILITY_* environment variables",
      {
        configured: {
          PUBLIC_AVAILABILITY_INGEST_URL: Boolean(url),
          PUBLIC_AVAILABILITY_BEARER_TOKEN: Boolean(bearerToken),
          PUBLIC_AVAILABILITY_HMAC_SECRET: Boolean(hmacSecret),
        },
      }
    );
  }

  const vehicles = await getPublicAvailability();

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "denmark-node",
    vehicles,
  };

  const timestamp = new Date().toISOString();
  const rawBody = JSON.stringify(payload);
  const ingestUrl = getPublicAvailabilityIngestLabel(url);

  const signature = crypto
    .createHmac("sha256", hmacSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
      "X-Denmark-Timestamp": timestamp,
      "X-Denmark-Signature": `sha256=${signature}`,
    },
    body: rawBody,
  });

  const text = await response.text();

  if (!response.ok) {
    const bodyPreview = text ? text.slice(0, 500) : "";
    throw createAvailabilityPushError(
      `Availability push failed: ${response.status} ${response.statusText || ""}`.trim(),
      {
        ingestUrl,
        status: response.status,
        statusText: response.statusText || null,
        contentType: response.headers.get("content-type") || null,
        bodyPreview,
        payloadBytes: Buffer.byteLength(rawBody, "utf8"),
        vehicleCount: vehicles.length,
      }
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, raw: text };
  }
}

async function pushPublicAvailabilitySnapshotSafe(reason = "unspecified") {
  try {
    const result = await pushPublicAvailabilitySnapshot();
    console.log(`[availability] push ok | reason=${reason}`);
    return result;
  } catch (error) {
    console.error(
      `[availability] push failed | reason=${reason} error=${error?.message || error}`
    );
    return null;
  }
}

module.exports = {
  getPublicAvailabilityExportConfig,
  pushPublicAvailabilitySnapshot,
  pushPublicAvailabilitySnapshotSafe,
};
