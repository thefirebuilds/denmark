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
  SETTINGS_KEY: VOLTAGE_ALERT_SETTINGS_KEY,
  DEFAULT_VOLTAGE_ALERT_SETTINGS,
  normalizeVoltageAlertSettings,
} = require("../services/alerts/voltageAlertSettings");
const {
  SETTINGS_KEY: SMS_ALERT_SETTINGS_KEY,
  DEFAULT_SMS_ALERT_SETTINGS,
  normalizeSmsAlertSettings,
  sanitizeSmsAlertSettings,
  getEffectiveSmsAlertSettings,
  saveSmsAlertSettings,
} = require("../services/alerts/smsAlertSettings");
const { sendSms } = require("../services/alerts/twilioSms");
const {
  SETTINGS_KEY: INTEGRATION_ENABLEMENT_KEY,
  DEFAULT_INTEGRATION_ENABLEMENT,
  normalizeIntegrationEnablement,
  getIntegrationEnablement,
  saveIntegrationEnablement,
} = require("../services/integrations/integrationSettings");
const {
  SETTINGS_KEY: IMAP_SETTINGS_KEY,
  DEFAULT_IMAP_SETTINGS,
  normalizeImapSettings,
  sanitizeImapSettings,
  getEffectiveImapSettings,
  saveImapSettings,
  testImapConnection,
} = require("../services/integrations/imapSettings");
const {
  SETTINGS_KEY: TOLL_SETTINGS_KEY,
  DEFAULT_TOLL_SETTINGS,
  normalizeTollSettings,
  sanitizeTollSettings,
  getEffectiveTollSettings,
  saveTollSettings,
  hasCompleteTollCredentials,
} = require("../services/integrations/tollSettings");
const { fetchTollTransactions } = require("../services/tolls/client");

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
  [VOLTAGE_ALERT_SETTINGS_KEY]: DEFAULT_VOLTAGE_ALERT_SETTINGS,
  [SMS_ALERT_SETTINGS_KEY]: DEFAULT_SMS_ALERT_SETTINGS,
  [INTEGRATION_ENABLEMENT_KEY]: DEFAULT_INTEGRATION_ENABLEMENT,
  [IMAP_SETTINGS_KEY]: DEFAULT_IMAP_SETTINGS,
  [TOLL_SETTINGS_KEY]: DEFAULT_TOLL_SETTINGS,
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

  if (key === VOLTAGE_ALERT_SETTINGS_KEY) {
    return normalizeVoltageAlertSettings(value);
  }

  if (key === SMS_ALERT_SETTINGS_KEY) {
    return normalizeSmsAlertSettings(value);
  }

  if (key === INTEGRATION_ENABLEMENT_KEY) {
    return normalizeIntegrationEnablement(value);
  }

  if (key === IMAP_SETTINGS_KEY) {
    return normalizeImapSettings(value);
  }

  if (key === TOLL_SETTINGS_KEY) {
    return normalizeTollSettings(value);
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

async function countRows(tableName, whereClause = "") {
  const safeTable = String(tableName || "").replace(/[^a-zA-Z0-9_]/g, "");
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS count FROM public.${safeTable} ${whereClause}`
  );
  return Number(rows[0]?.count || 0);
}

function checklistStatus(ok, { optional = false, skipped = false } = {}) {
  if (skipped) return "skipped";
  if (ok) return "ready";
  return optional ? "optional" : "needs_attention";
}

function summarizeProviderError(err, fallback = "Provider test failed") {
  const raw = String(err?.message || err || fallback)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
  const firstLine = raw.split("\n").find((line) => line.trim());
  return firstLine || fallback;
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

    if (settings[IMAP_SETTINGS_KEY]) {
      settings[IMAP_SETTINGS_KEY] = sanitizeImapSettings(settings[IMAP_SETTINGS_KEY], {
        source: "database",
      });
    }

    if (settings[TOLL_SETTINGS_KEY]) {
      settings[TOLL_SETTINGS_KEY] = sanitizeTollSettings(settings[TOLL_SETTINGS_KEY], {
        source: "database",
      });
    }

    res.json({ settings });
  } catch (err) {
    console.error("GET /api/settings failed:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.get("/setup/checklist", async (req, res) => {
  try {
    const [
      vehicles,
      users,
      activeUsers,
      trips,
      messages,
      settingsRows,
      imapSettings,
      integrationEnablement,
      effectiveSmsSettings,
    ] = await Promise.all([
      countRows("vehicles", "WHERE COALESCE(is_active, true) = true"),
      countRows("app_users"),
      countRows("app_users", "WHERE is_active = true"),
      countRows("trips"),
      countRows("messages"),
      pool.query(
        `
          SELECT key, value
          FROM app_settings
          WHERE key = ANY($1::text[])
        `,
        [[PUBLIC_BASE_URL_KEY, GOOGLE_CALENDAR_SETTINGS_KEY, "alerts.bridge", SMS_ALERT_SETTINGS_KEY]]
      ),
      getEffectiveImapSettings(),
      getIntegrationEnablement(),
      getEffectiveSmsAlertSettings(),
    ]);

    const settingsByKey = new Map(settingsRows.rows.map((row) => [row.key, row.value]));
    const publicBaseUrl = String(
      settingsByKey.get(PUBLIC_BASE_URL_KEY)?.publicBaseUrl || ""
    ).trim();
    const googleCalendarSettings = normalizeGoogleCalendarSyncSettings(
      settingsByKey.get(GOOGLE_CALENDAR_SETTINGS_KEY) || {}
    );
    const bridgeSettings = normalizeBridgeAlertSettings(
      settingsByKey.get("alerts.bridge") || {}
    );
    const smsSettings = effectiveSmsSettings;

    const items = [
      {
        key: "public_url",
        label: "Public app URL",
        status: checklistStatus(Boolean(publicBaseUrl)),
        detail: publicBaseUrl || "Set Settings > Authentication before Google sign-in.",
        section: "auth",
      },
      {
        key: "users",
        label: "Owner/user access",
        status: checklistStatus(activeUsers > 0),
        detail: `${activeUsers} active user${activeUsers === 1 ? "" : "s"} (${users} total)`,
        section: "users",
      },
      {
        key: "fleet",
        label: "Fleet vehicles",
        status: checklistStatus(vehicles > 0),
        detail: `${vehicles} active vehicle${vehicles === 1 ? "" : "s"}`,
        section: "fleet",
      },
      {
        key: "imap",
        label: "Turo email intake",
        status: checklistStatus(imapSettings.configured, {
          skipped: integrationEnablement.imap === false || imapSettings.enabled === false,
        }),
        detail:
          integrationEnablement.imap === false || imapSettings.enabled === false
            ? "Disabled"
            : imapSettings.configured
              ? `Configured from ${imapSettings.source}`
              : "Add IMAP settings or intentionally disable email intake.",
        section: "messages",
      },
      {
        key: "trips_messages",
        label: "Trip/message data",
        status: checklistStatus(trips > 0 || messages > 0, { optional: true }),
        detail: `${trips} trips | ${messages} messages`,
        section: "dispatch",
      },
      {
        key: "calendar",
        label: "Google Calendar",
        status: checklistStatus(googleCalendarSettings.syncEnabled !== false, {
          skipped:
            integrationEnablement.googleCalendar === false ||
            googleCalendarSettings.syncEnabled === false,
          optional: true,
        }),
        detail:
          integrationEnablement.googleCalendar === false ||
          googleCalendarSettings.syncEnabled === false
            ? "Disabled for this tenant"
            : "Enabled; connect Google in Integrations.",
        section: "integrations",
      },
      {
        key: "bridge",
        label: "Android notification bridge",
        status: checklistStatus(bridgeSettings.enabled !== false, {
          skipped: bridgeSettings.enabled === false,
          optional: true,
        }),
        detail:
          bridgeSettings.enabled === false
            ? "Disabled"
            : "Enabled; configure phone bridge if this tenant uses it.",
        section: "alerts",
      },
      {
        key: "sms",
        label: "SMS alerts",
        status: checklistStatus(smsSettings.enabled !== false && smsSettings.configured, {
          skipped: smsSettings.enabled === false,
          optional: true,
        }),
        detail:
          smsSettings.enabled === false
            ? "Disabled"
            : smsSettings.configured
              ? "Configured"
              : "Optional; configure Twilio or disable SMS.",
        section: "alerts",
      },
      {
        key: "backup",
        label: "Backup and restore",
        status: "optional",
        detail: "Create a first tenant backup after setup is complete.",
        section: "backup",
      },
    ];

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        ready: items.filter((item) => item.status === "ready").length,
        needsAttention: items.filter((item) => item.status === "needs_attention").length,
        skipped: items.filter((item) => item.status === "skipped").length,
        optional: items.filter((item) => item.status === "optional").length,
      },
      items,
    });
  } catch (err) {
    console.error("GET /api/settings/setup/checklist failed:", err);
    res.status(500).json({ error: "Failed to load setup checklist" });
  }
});

router.get(`/${INTEGRATION_ENABLEMENT_KEY}`, async (req, res) => {
  try {
    res.json({
      key: INTEGRATION_ENABLEMENT_KEY,
      value: await getIntegrationEnablement(),
      updated_at: null,
    });
  } catch (err) {
    console.error("GET /api/settings/integrations.enabled failed:", err);
    res.status(500).json({ error: "Failed to load integration switches" });
  }
});

router.put(`/${INTEGRATION_ENABLEMENT_KEY}`, async (req, res) => {
  try {
    const value = await saveIntegrationEnablement(req.body?.value ?? req.body);
    res.json({
      key: INTEGRATION_ENABLEMENT_KEY,
      value,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("PUT /api/settings/integrations.enabled failed:", err);
    res.status(500).json({ error: "Failed to save integration switches" });
  }
});

router.get(`/${IMAP_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await getEffectiveImapSettings();
    res.json({
      key: IMAP_SETTINGS_KEY,
      value: sanitizeImapSettings(settings, { source: settings.source }),
      updated_at: null,
    });
  } catch (err) {
    console.error("GET /api/settings/integrations.imap failed:", err);
    res.status(500).json({ error: "Failed to load IMAP settings" });
  }
});

