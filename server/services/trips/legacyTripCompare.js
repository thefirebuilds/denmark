// --------------------------------------------------------------
// server/services/trips/legacyTripCompare.js
// Compare normalized Denmark 1.0 and Denmark 2.0 trips and
// produce a reconciliation report keyed by reservation_id.
// --------------------------------------------------------------

const {
  cleanString,
} = require("./legacyTripNormalizer");

const TIME_DIFF_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
const MONEY_DIFF_TOLERANCE = 0.009;

function isNil(value) {
  return value === null || value === undefined;
}

function areStringsEqual(a, b) {
  return cleanString(a) === cleanString(b);
}

function areNumbersEqual(a, b, tolerance = MONEY_DIFF_TOLERANCE) {
  if (isNil(a) && isNil(b)) return true;
  if (isNil(a) || isNil(b)) return false;
  return Math.abs(Number(a) - Number(b)) <= tolerance;
}

function areIntegersEqual(a, b) {
  if (isNil(a) && isNil(b)) return true;
  return Number(a) === Number(b);
}

function areBooleansEqual(a, b) {
  if (isNil(a) && isNil(b)) return true;
  return a === b;
}

function areTimestampsEqual(a, b) {
  if (isNil(a) && isNil(b)) return true;
  if (isNil(a) || isNil(b)) return false;

  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();

  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
  return Math.abs(aMs - bMs) <= TIME_DIFF_TOLERANCE_MS;
}

function buildSuggestedUpdates(legacy, d2) {
  const updates = {};

  if (!d2) return updates;

  if (!d2.guest_name && legacy.guest_name) {
    updates.guest_name = legacy.guest_name;
  }

  if (!d2.trip_start && legacy.trip_start) {
    updates.trip_start = legacy.trip_start;
  }

  if (!d2.trip_end && legacy.trip_end) {
    updates.trip_end = legacy.trip_end;
  }

  if (isNil(d2.amount) || Number(d2.amount) === 0) {
    if (!isNil(legacy.amount)) {
      updates.amount = legacy.amount;
    }
  }

  if (isNil(d2.starting_odometer) && !isNil(legacy.starting_odometer)) {
    updates.starting_odometer = legacy.starting_odometer;
  }

  if (isNil(d2.ending_odometer) && !isNil(legacy.ending_odometer)) {
    updates.ending_odometer = legacy.ending_odometer;
  }

  if ((!d2.expense_status || d2.expense_status === "none") && legacy.expense_status) {
    updates.expense_status = legacy.expense_status;
  }

  if (legacy.normalized_stage === "canceled") {
    if (d2.normalized_stage !== "canceled") {
      updates.workflow_stage = "canceled";
    }
    if (!d2.canceled_at && legacy.canceled_at) {
      updates.canceled_at = legacy.canceled_at;
    }
    if (d2.closed_out !== true) {
      updates.closed_out = true;
    }
    if (!d2.closed_out_at && legacy.canceled_at) {
      updates.closed_out_at = legacy.canceled_at;
    }
  }

  if (legacy.normalized_stage === "complete") {
    if (d2.normalized_stage !== "complete") {
      updates.workflow_stage = "complete";
    }
    if (!d2.completed_at && legacy.completed_at) {
      updates.completed_at = legacy.completed_at;
    }
    if (d2.closed_out !== true) {
      updates.closed_out = true;
    }
    if (!d2.closed_out_at && legacy.completed_at) {
      updates.closed_out_at = legacy.completed_at;
    }
  }

  return updates;
}

