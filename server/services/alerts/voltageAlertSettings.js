const pool = require("../../db");

const SETTINGS_KEY = "alerts.voltage";
const DEFAULT_VOLTAGE_ALERT_SETTINGS = {
  enabled: true,
  boardEnabled: true,
  smsEnabled: true,
  lowVoltageThreshold: 12.2,
};

function coerceNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeVoltageAlertSettings(value = {}) {
  return {
    enabled: value.enabled !== false,
    boardEnabled: value.boardEnabled ?? value.board_enabled ?? true,
    smsEnabled: value.smsEnabled ?? value.sms_enabled ?? true,
    lowVoltageThreshold: coerceNumber(
      value.lowVoltageThreshold ??
        value.low_voltage_threshold ??
        process.env.BATTERY_LOW_VOLTAGE_THRESHOLD,
      DEFAULT_VOLTAGE_ALERT_SETTINGS.lowVoltageThreshold,
      10,
      13.5
    ),
  };
}

async function getVoltageAlertSettings() {
  const { rows } = await pool.query(
    "SELECT value FROM app_settings WHERE key = $1 LIMIT 1",
    [SETTINGS_KEY]
  );

  return normalizeVoltageAlertSettings(rows[0]?.value || {});
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_VOLTAGE_ALERT_SETTINGS,
  normalizeVoltageAlertSettings,
  getVoltageAlertSettings,
};
