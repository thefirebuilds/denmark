// ------------------------------------------------------------
// /src/utils/tripUtils.js
// Shared trip calculation helpers to ensure consistency across
// summary, list, and metrics views.
// ------------------------------------------------------------

const RETURNING_SOON_HOURS = 2;

export function isTripInProgress(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const status = String(trip?.status || "").toLowerCase();

  return (
    stage === "in_progress" ||
    status === "in_progress" ||
    status === "started" ||
    status === "trip_started"
  );
}

export function findVehicleForTrip(trip, vehicles = []) {
  const tripVehicleName = String(
    trip?.vehicle_name || trip?.vehicle_nickname || ""
  )
    .trim()
    .toLowerCase();

  if (!tripVehicleName) return null;

  return (
    vehicles.find((vehicle) => {
      const nickname = String(vehicle?.nickname || "")
        .trim()
        .toLowerCase();

      const turoVehicleName = String(vehicle?.turo_vehicle_name || "")
        .trim()
        .toLowerCase();

      return nickname === tripVehicleName || turoVehicleName === tripVehicleName;
    }) || null
  );
}

export function getMilesDriven(trip, vehicles = []) {
  const explicit = Number(trip?.miles_driven);
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  const start = Number(trip?.starting_odometer);
  const end = Number(trip?.ending_odometer);

  if (!Number.isFinite(start)) {
    return null;
  }

  // completed trip
  if (Number.isFinite(end) && end >= start) {
    return end - start;
  }

  // in-progress fallback to telemetry
  if (isTripInProgress(trip)) {
    const vehicle = findVehicleForTrip(trip, vehicles);
    const currentOdometer = Number(vehicle?.telemetry?.odometer);

    if (Number.isFinite(currentOdometer) && currentOdometer >= start) {
      return currentOdometer - start;
    }
  }

  return null;
}

export function getTripDays(start, end) {
  if (!start || !end) return 0;

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }

  return (endMs - startMs) / (1000 * 60 * 60 * 24);
}

function isClosedTrip(trip) {
  const status = String(trip?.status || "").toLowerCase();
  const stage = String(trip?.workflow_stage || "").toLowerCase();

  return (
    status === "completed" ||
    status === "closed" ||
    status === "finished" ||
    stage === "completed" ||
    stage === "closed"
  );
}

export function getHoursUntilTripEnd(trip) {
  const endMs = getTripEndMs(trip);
  if (!Number.isFinite(endMs) || endMs === Number.MAX_SAFE_INTEGER) return null;
  return (endMs - Date.now()) / (1000 * 60 * 60);
}

export function hasAssignedVehicle(trip) {
  return Boolean(
    trip?.vehicle_id ||
    String(trip?.vehicle_name || "").trim() ||
    String(trip?.vehicle_nickname || "").trim()
  );
}

export function hasDataIssues(trip, vehicles = []) {
  const startTime = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;
  const endTime = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;

  const startOdo = Number(trip?.starting_odometer);
  const endOdo = Number(trip?.ending_odometer);
  const explicitMiles = Number(trip?.miles_driven);
  const computedMiles = getMilesDriven(trip, vehicles);

  if (
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    endTime < startTime
  ) {
    return true;
  }

  if (
    Number.isFinite(startOdo) &&
    Number.isFinite(endOdo) &&
    endOdo < startOdo
  ) {
    return true;
  }

  if (Number.isFinite(explicitMiles) && explicitMiles < 0) {
    return true;
  }

  if (Number.isFinite(computedMiles) && computedMiles < 0) {
    return true;
  }

  return false;
}

export function isOpenActionTrip(trip, vehicles = []) {
  if (isCanceledTrip(trip)) return false;
  if (isTripInProgress(trip)) return true;
  if (!isClosedTrip(trip)) return true;

  const miles = getMilesDriven(trip, vehicles);

  return (
    ((trip?.gross_income == null && trip?.amount == null) ||
      trip?.starting_odometer == null ||
      (!Number.isFinite(Number(trip?.ending_odometer)) &&
        !Number.isFinite(miles)) ||
      !trip?.trip_start ||
      !trip?.trip_end)
  );
}

