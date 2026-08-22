const { DateTime } = require("luxon");

const SETTINGS_KEY = "alerts.physical_booking";
const DEFAULT_BOOKING_ALERT_SETTINGS = {
  enabled: true,
  startTime: "21:00",
  endTime: "07:00",
  pickupLeadHours: 10,
};

function normalizeClock(value, fallback) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${match[1]}:${match[2]}` : fallback;
}

function normalizeBookingAlertSettings(value = {}) {
  const leadHours = Number(value.pickupLeadHours);
  return {
    enabled: value.enabled !== false,
    startTime: normalizeClock(value.startTime, DEFAULT_BOOKING_ALERT_SETTINGS.startTime),
    endTime: normalizeClock(value.endTime, DEFAULT_BOOKING_ALERT_SETTINGS.endTime),
    pickupLeadHours: Number.isFinite(leadHours)
      ? Math.max(0.25, Math.min(168, leadHours))
      : DEFAULT_BOOKING_ALERT_SETTINGS.pickupLeadHours,
  };
}

function isBookingAlertEligible(trip, settings, now = new Date(), timeZone = "America/Chicago") {
  const policy = normalizeBookingAlertSettings(settings);
  if (!policy.enabled || !trip?.trip_start) return false;

  const current = DateTime.fromJSDate(now instanceof Date ? now : new Date(now), { zone: timeZone });
  const pickup = DateTime.fromJSDate(new Date(trip.trip_start), { zone: timeZone });
  if (!current.isValid || !pickup.isValid) return false;

  const minutesNow = current.hour * 60 + current.minute;
  const [startHour, startMinute] = policy.startTime.split(":").map(Number);
  const [endHour, endMinute] = policy.endTime.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const withinTime = start === end
    ? true
    : start < end
      ? minutesNow >= start && minutesNow < end
      : minutesNow >= start || minutesNow < end;
  const hoursUntilPickup = pickup.diff(current, "hours").hours;

  return withinTime && hoursUntilPickup >= 0 && hoursUntilPickup <= policy.pickupLeadHours;
}

module.exports = {
  SETTINGS_KEY,
  DEFAULT_BOOKING_ALERT_SETTINGS,
  normalizeBookingAlertSettings,
  isBookingAlertEligible,
};
