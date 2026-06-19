const pool = require("../../db");

const SETTINGS_KEY = "alerts.bridge";
const DEFAULT_BRIDGE_ALERT_SETTINGS = {
  enabled: true,
  heartbeatStaleMinutes: 25,
  turoNotificationStaleHours: 12,
};

function coerceNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeBridgeAlertSettings(value = {}) {
  return {
    enabled: value.enabled !== false,
    heartbeatStaleMinutes: coerceNumber(
      value.heartbeatStaleMinutes ??
        value.heartbeat_stale_minutes ??
        process.env.BRIDGE_HEARTBEAT_STALE_MINUTES,
      DEFAULT_BRIDGE_ALERT_SETTINGS.heartbeatStaleMinutes,
      5,
      240
    ),
    turoNotificationStaleHours: coerceNumber(
      value.turoNotificationStaleHours ??
        value.turo_notification_stale_hours ??
        process.env.BRIDGE_TURO_NOTIFICATION_STALE_HOURS,
      DEFAULT_BRIDGE_ALERT_SETTINGS.turoNotificationStaleHours,
      1,
      168
    ),
  };
}

async function getBridgeAlertSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );

  return normalizeBridgeAlertSettings(rows[0]?.value || {});
}

async function isAndroidBridgeEnabled() {
  const settings = await getBridgeAlertSettings();
  return settings.enabled !== false;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_BRIDGE_ALERT_SETTINGS,
  normalizeBridgeAlertSettings,
  getBridgeAlertSettings,
  isAndroidBridgeEnabled,
};
