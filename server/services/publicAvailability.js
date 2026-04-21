const pool = require("../db");

const LONG_TERM_DAYS = 28;
const AVAILABILITY_WINDOW_DAYS = 90;
const MIN_PUBLIC_BOOKING_GAP_HOURS = 48;
const PUBLIC_TIME_ZONE = "America/Chicago";

const INACTIVE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "declined",
  "expired",
  "closed",
  "completed",
  "complete",
  "ended",
  "returned",
  "finished",
]);

const INACTIVE_WORKFLOW_STAGES = new Set([
  "complete",
  "completed",
  "closed",
  "canceled",
  "cancelled",
  "deleted",
]);

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstPresent(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

function formatPublicDate(date) {
  if (!date) return null;

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: PUBLIC_TIME_ZONE,
  }).format(date);
}

function formatDateKey(date) {
  if (!date) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PUBLIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function parseDateKeyToUtcMidday(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function diffDays(start, end) {
  if (!start || !end) return 0;
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function normalizeTrip(row) {
  const start = toDate(row.trip_start);
  const end = toDate(row.trip_end);
  const status = String(row.status || "").trim().toLowerCase();
  const workflowStage = String(row.workflow_stage || "").trim().toLowerCase();

  return {
    ...row,
    start,
    end,
    status,
    workflowStage,
    closedOut: Boolean(row.closed_out),
    closedOutAt: toDate(row.closed_out_at),
    completedAt: toDate(row.completed_at),
    canceledAt: toDate(row.canceled_at),
    deletedAt: toDate(row.deleted_at),
  };
}

function isInactiveTrip(trip) {
  if (INACTIVE_STATUSES.has(trip.status)) return true;
  if (INACTIVE_WORKFLOW_STAGES.has(trip.workflowStage)) return true;
  if (trip.closedOut) return true;
  if (trip.closedOutAt) return true;
  if (trip.completedAt) return true;
  if (trip.canceledAt) return true;
  if (trip.deletedAt) return true;
  return false;
}

function isTripActiveNow(trip, now) {
  if (!trip.start || !trip.end) return false;
  if (isInactiveTrip(trip)) return false;
  return trip.start <= now && trip.end >= now;
}

function isFutureTrip(trip, now) {
  if (!trip.start) return false;
  if (isInactiveTrip(trip)) return false;
  return trip.start > now;
}

function isLongTermTrip(trip) {
  if (!trip.start || !trip.end) return false;
  return diffDays(trip.start, trip.end) >= LONG_TERM_DAYS;
}

function chooseVehicleTripKey(trip) {
  return firstPresent(trip, [
    "vehicle_id",
    "turo_vehicle_id",
    "trip_vehicle_id",
    "vehicle_turo_id",
    "car_id",
    "unit_id",
    "vehicle",
  ]);
}

function chooseVehicleKey(vehicle) {
  return firstPresent(vehicle, ["id", "turo_vehicle_id"]);
}

function getDateWindow() {
  const todayKey = formatDateKey(new Date());
  const start = parseDateKeyToUtcMidday(todayKey);
  const end = addDays(start, AVAILABILITY_WINDOW_DAYS - 1);

  return { start, end };
}

function getDateKeysBetweenInclusive(startDate, endDate) {
  const startKey = formatDateKey(startDate);
  const endKey = formatDateKey(endDate);

  if (!startKey || !endKey) return [];

  const keys = [];
  let cursor = parseDateKeyToUtcMidday(startKey);
  const end = parseDateKeyToUtcMidday(endKey);

  while (cursor <= end) {
    keys.push(formatDateKey(cursor));
    cursor = addDays(cursor, 1);
  }

  return keys;
}

function blockDateRange(unavailableKeySet, startDate, endDate) {
  const blockedKeys = getDateKeysBetweenInclusive(startDate, endDate);
  for (const key of blockedKeys) {
    unavailableKeySet.add(key);
  }
}

function getActiveCalendarTrips(trips) {
  return trips
    .filter((trip) => trip.start && trip.end && !isInactiveTrip(trip))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function blockShortBookingGaps(unavailableKeySet, trips, windowStart, windowEnd) {
  let previousTrip = null;

  for (const trip of trips) {
    if (!previousTrip) {
      previousTrip = trip;
      continue;
    }

    if (trip.end > previousTrip.end) {
      if (trip.start > previousTrip.end) {
        const gapHours =
          (trip.start.getTime() - previousTrip.end.getTime()) / (1000 * 60 * 60);

        if (gapHours < MIN_PUBLIC_BOOKING_GAP_HOURS) {
          const gapStart = previousTrip.end > windowStart ? previousTrip.end : windowStart;
          const gapEnd = trip.start < windowEnd ? trip.start : windowEnd;

          if (gapEnd >= windowStart && gapStart <= windowEnd) {
            blockDateRange(unavailableKeySet, gapStart, gapEnd);
          }
        }
      }

      previousTrip = trip;
    }
  }
}

function compressDateKeysToRanges(dateKeys, reason = "trip") {
  if (!dateKeys.length) return [];

  const sorted = [...dateKeys].sort();
  const ranges = [];

  let rangeStart = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const expectedNext = formatDateKey(addDays(parseDateKeyToUtcMidday(prev), 1));

    if (current === expectedNext) {
      prev = current;
      continue;
    }

    ranges.push({
      start: rangeStart,
      end: prev,
      reason,
    });

    rangeStart = current;
    prev = current;
  }

  ranges.push({
    start: rangeStart,
    end: prev,
    reason,
  });

  return ranges;
}

function buildAvailabilityCalendar(trips) {
  const { start: windowStart, end: windowEnd } = getDateWindow();
  const allWindowKeys = getDateKeysBetweenInclusive(windowStart, windowEnd);
  const unavailableKeySet = new Set();
  const activeCalendarTrips = getActiveCalendarTrips(trips);

  for (const trip of activeCalendarTrips) {
    const tripStart = trip.start > windowStart ? trip.start : windowStart;
    const tripEnd = trip.end < windowEnd ? trip.end : windowEnd;

    if (tripEnd < windowStart || tripStart > windowEnd) continue;

    blockDateRange(unavailableKeySet, tripStart, tripEnd);
  }

  blockShortBookingGaps(unavailableKeySet, activeCalendarTrips, windowStart, windowEnd);

  const unavailableDates = [...unavailableKeySet].sort();
  const availableDates = allWindowKeys.filter((key) => !unavailableKeySet.has(key));
  const unavailableRanges = compressDateKeysToRanges(unavailableDates, "trip");

  return {
    availableDates,
    unavailableDates,
    unavailableRanges,
  };
}

function buildVehicleStatus(vehicle, trips, now) {
  const activeTrip = trips.find((trip) => isTripActiveNow(trip, now));
  const futureTrips = trips
    .filter((trip) => isFutureTrip(trip, now))
    .sort((a, b) => a.start - b.start);

  const calendar = buildAvailabilityCalendar(trips);
  const nextAvailableDateKey = calendar.availableDates[0] || null;
  const window = getDateWindow();
  const fullWindowUnavailableDates = getDateKeysBetweenInclusive(window.start, window.end);

  if (activeTrip && isLongTermTrip(activeTrip)) {
    return {
      vehicleId: vehicle.id ?? null,
      turoVehicleId: vehicle.turo_vehicle_id ?? null,
      nickname: vehicle.nickname ?? null,
      status: "unavailable",
      label: "Long Term Trip Underway",
      nextAvailableDate: null,
      availableDates: [],
      unavailableDates: fullWindowUnavailableDates,
      unavailableRanges: [
        {
          start: formatDateKey(window.start),
          end: formatDateKey(window.end),
          reason: "long_term_trip",
        },
      ],
      updatedAt: now.toISOString(),
    };
  }

  if (activeTrip) {
    return {
      vehicleId: vehicle.id ?? null,
      turoVehicleId: vehicle.turo_vehicle_id ?? null,
      nickname: vehicle.nickname ?? null,
      status: "unavailable_until_current_trip_ends",
      label: nextAvailableDateKey
        ? `Next Available: ${formatPublicDate(parseDateKeyToUtcMidday(nextAvailableDateKey))}`
        : "Currently Unavailable",
      nextAvailableDate: nextAvailableDateKey,
      availableDates: calendar.availableDates,
      unavailableDates: calendar.unavailableDates,
      unavailableRanges: calendar.unavailableRanges,
      updatedAt: now.toISOString(),
    };
  }

  if (calendar.availableDates.length) {
    return {
      vehicleId: vehicle.id ?? null,
      turoVehicleId: vehicle.turo_vehicle_id ?? null,
      nickname: vehicle.nickname ?? null,
      status: "available_now",
      label: "Available Now",
      nextAvailableDate: nextAvailableDateKey,
      availableDates: calendar.availableDates,
      unavailableDates: calendar.unavailableDates,
      unavailableRanges: calendar.unavailableRanges,
      updatedAt: now.toISOString(),
      nextBookedStart: futureTrips[0]?.start
        ? formatDateKey(futureTrips[0].start)
        : null,
    };
  }

  return {
    vehicleId: vehicle.id ?? null,
    turoVehicleId: vehicle.turo_vehicle_id ?? null,
    nickname: vehicle.nickname ?? null,
    status: "fully_unavailable_in_window",
    label: "No Availability In Next 90 Days",
    nextAvailableDate: null,
    availableDates: [],
    unavailableDates: calendar.unavailableDates,
    unavailableRanges: calendar.unavailableRanges,
    updatedAt: now.toISOString(),
  };
}

async function getVehicles() {
  const sql = `
    SELECT
      id,
      turo_vehicle_id,
      nickname,
      vin
    FROM vehicles
    ORDER BY nickname NULLS LAST, id
  `;

  const { rows } = await pool.query(sql);
  return rows;
}

async function getRelevantTrips() {
  const sql = `
    SELECT
      id,
      guest_name,
      status,
      workflow_stage,
      trip_start,
      trip_end,
      closed_out,
      closed_out_at,
      completed_at,
      canceled_at,
      deleted_at,
      turo_vehicle_id
    FROM trips
    WHERE deleted_at IS NULL
      AND (
        trip_end >= NOW() - INTERVAL '7 days'
        OR trip_start >= NOW() - INTERVAL '7 days'
      )
    ORDER BY trip_start ASC
  `;

  const { rows } = await pool.query(sql);
  return rows.map(normalizeTrip);
}

async function getPublicAvailability() {
  const now = new Date();

  const [vehicles, trips] = await Promise.all([
    getVehicles(),
    getRelevantTrips(),
  ]);

  const tripsByVehicle = new Map();

  for (const trip of trips) {
    const key = chooseVehicleTripKey(trip);
    if (!key) continue;

    if (!tripsByVehicle.has(key)) {
      tripsByVehicle.set(key, []);
    }

    tripsByVehicle.get(key).push(trip);
  }

  return vehicles.map((vehicle) => {
    const vehicleIdKey = vehicle.id;
    const turoVehicleKey = vehicle.turo_vehicle_id;
    const fallbackKey = chooseVehicleKey(vehicle);

    const vehicleTrips =
      tripsByVehicle.get(vehicleIdKey) ||
      tripsByVehicle.get(turoVehicleKey) ||
      tripsByVehicle.get(fallbackKey) ||
      [];

    return buildVehicleStatus(vehicle, vehicleTrips, now);
  });
}

module.exports = {
  getPublicAvailability,
};
