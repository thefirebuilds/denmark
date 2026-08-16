const { DateTime } = require("luxon");

function envBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseClock(value, fallback) {
  const match = String(value || fallback).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid alert clock value: ${value}`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes >= 1440) throw new Error(`Invalid alert clock value: ${value}`);
  return minutes;
}

function isWithinQuietHours(value, options = {}) {
  const zone = options.timeZone || process.env.BUSINESS_TIMEZONE || "America/Chicago";
  const time = DateTime.fromJSDate(value instanceof Date ? value : new Date(value), { zone });
  if (!time.isValid) return false;
  const start = parseClock(options.start || process.env.ALERT_QUIET_HOURS_START, "21:00");
  const end = parseClock(options.end || process.env.ALERT_QUIET_HOURS_END, "07:00");
  const current = time.hour * 60 + time.minute;
  if (start === end) return true;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function isTripWithinCriticalWindow(discoveredAt, tripStart, windowHours) {
  const discovered = new Date(discoveredAt).getTime();
  const starts = new Date(tripStart).getTime();
  const hours = Number(windowHours ?? process.env.ALERT_CRITICAL_TRIP_WINDOW_HOURS ?? 10);
  return Number.isFinite(discovered) && Number.isFinite(starts) && Number.isFinite(hours) &&
    starts >= discovered && starts - discovered <= hours * 60 * 60 * 1000;
}

function getPhysicalAlertConfig() {
  return {
    mqtt: {
      enabled: envBoolean(process.env.MQTT_ENABLED, false),
      url: String(process.env.MQTT_URL || "").trim(),
      username: String(process.env.MQTT_USERNAME || "").trim() || undefined,
      password: String(process.env.MQTT_PASSWORD || "").trim() || undefined,
      clientId: String(process.env.MQTT_CLIENT_ID || "denmark").trim(),
    },
    defaultDeviceId: String(process.env.ALERT_DEFAULT_DEVICE_ID || "bedroom").trim(),
    quietHoursStart: process.env.ALERT_QUIET_HOURS_START || "21:00",
    quietHoursEnd: process.env.ALERT_QUIET_HOURS_END || "07:00",
    criticalTripWindowHours: Number(process.env.ALERT_CRITICAL_TRIP_WINDOW_HOURS || 10),
    businessTimeZone: process.env.BUSINESS_TIMEZONE || "America/Chicago",
    heartbeatIntervalMs: 30000,
  };
}

module.exports = { envBoolean, getPhysicalAlertConfig, isWithinQuietHours, isTripWithinCriticalWindow };
