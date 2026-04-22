// detailPanel.utils.js

export function getVehicleLocationLinkData(vehicleLike) {
  const vehicle = vehicleLike?.vehicle || vehicleLike;
  const telemetry = vehicleLike?.telemetry || vehicle?.telemetry;

  const label = getVehicleLocationLabel({
    ...vehicle,
    telemetry,
  });

  const url = buildBouncieVehicleDetailsUrl(vehicle);
  const providerLabel = Array.isArray(vehicle?.telemetry_source)
    ? vehicle.telemetry_source.join(" + ")
    : vehicle?.dimo_token_id
    ? "dimo"
    : vehicle?.bouncie_vehicle_id
    ? "bouncie"
    : "telemetry";

  return {
    label,
    url,
    title: url ? "View in Bouncie" : `Location from ${providerLabel}`,
    clickable: Boolean(url),
  };
}

function parseAppDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;

  // Preserve naive timestamps as local time instead of letting JS guess weirdly.
  const localMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (localMatch) {
    const [, y, m, d, hh = "00", mm = "00", ss = "00"] = localMatch;
    const date = new Date(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss)
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === "" || value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function getTripVehicleLabel(trip, selectedVehicleInfo) {
  return (
    selectedVehicleInfo?.nickname ||
    trip?.vehicle_nickname ||
    selectedVehicleInfo?.displayName ||
    trip?.vehicle_name ||
    "Unknown vehicle"
  );
}

export function getNextWorkflowStage(trip) {
  const allowed = Array.isArray(trip?.allowed_next_stages)
    ? trip.allowed_next_stages
    : [];

  const order = [
    "booked",
    "confirmed",
    "ready_for_handoff",
    "in_progress",
    "turnaround",
    "awaiting_expenses",
    "complete",
    "canceled",
  ];

  const currentIndex = order.indexOf(trip?.workflow_stage);

  for (let i = currentIndex + 1; i < order.length; i += 1) {
    if (allowed.includes(order[i])) return order[i];
  }

  return allowed[0] || "";
}

/**
 * Normalize loose text for safer comparisons.
 * Used for name matching where punctuation/casing should not matter.
 */
export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Normalize IDs where whitespace is the main issue.
 */
export function normalizeId(value) {
  return String(value || "").trim();
}

/**
 * Simple "time since" helper in hours.
 * Returns null if the date is missing or invalid.
 */
export function getHoursSince(value) {
  if (!value) return null;

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  return (Date.now() - d.getTime()) / 3600000;
}

/**
 * Format a timestamp for compact display in the UI.
 */
export function formatDateTime(value) {
  const d = parseAppDate(value);
  if (!d) return "—";

  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format a short date range label.
 */
export function formatDateShort(value) {
  const d = parseAppDate(value);
  if (!d) return "—";

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/**
 * Format odometer values as whole miles.
 */
export function formatOdometer(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";

  return `${Math.round(n).toLocaleString("en-US")} mi`;
}

/**
 * Format dollars without cents.
 */
export function formatMoney(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

/**
 * Format dollars with cents.
 */
export function formatMoneyPrecise(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Human-readable comm age for GPS / telematics.
 */
export function formatRelativeComm(value) {
  const d = parseAppDate(value);
  if (!d) return "—";

  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;

  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format fuel as a rounded percent.
 * Returns null if the value is not usable.
 */
export function formatFuelLevel(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return null;

  if (n === 0) return null;
  if (n < 5) return "Empty";

  return `${Math.round(n)}%`;
}

/**
 * Build the Bouncie details link when we have a known vehicle ID.
 */
export function buildBouncieVehicleDetailsUrl(vehicleLike) {
  const vehicle = vehicleLike?.vehicle || vehicleLike;
  const bouncieVehicleId = String(vehicle?.bouncie_vehicle_id || "").trim();

  if (!bouncieVehicleId) return "";
  return `https://www.bouncie.app/vehicles/${bouncieVehicleId}/details`;
}

/**
 * Open an external URL in a safe new tab.
 */
export function openUrl(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Render-friendly location label.
 */
export function getVehicleLocationLabel(vehicleLike) {
  const vehicle = vehicleLike?.vehicle || vehicleLike;
  const telemetry = vehicleLike?.telemetry || vehicle?.telemetry;
  const location = telemetry?.location;

  if (location?.address) return location.address;

  if (location?.lat != null && location?.lon != null) {
    return `${Number(location.lat).toFixed(3)}, ${Number(location.lon).toFixed(3)}`;
  }

  return "—";
}

/**
 * Telemetry communication alert logic.
 */
export function getCommAlert(vehicle) {
  const hours = getHoursSince(vehicle?.telemetry?.last_comm);

  if (hours == null) {
    return { level: "unknown", label: "No comm data" };
  }

  if (hours >= 24) {
    return { level: "critical", label: "No comms 24h+" };
  }

  if (hours >= 6) {
    return { level: "warning", label: "No comms 6h+" };
  }

  return null;
}

/**
 * Battery alert derivation for selected trip and fleet rows.
 */
export function getBatteryAlert(vehicle) {
  const battery = vehicle?.telemetry?.battery;
  const status = String(battery?.status || "").toLowerCase();

  if (!status) return null;

  if (status === "shutdown") {
    return {
      level: "critical",
      label: "Battery emergency",
      icon: "🔋",
      detail: "Battery reported shutdown",
    };
  }

  if (status === "critical" || status === "low") {
    return {
      level: "critical",
      label: "Battery low",
      icon: "🔋",
      detail: `Battery alert: ${battery.status}`,
    };
  }

  if (status === "warning" || status === "alert") {
    return {
      level: "warning",
      label: "Battery alert",
      icon: "🔋",
      detail: battery?.last_updated
        ? `Last alert sent ${formatDateTime(battery.last_updated)}`
        : "Battery alert reported",
    };
  }

  return null;
}

/**
 * Friendly label for battery status.
 */
export function getBatteryStatusLabel(vehicle) {
  const status = String(vehicle?.telemetry?.battery?.status || "").trim();
  if (!status) return "Normal";

  return status
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/**
 * Friendly label for high-level vehicle state.
 */
export function getVehicleStatusLabel(vehicle) {
  if (vehicle?.telemetry?.engine_running) return "Running";
  return "Parked";
}

/**
 * Tone used to style fleet pills/cards.
 */
export function getVehicleEmergencyTone(vehicle) {
  const batteryAlert = getBatteryAlert(vehicle);
  if (batteryAlert?.level === "critical") return "emergency";

  const commAlert = getCommAlert(vehicle);
  if (commAlert?.level === "critical") return "critical";

  if (vehicle?.telemetry?.engine_running) return "running";
  return "parked";
}

/**
 * Build Turo trip detail URL.
 */
export function buildTripUrl(trip) {
  if (trip?.trip_details_url) return trip.trip_details_url;
  if (trip?.reservation_id) {
    return `https://turo.com/us/en/reservation/${trip.reservation_id}`;
  }
  return "";
}

/**
 * Build Turo trip messages URL.
 */
export function buildReplyUrl(trip) {
  if (trip?.trip_details_url) {
    return `${trip.trip_details_url.replace(/\/$/, "")}/messages`;
  }

  if (trip?.reservation_id) {
    return `https://turo.com/reservation/${trip.reservation_id}/messages`;
  }

  return "";
}

/**
 * Derive a compact trip window label.
 */
export function deriveTripWindow(trip) {
  const start = parseAppDate(trip?.trip_start);
  const end = parseAppDate(trip?.trip_end);
  if (!start || !end) return "—";
  return `${formatDateShort(start)} → ${formatDateShort(end)}`;
}

/**
 * Derive return ETA.
 */
export function deriveReturnEta(trip) {
  const end = parseAppDate(trip?.trip_end);
  if (!end) return "—";
  return formatDateTime(end);
}

function formatStatusText(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Friendly status label for display.
 */
export function deriveStatusLabel(trip) {
  if (!trip) return "—";
  if (trip.display_status === "ending_today") return "Returning today";
  if (trip.display_status === "starting_today") return "Starting today";
  if (trip.display_status === "active") return "Active";
  if (trip.display_status === "upcoming") return "Upcoming";
  if (trip.display_status === "canceled") return "Canceled";
  if (trip.display_status === "past") {
    return formatStatusText(trip.workflow_stage) || "Past trip";
  }
  return formatStatusText(trip.workflow_stage) || formatStatusText(trip.status) || "—";
}

/**
 * Duration in days for per-day revenue math.
 */
export function getTripDurationDays(trip) {
  const start = parseAppDate(trip?.trip_start);
  const end = parseAppDate(trip?.trip_end);

  if (!start || !end || end <= start) return null;
  return (end.getTime() - start.getTime()) / 86400000;
}

/**
 * Revenue/day helper.
 */
export function getRevenuePerDay(trip) {
  const amount = Number(trip?.amount);
  const days = getTripDurationDays(trip);

  if (Number.isNaN(amount) || !days || days <= 0) return null;
  return amount / days;
}

/**
 * Progress bar percentage for in-flight trips.
 */
export function getTripProgressPercent(trip) {
  const start = parseAppDate(trip?.trip_start);
  const end = parseAppDate(trip?.trip_end);

  if (!start || !end || end <= start) return 0;

  const now = Date.now();
  const startMs = start.getTime();
  const endMs = end.getTime();

  if (now <= startMs) return 0;
  if (now >= endMs) return 100;

  return Math.max(0, Math.min(100, ((now - startMs) / (endMs - startMs)) * 100));
}

/**
 * Match a trip to a vehicle using the strongest available identifiers first.
 *
 * Matching order:
 * 1. Turo/listing IDs
 * 2. VIN
 * 3. exact normalized names
 *
 * We intentionally avoid fuzzy partial guesses at the end because bad telemetry
 * is worse than missing telemetry.
 */
export function findVehicleForTrip(trip, vehicles) {
  if (!trip || !Array.isArray(vehicles) || vehicles.length === 0) return null;

  function normalize(value) {
    return String(value || "").trim().toLowerCase();
  }

  function findMatchedVehicle(tripObj, vehiclesArr) {
    if (!tripObj || !Array.isArray(vehiclesArr) || vehiclesArr.length === 0) return null;

    const tripVin = normalize(tripObj.vehicle_vin || tripObj.vin || tripObj.vehicle_vin);
    const tripNickname = normalize(tripObj.vehicle_nickname || tripObj.nickname || tripObj.vehicle_nickname);
    const tripTuroVehicleId = normalize(tripObj.turo_vehicle_id || tripObj.turo_id || tripObj.listing_id || tripObj.vehicle_id);
    const tripVehicleName = normalize(tripObj.vehicle_name || `${tripObj.vehicle_make || ""} ${tripObj.vehicle_model || ""}`);
    const tripMake = normalize(tripObj.vehicle_make || tripObj.make);
    const tripModel = normalize(tripObj.vehicle_model || tripObj.model);
    const tripYear = String(tripObj.vehicle_year || tripObj.year || "").trim();

    return (
      vehiclesArr.find((vehicle) => normalize(vehicle?.turo_vehicle_id) === tripTuroVehicleId) ||
      vehiclesArr.find((vehicle) => normalize(vehicle?.vin) === tripVin) ||
      vehiclesArr.find((vehicle) => normalize(vehicle?.nickname) === tripNickname) ||
      vehiclesArr.find((vehicle) => {
        return (
          normalize(`${vehicle?.make || ""} ${vehicle?.model || ""}`) === tripVehicleName ||
          (
            normalize(vehicle?.make) === tripMake &&
            normalize(vehicle?.model) === tripModel &&
            String(vehicle?.year || "").trim() === tripYear
          )
        );
      }) ||
      null
    );
  }

  return findMatchedVehicle(trip, vehicles);
}

/**
 * Derive the best display name for a vehicle/trip combo.
 */
export function getVehicleDisplayName(vehicle, trip) {
  return (
    vehicle?.nickname ||
    vehicle?.turo_vehicle_name ||
    [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ") ||
    trip?.vehicle_name ||
    "Unknown vehicle"
  );
}

/**
 * Build a richer selected vehicle object for the UI so the rendering code
 * does not have to keep re-deriving everything.
 */
export function getSelectedTripVehicle(trip, vehicles) {
  const vehicle = findVehicleForTrip(trip, vehicles);

  const tripNickname =
    trip?.vehicle_nickname ||
    trip?.nickname ||
    trip?.car_nick ||
    null;

  if (!vehicle) {
    console.log("useVehicleStatus no match", {
      tripId: trip?.id,
      reservationId: trip?.reservation_id,
      tripVehicleName: trip?.vehicle_name,
      tripVehicleNickname: trip?.vehicle_nickname,
      tripVehicleVin: trip?.vehicle_vin,
      tripTuroVehicleId: trip?.turo_vehicle_id,
      candidateVehicles: (vehicles || []).map((vehicle) => ({
        nickname: vehicle?.nickname,
        vin: vehicle?.vin,
        make: vehicle?.make,
        model: vehicle?.model,
        year: vehicle?.year,
        turo_vehicle_id: vehicle?.turo_vehicle_id,
        bouncie_vehicle_id: vehicle?.bouncie_vehicle_id,
        dimo_token_id: vehicle?.dimo_token_id,
        telemetry_source: vehicle?.telemetry_source,
      })),
    });
    return {
      matched: false,
      nickname: tripNickname || null,
      displayName: tripNickname || trip?.vehicle_name || "Unknown vehicle",
      telemetry: null,
      vehicle: null,
    };
  }

  return {
    matched: true,
    nickname: vehicle.nickname || tripNickname || null,
    displayName: getVehicleDisplayName(vehicle, trip),
    telemetry: vehicle.telemetry || null,
    vehicle,
  };
}

/**
 * Placeholder mileage derivation.
 *
 * This is intentionally tolerant because your mileage model may not be fully
 * wired yet. Once the backend returns reliable values like:
 * - starting_odometer
 * - current_odometer
 * - mileage_included
 *
 * you can tighten this up.
 */

export function getMileageStats(trip, vehicle) {
  const allowed = firstFiniteNumber(
    trip?.mileage_included,
    trip?.allowed_miles,
    trip?.trip_miles_included
  );

  const starting = firstFiniteNumber(
    trip?.starting_odometer,
    trip?.start_odometer,
    trip?.odometer_start
  );

  const ending = firstFiniteNumber(
    trip?.ending_odometer,
    trip?.end_odometer,
    trip?.odometer_end
  );

  const current = firstFiniteNumber(
    vehicle?.telemetry?.odometer,
    trip?.current_odometer,
    trip?.latest_odometer,
    ending
  );

  const effectiveEnd = ending ?? current;

  const used =
    starting != null &&
    effectiveEnd != null &&
    effectiveEnd >= starting
      ? effectiveEnd - starting
      : null;

  const remaining =
    allowed != null && used != null
      ? Math.max(allowed - used, 0)
      : null;

  return {
    allowed,
    starting,
    ending,
    current,
    used,
    remaining,
  };
}
