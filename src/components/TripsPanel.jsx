// ------------------------------------------------------
// /src/components/TripsPanel.jsx
// File to hold the main dispatch panel showing all open trips in a priority-sorted queue.
// This is the default view when clicking the "Trips" button in the rail.
// ------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import {
  findVehicleForTrip,
  getVehicleLocationLabel,
} from "./detail-panel/detailPanel.utils";
import {
  buildVehicleTimeline,
  deriveCardStatus,
  deriveEtaLabel,
  deriveEtaText,
  deriveMeta4,
  deriveOperationalUrgency,
  deriveStatusLabel,
  deriveTripNickname,
  deriveTripVehicleLine,
  findAdjacentTrips,
  formatDateShort,
  formatTimeShort,
  getHoursUntilTripEnd,
  getTripStartMs,
  isCanceledTrip,
  isOverdueTrip,
  sortTrips,
} from "../utils/tripUtils";

// Trip helper functions are now provided by ../utils/tripUtils

const DEFAULT_DISPATCH_SETTINGS = {
  openTripsSort: "priority",
  pinOverdue: true,
  showCanceled: false,
  visibleBuckets: {
    needs_closeout: true,
    in_progress: true,
    unconfirmed: true,
    upcoming: true,
    canceled: false,
    closed: false,
  },
  bucketOrder: [
    "needs_closeout",
    "in_progress",
    "unconfirmed",
    "upcoming",
    "canceled",
    "closed",
  ],
};

const DEFAULT_VISIBLE_BUCKETS = DEFAULT_DISPATCH_SETTINGS.visibleBuckets;

function shouldShowCurrentLocation(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  return stage === "ready_for_handoff" || stage === "in_progress";
}

function getTripEndMs(trip) {
  const ms = trip?.trip_end ? new Date(trip.trip_end).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
}

function formatAttentionDateTime(value) {
  if (value == null) return "Schedule pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Schedule pending";
  return `${formatDateShort(date)} ${formatTimeShort(date)}`;
}

function getCompactNextActivityText(trip) {
  const stage = String(trip?.workflow_stage || "").toLowerCase();
  const attentionText = formatAttentionDateTime(trip?.attentionAt);
  const previousGuestName = trip?.previousTrip?.guest_name || "current guest";
  const previousReturnText = trip?.previousTrip?.trip_end
    ? formatAttentionDateTime(trip.previousTrip.trip_end)
    : null;

  if (stage === "in_progress") {
    return `Dropoff ${attentionText}`;
  }

  if (
    (stage === "ready_for_handoff" ||
      stage === "confirmed" ||
      trip?.queue_bucket === "upcoming") &&
    String(trip?.operationalNote || "").toLowerCase().startsWith("await return from")
  ) {
    return previousReturnText
      ? `Pending ${previousGuestName} return - ${previousReturnText}`
      : `Pending ${previousGuestName} return`;
  }

  if (stage === "ready_for_handoff" || stage === "confirmed" || trip?.queue_bucket === "upcoming") {
    return `Pickup ${attentionText}`;
  }

  return `${trip?.urgencyLabel || "Next step"} ${attentionText}`;
}

function getStringValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDispatchSettings(settings) {
  const merged = {
    ...DEFAULT_DISPATCH_SETTINGS,
    ...(settings || {}),
    bucketOrder:
      Array.isArray(settings?.bucketOrder) && settings.bucketOrder.length
        ? settings.bucketOrder
        : DEFAULT_DISPATCH_SETTINGS.bucketOrder,
  };

  merged.visibleBuckets = {
    ...DEFAULT_VISIBLE_BUCKETS,
    ...(settings?.visibleBuckets || {}),
  };

  if (!settings?.visibleBuckets && settings?.showCanceled !== undefined) {
    merged.visibleBuckets.canceled = Boolean(settings.showCanceled);
  }

  merged.showCanceled = Boolean(merged.visibleBuckets.canceled);
  return merged;
}

function isBucketVisible(trip, settings) {
  const bucket = trip?.queue_bucket || "";
  return settings.visibleBuckets?.[bucket] !== false;
}

function getPriorityBucketRank(trip) {
  if (trip.queue_bucket === "unconfirmed") {
    return -1;
  }

  return Number.isFinite(Number(trip.priorityBucket))
    ? Number(trip.priorityBucket)
    : 99;
}

function getAttentionAtRank(trip) {
  return Number.isFinite(Number(trip?.attentionAt))
    ? Number(trip.attentionAt)
    : Number.MAX_SAFE_INTEGER;
}