router.put(`/${IMAP_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await saveImapSettings(req.body?.value ?? req.body);
    res.json({
      key: IMAP_SETTINGS_KEY,
      value: sanitizeImapSettings(settings, { source: "database" }),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("PUT /api/settings/integrations.imap failed:", err);
    res.status(500).json({ error: "Failed to save IMAP settings" });
  }
});

router.post(`/${IMAP_SETTINGS_KEY}/test`, async (req, res) => {
  try {
    const current = await getEffectiveImapSettings();
    const rawInput =
      req.body?.value && typeof req.body.value === "object"
        ? req.body.value
        : req.body || {};
    const requestedPass = rawInput.pass;
    const preservePassword =
      requestedPass === undefined ||
      requestedPass === null ||
      String(requestedPass).trim() === "" ||
      requestedPass === "__KEEP__";
    const input = normalizeImapSettings(
      {
        ...rawInput,
        pass: preservePassword ? current.pass : requestedPass,
      },
      current
    );
    const testSettings = {
      ...current,
      ...input,
    };
    const result = await testImapConnection(testSettings);
    res.json(result);
  } catch (err) {
    console.error("POST /api/settings/integrations.imap/test failed:", err);
    res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Failed to test IMAP settings",
    });
  }
});

router.get(`/${TOLL_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await getEffectiveTollSettings();
    res.json({
      key: TOLL_SETTINGS_KEY,
      value: sanitizeTollSettings(settings, { source: settings.source }),
      updated_at: null,
    });
  } catch (err) {
    console.error("GET /api/settings/integrations.tolls failed:", err);
    res.status(500).json({ error: "Failed to load toll settings" });
  }
});