export function getTripStartMs(trip) {
  const ms = trip?.trip_start ? new Date(trip.trip_start).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

export function getTripEndMs(trip) {
  const ms = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

export function getVehicleKey(trip) {
  return (
    trip?.turo_vehicle_id ||
    trip?.vehicle_vin ||
    trip?.vehicle_nickname ||
    trip?.vehicle_name ||
    null
  );
}

export function formatDateShort(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function formatTimeShort(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatMoney(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

export function isCanceledTrip(trip) {
  const displayStatus = String(trip?.display_status || "").toLowerCase();
  const status = String(trip?.status || "").toLowerCase();
  return displayStatus === "canceled" || status === "canceled";
}

export function isOverdueTrip(trip) {
  const endMs = getTripEndMs(trip);
  const now = Date.now();

  if (!Number.isFinite(endMs) || endMs === Number.MAX_SAFE_INTEGER) return false;
  if (isCanceledTrip(trip)) return false;

  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const status = String(trip?.display_status || "").toLowerCase();

  const tripIsLive =
    stage === "in_progress" ||
    status === "active" ||
    status === "ending_today";

  return tripIsLive && endMs < now;
}

export function deriveTripNickname(trip) {
  return (
    trip.vehicle_nickname ||
    trip.nickname ||
    trip.car_nick ||
    "Unknown car"
  );
}

export function deriveTripVehicleLine(trip) {
  const year = trip.vehicle_year || trip.year;
  const make = trip.vehicle_make || trip.make;
  const model = trip.vehicle_model || trip.model;

  const full = [year, make, model].filter(Boolean).join(" ");
  return full || trip.vehicle_name || "Unknown vehicle";
}

export function deriveCardStatus(trip) {
  if (isCanceledTrip(trip)) return "canceled";
  if (isOverdueTrip(trip)) return "risk";

  const now = Date.now();
  const startMs = getTripStartMs(trip);
  const endMs = getTripEndMs(trip);

  const hoursUntilStart = (startMs - now) / (1000 * 60 * 60);
  const hoursUntilEnd = (endMs - now) / (1000 * 60 * 60);

  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const displayStatus = String(trip?.display_status || "").toLowerCase();

  const isLive =
    stage === "in_progress" ||
    displayStatus === "active" ||
    displayStatus === "ending_today";

  const isUpcoming =
    displayStatus === "upcoming" ||
    displayStatus === "starting_today" ||
    stage === "confirmed" ||
    stage === "booked" ||
    stage === "ready_for_handoff";

  if (isUpcoming && hoursUntilStart >= 0 && hoursUntilStart <= 48) {
    return "upcoming"; // hot, but not red
  }

  if (isLive && hoursUntilEnd >= 0 && hoursUntilEnd <= 24) {
    return "returning";
  }

  if (isLive) {
    return "active";
  }

  if (isUpcoming) {
    return "upcoming";
  }

  return "active";
}

export function deriveEtaText(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();

  if (stage === "ready_for_handoff" || stage === "in_progress") {
    return formatTimeShort(trip.trip_end) || formatDateShort(trip.trip_end);
  }

  const startDate = formatDateShort(trip.trip_start);
  const startTime = formatTimeShort(trip.trip_start);
  return [startDate, startTime].filter(Boolean).join(" ") || "—";
}

export function deriveEtaLabel(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();

  if (stage === "ready_for_handoff" || stage === "in_progress") {
    return "Return ETA";
  }

  return "Starting at";
}

function isSameLocalDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);

  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function isTomorrowLocalDay(target, now = Date.now()) {
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dt = new Date(target);

  return (
    dt.getFullYear() === tomorrow.getFullYear() &&
    dt.getMonth() === tomorrow.getMonth() &&
    dt.getDate() === tomorrow.getDate()
  );
}

export function deriveStatusLabel(trip) {
  const now = Date.now();
  const startMs = getTripStartMs(trip);
  const endMs = getTripEndMs(trip);

  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const expenseStatus = String(trip?.expense_status || "").toLowerCase();
  const tollReviewStatus = String(trip?.toll_review_status || "").toLowerCase();

  const tripEnded = Number.isFinite(endMs) && endMs < now;

  const isReadyForCustomer =
    stage === "ready_for_handoff" || stage === "in_progress";

  const needsCloseout =
    stage === "awaiting_expenses" ||
    (tripEnded && expenseStatus === "pending") ||
    (tripEnded && expenseStatus === "needs_review") ||
    (tripEnded && tollReviewStatus === "pending") ||
    (tripEnded && trip?.closed_out === false);

  if (isCanceledTrip(trip)) return "Canceled";
  if (isOverdueTrip(trip)) return "Overdue";

  if (isSameLocalDay(startMs, now) && !isReadyForCustomer) {
    return "Not ready for pickup";
  }

  if (isSameLocalDay(startMs, now)) {
    return "Pickup today";
  }

  if (isTomorrowLocalDay(startMs, now)) {
    return "Pickup tomorrow";
  }

  if (isSameLocalDay(endMs, now)) {
    return "Dropoff today";
  }

  if (isTomorrowLocalDay(endMs, now)) {
    return "Dropoff tomorrow";
  }

  if (needsCloseout) {
    return tollReviewStatus === "pending" ? "Needs tolls" : "Needs expenses";
  }

  if (stage === "in_progress") return "In trip";

  return "Upcoming";
}

export function deriveMeta4(trip) {
  const now = Date.now();
  const startMs = getTripStartMs(trip);
  const endMs = getTripEndMs(trip);

  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const expenseStatus = String(trip?.expense_status || "").toLowerCase();
  const tollReviewStatus = String(trip?.toll_review_status || "").toLowerCase();

  const tripEnded = Number.isFinite(endMs) && endMs < now;
  const tripStarted = Number.isFinite(startMs) && startMs <= now;

  if (isCanceledTrip(trip)) {
    return {
      label: "Trip state",
      value: "Canceled",
    };
  }

  if (!tripEnded) {
    if (stage === "booked") {
      return {
        label: "Next step",
        value: "Confirm trip",
      };
    }

    if (stage === "confirmed") {
      return {
        label: "Next step",
        value: "Ready for handoff",
      };
    }

    if (stage === "ready_for_handoff") {
      return {
        label: "Next step",
        value: tripStarted ? "Await pickup" : "Vehicle ready",
      };
    }

    if (stage === "in_progress") {
      return {
        label: "Next step",
        value: "Await return",
      };
    }

    if (stage === "turnaround") {
      return {
        label: "Next step",
        value: "Turn around vehicle",
      };
    }
  }

  if (
    stage === "awaiting_expenses" ||
    (tripEnded && expenseStatus === "pending") ||
    (tripEnded && expenseStatus === "needs_review")
  ) {
    return {
      label: "Next step",
      value: "Finish expenses",
    };
  }

  if (tripEnded && tollReviewStatus === "pending") {
    return {
      label: "Next step",
      value: "Review tolls",
    };
  }

  if (tripEnded && trip?.closed_out === false) {
    return {
      label: "Next step",
      value: "Close out trip",
    };
  }

  const amount = formatMoney(trip.amount);
  if (amount) {
    return {
      label: "Trip value",
      value: amount,
    };
  }

  return {
    label: "Status",
    value: deriveStatusLabel(trip),
  };
}

export function buildVehicleTimeline(trips) {
  const grouped = new Map();

  trips.forEach((trip) => {
    if (isCanceledTrip(trip)) return;

    const key = getVehicleKey(trip);
    if (!key) return;

    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trip);
  });

  grouped.forEach((list) => {
    list.sort((a, b) => getTripStartMs(a) - getTripStartMs(b));
  });

  return grouped;
}

export function findAdjacentTrips(trip, vehicleTimeline) {
  const key = getVehicleKey(trip);
  if (!key || !vehicleTimeline.has(key)) {
    return { previousTrip: null, nextTrip: null };
  }

  const list = vehicleTimeline.get(key);
  const idx = list.findIndex((item) => item.id === trip.id);

  if (idx === -1) {
    return { previousTrip: null, nextTrip: null };
  }

  return {
    previousTrip: idx > 0 ? list[idx - 1] : null,
    nextTrip: idx < list.length - 1 ? list[idx + 1] : null,
  };
}

export function getTurnGapHours(currentTrip, nextTrip) {
  if (!currentTrip || !nextTrip) return null;

  const currentEnd = getTripEndMs(currentTrip);
  const nextStart = getTripStartMs(nextTrip);

  if (!Number.isFinite(currentEnd) || !Number.isFinite(nextStart)) return null;

  return (nextStart - currentEnd) / (1000 * 60 * 60);
}

export function deriveOperationalUrgency(trip, previousTrip, nextTrip) {
  const now = Date.now();
  const startMs = getTripStartMs(trip);
  const endMs = getTripEndMs(trip);

  const hoursUntilStart = (startMs - now) / (1000 * 60 * 60);
  const hoursUntilEnd = (endMs - now) / (1000 * 60 * 60);

  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const displayStatus = String(trip?.display_status || "").toLowerCase();
  const expenseStatus = String(trip?.expense_status || "").toLowerCase();
  const tollReviewStatus = String(trip?.toll_review_status || "").toLowerCase();

  const tripEnded = Number.isFinite(endMs) && endMs < now;

  const isLive =
    stage === "in_progress" ||
    displayStatus === "active" ||
    displayStatus === "ending_today";

  const isUpcoming =
    displayStatus === "upcoming" ||
    displayStatus === "starting_today" ||
    stage === "confirmed" ||
    stage === "booked" ||
    stage === "ready_for_handoff";

  const startsToday = isSameLocalDay(startMs, now);
  const startsTomorrow = isTomorrowLocalDay(startMs, now);
  const endsToday = isSameLocalDay(endMs, now);
  const endsTomorrow = isTomorrowLocalDay(endMs, now);

  const startsWithin14Days =
    hoursUntilStart >= 0 && hoursUntilStart <= 24 * 14;

  const isReadyForCustomer =
    stage === "ready_for_handoff" || stage === "in_progress";

  const turnGapToNext = getTurnGapHours(trip, nextTrip);
  const turnGapFromPrev = getTurnGapHours(previousTrip, trip);

  const previousTripStillActive =
    previousTrip &&
    !isCanceledTrip(previousTrip) &&
    getTripEndMs(previousTrip) > now &&
    String(previousTrip?.workflow_stage || "").toLowerCase() !== "complete";

  const nextTripStartsWithin14Days =
    nextTrip &&
    (() => {
      const nextStartMs = getTripStartMs(nextTrip);
      const nextHoursUntilStart = (nextStartMs - now) / (1000 * 60 * 60);
      return nextHoursUntilStart >= 0 && nextHoursUntilStart <= 24 * 14;
    })();

  const liveTripBlocksUpcoming =
    isLive &&
    nextTripStartsWithin14Days &&
    turnGapToNext != null &&
    turnGapToNext <= 72;

  const needsCloseout =
    stage === "awaiting_expenses" ||
    (tripEnded && expenseStatus === "pending") ||
    (tripEnded && expenseStatus === "needs_review") ||
    (tripEnded && tollReviewStatus === "pending") ||
    (tripEnded && trip?.closed_out === false);

  if (isCanceledTrip(trip)) {
    return {
      bucket: 99,
      attentionAt: startMs,
      urgencyLabel: "Canceled",
      turnGapHours: null,
      isTurnaroundRisk: false,
      dependencyNote: null,
    };
  }

  if (isOverdueTrip(trip)) {
    return {
      bucket: 0,
      attentionAt: endMs,
      urgencyLabel: nextTrip ? "Overdue + blocking next trip" : "Overdue",
      turnGapHours: turnGapToNext,
      isTurnaroundRisk: Boolean(nextTrip),
      dependencyNote: null,
    };
  }

  if ((startsToday || startsTomorrow) && !isReadyForCustomer) {
    return {
      bucket: 1,
      attentionAt: startMs,
      urgencyLabel: startsToday
        ? "Pickup today - not ready"
        : "Pickup tomorrow - not ready",
      turnGapHours: turnGapFromPrev,
      isTurnaroundRisk: Boolean(previousTripStillActive),
      dependencyNote: previousTripStillActive
        ? `Await return from ${previousTrip?.guest_name || "current guest"}`
        : null,
    };
  }

  if (isUpcoming && startsWithin14Days) {
    return {
      bucket: 2,
      attentionAt: startMs,
      urgencyLabel: startsToday
        ? "Pickup today"
        : startsTomorrow
        ? "Pickup tomorrow"
        : "Pickup soon",
      turnGapHours: turnGapFromPrev,
      isTurnaroundRisk: Boolean(previousTripStillActive),
      dependencyNote: previousTripStillActive
        ? `Await return from ${previousTrip?.guest_name || "current guest"}`
        : null,
    };
  }

  if (needsCloseout) {
    return {
      bucket: 3,
      attentionAt: endMs,
      urgencyLabel:
        tollReviewStatus === "pending" ? "Needs tolls" : "Needs closeout",
      turnGapHours: null,
      isTurnaroundRisk: false,
      dependencyNote: null,
    };
  }

  if (endsToday) {
    return {
      bucket: 4,
      attentionAt: endMs,
      urgencyLabel: "Dropoff today",
      turnGapHours: turnGapToNext,
      isTurnaroundRisk: false,
      dependencyNote: null,
    };
  }

  if (endsTomorrow || liveTripBlocksUpcoming) {
    return {
      bucket: 5,
      attentionAt: endMs,
      urgencyLabel: endsTomorrow ? "Dropoff tomorrow" : "Dropoff soon",
      turnGapHours: turnGapToNext,
      isTurnaroundRisk: Boolean(nextTrip),
      dependencyNote: nextTrip
        ? `Blocking ${nextTrip?.guest_name || "next guest"}`
        : null,
    };
  }

  if (isLive) {
    return {
      bucket: 6,
      attentionAt: endMs,
      urgencyLabel: "In trip",
      turnGapHours: turnGapToNext,
      isTurnaroundRisk: false,
      dependencyNote: null,
    };
  }

  return {
    bucket: 7,
    attentionAt: startMs,
    urgencyLabel: "Upcoming",
    turnGapHours: turnGapFromPrev,
    isTurnaroundRisk: false,
    dependencyNote: null,
  };
}

export function sortTrips(trips) {
  return [...trips].sort((a, b) => {
    const bucketDiff = (a.priorityBucket ?? 99) - (b.priorityBucket ?? 99);
    if (bucketDiff !== 0) return bucketDiff;

    const attentionDiff =
      (a.attentionAt ?? Number.MAX_SAFE_INTEGER) -
      (b.attentionAt ?? Number.MAX_SAFE_INTEGER);
    if (attentionDiff !== 0) return attentionDiff;

    const aGap = a.turnGapHours ?? Number.MAX_SAFE_INTEGER;
    const bGap = b.turnGapHours ?? Number.MAX_SAFE_INTEGER;
    if (aGap !== bGap) return aGap - bGap;

    return getTripStartMs(a) - getTripStartMs(b);
  });
}