// --------------------------------------------------------------------------
// ./src/components/MessagesPanel.jsx
// This component displays incoming messages related to trips, including guest messages,
// system notifications, and other updates. It supports both a live feed of recent messages
// and a focused view for messages related to a selected trip. Users can mark messages as read
// and reply to guest messages directly from the panel.
// --------------------------------------------------------------------------


import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import GuestSafetySnapshotCard from "./maintenance/GuestSafetySnapshotCard";
import PreflightCard from "./maintenance/PreflightCard";
import { openPrintDialogForElement } from "../utils/printUtils";
import {
  buildExportFileName,
  buildPreflightDueItems,
  buildInspectionHistoryMap,
  getNextServiceDue,
  getVinLast6,
  mapRuleStatusToInspectionItem,
} from "../utils/maintUtils";

const API_BASE = "http://localhost:5000";
const COMPLETED_SYNTHETIC_TASKS_STORAGE_KEY = "denmark.completedSyntheticTasks";

function notifyMessageStatsUpdated() {
  window.dispatchEvent(new CustomEvent("messages:stats-updated"));
}

function loadCompletedSyntheticTaskIds() {
  try {
    const raw = window.localStorage.getItem(COMPLETED_SYNTHETIC_TASKS_STORAGE_KEY);
    const ids = JSON.parse(raw || "[]");
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function saveCompletedSyntheticTaskIds(ids) {
  try {
    window.localStorage.setItem(
      COMPLETED_SYNTHETIC_TASKS_STORAGE_KEY,
      JSON.stringify([...ids])
    );
  } catch {
    // localStorage may be unavailable in privacy modes.
  }
}

function buildReplyUrl(message) {
  if (message?.reply_url) {
    return message.reply_url;
  }

  if (message?.trip_details_url) {
    return `${message.trip_details_url.replace(/\/$/, "")}/messages`;
  }

  if (message?.reservation_id) {
    return `https://turo.com/reservation/${message.reservation_id}/messages`;
  }

  return "";
}

function formatTripTime(value) {
  if (!value) return "";

  const d = new Date(value);

  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTripWindow(start, end) {
  const startLabel = formatTripTime(start);
  const endLabel = formatTripTime(end);

  if (startLabel && endLabel) return `${startLabel} -> ${endLabel}`;
  return startLabel || endLabel || "";
}

function formatHandoffCountdown(value, nowMs = Date.now()) {
  if (!value) return "Pickup time unknown";

  const targetMs = new Date(value).getTime();
  if (!Number.isFinite(targetMs)) return "Pickup time unknown";

  const diffMs = targetMs - nowMs;
  const absMs = Math.abs(diffMs);
  const totalMinutes = Math.max(0, Math.floor(absMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${String(minutes).padStart(hours > 0 ? 2 : 1, "0")}m`);

  if (diffMs <= 0) return `${parts.join(" ")} overdue`;
  return `${parts.join(" ")} until pickup`;
}

function formatMoney(value) {
  if (value == null) return "";

  const n = Number(value);
  if (Number.isNaN(n)) return "";

  return `$${n.toFixed(2)}`;
}

function formatHoursDuration(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";

  if (Math.abs(n) < 48) {
    return `${n.toFixed(1)} hr`;
  }

  return `${(n / 24).toFixed(1)} days`;
}

function formatMileageIncluded(value) {
  const miles = Number(value);
  if (!Number.isFinite(miles) || miles <= 0) return "";
  return `${miles.toLocaleString()} mi allowed`;
}

function formatMaintenancePlanDate(value) {
  if (!value) return "Available now";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Available now";

  if (d.getTime() <= Date.now() + 5 * 60 * 1000) {
    return "Available now";
  }

  return formatTripTime(value);
}

function formatPrepWindowLabel(value) {
  if (!value) return "Before handoff";

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Before handoff";

  return `Before ${d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function buildPrepDueItems(message, summary = null) {
  const tripStart = message?.trip_start ? new Date(message.trip_start) : null;
  const cutoff =
    tripStart && !Number.isNaN(tripStart.getTime()) ? tripStart : new Date();
  const summaryItems = summary
    ? buildPreflightDueItems(summary, { cutoff })
    : [];
  const taskItems = (message?.maintenance_tasks || []).map((task) => ({
    id: task.id || task.title,
    title: task.title || "Maintenance task",
  }));
  const seen = new Set();

  return [...summaryItems, ...taskItems].filter((item) => {
    const key = String(item.title || "")
      .replace(/\s+-\s+(never recorded|due now|due before trip|overdue|failed)$/i, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildPrepVehicle(message, vehicle = null) {
  const source = vehicle || {};
  const vin = source.vin || message?.maintenance_vehicle_vin || null;

  return {
    ...source,
    nickname:
      source.nickname ||
      message?.maintenance_vehicle_name ||
      message?.vehicle_name ||
      "Vehicle",
    year: source.year || message?.vehicle_year || "",
    make: source.make || "",
    model: source.model || "",
    vin,
    vin_last6: source.vin_last6 || getVinLast6(vin),
    plate: source.plate || source.license_plate || "",
    license_plate: source.license_plate || source.plate || "",
    registration_expires: source.registration_expires || "",
    body_condition: source.body_condition || "unknown",
    currentOdometerMiles:
      source.currentOdometerMiles ||
      source.current_odometer_miles ||
      source.odometer ||
      null,
    body_notes: source.body_notes || source.guest_visible_condition_notes || [],
  };
}

function buildGuestInspectionVehicle(message, vehicle = null, summary = null) {
  const source = summary?.vehicle || vehicle || {};
  const notes = Array.isArray(summary?.guestVisibleConditionNotes)
    ? summary.guestVisibleConditionNotes
        .map((note) => {
          if (typeof note === "string") return note.trim();
          if (note && typeof note === "object") {
            return String(note.description || note.title || "").trim();
          }
          return "";
        })
        .filter(Boolean)
    : [];
  const historyMap = buildInspectionHistoryMap(summary || {});
  const ruleStatuses = Array.isArray(summary?.ruleStatuses)
    ? summary.ruleStatuses
    : [];
  const vin = source.vin || vehicle?.vin || message?.vehicle_vin || null;
  const plate =
    source.license_plate ||
    source.licensePlate ||
    source.plate ||
    vehicle?.license_plate ||
    vehicle?.plate ||
    "";

  return {
    ...source,
    nickname:
      source.nickname ||
      vehicle?.nickname ||
      message?.vehicle_nickname ||
      message?.vehicle_name ||
      "Vehicle",
    year: source.year || vehicle?.year || "",
    make: source.make || vehicle?.make || "",
    model: source.model || vehicle?.model || "",
    vin,
    vin_last6: getVinLast6(vin),
    plate,
    license_plate: plate,
    registration_expires:
      source.registration?.code ||
      source.registration_expires ||
      vehicle?.registration_expires ||
      "",
    body_condition: notes.length ? "documented" : "good",
    body_notes: notes.length
      ? notes
      : ["No guest-visible cosmetic notes recorded"],
    currentOdometerMiles:
      summary?.currentOdometerMiles ??
      source.currentOdometerMiles ??
      source.current_odometer_miles ??
      vehicle?.current_odometer_miles ??
      vehicle?.odometer ??
      null,
    next_service_due: getNextServiceDue(summary || {}),
    inspection_items: ruleStatuses.map((rule) =>
      mapRuleStatusToInspectionItem(rule, historyMap)
    ),
  };
}

function getMaintenanceTripState(message) {
  const start = message?.trip_start ? new Date(message.trip_start).getTime() : NaN;
  const end = message?.trip_end ? new Date(message.trip_end).getTime() : NaN;
  const now = Date.now();

  if (Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now) {
    return "active";
  }

  if (Number.isFinite(start) && start > now) {
    return "upcoming";
  }

  return "other";
}

function getMaintenanceTaskMode(message) {
  const tasks = Array.isArray(message?.maintenance_tasks)
    ? message.maintenance_tasks
    : [];

  const hasAfterReturn = tasks.some((task) => task?.planning_mode === "after_return");
  const hasProjection = tasks.some((task) => {
    if (task?.planning_mode === "after_return") return false;

    const type = String(task?.task_type || "").toLowerCase();
    const title = String(task?.title || "").toLowerCase();
    const triggerType = String(task?.trigger_context?.triggerType || "").toLowerCase();
    return (
      type.includes("projection") ||
      triggerType.includes("projection") ||
      title.includes("likely due during")
    );
  });

  if (hasProjection) return "during";
  if (hasAfterReturn) return "after";

  const hasPostTrip = tasks.some((task) =>
    String(task?.task_type || "").toLowerCase().startsWith("post_trip")
  );

  return hasPostTrip ? "after" : "before";
}

function getMaintenanceNoticeCopy(message) {
  const tripState = getMaintenanceTripState(message);
  const mode = getMaintenanceTaskMode(message);

  if (mode === "during") {
    return {
      title:
        tripState === "active"
          ? "Maintenance during current trip"
          : "Will come due during trip",
      body: tripState === "active" ? "during this active trip" : "during this trip",
      planLabel: tripState === "active" ? "Coordinate by" : "Plan around",
    };
  }

  if (mode === "after") {
    return {
      title: "Maintenance after return",
      body: "after this trip returns",
      planLabel: "Available after",
    };
  }

  return {
    title: "Maintenance before handoff",
    body: "before this trip starts",
    planLabel: "Plan around",
  };
}

function getMaintenanceVehicleKey(message) {
  return (
    message?.maintenance_vehicle_name ||
    message?.maintenance_vehicle_vin ||
    message?.vehicle_name ||
    ""
  );
}

function buildMessageBody(message) {
  const type = message?.type || message?.message_type;
  if (type === "handoff_ready_required") {
    const start = formatTripTime(message?.trip_start);
    const vehicleName = message?.vehicle_nickname || message?.vehicle_name || "Vehicle";

    return `${vehicleName} goes out${
      start ? ` ${start}` : " soon"
    }. Advance it when the handoff prep is complete.`;
  }

  if (type === "inspection_export_required") {
    return `Guest safety snapshot is ready for ${
      message?.vehicle_nickname || message?.vehicle_name || "this vehicle"
    }. Export it before sending handoff instructions.`;
  }

  if (type === "closeout_required") {
    const end = formatTripTime(message?.trip_end);
    const reasons = Array.isArray(message?.closeout_reasons)
      ? message.closeout_reasons
      : [];
    const reasonText = reasons.length
      ? `Needs ${reasons.join(", ")}.`
      : "Needs closeout review.";

    return `Trip ended${end ? ` ${end}` : ""}. ${reasonText}`;
  }

  if (type === "late_toll_unbilled") {
    const count = Number(message?.late_toll_count || 0);
    const total = formatMoney(message?.late_toll_total) || "$0.00";
    const lag = formatHoursDuration(message?.late_toll_hours_after_trip_end);

    return `${count} toll${count === 1 ? "" : "s"} totaling ${total} were recorded after trip end${
      lag ? ` (${lag} later)` : ""
    } and still need Turo billing.`;
  }

  if (type === "trip_overlap_detected") {
    const primaryGuest = message?.primary_guest_name || message?.guest_name || "Guest";
    const secondaryGuest = message?.overlapping_guest_name || "Guest";
    const overlapWindow = formatTripWindow(
      message?.overlap_start,
      message?.overlap_end
    );

    return `${primaryGuest} and ${secondaryGuest} are booked on the same vehicle at the same time${
      overlapWindow ? ` (${overlapWindow})` : ""
    }. Check the trip dates and correct the bad reservation window.`;
  }

  if (type === "maintenance_required") {
    const count = Number(message?.maintenance_task_count || 0);
    const copy = getMaintenanceNoticeCopy(message);

    return `${count} maintenance planning item${count === 1 ? "" : "s"} for ${
      message?.maintenance_vehicle_name || message?.vehicle_name || "this vehicle"
    } ${copy.body}.`;
  }

  if (type === "guest_message" && message?.guest_message) {
    return message.guest_message;
  }

  if (type === "trip_changed") {
    if (message?.new_trip_end) {
      return `New trip end: ${formatTripTime(message.new_trip_end)}`;
    }

  }

  if (type === "trip_booked") {
    const start = formatTripTime(message.trip_start);
    const end = formatTripTime(message.trip_end);
    const revenue = formatMoney(message.amount);

    if (start && end && revenue) {
      return `${start} → ${end} • ${revenue}`;
    }

    if (start && end) {
      return `${start} → ${end}`;
    }

    if (revenue) {
      return revenue;
    }
  }

  const amount = formatMoney(message?.amount);
  if (amount) {
    if (message?.subject) {
      return amount;
    }

    return amount;
  }

  return message?.guest_message || message?.subject || "";
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return "";

  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function buildMessageTitle(message) {
  const type = message?.type || message?.message_type;
  if (type === "trip_overlap_detected") {
    return message?.vehicle_nickname || message?.vehicle_name || "Overlapping trips";
  }

  const guest = message?.guest_name || message?.parsed?.guest;
  const vehicle =
    message?.vehicle_nickname || message?.vehicle_name || message?.parsed?.vehicle;

  if (vehicle && guest) return `${guest} • ${vehicle}`;
  if (vehicle) return vehicle;
  if (guest) return guest;
  return "Incoming message";
}

function buildMessageSub(message) {
  const type = message?.type || message?.message_type || message?.parsed?.type;

  if (type === "handoff_ready_required") return "Handoff prep required";
  if (type === "inspection_export_required") return "Guest inspection export";
  if (type === "closeout_required") return "Trip closeout needed";
  if (type === "late_toll_unbilled") return "Late toll billing needed";
  if (type === "trip_overlap_detected") return "Trip overlap detected";
  if (type === "guest_message") return "Guest message";
  if (type === "trip_booked") return "Trip booked";
  if (type === "maintenance_required") return "Maintenance required";
  if (type === "trip_changed") return "Trip changed";
  if (type === "payment_notice") return "Payment notice";
  if (type === "trip_rated") return "Trip rated";

  if (message?.subject) return message.subject;
  return "Message";
}

function getMessageTimestamp(message) {
  return (
    message?.display_at ||
    message?.timestamp ||
    message?.message_timestamp ||
    message?.created_at ||
    ""
  );
}

function getNotificationCreatedAtMs(message) {
  const value =
    message?.notification_created_at ||
    message?.created_at ||
    message?.message_timestamp ||
    message?.timestamp;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isBookingConfirmationTask(message) {
  const type = message?.type || message?.message_type;
  const stage = String(message?.trip_workflow_stage || "").toLowerCase();
  const status = String(message?.trip_status || "").toLowerCase();
  const terminalOrConfirmedStages = new Set([
    "confirmed",
    "ready_for_handoff",
    "in_progress",
    "turnaround",
    "awaiting_expenses",
    "complete",
    "closed",
    "canceled",
  ]);

  return (
    type === "trip_booked" &&
    message?.trip_id &&
    stage !== "canceled" &&
    status !== "canceled" &&
    (stage === "booked" ||
      (!terminalOrConfirmedStages.has(stage) &&
        (message?.trip_needs_review === true ||
          ["booked_unconfirmed", "updated_unconfirmed"].includes(status))))
  );
}

function isMaintenanceNotice(message) {
  const type = message?.type || message?.message_type;
  return type === "maintenance_required" && message?.trip_id;
}

function isHandoffReadyTask(message) {
  const type = message?.type || message?.message_type;
  return type === "handoff_ready_required" && message?.trip_id;
}

function isInspectionExportTask(message) {
  const type = message?.type || message?.message_type;
  return type === "inspection_export_required" && message?.trip_id;
}

function isCloseoutTask(message) {
  const type = message?.type || message?.message_type;
  return type === "closeout_required" && message?.trip_id;
}

function isLateTollTask(message) {
  const type = message?.type || message?.message_type;
  return type === "late_toll_unbilled" && message?.trip_id;
}

function isTripOverlapTask(message) {
  const type = message?.type || message?.message_type;
  return type === "trip_overlap_detected" && message?.trip_id;
}

function isCompletableSyntheticTask(message) {
  return isInspectionExportTask(message);
}

function boolOrReason(message, field, reason) {
  if (typeof message?.[field] === "boolean") return message[field];
  const reasons = Array.isArray(message?.closeout_reasons)
    ? message.closeout_reasons
    : [];
  return reasons.includes(reason);
}

function formatFuelPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unknown";
  return `${Math.round(n)}%`;
}

function buildFuelCloseoutDetail(message) {
  const level = formatFuelPercent(message?.closeout_latest_fuel_level);
  const source = message?.closeout_latest_fuel_source
    ? ` via ${message.closeout_latest_fuel_source}`
    : "";
  const nextGuest = message?.closeout_next_guest_name
    ? ` before ${message.closeout_next_guest_name} arrives`
    : " before the next guest arrives";
  const nextTrip = message?.closeout_next_trip_start
    ? ` (${formatTripTime(message.closeout_next_trip_start)})`
    : "";

  return `Fuel is ${level}${source}; refill to full${nextGuest}${nextTrip}.`;
}

function buildTollCloseoutDetail(message) {
  const count = Number(message?.closeout_toll_count ?? 0);
  const total = Number(message?.closeout_toll_total ?? 0);
  const status = message?.closeout_toll_review_status || "none";

  if (count > 0 || total > 0) {
    const tollLabel =
      count > 0 ? `${count} toll${count === 1 ? "" : "s"}` : "Tolls";
    return `${tollLabel} totaling ${formatMoney(total)} need Turo billing review. Current status: ${status}`;
  }

  return `Audit HCTRA tolls against Turo billing. Current status: ${status}`;
}

function buildCloseoutActionItems(message) {
  return [
    {
      key: "workflow",
      label: "Advance workflow",
      pending: boolOrReason(message, "closeout_workflow_incomplete", "advance workflow"),
      detail: "Move the trip through turnaround / awaiting expenses and finish it as complete.",
      where: "Detail panel stage button",
    },
    {
      key: "starting_odometer",
      label: "Starting odometer",
      pending: boolOrReason(
        message,
        "closeout_missing_starting_odometer",
        "starting odometer"
      ),
      detail: message?.starting_odometer
        ? `Recorded: ${Number(message.starting_odometer).toLocaleString("en-US")} mi`
        : "Enter the starting odometer from trip start.",
      where: "Main panel",
    },
    {
      key: "ending_odometer",
      label: "Ending odometer",
      pending: boolOrReason(
        message,
        "closeout_missing_ending_odometer",
        "ending odometer"
      ),
      detail: message?.ending_odometer
        ? `Recorded: ${Number(message.ending_odometer).toLocaleString("en-US")} mi`
        : "Enter the return odometer so mileage and overage can calculate.",
      where: "Main panel",
    },
    {
      key: "expenses",
      label: "Turo expense review",
      pending: boolOrReason(message, "closeout_expenses_pending", "expense review"),
      detail: `Review fuel and incidentals in Turo, then record the result here. Current status: ${
        message?.closeout_expense_status || "pending"
      }`,
      where: "Main panel",
    },
    {
      key: "tolls",
      label: "Turo toll billing",
      pending: boolOrReason(message, "closeout_tolls_pending", "toll billing"),
      detail: buildTollCloseoutDetail(message),
      where: "Main panel",
    },
    {
      key: "fuel_before_next_guest",
      label: "Fuel before next guest",
      pending: boolOrReason(
        message,
        "closeout_fuel_low",
        "fuel before next guest"
      ),
      detail: buildFuelCloseoutDetail(message),
      where: "Before next pickup",
    },
    {
      key: "closed_out",
      label: "Closeout flag",
      pending: boolOrReason(message, "closeout_flag_incomplete", "closeout flag"),
      detail: "Mark the trip closed out once the audit items above are handled.",
      where: "Main panel",
    },
  ];
}

function normalizeCompareValue(value) {
  return String(value ?? "").trim().toLowerCase();
}

function datesMatch(a, b) {
  if (!a || !b) return !a && !b;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

function amountsMatch(a, b) {
  const aNum = Number(a);
  const bNum = Number(b);
  if (!Number.isFinite(aNum) && !Number.isFinite(bNum)) return true;
  return Number.isFinite(aNum) && Number.isFinite(bNum) && Math.abs(aNum - bNum) < 0.01;
}

function buildBookingComparisonRows(message) {
  return [
    {
      label: "Guest",
      emailValue: message.guest_name || "",
      tripValue: message.trip_record_guest_name || "",
      matches:
        normalizeCompareValue(message.guest_name) ===
        normalizeCompareValue(message.trip_record_guest_name),
    },
    {
      label: "Vehicle",
      emailValue: message.vehicle_name || "",
      tripValue: message.trip_record_vehicle_name || "",
      matches:
        normalizeCompareValue(message.vehicle_name) ===
        normalizeCompareValue(message.trip_record_vehicle_name),
    },
    {
      label: "Allowed mileage",
      emailValue: formatMileageIncluded(message.mileage_included),
      tripValue: formatMileageIncluded(message.trip_record_mileage_included),
      matches:
        Number(message.mileage_included || 0) ===
        Number(message.trip_record_mileage_included || 0),
    },
    {
      label: "Start",
      emailValue: formatTripTime(message.trip_start),
      tripValue: formatTripTime(message.trip_record_start),
      matches: datesMatch(message.trip_start, message.trip_record_start),
    },
    {
      label: "End",
      emailValue: formatTripTime(message.trip_end),
      tripValue: formatTripTime(message.trip_record_end),
      matches: datesMatch(message.trip_end, message.trip_record_end),
    },
    {
      label: "Earnings",
      emailValue: formatMoney(message.amount),
      tripValue: formatMoney(message.trip_record_amount),
      matches: amountsMatch(message.amount, message.trip_record_amount),
    },
    {
      label: "Reservation",
      emailValue: message.reservation_id ? `#${message.reservation_id}` : "",
      tripValue: message.trip_record_reservation_id
        ? `#${message.trip_record_reservation_id}`
        : "",
      matches:
        normalizeCompareValue(message.reservation_id) ===
        normalizeCompareValue(message.trip_record_reservation_id),
    },
  ];
}

export default function MessagesPanel({
  selectedTrip,
  messageMode = "live",
  onClearSelectedTrip,
  onSelectTrip,
  onOpenMaintenanceVehicle,
  initialMessages = [],
  initialUnreadCount = 0,
  initialLoadComplete = false,
}) {
  const [messages, setMessages] = useState(() =>
    Array.isArray(initialMessages) ? initialMessages : []
  );
  const [loading, setLoading] = useState(!initialLoadComplete);
  const [error, setError] = useState("");
  const [newMessageIds, setNewMessageIds] = useState([]);
  const [unreadCount, setUnreadCount] = useState(Number(initialUnreadCount || 0));
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [confirmingMessageId, setConfirmingMessageId] = useState(null);
  const [focusingMessageId, setFocusingMessageId] = useState(null);
  const [readyingHandoffMessageId, setReadyingHandoffMessageId] = useState(null);
  const [exportingPrepMessageId, setExportingPrepMessageId] = useState(null);
  const [exportingInspectionMessageId, setExportingInspectionMessageId] =
    useState(null);
  const [prepExport, setPrepExport] = useState(null);
  const [inspectionExport, setInspectionExport] = useState(null);
  const [printingPrepMessageId, setPrintingPrepMessageId] = useState(null);
  const [prepPrint, setPrepPrint] = useState(null);
  const [focusedCloseoutTask, setFocusedCloseoutTask] = useState(null);
  const [expandedMaintenanceIds, setExpandedMaintenanceIds] = useState(() => new Set());
  const [completedSyntheticTaskIds, setCompletedSyntheticTaskIds] = useState(() =>
    loadCompletedSyntheticTaskIds()
  );

  const seenIdsRef = useRef(new Set());
  const knownQueueItemIdsRef = useRef(new Set());
  const queueChimeWatermarkRef = useRef(Date.now());
  const audioRef = useRef(null);
  const highlightTimeoutRef = useRef(null);
  const prepExportRef = useRef(null);
  const inspectionExportRef = useRef(null);
  const consumedInitialLiveMessagesRef = useRef(false);
  const completedSyntheticTaskIdsRef = useRef(completedSyntheticTaskIds);

  useEffect(() => {
    completedSyntheticTaskIdsRef.current = completedSyntheticTaskIds;
  }, [completedSyntheticTaskIds]);

  async function loadMessageStats() {
    try {
      const res = await fetch("http://localhost:5000/api/messages/stats");

      if (!res.ok) {
        throw new Error(`Failed to load message stats (${res.status})`);
      }

      const stats = await res.json();

      setUnreadCount(Number(stats.unread || 0));
    } catch (err) {
      console.error("Failed loading message stats:", err);
    }
  }

async function handleMarkAsRead(messageId) {
  try {
    const res = await fetch(`http://localhost:5000/api/messages/${messageId}/read`, {
      method: "PATCH",
    });

    if (!res.ok) {
      throw new Error(`Failed to mark message as read (${res.status})`);
    }

    setMessages((prev) => prev.filter((msg) => msg.id !== messageId));
    setNewMessageIds((prev) => prev.filter((id) => id !== messageId));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    seenIdsRef.current.delete(messageId);

    notifyMessageStatsUpdated();
  } catch (err) {
    setError(err.message || "Failed to mark message as read");
  }
}

async function handleFocusTrip(message) {
  if (!message?.trip_id) {
    return;
  }

  try {
    setFocusingMessageId(message.id);
    setError("");

    const res = await fetch(`${API_BASE}/api/trips/${message.trip_id}`);

    if (!res.ok) {
      throw new Error(`Failed to load trip (${res.status})`);
    }

    const trip = await res.json();
    if (isCloseoutTask(message)) {
      setFocusedCloseoutTask({
        ...message,
        trip_workflow_stage: trip.workflow_stage ?? message.trip_workflow_stage,
        trip_status: trip.status ?? message.trip_status,
        starting_odometer: trip.starting_odometer ?? message.starting_odometer,
        ending_odometer: trip.ending_odometer ?? message.ending_odometer,
        closeout_expense_status:
          trip.expense_status ?? message.closeout_expense_status,
        closeout_toll_review_status:
          trip.toll_review_status ?? message.closeout_toll_review_status,
        has_tolls: trip.has_tolls ?? message.has_tolls,
        closed_out: trip.closed_out ?? message.closed_out,
      });
    }
    onSelectTrip?.(trip);
  } catch (err) {
    setError(err.message || "Failed to focus trip");
  } finally {
    setFocusingMessageId(null);
  }
}

function toggleMaintenanceNotice(messageId) {
  setExpandedMaintenanceIds((prev) => {
    const next = new Set(prev);

    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }

    return next;
  });
}

function completeSyntheticTask(message) {
  if (!isCompletableSyntheticTask(message)) return;

  setCompletedSyntheticTaskIds((prev) => {
    const next = new Set(prev);
    next.add(message.id);
    saveCompletedSyntheticTaskIds(next);
    completedSyntheticTaskIdsRef.current = next;
    return next;
  });

  setMessages((prev) => prev.filter((item) => item.id !== message.id));
  setNewMessageIds((prev) => prev.filter((id) => id !== message.id));
  seenIdsRef.current.delete(message.id);
}

async function handleConfirmBooking(message) {
  if (!message?.trip_id) {
    setError("No linked trip found for this booking message");
    return;
  }

  try {
    setConfirmingMessageId(message.id);
    setError("");

    const res = await fetch(`${API_BASE}/api/trips/${message.trip_id}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow_stage: "confirmed",
        force: false,
      }),
    });

    if (!res.ok) {
      const maybeJson = await res.json().catch(() => null);
      throw new Error(maybeJson?.error || `Failed to confirm trip (${res.status})`);
    }

    if (message.status === "unread") {
      await fetch(`${API_BASE}/api/messages/${message.id}/read`, {
        method: "PATCH",
      }).catch(() => null);
    }

    await loadMessages(false);
    await loadMessageStats();
    notifyMessageStatsUpdated();
  } catch (err) {
    setError(err.message || "Failed to confirm booking");
  } finally {
    setConfirmingMessageId(null);
  }
}

async function handleAdvanceToReadyForHandoff(message) {
  if (!message?.trip_id) {
    setError("No linked trip found for this handoff task");
    return;
  }

  try {
    setReadyingHandoffMessageId(message.id);
    setError("");

    const res = await fetch(`${API_BASE}/api/trips/${message.trip_id}/stage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflow_stage: "ready_for_handoff",
        force: false,
      }),
    });

    if (!res.ok) {
      const maybeJson = await res.json().catch(() => null);
      throw new Error(
        maybeJson?.error || `Failed to advance trip (${res.status})`
      );
    }

    await loadMessages(false);
    notifyMessageStatsUpdated();
  } catch (err) {
    setError(err.message || "Failed to advance trip to ready for handoff");
  } finally {
    setReadyingHandoffMessageId(null);
  }
}

async function handleExportPrepSheet(message, mode = "export") {
  if (
    !isMaintenanceNotice(message) ||
    exportingPrepMessageId ||
    printingPrepMessageId
  ) {
    return;
  }

  const printWindow =
    mode === "print" ? window.open("", "_blank") : null;

  if (mode === "print" && !printWindow) {
    setError("Browser blocked the print window");
    return;
  }

  try {
    if (mode === "print") {
      setPrintingPrepMessageId(message.id);
    } else {
      setExportingPrepMessageId(message.id);
    }
    setError("");

    let vehicle = null;
    let summary = null;
    const vehicleSelector =
      message.maintenance_vehicle_vin ||
      message.maintenance_vehicle_name ||
      message.vehicle_name;

    if (vehicleSelector) {
      const res = await fetch(
        `${API_BASE}/api/vehicles/${encodeURIComponent(vehicleSelector)}`
      );

      if (res.ok) {
        vehicle = await res.json();
      }

      const summarySelector = vehicle?.vin || vehicleSelector;
      const summaryRes = await fetch(
        `${API_BASE}/api/vehicles/${encodeURIComponent(
          summarySelector
        )}/maintenance-summary`
      );

      if (summaryRes.ok) {
        summary = await summaryRes.json();
      }
    }

    const payload = {
      messageId: message.id,
      vehicle: buildPrepVehicle(message, vehicle),
      windowLabel: formatPrepWindowLabel(message.trip_start),
      dueItems: buildPrepDueItems(message, summary),
    };

    if (mode === "print") {
      setPrepPrint({
        ...payload,
        printWindow,
      });
    } else {
      setPrepExport(payload);
    }
  } catch (err) {
    console.error("Failed preparing prep sheet:", err);
    setError(err.message || `Could not ${mode} prep sheet`);
    setExportingPrepMessageId(null);
    setPrintingPrepMessageId(null);
    if (mode === "print") {
      printWindow?.close();
    }
  }
}

async function handleExportGuestInspectionSheet(message) {
  if (!isInspectionExportTask(message) || exportingInspectionMessageId) {
    return;
  }

  try {
    setExportingInspectionMessageId(message.id);
    setError("");

    const vehicleSelector =
      message.vehicle_vin ||
      message.vehicle_nickname ||
      message.vehicle_name;
    let vehicle = null;
    let summary = null;

    if (vehicleSelector) {
      const vehicleRes = await fetch(
        `${API_BASE}/api/vehicles/${encodeURIComponent(vehicleSelector)}`
      );

      if (vehicleRes.ok) {
        vehicle = await vehicleRes.json();
      }

      const summarySelector = vehicle?.vin || vehicleSelector;
      const summaryRes = await fetch(
        `${API_BASE}/api/vehicles/${encodeURIComponent(
          summarySelector
        )}/maintenance-summary`
      );

      if (summaryRes.ok) {
        summary = await summaryRes.json();
      }
    }

    setInspectionExport({
      messageId: message.id,
      vehicle: buildGuestInspectionVehicle(message, vehicle, summary),
    });
  } catch (err) {
    console.error("Failed preparing guest inspection sheet:", err);
    setError(err.message || "Could not export guest inspection sheet");
    setExportingInspectionMessageId(null);
  }
}

  function handleReply(message) {
    const url = buildReplyUrl(message);

    if (!url) {
      setError("No reply URL found for this message");
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function loadMessages(isInitialLoad = false) {
    try {
      if (isInitialLoad) {
        setLoading(true);
      }

      const showingTripMessages = messageMode === "trip" && selectedTrip?.id;
      const endpoint = showingTripMessages
        ? `http://localhost:5000/api/trips/${selectedTrip.id}/messages`
        : "http://localhost:5000/api/messages";

      const res = await fetch(endpoint);

      if (!res.ok) {
        throw new Error(`Failed to load messages (${res.status})`);
      }

      const data = await res.json();
      const nextMessages = Array.isArray(data)
        ? showingTripMessages
          ? data
          : data.slice(0, 5)
        : [];
      const visibleMessages = nextMessages.filter(
        (message) =>
          !isCompletableSyntheticTask(message) ||
          !completedSyntheticTaskIdsRef.current.has(message.id)
      );
      const closeoutTaskIsFocused =
        showingTripMessages &&
        !selectedTrip?.closed_out &&
        focusedCloseoutTask?.trip_id &&
        Number(focusedCloseoutTask.trip_id) === Number(selectedTrip?.id);
      const displayMessages =
        closeoutTaskIsFocused &&
        !visibleMessages.some((message) => message.id === focusedCloseoutTask.id)
          ? [focusedCloseoutTask, ...visibleMessages]
          : visibleMessages;

      const nextIds = displayMessages.map((msg) => msg.id);
      const nextIdKeys = displayMessages.map((msg) => String(msg.id));
      const seenIds = seenIdsRef.current;
      const knownQueueItemIds = knownQueueItemIdsRef.current;

      if (isInitialLoad) {
        seenIds.clear();
        nextIds.forEach((id) => seenIds.add(id));
        knownQueueItemIds.clear();
        nextIdKeys.forEach((id) => knownQueueItemIds.add(id));
        queueChimeWatermarkRef.current = Date.now();
      } else {
        const watermark = queueChimeWatermarkRef.current;
        const freshMessages = displayMessages.filter((message) => {
          const idKey = String(message.id);
          if (knownQueueItemIds.has(idKey)) return false;

          const createdAtMs = getNotificationCreatedAtMs(message);
          return createdAtMs > watermark - 5000;
        });
        const freshIds = freshMessages.map((message) => message.id);

        if (freshIds.length > 0) {
          setNewMessageIds(freshIds);

          if (highlightTimeoutRef.current) {
            clearTimeout(highlightTimeoutRef.current);
          }

          highlightTimeoutRef.current = setTimeout(() => {
            setNewMessageIds([]);
          }, 6000);

          if (!showingTripMessages && audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play().catch(() => {
              // Browser may block autoplay until user interacts with the page.
            });
          }
        }

        seenIds.clear();
        nextIds.forEach((id) => seenIds.add(id));
        nextIdKeys.forEach((id) => knownQueueItemIds.add(id));
        queueChimeWatermarkRef.current = Date.now();
      }

      setMessages(displayMessages);
      setError("");
    } catch (err) {
      setError(err.message || "Failed to load messages");
    } finally {
      if (isInitialLoad) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const timerId = setInterval(() => {
      setCountdownNow(Date.now());
    }, 30000);

    return () => clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (messageMode !== "trip" || !selectedTrip?.id) {
      setFocusedCloseoutTask(null);
      return;
    }

    if (selectedTrip?.closed_out) {
      setFocusedCloseoutTask(null);
      setMessages((current) =>
        current.filter((message) => !isCloseoutTask(message))
      );
      return;
    }

    setFocusedCloseoutTask((current) =>
      current?.trip_id && Number(current.trip_id) === Number(selectedTrip.id)
        ? current
        : null
    );
  }, [messageMode, selectedTrip?.id, selectedTrip?.closed_out]);

  useEffect(() => {
    audioRef.current = new Audio("/boop.mp3");
    audioRef.current.preload = "auto";

    const canUseInitialMessages =
      initialLoadComplete &&
      messageMode === "live" &&
      !selectedTrip?.id &&
      Array.isArray(initialMessages) &&
      !consumedInitialLiveMessagesRef.current;

    const seededMessages = canUseInitialMessages ? initialMessages : [];
    const visibleSeededMessages = seededMessages.filter(
      (message) =>
        !isCompletableSyntheticTask(message) ||
        !completedSyntheticTaskIdsRef.current.has(message.id)
    );

    setMessages(visibleSeededMessages);
    setNewMessageIds([]);
    seenIdsRef.current.clear();
    visibleSeededMessages.forEach((message) => seenIdsRef.current.add(message.id));
    knownQueueItemIdsRef.current.clear();
    visibleSeededMessages.forEach((message) =>
      knownQueueItemIdsRef.current.add(String(message.id))
    );
    queueChimeWatermarkRef.current = Date.now();
    consumedInitialLiveMessagesRef.current =
      consumedInitialLiveMessagesRef.current || canUseInitialMessages;

    if (canUseInitialMessages) {
      setLoading(false);
    } else {
      loadMessages(true);
    }

    loadMessageStats();

    const intervalId = setInterval(() => {
      loadMessages(false);
      loadMessageStats();
    }, 15000);

    return () => {
      clearInterval(intervalId);

      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, [selectedTrip?.id, selectedTrip?.closed_out, messageMode]);

  useEffect(() => {
    if (!prepExport) return undefined;

    let cancelled = false;

    async function exportPrepSheet() {
      try {
        await new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });

        if (cancelled || !prepExportRef.current) return;

        const dataUrl = await toPng(prepExportRef.current, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: "#ffffff",
        });

        const link = document.createElement("a");
        link.download = buildExportFileName(prepExport.vehicle, "Service");
        link.href = dataUrl;
        link.click();
      } catch (err) {
        console.error("Prep sheet export failed:", err);
        setError(err.message || "Could not export prep sheet");
      } finally {
        if (!cancelled) {
          setPrepExport(null);
          setExportingPrepMessageId(null);
        }
      }
    }

    exportPrepSheet();

    return () => {
      cancelled = true;
    };
  }, [prepExport]);

  useEffect(() => {
    if (!prepPrint) return undefined;

    let cancelled = false;

    async function printPrepSheet() {
      try {
        await new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });

        if (cancelled || !prepExportRef.current) return;

        openPrintDialogForElement(
          prepExportRef.current,
          `${prepPrint.vehicle?.nickname || "Vehicle"} prep card`,
          prepPrint.printWindow
        );
      } catch (err) {
        console.error("Prep sheet print failed:", err);
        setError(err.message || "Could not print prep sheet");
        prepPrint.printWindow?.close();
      } finally {
        if (!cancelled) {
          setPrepPrint(null);
          setPrintingPrepMessageId(null);
        }
      }
    }

    printPrepSheet();

    return () => {
      cancelled = true;
    };
  }, [prepPrint]);

  useEffect(() => {
    if (!inspectionExport) return undefined;

    let cancelled = false;

    async function exportInspectionSheet() {
      try {
        await new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });

        if (cancelled || !inspectionExportRef.current) return;

        const dataUrl = await toPng(inspectionExportRef.current, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: "#ffffff",
        });

        const link = document.createElement("a");
        link.download = buildExportFileName(
          inspectionExport.vehicle,
          "Inspection"
        );
        link.href = dataUrl;
        link.click();
      } catch (err) {
        console.error("Guest inspection export failed:", err);
        setError(err.message || "Could not export guest inspection sheet");
      } finally {
        if (!cancelled) {
          setInspectionExport(null);
          setExportingInspectionMessageId(null);
        }
      }
    }

    exportInspectionSheet();

    return () => {
      cancelled = true;
    };
  }, [inspectionExport]);

  const showingTripMessages = messageMode === "trip" && selectedTrip?.id;

  return (
    <section className="panel messages-panel">
      <div className="panel-header">
        <h2>{showingTripMessages ? "Trip Messages" : "Dispatch Tasks"}</h2>
        <span>{showingTripMessages ? "selected trip feed" : "message and prep queue"}</span>
      </div>

      <div className="panel-subbar">
        <div className="chip search">
          {showingTripMessages
            ? `Trip #${selectedTrip.reservation_id}`
            : "Top queue items"}
        </div>

        <div className="chip">{unreadCount} unread</div>

        {showingTripMessages && (
          <button
            type="button"
            className="message-action"
            onClick={onClearSelectedTrip}
          >
            Back to live queue
          </button>
        )}
      </div>

      <div className="message-list">
        {loading && <div className="message-empty">Loading messages…</div>}

        {!loading && error && <div className="message-empty">{error}</div>}

        {!loading && !error && messages.length === 0 && (
          <div className="message-empty">No messages found.</div>
        )}

        {!loading &&
          !error &&
          messages.map((message) => {
            const isUnread = message.status === "unread";
            const isNew = newMessageIds.includes(message.id);
            const canAdvanceHandoff = isHandoffReadyTask(message);
            const canExportInspection = isInspectionExportTask(message);
            const canCloseoutTrip = isCloseoutTask(message);
            const canReviewLateToll = isLateTollTask(message);
            const canReviewOverlap = isTripOverlapTask(message);
            const canConfirmBooking = isBookingConfirmationTask(message);
            const canShowMaintenance = isMaintenanceNotice(message);
            const canCompleteSyntheticTask = isCompletableSyntheticTask(message);
            const canReply = !!buildReplyUrl(message) && !canCompleteSyntheticTask;
            const canFocusTrip =
              (canAdvanceHandoff ||
                canExportInspection ||
                canCloseoutTrip ||
                canReviewLateToll ||
                canReviewOverlap ||
                canConfirmBooking ||
                canShowMaintenance) &&
              Boolean(message.trip_id);
            const canMarkAsRead =
              isUnread &&
              !canAdvanceHandoff &&
              !canExportInspection &&
              !canCloseoutTrip &&
              !canConfirmBooking &&
              !canShowMaintenance;
            const maintenanceExpanded =
              canShowMaintenance && expandedMaintenanceIds.has(message.id);
            const maintenanceCopy = canShowMaintenance
              ? getMaintenanceNoticeCopy(message)
              : null;
            const bookingComparisonRows = canConfirmBooking
              ? buildBookingComparisonRows(message)
              : [];
            const bookingVehicleNickname =
              message.trip_record_vehicle_nickname ||
              message.vehicle_nickname ||
              message.trip_record_vehicle_name ||
              message.vehicle_name ||
              "Vehicle";
            const bookingAllowedMileage =
              formatMileageIncluded(message.trip_record_mileage_included) ||
              formatMileageIncluded(message.mileage_included) ||
              "Missing";
            const closeoutActionItems = canCloseoutTrip
              ? buildCloseoutActionItems(message)
              : [];
            const closeoutPendingCount = closeoutActionItems.filter(
              (item) => item.pending
            ).length;

            return (
              <article
                key={message.id}
                className={`message ${isUnread ? "unread" : ""} ${
                  isNew ? "message-new" : ""
                } ${canFocusTrip ? "message-focusable" : ""} ${
                  canCloseoutTrip ? "message-closeout-guide" : ""
                }`}
                onClick={() => {
                  if (canShowMaintenance) {
                    toggleMaintenanceNotice(message.id);
                    return;
                  }

                  if (canFocusTrip) {
                    handleFocusTrip(message);
                  }
                }}
              >
                <div className="message-head">
                  <div>
                    <div className="message-title">{buildMessageTitle(message)}</div>
                    <div className="message-sub">{buildMessageSub(message)}</div>
                  </div>

                  <div className="message-time">
                    {isNew ? "just in" : formatTimeAgo(getMessageTimestamp(message))}
                  </div>
                </div>

                <div className="message-body">{buildMessageBody(message)}</div>

                {canAdvanceHandoff && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Ready for handoff?
                      <span>
                        {message.vehicle_nickname || message.vehicle_name || "Vehicle"}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Pickup</span>
                      <strong>{formatTripTime(message.trip_start)}</strong>
                    </div>
                    <div className="message-handoff-countdown">
                      {formatHandoffCountdown(message.trip_start, countdownNow)}
                    </div>
                  </div>
                )}

                {canConfirmBooking && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Confirm this booking
                      <span>Email vs trip record</span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Vehicle nickname</span>
                      <strong>{bookingVehicleNickname}</strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Allowed mileage</span>
                      <strong>{bookingAllowedMileage}</strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Pickup</span>
                      <strong>{formatTripTime(message.trip_start) || "Unknown"}</strong>
                    </div>
                    <div className="message-handoff-countdown">
                      {formatHandoffCountdown(message.trip_start, countdownNow)}
                    </div>
                    {canFocusTrip && (
                      <div className="message-inline-actions">
                        <button
                          type="button"
                          className="message-action"
                          disabled={focusingMessageId === message.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleFocusTrip(message);
                          }}
                        >
                          {focusingMessageId === message.id ? "Loading..." : "Open trip"}
                        </button>
                      </div>
                    )}
                    <div className="message-booking-compare">
                      <div className="message-booking-compare-head">
                        <span>Field</span>
                        <span>Email</span>
                        <span>Trip record</span>
                      </div>
                      {bookingComparisonRows.map((row) => (
                        <div
                          key={row.label}
                          className={`message-booking-compare-row ${
                            row.matches ? "matches" : "mismatch"
                          }`}
                        >
                          <span>{row.label}</span>
                          <strong>{row.emailValue || "Missing"}</strong>
                          <strong>{row.tripValue || "Missing"}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canCloseoutTrip && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Finish trip closeout
                      <span>
                        {closeoutPendingCount
                          ? `${closeoutPendingCount} action${
                              closeoutPendingCount === 1 ? "" : "s"
                            } left`
                          : "ready to close"}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Returned</span>
                      <strong>{formatTripTime(message.trip_end)}</strong>
                    </div>
                    <div className="message-closeout-hint">
                      Reconcile tolls and incidentals in Turo, transcribe the result
                      in the selected trip panel, then close the trip.
                    </div>
                    <div className="message-maintenance-list">
                      {closeoutActionItems.map((item) => (
                        <div
                          key={item.key}
                          className={`message-maintenance-item message-closeout-item ${
                            item.pending
                              ? "message-closeout-item--pending"
                              : "message-closeout-item--done"
                          }`}
                        >
                          <div>
                            <strong>{item.label}</strong>
                            <span>{item.detail}</span>
                          </div>
                          <em>{item.pending ? item.where : "done"}</em>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canReviewLateToll && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Late tolls received
                      <span>
                        {formatMoney(message.late_toll_total) || "$0.00"} unbilled
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Recorded</span>
                      <strong>
                        {formatTripTime(message.late_toll_latest_recorded_at) ||
                          "Unknown"}
                      </strong>
                    </div>
                    <div className="message-closeout-hint">
                      {Number(message.late_toll_count || 0)} toll
                      {Number(message.late_toll_count || 0) === 1 ? "" : "s"} landed
                      after this trip ended. Bill the guest in Turo, then set toll
                      status to billed on the trip.
                    </div>
                  </div>
                )}

                {canReviewOverlap && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Trip dates overlap
                      <span>
                        {message.primary_guest_name || "Guest"} vs{" "}
                        {message.overlapping_guest_name || "guest"}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Overlap window</span>
                      <strong>
                        {formatTripWindow(
                          message.overlap_start,
                          message.overlap_end
                        ) || "Check both reservations"}
                      </strong>
                    </div>
                    <div className="message-booking-compare">
                      <div className="message-booking-compare-head">
                        <span>Trip</span>
                        <span>Reservation</span>
                        <span>Window</span>
                      </div>
                      <div className="message-booking-compare-row mismatch">
                        <span>{message.primary_guest_name || "Primary trip"}</span>
                        <strong>
                          {message.primary_reservation_id
                            ? `#${message.primary_reservation_id}`
                            : "Missing"}
                        </strong>
                        <strong>
                          {formatTripWindow(
                            message.primary_trip_start,
                            message.primary_trip_end
                          ) || "Missing"}
                        </strong>
                      </div>
                      <div className="message-booking-compare-row mismatch">
                        <span>{message.overlapping_guest_name || "Overlapping trip"}</span>
                        <strong>
                          {message.overlapping_reservation_id
                            ? `#${message.overlapping_reservation_id}`
                            : "Missing"}
                        </strong>
                        <strong>
                          {formatTripWindow(
                            message.overlapping_trip_start,
                            message.overlapping_trip_end
                          ) || "Missing"}
                        </strong>
                      </div>
                    </div>
                  </div>
                )}

                {canExportInspection && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Export guest inspection sheet
                      <span>
                        {message.vehicle_nickname || message.vehicle_name || "Vehicle"}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Pickup</span>
                      <strong>{formatTripTime(message.trip_start)}</strong>
                    </div>
                  </div>
                )}

                {canShowMaintenance && (
                  <div
                    className={`message-maintenance-task ${
                      maintenanceExpanded ? "" : "message-maintenance-task--compact"
                    }`}
                  >
                    <div className="message-booking-title">
                      {maintenanceCopy?.title || "Maintenance planning"}
                      <span>
                        {maintenanceExpanded
                          ? message.maintenance_vehicle_name || message.vehicle_name
                          : `${Number(message.maintenance_task_count || 0)} item${
                              Number(message.maintenance_task_count || 0) === 1
                                ? ""
                                : "s"
                            } - click to review`}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>{maintenanceCopy?.planLabel || "Plan around"}</span>
                      <strong>
                        {formatMaintenancePlanDate(message.maintenance_available_at)}
                      </strong>
                    </div>
                    <div className="message-maintenance-list">
                      {(message.maintenance_tasks || []).slice(0, 5).map((task) => (
                        <div key={task.id} className="message-maintenance-item">
                          <div>
                            <strong>{task.title || "Maintenance task"}</strong>
                            {task.description ? <span>{task.description}</span> : null}
                          </div>
                          <em>{task.priority || "medium"}</em>
                        </div>
                      ))}
                    </div>
                    {Number(message.maintenance_task_count || 0) > 5 ? (
                      <div className="message-maintenance-more">
                        +{Number(message.maintenance_task_count) - 5} more
                      </div>
                    ) : null}
                  </div>
                )}

                {(!canShowMaintenance || maintenanceExpanded) &&
                  (canReply ||
                  canMarkAsRead ||
                  canAdvanceHandoff ||
                  canExportInspection ||
                  canCloseoutTrip ||
                  canReviewLateToll ||
                  canCompleteSyntheticTask ||
                  canConfirmBooking ||
                  canShowMaintenance ||
                  canFocusTrip) && (
                  <div className="message-actions">
                    {canFocusTrip && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={focusingMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleFocusTrip(message);
                        }}
                      >
                        {focusingMessageId === message.id
                          ? "Loading..."
                          : canCloseoutTrip
                          ? "Close out trip"
                          : canReviewLateToll
                          ? "Review tolls"
                          : canReviewOverlap
                          ? "Review overlap"
                          : canShowMaintenance || canAdvanceHandoff || canExportInspection
                          ? "View trip"
                          : "Verify details"}
                      </button>
                    )}

                    {canExportInspection && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={exportingInspectionMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleExportGuestInspectionSheet(message);
                        }}
                      >
                        {exportingInspectionMessageId === message.id
                          ? "Exporting..."
                          : "Export inspection sheet"}
                      </button>
                    )}

                    {canAdvanceHandoff && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={readyingHandoffMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAdvanceToReadyForHandoff(message);
                        }}
                      >
                        {readyingHandoffMessageId === message.id
                          ? "Advancing..."
                          : "Ready for handoff"}
                      </button>
                    )}

                    {canShowMaintenance && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenMaintenanceVehicle?.(getMaintenanceVehicleKey(message));
                        }}
                      >
                        {`Maintenance queue for ${
                          message.maintenance_vehicle_name ||
                          message.vehicle_name ||
                          "vehicle"
                        }`}
                      </button>
                    )}

                    {canShowMaintenance && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={
                          exportingPrepMessageId === message.id ||
                          printingPrepMessageId === message.id
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleExportPrepSheet(message);
                        }}
                      >
                        {exportingPrepMessageId === message.id
                          ? "Exporting..."
                          : "Export prep sheet"}
                      </button>
                    )}

                    {canShowMaintenance && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={
                          exportingPrepMessageId === message.id ||
                          printingPrepMessageId === message.id
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleExportPrepSheet(message, "print");
                        }}
                      >
                        {printingPrepMessageId === message.id
                          ? "Printing..."
                          : "Print prep sheet"}
                      </button>
                    )}

                    {canConfirmBooking && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={confirmingMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleConfirmBooking(message);
                        }}
                      >
                        {confirmingMessageId === message.id
                          ? "Confirming..."
                          : "Confirm trip"}
                      </button>
                    )}

                    {canReply && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleReply(message);
                        }}
                      >
                        Reply
                      </button>
                    )}

                    {canCompleteSyntheticTask && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          completeSyntheticTask(message);
                        }}
                      >
                        Complete
                      </button>
                    )}

                    {canMarkAsRead && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMarkAsRead(message.id);
                        }}
                      >
                        Mark as read
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
      </div>

      {prepExport || prepPrint ? (
        <div className="fleet-export-hidden">
          <PreflightCard
            vehicle={(prepExport || prepPrint).vehicle}
            windowLabel={(prepExport || prepPrint).windowLabel}
            dueItems={(prepExport || prepPrint).dueItems}
            cardRef={prepExportRef}
          />
        </div>
      ) : null}

      {inspectionExport ? (
        <div className="fleet-export-hidden">
          <GuestSafetySnapshotCard
            vehicle={inspectionExport.vehicle}
            cardRef={inspectionExportRef}
          />
        </div>
      ) : null}
    </section>
  );
}