function sortTripsWithSettings(trips, rawSettings) {
  const settings = normalizeDispatchSettings(rawSettings);

  if (settings.openTripsSort === "priority") {
    return [...trips].sort((a, b) => {
      const aOverdue = settings.pinOverdue && isOverdueTrip(a);
      const bOverdue = settings.pinOverdue && isOverdueTrip(b);

      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

      const attentionDiff = getAttentionAtRank(a) - getAttentionAtRank(b);
      if (attentionDiff !== 0) return attentionDiff;

      const aBucket = getPriorityBucketRank(a);
      const bBucket = getPriorityBucketRank(b);
      if (aBucket !== bBucket) return aBucket - bBucket;

      return sortTrips([a, b])[0] === a ? -1 : 1;
    });
  }

  return [...trips].sort((a, b) => {
    if (settings.pinOverdue) {
      const aOverdue = isOverdueTrip(a);
      const bOverdue = isOverdueTrip(b);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    }

    switch (settings.openTripsSort) {
      case "trip_start_desc":
        return getTripStartMs(b) - getTripStartMs(a);
      case "trip_end_asc":
        return getTripEndMs(a) - getTripEndMs(b);
      case "trip_end_desc":
        return getTripEndMs(b) - getTripEndMs(a);
      case "vehicle_name":
        return getStringValue(a.cardVehicleLine || a.vehicle_name).localeCompare(
          getStringValue(b.cardVehicleLine || b.vehicle_name)
        );
      case "guest_name":
        return getStringValue(a.guest_name).localeCompare(getStringValue(b.guest_name));
      case "status_bucket": {
        const bucketRank = new Map(
          settings.bucketOrder.map((bucket, index) => [bucket, index])
        );
        const bucketDiff =
          (bucketRank.get(a.queue_bucket) ?? 99) -
          (bucketRank.get(b.queue_bucket) ?? 99);
        if (bucketDiff !== 0) return bucketDiff;
        return getTripStartMs(a) - getTripStartMs(b);
      }
      case "trip_start_asc":
      default:
        return getTripStartMs(a) - getTripStartMs(b);
    }
  });
}

