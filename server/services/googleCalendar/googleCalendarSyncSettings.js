const pool = require("../../db");

const SETTINGS_KEY = "integrations.google_calendar";
const DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS = {
  syncEnabled: true,
};

function normalizeGoogleCalendarSyncSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS };
  }

  return {
    ...DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS,
    syncEnabled: value.syncEnabled !== false,
  };
}

async function getGoogleCalendarSyncSettings() {
  const result = await pool.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [SETTINGS_KEY]
  );

  return normalizeGoogleCalendarSyncSettings(result.rows[0]?.value);
}

async function isGoogleCalendarSyncEnabled() {
  const settings = await getGoogleCalendarSyncSettings();
  return settings.syncEnabled !== false;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_GOOGLE_CALENDAR_SYNC_SETTINGS,
  normalizeGoogleCalendarSyncSettings,
  getGoogleCalendarSyncSettings,
  isGoogleCalendarSyncEnabled,
};