router.put(`/${TOLL_SETTINGS_KEY}`, async (req, res) => {
  try {
    const settings = await saveTollSettings(req.body?.value ?? req.body);
    res.json({
      key: TOLL_SETTINGS_KEY,
      value: sanitizeTollSettings(settings, { source: "database" }),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("PUT /api/settings/integrations.tolls failed:", err);
    res.status(500).json({ error: "Failed to save toll settings" });
  }
});

router.post(`/${TOLL_SETTINGS_KEY}/test`, async (req, res) => {
  let browserResult = null;
  try {
    const current = await getEffectiveTollSettings();
    const rawInput =
      req.body?.value && typeof req.body.value === "object"
        ? req.body.value
        : req.body || {};
    const requestedPassword = rawInput.password;
    const requestedSalt = rawInput.fingerprintSalt;
    const preservePassword =
      requestedPassword === undefined ||
      requestedPassword === null ||
      String(requestedPassword).trim() === "" ||
      requestedPassword === "__KEEP__";
    const preserveSalt =
      requestedSalt === undefined ||
      requestedSalt === null ||
      String(requestedSalt).trim() === "" ||
      requestedSalt === "__KEEP__" ||
      requestedSalt === "__CONFIGURED__";
    const input = normalizeTollSettings(
      {
        ...rawInput,
        password: preservePassword ? current.password : requestedPassword,
        fingerprintSalt: preserveSalt ? current.fingerprintSalt : requestedSalt,
      },
      current
    );
    const testSettings = {
      ...current,
      ...input,
    };

    if (testSettings.enabled === false) {
      return res.status(409).json({
        ok: false,
        error: "Toll integration is disabled for this tenant",
      });
    }

    if (!hasCompleteTollCredentials(testSettings)) {
      return res.status(400).json({
        ok: false,
        error:
          "Toll provider login URL, activity URL, API pattern, username, and password are required",
      });
    }

    browserResult = await fetchTollTransactions(testSettings);
    const records = Array.isArray(browserResult.records) ? browserResult.records : [];
    const first = records[0] || null;

    res.json({
      ok: true,
      provider: testSettings.provider,
      providerLabel: testSettings.providerLabel,
      activityUrl: testSettings.activityUrl,
      activityApiPattern: testSettings.activityApiPattern,
      recordsSeen: records.length,
      recordsUnfiltered: browserResult.recordsUnfiltered ?? records.length,
      lookbackDays: testSettings.lookbackDays,
      sample: first
        ? {
            trxnDate: first.trxnDate || null,
            postedDate: first.postedDate || null,
            licensePlate: first.licensePlate || null,
            amount: first.amount ?? null,
            agencyName: first.agencyName || null,
            transType: first.transType || null,
          }
        : null,
    });
  } catch (err) {
    console.error("POST /api/settings/integrations.tolls/test failed:", err);
    res.status(err.status || 502).json({
      ok: false,
      error: summarizeProviderError(err, "Failed to test toll provider settings"),
      recordsSeen: browserResult?.records?.length || 0,
    });
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