export default function TripsPanel({
  selectedTrip,
  onSelectTrip,
  pauseRefresh = false,
  trips,
  setTrips,
  dispatchSettings,
  initialVehicles = [],
  initialLoadComplete = false,
}) {
  const [vehicles, setVehicles] = useState(() =>
    Array.isArray(initialVehicles) ? initialVehicles : []
  );
  const [loading, setLoading] = useState(!initialLoadComplete);
  const [error, setError] = useState("");
  const normalizedDispatchSettings = normalizeDispatchSettings(dispatchSettings);

  useEffect(() => {
    if (Array.isArray(initialVehicles)) {
      setVehicles(initialVehicles);
    }
  }, [initialVehicles]);

  useEffect(() => {
    let ignore = false;

      async function loadTrips() {
    try {
      setError("");

      const [tripsRes, vehiclesRes] = await Promise.all([
        fetch("http://localhost:5000/api/trips?scope=all"),
        fetch("http://localhost:5000/api/vehicles/live-status"),
      ]);

      if (!tripsRes.ok) {
        throw new Error(`Trips request failed: ${tripsRes.status}`);
      }

      if (!vehiclesRes.ok) {
        throw new Error(`Vehicle telemetry request failed: ${vehiclesRes.status}`);
      }

      const [tripsData, vehiclesData] = await Promise.all([
        tripsRes.json(),
        vehiclesRes.json(),
      ]);

      if (ignore) return;

      const rawTrips = Array.isArray(tripsData) ? tripsData : [];
      const nextTrips = rawTrips.filter((trip) =>
        isBucketVisible(trip, normalizedDispatchSettings)
      );
      const nextVehicles = Array.isArray(vehiclesData) ? vehiclesData : [];

      setTrips(nextTrips);
      setVehicles(nextVehicles);
    } catch (err) {
      if (!ignore) {
        setError(err.message || "Failed to load trips");
      }
    } finally {
      if (!ignore) {
        setLoading(false);
      }
    }
  }

    loadTrips();

    if (pauseRefresh) {
      return () => {
        ignore = true;
      };
    }

    const intervalId = setInterval(() => {
      loadTrips();
    }, 15000);

    return () => {
      ignore = true;
      clearInterval(intervalId);
    };
  }, [
    selectedTrip?.id,
    onSelectTrip,
    pauseRefresh,
    JSON.stringify(normalizedDispatchSettings.visibleBuckets),
  ]);

const mappedTrips = useMemo(() => {
  const activeOnly = trips.filter((trip) => !isCanceledTrip(trip));
  const vehicleTimeline = buildVehicleTimeline(activeOnly);

  function deriveCardTone(trip, urgency) {
  if (isCanceledTrip(trip)) return "canceled";
  if (isOverdueTrip(trip) || urgency.bucket === 0) return "risk";

  // Hot departures should be blue, not red.
  if (urgency.bucket === 1 || urgency.bucket === 2) {
    return "upcoming";
  }

  // Expenses / closeout can stay amber so they read as action-needed.
  if (urgency.bucket === 3) {
    return "returning";
  }

  // Return-focused / blocking items.
  if (urgency.bucket === 4 || urgency.bucket === 5) {
    return "returning";
  }

  if (urgency.bucket === 6) {
    return "active";
  }

  return "upcoming";
}

  return trips.map((trip) => {
    const meta4 = deriveMeta4(trip);
    const canceled = isCanceledTrip(trip);

    const matchedVehicle = findVehicleForTrip(trip, vehicles);
    const showCurrentLocation = shouldShowCurrentLocation(trip);
    const locationText = showCurrentLocation
      ? matchedVehicle
        ? getVehicleLocationLabel(matchedVehicle)
        : "Awaiting telemetry"
      : "—";

    const { previousTrip, nextTrip } = findAdjacentTrips(trip, vehicleTimeline);
    const urgency = deriveOperationalUrgency(trip, previousTrip, nextTrip);

let operationalNote = urgency.urgencyLabel;

if (urgency.dependencyNote) {
  operationalNote = urgency.dependencyNote;
} else if (urgency.isTurnaroundRisk && nextTrip) {
  operationalNote = `Prep for ${nextTrip.guest_name || "next guest"} • ${formatDateShort(
    nextTrip.trip_start
  )} ${formatTimeShort(nextTrip.trip_start)}`;
}

    return {
      ...trip,
      canceled,
      cardStatus: deriveCardTone(trip, urgency),
      statusLabel: deriveStatusLabel(trip),
      cardGuestName: trip.guest_name || "Unknown guest",
      cardNickname: deriveTripNickname(trip),
      cardVehicleLine: deriveTripVehicleLine(trip),
      reservationText: `Reservation #${trip.reservation_id || "—"}`,
      windowText: `${formatDateShort(trip.trip_start)} → ${formatDateShort(
        trip.trip_end
      )}`,
      returnEtaText: deriveEtaText(trip),
      etaLabel: deriveEtaLabel(trip),
      locationText,
      meta4Label: meta4.label,
      meta4Value: meta4.value,
      previousTrip,
      nextTrip,
      attentionAt: urgency.attentionAt,
      priorityBucket: urgency.bucket,
      urgencyLabel: urgency.urgencyLabel,
      turnGapHours: urgency.turnGapHours,
      turnaroundRisk: urgency.isTurnaroundRisk,
      operationalNote,
      alertCount: 0,
    };
  });
}, [trips, vehicles]);

  const activeTrips = sortTripsWithSettings(
    mappedTrips.filter(
      (trip) => !trip.canceled && isBucketVisible(trip, normalizedDispatchSettings)
    ),
    normalizedDispatchSettings
  );
  const canceledTrips = normalizedDispatchSettings.visibleBuckets.canceled
    ? sortTripsWithSettings(
        mappedTrips.filter(
          (trip) => trip.canceled && isBucketVisible(trip, normalizedDispatchSettings)
        ),
        normalizedDispatchSettings
      )
    : [];

  const openCount = activeTrips.length;
  const returningTodayCount = activeTrips.filter(
    (trip) => trip.display_status === "ending_today"
  ).length;
  
  const atRiskCount = activeTrips.filter((trip) => isOverdueTrip(trip)).length;

  if (loading) {
    return (
      <section className="panel trips-panel">
        <div className="panel-header">
          <h2>Open Trips</h2>
          <span>priority-sorted queue</span>
        </div>
        <div className="list">
          <article className="trip-card">
            <div className="trip-title">Loading trips...</div>
          </article>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel trips-panel">
        <div className="panel-header">
          <h2>Open Trips</h2>
          <span>priority-sorted queue</span>
        </div>
        <div className="list">
          <article className="trip-card risk">
            <div className="trip-title">Failed to load trips</div>
            <div className="trip-sub">{error}</div>
          </article>
        </div>
      </section>
    );
  }

  return (
    <section className="panel trips-panel">
      <div className="panel-header">
        <h2>Open Trips</h2>
        <span>{normalizedDispatchSettings.openTripsSort.replaceAll("_", " ")}</span>
      </div>

      <div className="panel-subbar">
        <div className="chip">{openCount} open</div>
        <div className="chip">{returningTodayCount} returning today</div>
        <div className="chip">{atRiskCount} at risk</div>
        {canceledTrips.length > 0 && (
          <div className="chip">{canceledTrips.length} canceled</div>
        )}
      </div>

      <div className="list">
        {activeTrips.map((trip) => {
          const isSelected = trip.id === selectedTrip?.id;

          return (
            <article
              key={trip.id}
              className={`trip-card ${trip.cardStatus} ${
                isSelected ? "selected" : "compact"
              }`}
              onClick={() => onSelectTrip(isSelected ? null : trip)}
            >
              <div className="trip-top">
                <div className="trip-top-main">
                  <div className="trip-title">
                    {trip.cardGuestName} - {trip.cardNickname}
                  </div>
                  {isSelected ? (
                    <>
                      <div className="trip-sub">{trip.cardVehicleLine} - {trip.statusLabel}</div>
                      <div className="trip-sub">{trip.reservationText}</div>
                    </>
                  ) : trip.alertCount > 0 ? (
                    <div className="trip-sub">{trip.statusLabel}</div>
                  ) : null}
                </div>

                {trip.alertCount > 0 ? (
                  <div className="alert-badge">{trip.alertCount} new</div>
                ) : (
                  <div className="chip">{trip.statusLabel.toLowerCase()}</div>
                )}
              </div>

              {isSelected ? (
                <div className="trip-facts-bubble">
                  <div className="trip-facts">
                    <div className="trip-fact-row">
                      <span className="trip-fact-label">Window:</span>
                      <span className="trip-fact-value">{trip.windowText}</span>
                    </div>

                    <div className="trip-fact-row">
                      <span className="trip-fact-label">{trip.etaLabel}:</span>
                      <span className="trip-fact-value">{trip.returnEtaText}</span>
                    </div>

                    {shouldShowCurrentLocation(trip) && (
                      <div className="trip-fact-row">
                        <span className="trip-fact-label">Current location:</span>
                        <span className="trip-fact-value">{trip.locationText}</span>
                      </div>
                    )}

                    {trip.operationalNote &&
                    trip.meta4Value &&
                    trip.operationalNote.trim().toLowerCase() !== trip.meta4Value.trim().toLowerCase() ? (
                      <>
                        <div className="trip-fact-row">
                          <span className="trip-fact-label">Priority:</span>
                          <span className="trip-fact-value">{trip.operationalNote}</span>
                        </div>
                        <div className="trip-fact-row">
                          <span className="trip-fact-label">{trip.meta4Label}:</span>
                          <span className="trip-fact-value">{trip.meta4Value}</span>
                        </div>
                      </>
                    ) : (
                      <div className="trip-fact-row">
                        <span className="trip-fact-label">{trip.meta4Label || "Priority"}:</span>
                        <span className="trip-fact-value">{trip.meta4Value || trip.operationalNote}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="trip-compact-meta">
                  <div className="trip-fact-row">
                    <span className="trip-fact-label">Next activity:</span>
                    <span className="trip-fact-value">
                      {getCompactNextActivityText(trip)}
                    </span>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        {canceledTrips.length > 0 && (
          <div className="trip-section-divider">
            <div className="trip-section-label">Canceled / no longer active</div>
          </div>
        )}

        {canceledTrips.map((trip) => (
          <article
            key={trip.id}
            className={`trip-card canceled ${
              trip.id === selectedTrip?.id ? "selected" : ""
            }`}
            onClick={() =>
                onSelectTrip(selectedTrip?.id === trip.id ? null : trip)
            }
          >
            <div className="trip-top">
              <div className="trip-top-main">
                <div className="trip-title trip-title-canceled">
                  {trip.cardGuestName} • {trip.cardNickname}
                </div>
                <div className="trip-sub">{trip.cardVehicleLine} • {trip.statusLabel}</div>
                <div className="trip-sub">{trip.reservationText}</div>
              </div>

              <div className="chip">canceled</div>
            </div>

            <div className="trip-facts">
  <div className="trip-fact-row">
    <span className="trip-fact-label">Window:</span>
    <span className="trip-fact-value">{trip.windowText}</span>
  </div>

  <div className="trip-fact-row">
    <span className="trip-fact-label">{trip.etaLabel}:</span>
    <span className="trip-fact-value">{trip.returnEtaText}</span>
  </div>

  {shouldShowCurrentLocation(trip) && (
    <div className="trip-fact-row">
      <span className="trip-fact-label">Current location:</span>
      <span className="trip-fact-value">{trip.locationText}</span>
    </div>
  )}

  <div className="trip-fact-row">
    <span className="trip-fact-label">{trip.meta4Label}:</span>
    <span className="trip-fact-value">{trip.meta4Value}</span>
  </div>
</div>
          </article>
        ))}
      </div>
    </section>
  );
}
