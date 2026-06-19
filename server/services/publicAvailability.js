const pool = require("../db");
const {
  ensureVehicleAliasesTable,
} = require("./vehicles/vehicleAliases");

const LONG_TERM_DAYS = 28;
const AVAILABILITY_WINDOW_DAYS = 90;
const MIN_PUBLIC_BOOKING_GAP_HOURS = 48;
const PUBLIC_ADVANCE_NOTICE_HOURS = Number(
  process.env.PUBLIC_AVAILABILITY_ADVANCE_NOTICE_HOURS || 12
);
const PUBLIC_TIME_ZONE = "America/Chicago";
const DAILY_RATE_LOOKBACK_DAYS = Number(
  process.env.PUBLIC_AVAILABILITY_RATE_LOOKBACK_DAYS || 180
);
const PUBLIC_RATE_GUEST_PRICE_MULTIPLIER = 1.15;

const VEHICLE_IMAGE_BY_NICKNAME = {
  geneva: "/images/geneva.jpg",
};

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

function formatPublicDateTime(date) {
  if (!date) return null;

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

function getTripCalendarDays(trip) {
  if (!trip?.start || !trip?.end) return 0;

  const startKey = formatDateKey(trip.start);
  const endKey = formatDateKey(trip.end);
  if (!startKey || !endKey) return 0;

  return getDateKeysBetweenInclusive(
    parseDateKeyToUtcMidday(startKey),
    parseDateKeyToUtcMidday(endKey)
  ).length;
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];

  const index = (sortedValues.length - 1) * percentileValue;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function getTypicalRateBand(rates) {
  if (rates.length < 4) {
    return {
      bandRates: rates,
      sampleSize: rates.length,
      filteredOutlierCount: 0,
      method: "full_sample",
    };
  }

  const q1 = percentile(rates, 0.25);
  const q3 = percentile(rates, 0.75);
  const iqr = q3 - q1;
  const lowerFence = iqr > 0 ? q1 - iqr * 1.5 : q1;
  const upperFence = iqr > 0 ? q3 + iqr * 1.5 : q3;
  const withoutOutliers = rates.filter(
    (rate) => rate >= lowerFence && rate <= upperFence
  );
  const usableRates = withoutOutliers.length >= 3 ? withoutOutliers : rates;

  if (usableRates.length < 5) {
    return {
      bandRates: usableRates,
      sampleSize: usableRates.length,
      filteredOutlierCount: rates.length - usableRates.length,
      method: "iqr",
    };
  }

  return {
    bandRates: [
      percentile(usableRates, 0.2),
      percentile(usableRates, 0.8),
    ].sort((a, b) => a - b),
    sampleSize: usableRates.length,
    filteredOutlierCount: rates.length - usableRates.length,
    method: "iqr_middle_60",
  };
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

function normalizeVehicleLookupValue(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return text || null;
}

function compactLookupKeys(keys) {
  return Array.from(
    new Set(
      keys
        .map((key) => (key == null || key === "" ? null : String(key)))
        .filter(Boolean)
    )
  );
}

function getVehicleLookupKeys(vehicle) {
  const nickname = normalizeVehicleLookupValue(vehicle?.nickname);
  const turoName = normalizeVehicleLookupValue(vehicle?.turo_vehicle_name);
  const displayName = normalizeVehicleLookupValue(getVehicleDisplayName(vehicle));

  return compactLookupKeys([
    vehicle?.id,
    vehicle?.turo_vehicle_id,
    nickname ? `name:${nickname}` : null,
    turoName ? `name:${turoName}` : null,
    displayName ? `name:${displayName}` : null,
  ]);
}

function getTripLookupKeys(trip) {
  const vehicleName = normalizeVehicleLookupValue(trip?.vehicle_name);
  const resolvedName = normalizeVehicleLookupValue(trip?.resolved_vehicle_name);
  const resolvedTuroName = normalizeVehicleLookupValue(trip?.resolved_turo_vehicle_name);

  return compactLookupKeys([
    chooseVehicleTripKey(trip),
    trip?.vehicle_id,
    trip?.turo_vehicle_id,
    vehicleName ? `name:${vehicleName}` : null,
    resolvedName ? `name:${resolvedName}` : null,
    resolvedTuroName ? `name:${resolvedTuroName}` : null,
  ]);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getVehicleImageUrl(vehicle) {
  const nickname = String(vehicle?.nickname || "").trim();
  const key = nickname.toLowerCase();
  if (VEHICLE_IMAGE_BY_NICKNAME[key]) return VEHICLE_IMAGE_BY_NICKNAME[key];

  const slug = slugify(nickname);
  return slug ? `/images/${slug}.jpg` : null;
}

function getVehicleDisplayName(vehicle) {
  return (
    vehicle.nickname ||
    vehicle.turo_vehicle_name ||
    [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") ||
    vehicle.vin ||
    "Vehicle"
  );
}

function buildVehiclePublicMetadata(vehicle) {
  const displayName = getVehicleDisplayName(vehicle);
  const imageUrl = getVehicleImageUrl(vehicle);

  return {
    vehicleId: vehicle.id ?? null,
    turoVehicleId: vehicle.turo_vehicle_id ?? null,
    nickname: vehicle.nickname ?? null,
    displayName,
    imageUrl,
    imageAlt: imageUrl ? `${displayName} rental car` : null,
  };
}

function getTypicalDailyRate(trips, now) {
  const lookbackStart = new Date(
    now.getTime() - DAILY_RATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const rates = trips
    .filter((trip) => {
      if (!trip?.start || !trip?.end) return false;
      if (trip.end > now) return false;
      if (trip.end < lookbackStart) return false;
      if (trip.canceledAt || trip.deletedAt) return false;
      if (trip.status === "canceled" || trip.status === "cancelled") return false;
      if (
        trip.workflowStage === "canceled" ||
        trip.workflowStage === "cancelled" ||
        trip.workflowStage === "deleted"
      ) {
        return false;
      }
      return Number(trip.amount || 0) > 0;
    })
    .map((trip) => {
      const days = getTripCalendarDays(trip);
      if (!days) return null;
      const rate = Number(trip.amount || 0) / days;
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    })
    .filter((rate) => rate != null)
    .sort((a, b) => a - b);

  if (!rates.length) return null;

  const typicalBand = getTypicalRateBand(rates);
  const low = Math.round(
    typicalBand.bandRates[0] * PUBLIC_RATE_GUEST_PRICE_MULTIPLIER
  );
  const high = Math.round(
    typicalBand.bandRates[typicalBand.bandRates.length - 1] *
      PUBLIC_RATE_GUEST_PRICE_MULTIPLIER
  );

  return {
    low,
    high,
    label: low === high ? `Typical rate: $${low}/day` : `Typical rate: $${low}-$${high}/day`,
    sampleSize: typicalBand.sampleSize,
    rawSampleSize: rates.length,
    filteredOutlierCount: typicalBand.filteredOutlierCount,
    lookbackDays: DAILY_RATE_LOOKBACK_DAYS,
    method: typicalBand.method,
    guestPriceMultiplier: PUBLIC_RATE_GUEST_PRICE_MULTIPLIER,
  };
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

function getHoursBetween(start, end) {
  if (!start || !end) return null;
  return (end.getTime() - start.getTime()) / (1000 * 60 * 60);
}

function getFirstAvailableDateAfter(calendar, date) {
  const cutoffKey = formatDateKey(date);
  if (!cutoffKey) return null;

  return calendar.availableDates.find((key) => key > cutoffKey) || null;
}

function buildVehicleStatus(vehicle, trips, now) {
  const activeTrip = trips.find((trip) => isTripActiveNow(trip, now));
  const futureTrips = trips
    .filter((trip) => isFutureTrip(trip, now))
    .sort((a, b) => a.start - b.start);

  const calendar = buildAvailabilityCalendar(trips);
  const typicalDailyRate = getTypicalDailyRate(trips, now);
  const nextAvailableDateKey = calendar.availableDates[0] || null;
  const nextBookedTrip = futureTrips[0] || null;
  const nextBookedStartKey = nextBookedTrip?.start
    ? formatDateKey(nextBookedTrip.start)
    : null;
  const nextBookedLabel = nextBookedTrip?.start
    ? `Next Booking: ${formatPublicDateTime(nextBookedTrip.start)}`
    : null;
  const nextAvailabilityAfterBookingKey = nextBookedTrip?.end
    ? getFirstAvailableDateAfter(calendar, nextBookedTrip.end)
    : null;
  const hoursUntilNextBooking = nextBookedTrip?.start
    ? getHoursBetween(now, nextBookedTrip.start)
    : null;
  const hasShortPreBookingWindow =
    hoursUntilNextBooking != null &&
    hoursUntilNextBooking >= 0 &&
    hoursUntilNextBooking < Math.max(
      PUBLIC_ADVANCE_NOTICE_HOURS,
      MIN_PUBLIC_BOOKING_GAP_HOURS
    );
  const window = getDateWindow();
  const fullWindowUnavailableDates = getDateKeysBetweenInclusive(window.start, window.end);

  if (vehicle.in_service === false) {
    return {
      ...buildVehiclePublicMetadata(vehicle),
      status: "unavailable",
      label: "Unavailable",
      nextAvailableDate: null,
      availableDates: [],
      unavailableDates: fullWindowUnavailableDates,
      unavailableRanges: [
        {
          start: formatDateKey(window.start),
          end: formatDateKey(window.end),
          reason: "maintenance_mode",
        },
      ],
      updatedAt: now.toISOString(),
      typicalDailyRate,
    };
  }

  if (activeTrip && isLongTermTrip(activeTrip)) {
    return {
      ...buildVehiclePublicMetadata(vehicle),
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
      typicalDailyRate,
    };
  }

  if (activeTrip) {
    return {
      ...buildVehiclePublicMetadata(vehicle),
      status: "unavailable_until_current_trip_ends",
      label: nextAvailableDateKey
        ? `Next Available: ${formatPublicDate(parseDateKeyToUtcMidday(nextAvailableDateKey))}`
        : "Currently Unavailable",
      nextAvailableDate: nextAvailableDateKey,
      availableDates: calendar.availableDates,
      unavailableDates: calendar.unavailableDates,
      unavailableRanges: calendar.unavailableRanges,
      updatedAt: now.toISOString(),
      typicalDailyRate,
    };
  }

  if (calendar.availableDates.length) {
    if (hasShortPreBookingWindow && nextBookedStartKey) {
      return {
        ...buildVehiclePublicMetadata(vehicle),
        status: "available_until_next_booking",
        label: nextBookedLabel || "Booked Soon",
        nextAvailableDate: nextAvailabilityAfterBookingKey || nextAvailableDateKey,
        nextAvailableLabel: nextAvailabilityAfterBookingKey
          ? `Next Availability: ${formatPublicDate(
              parseDateKeyToUtcMidday(nextAvailabilityAfterBookingKey)
            )}`
          : null,
        availableDates: calendar.availableDates,
        unavailableDates: calendar.unavailableDates,
        unavailableRanges: calendar.unavailableRanges,
        updatedAt: now.toISOString(),
        nextBookedStart: nextBookedStartKey,
        nextBookedDateTime: nextBookedTrip?.start?.toISOString() || null,
        nextBookedLabel,
        publicAdvanceNoticeHours: PUBLIC_ADVANCE_NOTICE_HOURS,
        shortPreBookingWindow: true,
        typicalDailyRate,
      };
    }

    return {
      ...buildVehiclePublicMetadata(vehicle),
      status: "available_now",
      label: "Available Now",
      nextAvailableDate: nextAvailableDateKey,
      nextAvailableLabel: nextAvailableDateKey
        ? `Next Availability: ${formatPublicDate(
            parseDateKeyToUtcMidday(nextAvailableDateKey)
          )}`
        : null,
      availableDates: calendar.availableDates,
      unavailableDates: calendar.unavailableDates,
      unavailableRanges: calendar.unavailableRanges,
      updatedAt: now.toISOString(),
      nextBookedStart: nextBookedStartKey,
      nextBookedDateTime: nextBookedTrip?.start?.toISOString() || null,
      nextBookedLabel,
      publicAdvanceNoticeHours: PUBLIC_ADVANCE_NOTICE_HOURS,
      shortPreBookingWindow: false,
      typicalDailyRate,
    };
  }

  return {
    ...buildVehiclePublicMetadata(vehicle),
    status: "fully_unavailable_in_window",
    label: "No Availability In Next 90 Days",
    nextAvailableDate: null,
    availableDates: [],
    unavailableDates: calendar.unavailableDates,
    unavailableRanges: calendar.unavailableRanges,
    updatedAt: now.toISOString(),
    typicalDailyRate,
  };
}

async function getVehicles() {
  const sql = `
    SELECT
      id,
      turo_vehicle_id,
      turo_vehicle_name,
      nickname,
      vin,
      year,
      make,
      model,
      in_service
    FROM vehicles
    ORDER BY nickname NULLS LAST, id
  `;

  const { rows } = await pool.query(sql);
  return rows;
}

async function getRelevantTrips() {
  await ensureVehicleAliasesTable();

  const sql = `
    SELECT
      t.id,
      resolved_vehicle.id AS vehicle_id,
      t.guest_name,
      t.status,
      t.workflow_stage,
      t.trip_start,
      t.trip_end,
      t.vehicle_name,
      t.amount,
      t.closed_out,
      t.closed_out_at,
      t.completed_at,
      t.canceled_at,
      t.deleted_at,
      resolved_vehicle.nickname AS resolved_vehicle_name,
      resolved_vehicle.turo_vehicle_name AS resolved_turo_vehicle_name,
      COALESCE(t.turo_vehicle_id, resolved_vehicle.turo_vehicle_id) AS turo_vehicle_id
    FROM trips t
    LEFT JOIN LATERAL (
      SELECT v.id, v.turo_vehicle_id, v.nickname, v.turo_vehicle_name
      FROM vehicles v
      WHERE (
        t.turo_vehicle_id IS NOT NULL
        AND v.turo_vehicle_id = t.turo_vehicle_id
      )
      OR (
        COALESCE(t.vehicle_name, '') <> ''
        AND LOWER(v.nickname) = LOWER(t.vehicle_name)
      )
      OR (
        COALESCE(t.vehicle_name, '') <> ''
        AND LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER(t.vehicle_name)
      )
      OR EXISTS (
        SELECT 1
        FROM vehicle_aliases va
        WHERE va.vehicle_id = v.id
          AND va.active = true
          AND COALESCE(t.vehicle_name, '') <> ''
          AND LOWER(va.alias) = LOWER(t.vehicle_name)
      )
      ORDER BY
        CASE
          WHEN t.turo_vehicle_id IS NOT NULL AND v.turo_vehicle_id = t.turo_vehicle_id THEN 1
          WHEN COALESCE(t.vehicle_name, '') <> '' AND LOWER(v.nickname) = LOWER(t.vehicle_name) THEN 2
          WHEN COALESCE(t.vehicle_name, '') <> '' AND LOWER(COALESCE(v.turo_vehicle_name, '')) = LOWER(t.vehicle_name) THEN 3
          ELSE 4
        END
      LIMIT 1
    ) resolved_vehicle ON true
    WHERE t.deleted_at IS NULL
      AND (
        t.trip_end >= NOW() - INTERVAL '7 days'
        OR t.trip_start >= NOW() - INTERVAL '7 days'
        OR t.trip_end >= NOW() - ($1::int * INTERVAL '1 day')
      )
    ORDER BY t.trip_start ASC
  `;

  const { rows } = await pool.query(sql, [DAILY_RATE_LOOKBACK_DAYS]);
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
    const keys = getTripLookupKeys(trip);
    if (!keys.length) continue;

    for (const key of keys) {
      if (!tripsByVehicle.has(key)) {
        tripsByVehicle.set(key, []);
      }
      tripsByVehicle.get(key).push(trip);
    }
  }

  return vehicles.map((vehicle) => {
    const vehicleTripsById = new Map();
    for (const key of getVehicleLookupKeys(vehicle)) {
      for (const trip of tripsByVehicle.get(key) || []) {
        vehicleTripsById.set(trip.id, trip);
      }
    }

    return buildVehicleStatus(vehicle, [...vehicleTripsById.values()], now);
  });
}

module.exports = {
  getPublicAvailability,
};
