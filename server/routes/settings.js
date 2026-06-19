// ------------------------------------------------------------
// /server/routes/settings.js
// Small JSON-backed application settings API.
// ------------------------------------------------------------

const express = require("express");
const pool = require("../db");
const { getPublicAvailability } = require("../services/publicAvailability");
const {
  getPublicAvailabilityExportConfig,
  pushPublicAvailabilitySnapshot,
} = require("../services/pushPublicAvailability");
const {
  getDefaultLocationSettings,
  normalizeLocationSettings,
  SETTINGS_KEY: LOCATION_SETTINGS_KEY,
} = require("../services/locations/locationSettings");
const {
  PUBLIC_BASE_URL_KEY,
  GOOGLE_CALLBACK_PATH_KEY,
  DEFAULT_GOOGLE_CALLBACK_PATH,
  computeGoogleRedirectUri,
  normalizePublicBaseUrl,
  normalizeGoogleCallbackPath,
  loadAuthPublicUrlSettings,
  saveAuthPublicUrlSettings,
} = require("../services/authPublicUrlSettings");
const {
  SETTINGS_KEY: GOOGLE_CALENDAR_SETTINGS_KEY,
  DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS,
  normalizeGoogleCalendarSyncSettings,
} = require("../services/googleCalendar/googleCalendarSyncSettings");
const {
  DEFAULT_BRIDGE_ALERT_SETTINGS,
  normalizeBridgeAlertSettings,
} = require("../services/alerts/bridgeAlertSettings");
const {
  SETTINGS_KEY: SMS_ALERT_SETTINGS_KEY,
  DEFAULT_SMS_ALERT_SETTINGS,
  normalizeSmsAlertSettings,
  sanitizeSmsAlertSettings,
  getEffectiveSmsAlertSettings,
  saveSmsAlertSettings,
} = require("../services/alerts/smsAlertSettings");
const { sendSms } = require("../services/alerts/twilioSms");

const router = express.Router();

const DEFAULT_EXPENSE_CATEGORIES = [
  "Vehicle Onboard",
  "Operating Expense",
  "Maintenance",
  "Insurance",
  "Cleaning",
  "Interest",
  "Fuel",
  "Tools",
  "Tolls",
  "Tires",
  "Hospitality",
  "Parking",
  "Research / Travel",
  "Delivery",
  "Marketing",
];

const DEFAULT_SETTINGS = {
  "ui.dispatch": {
    openTripsSort: "priority",
    pinOverdue: true,
    showCanceled: false,
    visibleBuckets: {
      needs_closeout: true,
      in_progress: true,
      unconfirmed: true,
      upcoming: true,
      canceled: false,
      closed: false,
    },
    bucketOrder: [
      "needs_closeout",
      "in_progress",
      "unconfirmed",
      "upcoming",
      "canceled",
      "closed",
    ],
  },
  "expenses.categories": {
    categories: DEFAULT_EXPENSE_CATEGORIES,
  },
  "alerts.bridge": DEFAULT_BRIDGE_ALERT_SETTINGS,
  [SMS_ALERT_SETTINGS_KEY]: DEFAULT_SMS_ALERT_SETTINGS,
  [GOOGLE_CALENDAR_SETTINGS_KEY]: DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS,
  [LOCATION_SETTINGS_KEY]: getDefaultLocationSettings(),
  [PUBLIC_BASE_URL_KEY]: {
    publicBaseUrl: "",
  },
  [GOOGLE_CALLBACK_PATH_KEY]: {
    googleCallbackPath: DEFAULT_GOOGLE_CALLBACK_PATH,
  },
};

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function defaultForKey(key) {
  return DEFAULT_SETTINGS[key] || {};
}