function toDateOnlyString(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function areTripEndsEquivalent(legacyEnd, d2End) {
  if (isNil(legacyEnd) && isNil(d2End)) return true;
  if (isNil(legacyEnd) || isNil(d2End)) return false;

  if (areTimestampsEqual(legacyEnd, d2End)) return true;

  const legacyDate = toDateOnlyString(legacyEnd);
  const d2Date = toDateOnlyString(d2End);

  if (!legacyDate || !d2Date) return false;

  const legacyMs = new Date(`${legacyDate}T00:00:00.000Z`).getTime();
  const d2Ms = new Date(`${d2Date}T00:00:00.000Z`).getTime();
  const diffDays = Math.abs((d2Ms - legacyMs) / 86400000);

  // treat next-day rollover as equivalent
  return diffDays <= 1;
}

function shouldSyncLegacyTollToD2(legacy, d2) {
  const legacyToll = Number(legacy?.toll_reimbursement ?? 0);
  const d2Toll = Number(d2?.toll_total ?? 0);

  if (!Number.isFinite(legacyToll) || legacyToll <= 0) return false;
  if (!Number.isFinite(d2Toll)) return true;

  return d2Toll === 0 || d2Toll < legacyToll;
}

function compareTrips(legacy, d2) {
  if (!legacy && !d2) {
    throw new Error("compareTrips received neither legacy nor d2 trip");
  }

  const reservationId = legacy?.reservation_id || d2?.reservation_id || null;

  if (!legacy) {
    return {
      reservation_id: reservationId,
      compare_status: "missing_in_legacy",
      delta_fields: [],
      safe_to_sync: false,
      suggested_updates: {},
      legacy: null,
      d2,
    };
  }

  if (!d2) {
    return {
      reservation_id: reservationId,
      compare_status: "missing_in_d2",
      delta_fields: ["missing_trip"],
      safe_to_sync: false,
      suggested_updates: {},
      legacy,
      d2: null,
    };
  }

  const deltaFields = [];

  if (!areStringsEqual(legacy.guest_name, d2.guest_name)) {
    deltaFields.push("guest_name");
  }

  if (!areStringsEqual(legacy.normalized_stage, d2.normalized_stage)) {
    deltaFields.push("workflow_stage");
  }

  if (!areTimestampsEqual(legacy.trip_start, d2.trip_start)) {
    deltaFields.push("trip_start");
  }

  if (!areTripEndsEquivalent(legacy.trip_end, d2.trip_end)) {
    deltaFields.push("trip_end");
  }

  if (!areNumbersEqual(legacy.amount, d2.amount)) {
    deltaFields.push("amount");
  }

    if (shouldSyncLegacyTollToD2(legacy, d2)) {
    deltaFields.push("toll_total");
  }

  if (!areIntegersEqual(legacy.starting_odometer, d2.starting_odometer)) {
    deltaFields.push("starting_odometer");
  }

  if (!areIntegersEqual(legacy.ending_odometer, d2.ending_odometer)) {
    deltaFields.push("ending_odometer");
  }

  if (!areStringsEqual(legacy.expense_status, d2.expense_status)) {
    deltaFields.push("expense_status");
  }

    if (
    (legacy.normalized_stage === "complete" || legacy.normalized_stage === "canceled" ||
      d2.normalized_stage === "complete" || d2.normalized_stage === "canceled") &&
    !areBooleansEqual(legacy.closed_out, d2.closed_out)
  ) {
    deltaFields.push("closed_out");
  }

  if (
    legacy.normalized_stage === "complete" &&
    d2.normalized_stage === "complete" &&
    !areTimestampsEqual(legacy.completed_at, d2.completed_at)
  ) {
    deltaFields.push("completed_at");
  }

  if (!areTimestampsEqual(legacy.canceled_at, d2.canceled_at)) {
    if (legacy.normalized_stage === "canceled" || d2.normalized_stage === "canceled") {
      deltaFields.push("canceled_at");
    }
  }

    const suggestedUpdates = buildSuggestedUpdates(legacy, d2);
  const safeUpdateFields = Object.keys(suggestedUpdates);

  const isLegacyTerminal =
    legacy.normalized_stage === "complete" ||
    legacy.normalized_stage === "canceled";

  const isD2Terminal =
    d2.normalized_stage === "complete" ||
    d2.normalized_stage === "canceled";

  const hasOnlyFillUpdates = safeUpdateFields.every((field) =>
    [
      "guest_name",
      "amount",
      "starting_odometer",
      "ending_odometer",
      "expense_status",
      "completed_at",
      "canceled_at",
      "closed_out",
      "closed_out_at",
    ].includes(field)
  );

  const safeToSync =
    safeUpdateFields.length > 0 &&
    isLegacyTerminal &&
    (
      legacy.normalized_stage === "canceled" ||
      (legacy.normalized_stage === "complete" && isD2Terminal) ||
      hasOnlyFillUpdates
    );

  return {
    reservation_id: reservationId,
    compare_status: deltaFields.length ? "field_mismatch" : "match",
    delta_fields: deltaFields,
    safe_to_sync: safeToSync,
    suggested_updates: suggestedUpdates,
    legacy,
    d2,
  };
}

function getTripCompletenessScore(trip) {
  if (!trip) return 0;

  return (
    (trip.guest_name ? 2 : 0) +
    (trip.trip_start ? 2 : 0) +
    (trip.trip_end ? 2 : 0) +
    (!isNil(trip.amount) && Number(trip.amount) !== 0 ? 3 : 0) +
    (!isNil(trip.starting_odometer) ? 3 : 0) +
    (!isNil(trip.ending_odometer) ? 3 : 0) +
    (trip.expense_status && trip.expense_status !== "none" ? 2 : 0) +
    (trip.notes ? 1 : 0) +
    (trip.repair_notes ? 1 : 0) +
    (trip.closed_out === true ? 2 : 0) +
    (trip.completed_at ? 2 : 0)
  );
}

function getStagePriority(trip) {
  const stage = trip?.normalized_stage || "unknown";

  switch (stage) {
    case "complete":
      return 5;
    case "awaiting_expenses":
      return 4;
    case "turnaround":
      return 3;
    case "in_progress":
      return 2;
    case "confirmed":
      return 1;
    case "booked":
      return 0;
    case "canceled":
      return -2;
    default:
      return -1;
  }
}

function getTripFreshnessValue(trip) {
  const value =
    trip?.raw?.updated_at ||
    trip?.raw?.updated_on ||
    trip?.raw?.completed_at ||
    trip?.raw?.canceled_at ||
    trip?.raw?.trip_end ||
    trip?.raw?.end_at ||
    trip?.raw?.created_at ||
    trip?.raw?.created_on ||
    0;

  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function pickPreferredTrip(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aStagePriority = getStagePriority(a);
  const bStagePriority = getStagePriority(b);

  if (aStagePriority !== bStagePriority) {
    return bStagePriority > aStagePriority ? b : a;
  }

  const aCompleteness = getTripCompletenessScore(a);
  const bCompleteness = getTripCompletenessScore(b);

  if (aCompleteness !== bCompleteness) {
    return bCompleteness > aCompleteness ? b : a;
  }

  const aFreshness = getTripFreshnessValue(a);
  const bFreshness = getTripFreshnessValue(b);

  if (aFreshness !== bFreshness) {
    return bFreshness > aFreshness ? b : a;
  }

  return Number(b.id || 0) > Number(a.id || 0) ? b : a;
}

function indexTripsByReservationId(trips, sourceName = "unknown") {
  const map = new Map();
  const duplicates = [];

  for (const trip of trips) {
    if (!trip?.reservation_id) continue;

    if (!map.has(trip.reservation_id)) {
      map.set(trip.reservation_id, trip);
      continue;
    }

    const existing = map.get(trip.reservation_id);
    const preferred = pickPreferredTrip(existing, trip);
    const rejected = preferred === existing ? trip : existing;

    map.set(trip.reservation_id, preferred);

    duplicates.push({
      source: sourceName,
      reservation_id: trip.reservation_id,

      kept_id: preferred?.id ?? null,
      dropped_id: rejected?.id ?? null,

      kept_stage: preferred?.normalized_stage ?? null,
      dropped_stage: rejected?.normalized_stage ?? null,

      kept_amount: preferred?.amount ?? null,
      dropped_amount: rejected?.amount ?? null,

      kept_starting_odometer: preferred?.starting_odometer ?? null,
      dropped_starting_odometer: rejected?.starting_odometer ?? null,

      kept_ending_odometer: preferred?.ending_odometer ?? null,
      dropped_ending_odometer: rejected?.ending_odometer ?? null,

      kept_trip_start: preferred?.trip_start ?? null,
      dropped_trip_start: rejected?.trip_start ?? null,

      kept_trip_end: preferred?.trip_end ?? null,
      dropped_trip_end: rejected?.trip_end ?? null,
    });
  }

  return { map, duplicates };
}

function summarizeResults(rows, duplicates = []) {
  const summary = {
    total: rows.length,
    match: 0,
    field_mismatch: 0,
    missing_in_d2: 0,
    missing_in_legacy: 0,
    safe_to_sync: 0,
    duplicate_rows: duplicates.length,
  };

  for (const row of rows) {
    if (summary[row.compare_status] !== undefined) {
      summary[row.compare_status] += 1;
    }
    if (row.safe_to_sync) summary.safe_to_sync += 1;
  }

  return summary;
}

function buildDeltaFieldCounts(rows) {
  const counts = {};

  for (const row of rows) {
    for (const field of row.delta_fields || []) {
      counts[field] = (counts[field] || 0) + 1;
    }
  }

  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
}

function reconcileTrips({ legacyTrips, d2Trips }) {
  const legacyIndexed = indexTripsByReservationId(legacyTrips, "legacy");
  const d2Indexed = indexTripsByReservationId(d2Trips, "d2");

  const legacyMap = legacyIndexed.map;
  const d2Map = d2Indexed.map;
  const duplicates = [...legacyIndexed.duplicates, ...d2Indexed.duplicates];

  const allReservationIds = new Set([
    ...legacyMap.keys(),
    ...d2Map.keys(),
  ]);

  const rows = [];

  for (const reservationId of [...allReservationIds].sort()) {
    const legacy = legacyMap.get(reservationId) || null;
    const d2 = d2Map.get(reservationId) || null;
    rows.push(compareTrips(legacy, d2));
  }

  return {
    generated_at: new Date().toISOString(),
    summary: summarizeResults(rows, duplicates),
    delta_field_counts: buildDeltaFieldCounts(rows),
    duplicates,
    rows,
  };
}

module.exports = {
  reconcileTrips,
  compareTrips,
  summarizeResults,
  buildDeltaFieldCounts,
};