function mergeSettings(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultForKey(key);
  }

  const merged = {
    ...defaultForKey(key),
    ...value,
  };

  if (key === "ui.dispatch") {
    const defaults = defaultForKey(key);
    merged.visibleBuckets = {
      ...(defaults.visibleBuckets || {}),
      ...(value.visibleBuckets || {}),
    };

    if (!value.visibleBuckets && value.showCanceled !== undefined) {
      merged.visibleBuckets.canceled = Boolean(value.showCanceled);
    }

    merged.showCanceled = Boolean(merged.visibleBuckets.canceled);
  }

  if (key === "expenses.categories") {
    const incoming = Array.isArray(value.categories)
      ? value.categories
      : Array.isArray(value)
        ? value
        : [];
    const categories = Array.from(
      new Set(
        incoming
          .map((category) => String(category || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));

    return {
      categories: categories.length ? categories : DEFAULT_EXPENSE_CATEGORIES,
    };
  }

  if (key === "alerts.bridge") {
    return normalizeBridgeAlertSettings(value);
  }

  if (key === SMS_ALERT_SETTINGS_KEY) {
    return normalizeSmsAlertSettings(value);
  }

  if (key === GOOGLE_CALENDAR_SETTINGS_KEY) {
    return normalizeGoogleCalendarSyncSettings(value);
  }

  if (key === LOCATION_SETTINGS_KEY) {
    return normalizeLocationSettings(value);
  }

  if (key === PUBLIC_BASE_URL_KEY) {
    return {
      publicBaseUrl: normalizePublicBaseUrl(
        typeof value === "string"
          ? value
          : value.publicBaseUrl || value.url || "",
        { allowEmpty: true }
      ),
    };
  }

  if (key === GOOGLE_CALLBACK_PATH_KEY) {
    return {
      googleCallbackPath: normalizeGoogleCallbackPath(
        typeof value === "string"
          ? value
          : value.googleCallbackPath ||
              value.callbackPath ||
              DEFAULT_GOOGLE_CALLBACK_PATH
      ),
    };
  }

  return merged;
}

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT key, value, updated_at
      FROM app_settings
      ORDER BY key ASC
    `);

    const settings = { ...DEFAULT_SETTINGS };

    for (const row of rows) {
      settings[row.key] = mergeSettings(row.key, row.value);
    }

    if (settings[SMS_ALERT_SETTINGS_KEY]) {
      settings[SMS_ALERT_SETTINGS_KEY] = sanitizeSmsAlertSettings(
        settings[SMS_ALERT_SETTINGS_KEY],
        { source: "database" }
      );
    }

    res.json({ settings });
  } catch (err) {
    console.error("GET /api/settings failed:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.get("/public-availability-export", async (req, res) => {
  try {
    const config = getPublicAvailabilityExportConfig();
    const vehicles = await getPublicAvailability();
    const sampleVehicle = vehicles[0] || null;

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      vehicleCount: vehicles.length,
      ...config,
      sampleVehicle,
    });
  } catch (err) {
    console.error("GET /api/settings/public-availability-export failed:", err);
    res.status(500).json({ error: "Failed to load public availability export info" });
  }
});

router.post("/public-availability-export/push", async (req, res) => {
  try {
    const config = getPublicAvailabilityExportConfig();

    if (!config.push.enabled) {
      return res.status(400).json({
        error: "Missing one or more PUBLIC_AVAILABILITY_* environment variables",
        configured: config.push.configured,
      });
    }

    const result = await pushPublicAvailabilitySnapshot();

    res.json({
      ok: true,
      pushedAt: new Date().toISOString(),
      result,
    });
  } catch (err) {
    console.error("POST /api/settings/public-availability-export/push failed:", err);
    res.status(502).json({
      error: err.message || "Failed to push public availability export",
      details: err.details || null,
    });
  }
});

router.get("/auth/public-url", async (req, res) => {
  try {
    const settings = await loadAuthPublicUrlSettings();
    res.json({
      key: "auth.public_url",
      value: settings,
    });
  } catch (err) {
    console.error("GET /api/settings/auth/public-url failed:", err);
    res.status(500).json({ error: "Failed to load auth public URL settings" });
  }
});

router.put("/auth/public-url", async (req, res) => {
  try {
    const input = req.body?.value || req.body || {};
    const settings = await saveAuthPublicUrlSettings({
      publicBaseUrl: input.publicBaseUrl,
      googleCallbackPath: input.googleCallbackPath,
    });

    res.json({
      key: "auth.public_url",
      value: {
        ...settings,
        googleRedirectUri: computeGoogleRedirectUri(
          settings.publicBaseUrl,
          settings.googleCallbackPath
        ),
      },
    });
  } catch (err) {
    console.error("PUT /api/settings/auth/public-url failed:", err);
    res.status(400).json({
      error: err.message || "Failed to save auth public URL settings",
    });
  }
});

router.get(`/${SMS_ALERT_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await getEffectiveSmsAlertSettings();
    res.json({
      key: SMS_ALERT_SETTINGS_KEY,
      value: sanitizeSmsAlertSettings(settings, { source: settings.source }),
      updated_at: null,
    });
  } catch (err) {
    console.error("GET /api/settings/alerts.sms failed:", err);
    res.status(500).json({ error: "Failed to load SMS alert settings" });
  }
});

router.put(`/${SMS_ALERT_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await saveSmsAlertSettings(req.body?.value ?? req.body);
    res.json({
      key: SMS_ALERT_SETTINGS_KEY,
      value: sanitizeSmsAlertSettings(settings, { source: "database" }),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("PUT /api/settings/alerts.sms failed:", err);
    res.status(500).json({ error: "Failed to save SMS alert settings" });
  }
});

router.post(`/${SMS_ALERT_SETTINGS_KEY}/test`, async (req, res) => {
  try {
    const delivery = await sendSms(
      `Denmark test text from ${
        req.hostname || "this tenant"
      } at ${new Date().toLocaleString("en-US", {
        timeZone: "America/Chicago",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })}.`
    );

    if (delivery.skipped) {
      return res.status(409).json({
        ok: false,
        skipped: true,
        reason: delivery.reason || "sms skipped",
      });
    }

    return res.json({
      ok: delivery.ok === true,
      sid: delivery.sid || null,
      status: delivery.status || null,
    });
  } catch (err) {
    console.error("POST /api/settings/alerts.sms/test failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Failed to send test SMS",
    });
  }
});

router.get("/:key", async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);

    if (!key) {
      return res.status(400).json({ error: "Setting key is required" });
    }

    const { rows } = await pool.query(
      `
      SELECT key, value, updated_at
      FROM app_settings
      WHERE key = $1
      LIMIT 1
      `,
      [key]
    );

    const row = rows[0] || null;

    res.json({
      key,
      value: mergeSettings(key, row?.value),
      updated_at: row?.updated_at || null,
    });
  } catch (err) {
    console.error("GET /api/settings/:key failed:", err);
    res.status(500).json({ error: "Failed to load setting" });
  }
});

router.put("/:key", async (req, res) => {
  try {
    const key = normalizeKey(req.params.key);
    const value = mergeSettings(key, req.body?.value ?? req.body);

    if (!key) {
      return res.status(400).json({ error: "Setting key is required" });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = NOW()
      RETURNING key, value, updated_at
      `,
      [key, JSON.stringify(value)]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /api/settings/:key failed:", err);
    res.status(500).json({ error: "Failed to save setting" });
  }
});

module.exports = router;
