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
  getActiveTrip,
  getNextUpcomingTrip,
  getVinLast6,
  mapMaintenanceSummaryToGuestInspectionVehicle,
} from "../utils/maintUtils";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
const COMPLETED_SYNTHETIC_TASKS_STORAGE_KEY = "denmark.completedSyntheticTasks";
const LIVE_MESSAGE_CACHE_STORAGE_KEY = "denmark.liveMessageQueue";
const RECENTLY_RESOLVED_MESSAGES_STORAGE_KEY = "denmark.recentlyResolvedMessages";
const DAILY_BRIEF_DISPLAY_STORAGE_KEY = "denmark.dailyBriefDisplay";
const MAINTENANCE_BRIEF_DISPLAY_STORAGE_KEY = "denmark.maintenanceBriefDisplay";
const LIVE_MESSAGE_CACHE_TTL_MS = 60 * 1000;
const RECENTLY_RESOLVED_MESSAGE_TTL_MS = 180 * 1000;
const FULL_QUEUE_ONLY_TYPES = new Set([
  "vehicle_diagnostic_alert",
  "maintenance_required",
  "closeout_required",
  "refuel_required",
  "late_toll_unbilled",
  "trip_overlap_detected",
]);
const RAW_FEED_TYPES = [
  { id: "emails", label: "Emails" },
  { id: "internal", label: "Internal messages" },
  { id: "android", label: "Android notifications" },
];
const RAW_FEED_PAGE_SIZE = 10;

function notifyMessageStatsUpdated() {
  window.dispatchEvent(new CustomEvent("messages:stats-updated"));
}

function readLiveMessageQueueCache() {
  try {
    const raw = window.sessionStorage?.getItem(LIVE_MESSAGE_CACHE_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const createdAt = Number(parsed?.createdAt || 0);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (!createdAt || Date.now() - createdAt > LIVE_MESSAGE_CACHE_TTL_MS) {
      window.sessionStorage?.removeItem(LIVE_MESSAGE_CACHE_STORAGE_KEY);
      return null;
    }

    return {
      createdAt,
      items: filterRecentlyResolvedMessagesFromStorage(items),
    };
  } catch {
    return null;
  }
}

function writeLiveMessageQueueCache(items) {
  try {
    if (!Array.isArray(items)) return;
    const cacheItems = filterRecentlyResolvedMessagesFromStorage(items);
    window.sessionStorage?.setItem(
      LIVE_MESSAGE_CACHE_STORAGE_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        items: cacheItems.slice(0, 8),
      })
    );
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function clearLiveMessageQueueCache() {
  try {
    window.sessionStorage?.removeItem(LIVE_MESSAGE_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function readRecentlyResolvedMessageEntries() {
  try {
    const raw = window.sessionStorage?.getItem(RECENTLY_RESOLVED_MESSAGES_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    const activeEntries = parsed
      .map((entry) => ({
        id: String(entry?.id || "").trim(),
        expiresAt: Number(entry?.expiresAt || 0),
      }))
      .filter((entry) => entry.id && entry.expiresAt > now);

    if (activeEntries.length !== parsed.length) {
      writeRecentlyResolvedMessageEntries(activeEntries);
    }

    return activeEntries;
  } catch {
    return [];
  }
}

function writeRecentlyResolvedMessageEntries(entries) {
  try {
    const activeEntries = Array.isArray(entries)
      ? entries
          .map((entry) => ({
            id: String(entry?.id || "").trim(),
            expiresAt: Number(entry?.expiresAt || 0),
          }))
          .filter((entry) => entry.id && entry.expiresAt > Date.now())
      : [];

    if (!activeEntries.length) {
      window.sessionStorage?.removeItem(RECENTLY_RESOLVED_MESSAGES_STORAGE_KEY);
      return;
    }

    window.sessionStorage?.setItem(
      RECENTLY_RESOLVED_MESSAGES_STORAGE_KEY,
      JSON.stringify(activeEntries.slice(-200))
    );
  } catch {
    // Ignore storage failures in private or restricted browser contexts.
  }
}

function getMessageIdentityKeys(message) {
  return [
    message?.id,
    message?.messageId,
    message?.latest_message_id,
    ...(Array.isArray(message?.message_ids) ? message.message_ids : []),
  ]
    .map((id) => String(id || "").trim())
    .filter(Boolean);
}

function filterRecentlyResolvedMessagesFromStorage(items) {
  if (!Array.isArray(items) || !items.length) return [];

  const resolvedIds = new Set(
    readRecentlyResolvedMessageEntries().map((entry) => entry.id)
  );
  if (!resolvedIds.size) return items;

  return items.filter(
    (message) => !getMessageIdentityKeys(message).some((id) => resolvedIds.has(id))
  );
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

async function waitForExportAssetPaint(root) {
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  if (document.fonts?.ready) {
    await document.fonts.ready.catch(() => undefined);
  }

  const images = Array.from(root?.querySelectorAll?.("img") || []);
  await Promise.all(
    images.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    })
  );
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

function loadDailyBriefDisplayState() {
  try {
    const raw = window.localStorage.getItem(DAILY_BRIEF_DISPLAY_STORAGE_KEY);
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveDailyBriefDisplayState(state) {
  try {
    window.localStorage.setItem(
      DAILY_BRIEF_DISPLAY_STORAGE_KEY,
      JSON.stringify(state || {})
    );
  } catch {
    // localStorage may be unavailable in privacy modes.
  }
}

function getLocalDateKey(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "today";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadMaintenanceBriefDisplayState() {
  try {
    const raw = window.localStorage.getItem(MAINTENANCE_BRIEF_DISPLAY_STORAGE_KEY);
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveMaintenanceBriefDisplayState(state) {
  try {
    window.localStorage.setItem(
      MAINTENANCE_BRIEF_DISPLAY_STORAGE_KEY,
      JSON.stringify(state || {})
    );
  } catch {
    // localStorage may be unavailable in privacy modes.
  }
}

function isFullQueueOnlyItem(message) {
  const type = message?.type || message?.message_type;
  return FULL_QUEUE_ONLY_TYPES.has(type);
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

function formatBridgeHeartbeat(heartbeat) {
  if (!heartbeat?.received_at) return "Bridge heartbeat: none";

  const age = Number(heartbeat.age_minutes);
  if (Number.isFinite(age)) {
    return `Bridge heartbeat: ${Math.round(age)} min ago`;
  }

  return `Bridge heartbeat: ${formatTripTime(heartbeat.received_at)}`;
}

function formatBridgeTuroNotification(notification) {
  if (!notification?.received_at) return "Turo notifications: none";

  const age = Number(notification.age_minutes);
  if (Number.isFinite(age)) {
    if (age < 90) return `Turo notifications: ${Math.round(age)} min ago`;
    return `Turo notifications: ${Math.round(age / 60)} hr ago`;
  }

  return `Turo notifications: ${formatTripTime(notification.received_at)}`;
}

function formatTripWindow(start, end) {
  const startLabel = formatTripTime(start);
  const endLabel = formatTripTime(end);

  if (startLabel && endLabel) return `${startLabel} -> ${endLabel}`;
  return startLabel || endLabel || "";
}

function truncateRawText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getRawItemTimestamp(type, item) {
  if (type === "android") {
    return item.received_at || item.posted_at;
  }

  return item.message_timestamp || item.ingested_at || item.created_at;
}

function getRawItemTitle(type, item) {
  if (type === "android") {
    return item.title || item.classification || item.app || "Android notification";
  }

  return item.subject || item.message_type || `Message #${item.id}`;
}

function getRawItemBody(type, item) {
  if (type === "android") {
    return truncateRawText(
      [item.body, item.big_text, item.sub_text].filter(Boolean).join(" ")
    );
  }

  return truncateRawText(
    item.guest_message || item.normalized_text_body || item.date_header || ""
  );
}

function getRawItemMeta(type, item) {
  if (type === "android") {
    return [
      item.classification || "unclassified",
      item.device || item.source,
      item.guest_name,
      item.vehicle_name,
      item.reservation_id ? `#${item.reservation_id}` : "",
      item.acknowledged_at ? "acknowledged" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return [
    item.message_type || "message",
    item.status,
    item.mailbox,
    item.guest_name,
    item.vehicle_name,
    item.reservation_id ? `#${item.reservation_id}` : "",
    item.amount != null ? formatMoney(item.amount) : "",
  ]
    .filter(Boolean)
    .join(" · ");
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

function formatStatusLabel(value) {
  if (!value) return "";
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatMoney(value) {
  if (value == null) return "";

  const n = Number(value);
  if (Number.isNaN(n)) return "";

  return `$${n.toFixed(2)}`;
}

function formatSignedMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";

  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
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

function parseMoneyNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseIntegerNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseTuroShortDateTime(datePart, timePart) {
  const dateMatch = String(datePart || "").match(
    /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/
  );
  const timeMatch = String(timePart || "")
    .replace(/\u202f|\u00a0/g, " ")
    .match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?/i);

  if (!dateMatch || !timeMatch) return null;

  const month = Number(dateMatch[1]) - 1;
  const day = Number(dateMatch[2]);
  const rawYear = Number(dateMatch[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = timeMatch[3].toLowerCase();

  if (meridiem === "p" && hour < 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;

  const parsed = new Date(year, month, day, hour, minute);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractTripChangeDeltas(message) {
  const text = String(
    message?.normalized_text_body || message?.text_body || ""
  ).replace(/\u202f|\u00a0/g, " ");
  const deltas = {};

  const earningsNew =
    parseMoneyNumber(message?.new_total_earnings ?? message?.amount) ??
    parseMoneyNumber(
      text.match(/Your new total earnings will be \$([0-9,]+(?:\.\d{2})?)/i)?.[1]
    );
  const earningsPrior =
    parseMoneyNumber(message?.prior_trip_amount) ??
    parseMoneyNumber(text.match(/You earn\s*\n?\s*\$([0-9,]+(?:\.\d{2})?)\s+\$([0-9,]+(?:\.\d{2})?)/i)?.[2]);

  if (earningsNew != null) {
    deltas.newEarnings = earningsNew;
  }
  if (earningsNew != null && earningsPrior != null) {
    deltas.priorEarnings = earningsPrior;
    deltas.earningsDelta = earningsNew - earningsPrior;
  } else {
    const explicitDelta = parseMoneyNumber(
      message?.additional_earnings ?? message?.earnings_delta
    );
    if (explicitDelta != null) deltas.earningsDelta = explicitDelta;
  }

  const milesMatch = text.match(
    /Total distance included\s*\n?\s*([0-9,]+)\s*miles?\s+([0-9,]+)\s*miles?/i
  );
  if (milesMatch) {
    const newMiles = parseIntegerNumber(milesMatch[1]);
    const priorMiles = parseIntegerNumber(milesMatch[2]);
    if (newMiles != null) deltas.newMiles = newMiles;
    if (newMiles != null && priorMiles != null) {
      deltas.priorMiles = priorMiles;
      deltas.milesDelta = newMiles - priorMiles;
    }
  }

  const endMatch = text.match(
    /Trip end\s*\n\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*\n\s*([0-9:]+\s*[ap]\.?m?\.?)\s*\n\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+([0-9:]+\s*[ap]\.?m?\.?)/i
  );
  if (endMatch) {
    const newEnd = parseTuroShortDateTime(endMatch[1], endMatch[2]);
    const priorEnd = parseTuroShortDateTime(endMatch[3], endMatch[4]);
    if (newEnd) deltas.newEnd = newEnd;
    if (newEnd && priorEnd) {
      deltas.priorEnd = priorEnd;
      deltas.endDeltaDays =
        (newEnd.getTime() - priorEnd.getTime()) / 86400000;
    }
  }

  return deltas;
}

function formatSignedMiles(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString()} mi`;
}

function formatTripEndDayDelta(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) < 0.01) return "";
  const direction = n > 0 ? "Extended" : "Shortened";
  return `${direction} ${Math.abs(n).toFixed(1)} days`;
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
  const fallbackVehicle = {
    ...(vehicle || {}),
    nickname:
      vehicle?.nickname ||
      message?.vehicle_nickname ||
      message?.vehicle_name ||
      "Vehicle",
    vin: vehicle?.vin || message?.vehicle_vin || null,
  };

  return mapMaintenanceSummaryToGuestInspectionVehicle(summary || {}, {
    fallbackId:
      message?.turo_vehicle_id ||
      message?.vehicle_vin ||
      message?.vehicle_nickname ||
      message?.vehicle_name ||
      null,
    fallbackVehicle,
    fleetVehicle: vehicle,
  });
}

function getVehicleTripSelector(message, vehicle = null) {
  return (
    vehicle?.nickname ||
    vehicle?.vin ||
    vehicle?.id ||
    vehicle?.turo_vehicle_id ||
    message?.vehicle_nickname ||
    message?.vehicle_vin ||
    message?.vehicle_name ||
    message?.turo_vehicle_id ||
    null
  );
}

async function resolveGuestInspectionGuestName(message, vehicle = null) {
  const selector = getVehicleTripSelector(message, vehicle);
  if (!selector) return message?.guest_name || "";

  try {
    const res = await fetch(
      `${API_BASE}/api/trips/vehicle/${encodeURIComponent(
        selector
      )}?mode=relevant`
    );

    if (!res.ok) return message?.guest_name || "";

    const trips = await res.json();
    const relevantTrips = Array.isArray(trips) ? trips : [];
    const activeTrip = getActiveTrip(relevantTrips);
    const matchingTrip = relevantTrips.find(
      (trip) => String(trip?.id || "") === String(message?.trip_id || "")
    );
    const nextTrip = getNextUpcomingTrip(relevantTrips);

    return (
      activeTrip?.guest_name ||
      matchingTrip?.guest_name ||
      message?.guest_name ||
      nextTrip?.guest_name ||
      ""
    );
  } catch (err) {
    console.warn("Failed to resolve guest inspection trip guest:", err);
    return message?.guest_name || "";
  }
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

  return hasPostTrip && getMaintenanceTripState(message) === "active"
    ? "after"
    : "before";
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

function getMaintenanceBriefEntryCopy(entry) {
  const mode = entry?.maintenance_mode;
  const state = entry?.trip_state;

  if (mode === "during_trip") {
    return state === "active" ? "Due during current trip" : "May come due during trip";
  }

  if (mode === "after_return" || state === "active") {
    return "Plan after return";
  }

  if (state === "upcoming") {
    return "Before next handoff";
  }

  return "Available now";
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
  if (type === "daily_brief") {
    const generated = formatTripTime(message?.daily_brief_generated_at);
    const parts = [];
    if (generated) parts.push(`Generated ${generated}`);
    if (message?.daily_brief_unread_guest_count != null) {
      const count = Number(message.daily_brief_unread_guest_count || 0);
      parts.push(`${count} guest thread${count === 1 ? "" : "s"}`);
    }
    if (message?.daily_brief_month_to_date_revenue != null) {
      parts.push(`${formatMoney(message.daily_brief_month_to_date_revenue)} MTD`);
    }
    return parts.join(" | ") || "Morning fleet briefing is ready.";
  }

  if (type === "maintenance_brief") {
    const today = Number(message?.maintenance_brief_today_count || 0);
    const future = Number(message?.maintenance_brief_future_count || 0);
    const tasks = Number(message?.maintenance_task_count || 0);
    const todayText = `${today} vehicle${today === 1 ? "" : "s"} can be handled today`;
    const futureText = `${future} future watchlist vehicle${
      future === 1 ? "" : "s"
    }`;
    return `${todayText}; ${futureText}. ${tasks} maintenance item${
      tasks === 1 ? "" : "s"
    } total.`;
  }

  if (type === "handoff_ready_required") {
    const start = formatTripTime(message?.trip_start);
    const vehicleName = message?.vehicle_nickname || message?.vehicle_name || "Vehicle";
    const maintenanceCount = Number(message?.maintenance_task_count || 0);
    const maintenanceText =
      maintenanceCount > 0
        ? ` ${maintenanceCount} maintenance item${
            maintenanceCount === 1 ? "" : "s"
          } also need attention before handoff.`
        : "";

    return `${vehicleName} goes out${
      start ? ` ${start}` : " soon"
    }. Advance it when the handoff prep is complete.${maintenanceText}`;
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

  if (type === "refuel_required") {
    const returned = formatTripTime(message?.refuel_returned_at || message?.trip_end);
    const vehicle = message?.vehicle_nickname || message?.vehicle_name || "Vehicle";
    const fuel =
      message?.refuel_latest_fuel_level == null
        ? "below threshold"
        : `${Math.round(Number(message.refuel_latest_fuel_level))}%`;
    const threshold = Math.round(Number(message?.refuel_threshold || 95));

    const returnLocation = message?.refuel_return_location_label || "required return location";
    const distance = Number(message?.refuel_return_distance_miles);
    const distanceText = Number.isFinite(distance) ? ` (${distance.toFixed(2)} mi away)` : "";

    return `${vehicle} is back at ${returnLocation}${distanceText}${
      returned ? ` as of ${returned}` : ""
    } with ${fuel} fuel. Plan refueling before the next handoff; threshold is ${threshold}%.`;
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

  if (type === "notification_unmatched") {
    const received = formatTripTime(message?.notification_received_at);
    const classification = message?.notification_classification
      ? ` (${message.notification_classification})`
      : "";
    const noticeText = [
      message?.notification_title,
      message?.notification_body,
    ]
      .filter(Boolean)
      .join(" ");
    const isCancellationNotice =
      message?.notification_classification === "trip_canceled" ||
      /has cancelled their trip|has canceled their trip|cancelled their trip|canceled their trip/i.test(
        noticeText
      );
    const isCanceledInDenmark =
      String(message?.trip_workflow_stage || "").toLowerCase() === "canceled" ||
      String(message?.trip_status || "").toLowerCase() === "canceled";
    const denmarkAction =
      isCancellationNotice && isCanceledInDenmark
        ? `Denmark already marked${
            message?.reservation_id ? ` reservation #${message.reservation_id}` : " this reservation"
          } as canceled. `
        : "";
    const body =
      message?.notification_body ||
      message?.notification_title ||
      "The Android bridge saw a Turo notification, but no matching email/message was found.";

    return `${denmarkAction}Bridge saw this Turo notification${classification}${
      received ? ` at ${received}` : ""
    }, but the email/message table has no match yet. ${body}`;
  }

  if (type === "return_location_check") {
    const received = formatTripTime(message?.notification_received_at);
    const vehicle = message?.vehicle_name || "the car";
    const body =
      message?.return_location_text ||
      message?.notification_body ||
      "Turo says this vehicle has been returned.";

    return `Turo says ${vehicle} was returned${
      received ? ` at ${received}` : ""
    }. Verify the vehicle GPS matches the return location. ${body}`;
  }

  if (type === "vehicle_diagnostic_alert") {
    const source = message?.diagnostic_source || "telematics";
    const label = message?.diagnostic_label || "diagnostic warning";
    const firstReported = formatTripTime(message?.diagnostic_first_reported_at);
    return `${message?.vehicle_name || "Vehicle"} reported ${label} from ${source}${
      firstReported ? `, first reported ${firstReported}` : ""
    }. Review before the next handoff.`;
  }

  if (type === "google_calendar_reconnect_required") {
    const calendar = message?.calendar_summary || message?.calendar_id || "Google Calendar";
    const error = message?.calendar_token_error || "invalid token";
    return `Denmark cannot update ${calendar}. Google returned ${error}. Reconnect Google Calendar so trip changes can update calendar events.`;
  }

  if (type === "banking_reconciliation_required") {
    return message?.subject || "Bank transactions are ready for reconciliation.";
  }

  if (type === "guest_message_thread") {
    const count = Number(message?.guest_message_count || 0);
    const latest = message?.latest_guest_message || message?.guest_message || "";
    return `${count} guest message${count === 1 ? "" : "s"} grouped for review${
      latest ? `. Latest: ${latest}` : "."
    }`;
  }

  if (type === "maintenance_required") {
    const count = Number(message?.maintenance_task_count || 0);
    const copy = getMaintenanceNoticeCopy(message);
    const available = formatMaintenancePlanDate(message?.maintenance_available_at);

    return `${count} maintenance planning item${count === 1 ? "" : "s"} for ${
      message?.maintenance_vehicle_name || message?.vehicle_name || "this vehicle"
    } ${copy.body}. Available: ${available}.`;
  }

  if (type === "guest_message" && message?.guest_message) {
    return message.guest_message;
  }

  if (isReimbursementInvoiceMessage(message)) {
    return "Reimbursement invoice received";
  }

  if (type === "trip_changed") {
    return buildTripChangedDetail(message) || "Trip details changed";
  }

  if (type === "trip_booked") {
    const start = formatTripTime(message.trip_start);
    const end = formatTripTime(message.trip_end);

    if (start && end) {
      return `${start} -> ${end}`;
    }
  }

  if (
    type === "turo_notification" &&
    /upcoming trip/i.test(message?.subject || "")
  ) {
    const start = formatTripTime(message.trip_start || message.trip_record_start);
    const pickup = message.pickup_location;
    if (start && pickup) return `${start} pickup at ${pickup}`;
    if (start) return `${start} pickup`;
    if (pickup) return `Pickup at ${pickup}`;
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

function formatLastChecked(value) {
  const age = formatTimeAgo(value);
  return age ? `Last checked: ${age}` : "Last checked recently";
}

function formatQueueTimingSummary(debugTiming) {
  if (!debugTiming || typeof debugTiming !== "object") return "";
  const entries = Object.entries(debugTiming)
    .filter(([, value]) => Number(value) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3);
  if (!entries.length) return "";
  return entries
    .map(([key, value]) => `${key} ${Math.round(Number(value))}ms`)
    .join(", ");
}

function buildMessageTitle(message) {
  const type = message?.type || message?.message_type;
  if (type === "daily_brief") {
    return "Daily fleet brief";
  }

  if (type === "maintenance_brief") {
    return "Maintenance brief";
  }

  if (type === "return_location_check") {
    const guest = message?.guest_name;
    const vehicle = message?.vehicle_name || message?.vehicle_nickname;
    if (guest && vehicle) return `${guest} returned ${vehicle}`;
    return message?.notification_title || "Return location check";
  }

  if (type === "refuel_required") {
    return `${message?.vehicle_nickname || message?.vehicle_name || "Vehicle"} needs fuel`;
  }

  if (type === "vehicle_diagnostic_alert") {
    return message?.vehicle_name || message?.vehicle_nickname || "Vehicle diagnostic";
  }

  if (type === "google_calendar_reconnect_required") {
    return "Google Calendar reconnect required";
  }

  if (type === "banking_reconciliation_required") {
    return "Bank transactions need review";
  }

  if (type === "notification_unmatched") {
    return message?.notification_title || "Turo notification missing email";
  }

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

  if (type === "daily_brief") return "AM briefing";
  if (type === "maintenance_brief") return "Fleet maintenance rollup";
  if (type === "handoff_ready_required") return "Handoff prep required";
  if (type === "inspection_export_required") return "Guest inspection export";
  if (type === "closeout_required") return "Trip closeout needed";
  if (type === "refuel_required") return "Turnover refuel needed";
  if (type === "late_toll_unbilled") return "Late toll billing needed";
  if (type === "trip_overlap_detected") return "Trip overlap detected";
  if (type === "return_location_check") return "Verify return GPS";
  if (type === "vehicle_diagnostic_alert") return "Diagnostic alert";
  if (type === "google_calendar_reconnect_required") return "Integration attention";
  if (type === "banking_reconciliation_required") return "Expense reconciliation";
  if (type === "notification_unmatched") return "Urgent bridge/email mismatch";
  if (type === "guest_message_thread") {
    const count = Number(message?.guest_message_count || 0);
    return `${count} guest messages`;
  }
  if (type === "guest_message") return "Guest message";
  if (type === "trip_booked") return "Trip booked";
  if (
    type === "turo_notification" &&
    /upcoming trip/i.test(message?.subject || "")
  ) {
    return "Upcoming trip notice";
  }
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

function isMaintenanceBriefNotice(message) {
  const type = message?.type || message?.message_type;
  return type === "maintenance_brief";
}

function getMaintenanceBriefDisplayKey() {
  return `maintenance-brief:${getLocalDateKey(new Date())}`;
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

function isRefuelTask(message) {
  const type = message?.type || message?.message_type;
  return type === "refuel_required" && message?.trip_id;
}

function isLateTollTask(message) {
  const type = message?.type || message?.message_type;
  return type === "late_toll_unbilled" && message?.trip_id;
}

function isTripOverlapTask(message) {
  const type = message?.type || message?.message_type;
  return type === "trip_overlap_detected" && message?.trip_id;
}

function isReimbursementInvoiceMessage(message) {
  const type = message?.type || message?.message_type;
  const subject = String(message?.subject || "");

  return (
    type === "reimbursement_invoice" ||
    /reimbursement invoice/i.test(subject)
  );
}

function isUnmatchedNotification(message) {
  const type = message?.type || message?.message_type;
  return type === "notification_unmatched";
}

function isReturnLocationCheck(message) {
  const type = message?.type || message?.message_type;
  return type === "return_location_check";
}

function isVehicleDiagnosticAlert(message) {
  const type = message?.type || message?.message_type;
  return type === "vehicle_diagnostic_alert";
}

function isGoogleCalendarReconnectNotice(message) {
  const type = message?.type || message?.message_type;
  return type === "google_calendar_reconnect_required";
}

function isBankingReconciliationNotice(message) {
  const type = message?.type || message?.message_type;
  return type === "banking_reconciliation_required";
}

function isDailyBriefNotice(message) {
  const type = message?.type || message?.message_type;
  return type === "daily_brief" && Boolean(message?.daily_brief_text);
}

function getDailyBriefDisplayKey(message) {
  return String(
    message?.id ||
      message?.message_id ||
      message?.daily_brief_date ||
      message?.daily_brief_generated_at ||
      "daily-brief"
  );
}

function getGuestReplySuggestionKey(message) {
  return String(message?.id || message?.messageId || message?.latest_message_id || "");
}

function isGuestReplySuggestionCandidate(message) {
  const type = message?.type || message?.message_type;
  if (type !== "guest_message" && type !== "guest_message_thread") return false;
  return Boolean(
    message?.guest_message ||
      message?.latest_guest_message ||
      (Array.isArray(message?.guest_messages) && message.guest_messages.length > 0)
  );
}

function buildGuestReplySuggestionPayload(message) {
  const guestMessages = Array.isArray(message?.guest_messages)
    ? message.guest_messages
    : [];
  const latestMessage =
    message?.latest_guest_message ||
    message?.guest_message ||
    guestMessages[guestMessages.length - 1]?.guest_message ||
    "";

  return {
    messageId: message?.id || message?.messageId || null,
    subject: message?.subject || "",
    guestName:
      message?.guest_thread_guest_name ||
      message?.guest_name ||
      message?.parsed?.guest ||
      "",
    vehicleName:
      message?.guest_thread_vehicle_name ||
      message?.vehicle_nickname ||
      message?.vehicle_name ||
      message?.parsed?.vehicle ||
      "",
    reservationId:
      message?.guest_thread_reservation_id || message?.reservation_id || "",
    latestMessage,
    messages: guestMessages.length
      ? guestMessages.map((guestMessage) => ({
          timestamp: guestMessage.timestamp,
          subject: guestMessage.subject,
          text: guestMessage.guest_message || guestMessage.subject || "",
        }))
      : [
          {
            timestamp: message?.timestamp || message?.message_timestamp,
            subject: message?.subject,
            text: latestMessage,
          },
        ],
    trip: {
      start: message?.trip_record_start || message?.trip_start,
      end: message?.trip_record_end || message?.trip_end,
      status: message?.trip_status,
      workflowStage: message?.trip_workflow_stage,
      pickupLocation: message?.pickup_location,
    },
  };
}

function isOperationalTripNotice(message) {
  const type = message?.type || message?.message_type;
  if (!message?.trip_id && !message?.reservation_id) return false;

  if (type === "trip_booked") return true;

  return (
    type === "turo_notification" &&
    /upcoming trip/i.test(message?.subject || "")
  );
}

function getVehicleOperationalStatus(message) {
  if (message?.active_trip_id) {
    const sameTrip =
      message?.trip_id &&
      Number(message.active_trip_id) === Number(message.trip_id);

    if (sameTrip) return "This trip is active now";

    const guest = message.active_trip_guest_name || "another guest";
    const end = formatTripTime(message.active_trip_end);
    if (end) return `Out with ${guest} until ${end}`;
    return `Out with ${guest}`;
  }

  const stage = formatStatusLabel(
    message?.trip_workflow_stage || message?.trip_status
  );

  if (stage) return `No active trip now; booking is ${stage}`;
  return "No active trip now";
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

function buildTripChangedDetail(message) {
  const parts = [];
  const deltas = extractTripChangeDeltas(message);

  if (message?.new_trip_end) {
    parts.push(`New trip end: ${formatTripTime(message.new_trip_end)}`);
  }

  const dayDelta = formatTripEndDayDelta(deltas.endDeltaDays);
  if (dayDelta) {
    parts.push(dayDelta);
  }

  const newTotal = Number(deltas.newEarnings ?? message?.new_total_earnings ?? message?.amount);
  if (Number.isFinite(newTotal)) {
    const delta = Number(
      deltas.earningsDelta ?? message?.additional_earnings ?? message?.earnings_delta
    );
    if (Number.isFinite(delta) && Math.abs(delta) >= 0.005) {
      const prior =
        Number.isFinite(Number(deltas.priorEarnings))
          ? ` (${formatMoney(deltas.priorEarnings)} -> ${formatMoney(newTotal)})`
          : "";
      parts.push(`Earnings: ${formatSignedMoney(delta)}${prior}`);
    } else {
      parts.push(`New total: ${formatMoney(newTotal)}`);
    }
  }

  if (Number.isFinite(Number(deltas.milesDelta))) {
    const prior =
      Number.isFinite(Number(deltas.priorMiles)) &&
      Number.isFinite(Number(deltas.newMiles))
        ? ` (${Number(deltas.priorMiles).toLocaleString()} -> ${Number(
            deltas.newMiles
          ).toLocaleString()})`
        : "";
    parts.push(`Miles: ${formatSignedMiles(deltas.milesDelta)}${prior}`);
  }

  return parts.join(" - ");
}

function buildReimbursementInvoiceDetail(message) {
  const invoice = message?.reimbursement_invoice;
  if (!invoice) {
    const amount = formatMoney(message?.amount);
    return amount ? `Invoice amount captured: ${amount}` : "";
  }

  const parts = [];
  const lineItems = [];
  const discrepancies = Array.isArray(invoice.discrepancies)
    ? invoice.discrepancies
    : [];
  const notes = Array.isArray(invoice.notes) ? invoice.notes : [];

  if (invoice.tolls != null) lineItems.push(`tolls ${formatMoney(invoice.tolls)}`);
  if (invoice.refueling != null) {
    lineItems.push(`refuel ${formatMoney(invoice.refueling)}`);
  }
  if (invoice.refueling_convenience_fee != null) {
    lineItems.push(`fee ${formatMoney(invoice.refueling_convenience_fee)}`);
  }

  const total = formatMoney(invoice.total_charge ?? message?.amount);
  if (total) {
    parts.push(`Invoice total ${total}${lineItems.length ? ` (${lineItems.join(", ")})` : ""}`);
  }

  if (discrepancies.length) {
    const discrepancyText = discrepancies
      .slice(0, 2)
      .map((item) => {
        const invoiceAmount = formatMoney(item.invoice);
        const expectedAmount = formatMoney(item.expected);
        const delta = formatSignedMoney(item.delta);
        return `${item.label || "Amount"} ${invoiceAmount} vs ${expectedAmount}${
          delta ? ` (${delta})` : ""
        }`;
      })
      .join("; ");
    parts.push(`Discrepancy: ${discrepancyText}`);
  } else if (invoice.expected_total != null && invoice.total_charge != null) {
    parts.push("Matches trip reimbursement fields");
  }

  const attributedTollNote = notes.find((item) => item.field === "attributed_tolls");
  if (attributedTollNote) {
    const count = Number(attributedTollNote.toll_count || 0);
    const countText = count > 0 ? `${count} attributed toll${count === 1 ? "" : "s"} ` : "";
    parts.push(
      `Note: ${countText}${formatMoney(attributedTollNote.attributed)} vs charged ${formatMoney(
        attributedTollNote.charged
      )}`
    );
  }

  return parts.join(" - ");
}

function buildReimbursementInvoiceRows(message) {
  const invoice = message?.reimbursement_invoice;
  if (!invoice) return [];

  const rows = [];
  const invoiceParts = [];
  if (invoice.tolls != null) invoiceParts.push(`Tolls ${formatMoney(invoice.tolls)}`);
  if (invoice.refueling != null) {
    invoiceParts.push(`Refuel ${formatMoney(invoice.refueling)}`);
  }
  if (invoice.refueling_convenience_fee != null) {
    invoiceParts.push(`Fee ${formatMoney(invoice.refueling_convenience_fee)}`);
  }

  rows.push({
    key: "invoice-total",
    label: "Invoice total",
    value: formatMoney(invoice.total_charge ?? message?.amount) || "Unknown",
    detail: invoiceParts.join(" / "),
    tone: "neutral",
  });

  const discrepancies = Array.isArray(invoice.discrepancies)
    ? invoice.discrepancies
    : [];

  if (discrepancies.length) {
    discrepancies.slice(0, 2).forEach((item, index) => {
      rows.push({
        key: `discrepancy-${item.field || index}`,
        label: item.label || "Discrepancy",
        value: `${formatMoney(item.invoice)} vs ${formatMoney(item.expected)}`,
        detail: `${item.source || "Trip record"} ${formatSignedMoney(item.delta)}`,
        tone: "warning",
      });
    });
  } else if (invoice.expected_total != null && invoice.total_charge != null) {
    rows.push({
      key: "trip-match",
      label: "Trip check",
      value: "Matches recorded charges",
      detail: `Trip expected ${formatMoney(invoice.expected_total)}`,
      tone: "success",
    });
  }

  const attributedTollNote = Array.isArray(invoice.notes)
    ? invoice.notes.find((item) => item.field === "attributed_tolls")
    : null;
  if (attributedTollNote) {
    const count = Number(attributedTollNote.toll_count || 0);
    rows.push({
      key: "attributed-tolls",
      label: "Toll exposure",
      value: `${formatMoney(attributedTollNote.charged)} charged`,
      detail: `${formatMoney(attributedTollNote.attributed)} attributed${
        count > 0 ? ` across ${count} toll${count === 1 ? "" : "s"}` : ""
      }`,
      tone: "note",
    });
  }

  return rows;
}

function ReimbursementInvoiceSummary({ message }) {
  const rows = buildReimbursementInvoiceRows(message);
  if (!rows.length) return null;

  return (
    <div className="message-invoice-summary">
      <div className="message-booking-title">
        Invoice audit
        <span>
          {message.reimbursement_invoice_has_discrepancy ? "Review" : "Matched"}
        </span>
      </div>
      <div className="message-invoice-rows">
        {rows.map((row) => (
          <div
            key={row.key}
            className={`message-invoice-row message-invoice-row--${row.tone}`}
          >
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            {row.detail ? <em>{row.detail}</em> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildTollCloseoutDetail(message) {
  const count = Number(message?.closeout_toll_count ?? 0);
  const total = Number(message?.closeout_toll_total ?? 0);
  const status = message?.closeout_toll_review_status || "none";
  const arrivalDelay = Math.max(
    24,
    Number(message?.closeout_toll_arrival_delay_hours || 24)
  );
  const unresolved = Number(message?.closeout_unresolved_toll_count || 0);
  const unresolvedText = unresolved > 0
    ? ` ${unresolved} vehicle-window toll${unresolved === 1 ? " is" : "s are"} still unresolved and must be assigned or dismissed before billing.`
    : " No unresolved vehicle-window tolls remain.";

  if (count > 0 || total > 0) {
    const tollLabel =
      count > 0 ? `${count} toll${count === 1 ? "" : "s"}` : "Tolls";
    return `${tollLabel} totaling ${formatMoney(total)} need Turo billing review. Current status: ${status}.${unresolvedText} Reminder held for the observed ${arrivalDelay}-hour toll-arrival window.`;
  }

  return `Audit HCTRA tolls against Turo billing. Current status: ${status}.${unresolvedText} Reminder held for the observed ${arrivalDelay}-hour toll-arrival window.`;
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
  onEditTrip,
  onOpenMaintenanceVehicle,
  onOpenBankingReconciliation,
  initialMessages = [],
  initialUnreadCount = 0,
  initialLoadComplete = false,
}) {
  const [messages, setMessages] = useState(() =>
    filterRecentlyResolvedMessagesFromStorage(
      Array.isArray(initialMessages) ? initialMessages : []
    )
  );
  const [loading, setLoading] = useState(!initialLoadComplete);
  const [queueStatus, setQueueStatus] = useState("");
  const [lastMessagesCheckedAt, setLastMessagesCheckedAt] = useState(() =>
    initialLoadComplete ? new Date().toISOString() : null
  );
  const [error, setError] = useState("");
  const [newMessageIds, setNewMessageIds] = useState([]);
  const [unreadCount, setUnreadCount] = useState(Number(initialUnreadCount || 0));
  const [androidBridgeEnabled, setAndroidBridgeEnabled] = useState(true);
  const [bridgeHeartbeat, setBridgeHeartbeat] = useState(null);
  const [bridgeLastTuroNotification, setBridgeLastTuroNotification] =
    useState(null);
  const [rawFeedType, setRawFeedType] = useState("");
  const [rawFeedPage, setRawFeedPage] = useState(1);
  const [rawFeed, setRawFeed] = useState({
    items: [],
    total: 0,
    page: 1,
    limit: RAW_FEED_PAGE_SIZE,
  });
  const [rawFeedLoading, setRawFeedLoading] = useState(false);
  const [rawFeedError, setRawFeedError] = useState("");
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [confirmingMessageId, setConfirmingMessageId] = useState(null);
  const [focusingMessageId, setFocusingMessageId] = useState(null);
  const [ackingNotificationId, setAckingNotificationId] = useState(null);
  const [resolvingMaintenanceId, setResolvingMaintenanceId] = useState(null);
  const [suppressingDiagnosticId, setSuppressingDiagnosticId] = useState(null);
  const [readyingHandoffMessageId, setReadyingHandoffMessageId] = useState(null);
  const [exportingPrepMessageId, setExportingPrepMessageId] = useState(null);
  const [exportingInspectionMessageId, setExportingInspectionMessageId] =
    useState(null);
  const [previewingInspectionMessageId, setPreviewingInspectionMessageId] =
    useState(null);
  const [prepExport, setPrepExport] = useState(null);
  const [inspectionExport, setInspectionExport] = useState(null);
  const [inspectionPreview, setInspectionPreview] = useState(null);
  const [printingPrepMessageId, setPrintingPrepMessageId] = useState(null);
  const [prepPrint, setPrepPrint] = useState(null);
  const [focusedCloseoutTask, setFocusedCloseoutTask] = useState(null);
  const [replySuggestingMessageId, setReplySuggestingMessageId] = useState(null);
  const [replySuggestions, setReplySuggestions] = useState({});
  const [replySuggestionErrors, setReplySuggestionErrors] = useState({});
  const [copiedReplySuggestionId, setCopiedReplySuggestionId] = useState(null);
  const [copiedDailyBriefId, setCopiedDailyBriefId] = useState(null);
  const [refreshingDailyBriefId, setRefreshingDailyBriefId] = useState(null);
  const [ackingRefuelId, setAckingRefuelId] = useState(null);
  const [dailyBriefDisplay, setDailyBriefDisplay] = useState(() =>
    loadDailyBriefDisplayState()
  );
  const [maintenanceBriefDisplay, setMaintenanceBriefDisplay] = useState(() =>
    loadMaintenanceBriefDisplayState()
  );
  const [expandedMaintenanceIds, setExpandedMaintenanceIds] = useState(() => new Set());
  const [completedSyntheticTaskIds, setCompletedSyntheticTaskIds] = useState(() =>
    loadCompletedSyntheticTaskIds()
  );

  const seenIdsRef = useRef(new Set());
  const knownQueueItemIdsRef = useRef(new Set());
  const queueChimeWatermarkRef = useRef(Date.now());
  const messagesRef = useRef([]);
  const recentlyResolvedMessageIdsRef = useRef(
    new Map(
      readRecentlyResolvedMessageEntries().map((entry) => [
        entry.id,
        entry.expiresAt,
      ])
    )
  );
  const audioRef = useRef(null);
  const highlightTimeoutRef = useRef(null);
  const prepExportRef = useRef(null);
  const inspectionExportRef = useRef(null);
  const consumedInitialLiveMessagesRef = useRef(false);
  const completedSyntheticTaskIdsRef = useRef(completedSyntheticTaskIds);
  const lastFullQueueRefreshAtRef = useRef(0);
  const forceMessageQueueRefreshRef = useRef(false);

  useEffect(() => {
    completedSyntheticTaskIdsRef.current = completedSyntheticTaskIds;
  }, [completedSyntheticTaskIds]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  function invalidateLiveQueueCache() {
    clearLiveMessageQueueCache();
    forceMessageQueueRefreshRef.current = true;
  }

  async function loadMessageStats() {
    try {
      const res = await fetch("/api/messages/stats");

      if (!res.ok) {
        throw new Error(`Failed to load message stats (${res.status})`);
      }

      const stats = await res.json();

      setUnreadCount(Number(stats.unread || 0));
      setAndroidBridgeEnabled(stats.androidBridgeEnabled !== false);
      setBridgeHeartbeat(stats.bridgeHeartbeat || null);
      setBridgeLastTuroNotification(stats.bridgeLastTuroNotification || null);
    } catch (err) {
      console.error("Failed loading message stats:", err);
    }
  }

  function pruneRecentlyResolvedMessages() {
    const now = Date.now();
    let changed = false;
    for (const [id, expiresAt] of recentlyResolvedMessageIdsRef.current.entries()) {
      if (expiresAt <= now) {
        recentlyResolvedMessageIdsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) {
      writeRecentlyResolvedMessageEntries(
        Array.from(recentlyResolvedMessageIdsRef.current.entries()).map(
          ([id, expiresAt]) => ({ id, expiresAt })
        )
      );
    }
  }

  function rememberResolvedMessages(ids) {
    const expiresAt = Date.now() + RECENTLY_RESOLVED_MESSAGE_TTL_MS;
    let changed = false;
    Array.from(ids || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
      .forEach((id) => {
        recentlyResolvedMessageIdsRef.current.set(id, expiresAt);
        changed = true;
      });
    if (changed) {
      writeRecentlyResolvedMessageEntries(
        Array.from(recentlyResolvedMessageIdsRef.current.entries()).map(
          ([id, entryExpiresAt]) => ({ id, expiresAt: entryExpiresAt })
        )
      );
      clearLiveMessageQueueCache();
    }
  }

  function wasRecentlyResolved(message) {
    pruneRecentlyResolvedMessages();
    const ids = getMessageIdentityKeys(message);

    return ids.some((id) => recentlyResolvedMessageIdsRef.current.has(id));
  }

  async function loadRawFeed(type = rawFeedType, page = rawFeedPage) {
    if (!type) return;

    setRawFeedLoading(true);
    setRawFeedError("");

    try {
      const params = new URLSearchParams({
        type,
        page: String(page),
        limit: String(RAW_FEED_PAGE_SIZE),
      });
      const res = await fetch(`${API_BASE}/api/messages/raw?${params.toString()}`);

      if (!res.ok) {
        throw new Error(`Failed to load raw feed (${res.status})`);
      }

      const data = await res.json();
      setRawFeed({
        items: Array.isArray(data.items) ? data.items : [],
        total: Number(data.total || 0),
        page: Number(data.page || page),
        limit: Number(data.limit || RAW_FEED_PAGE_SIZE),
      });
    } catch (err) {
      setRawFeedError(err.message || "Failed to load raw feed");
    } finally {
      setRawFeedLoading(false);
    }
  }

  function selectRawFeed(type) {
    setRawFeedType((current) => {
      const next = current === type ? "" : type;
      setRawFeedPage(1);
      if (!next) {
        setRawFeed({
          items: [],
          total: 0,
          page: 1,
          limit: RAW_FEED_PAGE_SIZE,
        });
        setRawFeedError("");
      }
      return next;
    });
  }

async function handleMarkAsRead(messageId) {
  const message =
    typeof messageId === "object" && messageId !== null
      ? messageId
      : messages.find((item) => item.id === messageId);
  const isGuestThread =
    (message?.type || message?.message_type) === "guest_message_thread";
  const ids = Array.isArray(message?.message_ids) && message.message_ids.length
    ? message.message_ids
    : [typeof messageId === "object" ? message?.id : messageId].filter(Boolean);
  const queueItemId = message?.id || messageId;
  const previousMessages = messages;
  const previousNewMessageIds = newMessageIds;
  const previousUnreadCount = unreadCount;

  try {
    invalidateLiveQueueCache();
    rememberResolvedMessages([
      queueItemId,
      message?.messageId,
      message?.latest_message_id,
      ...(Array.isArray(message?.message_ids) ? message.message_ids : []),
      ...ids,
    ]);
    setMessages((prev) => prev.filter((msg) => msg.id !== queueItemId));
    setNewMessageIds((prev) => prev.filter((id) => id !== queueItemId));
    seenIdsRef.current.delete(queueItemId);
    knownQueueItemIdsRef.current.delete(String(queueItemId));
    setError("");

    const res = await fetch(`${API_BASE}/api/messages/read`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ids,
        thread: isGuestThread
          ? {
              type: "guest_message_thread",
              key: message.guest_thread_key || null,
              tripId: message.guest_thread_trip_id || message.trip_id || null,
              reservationId:
                message.guest_thread_reservation_id ||
                message.reservation_id ||
                null,
              guestName:
                message.guest_thread_guest_name || message.guest_name || null,
              vehicleName:
                message.guest_thread_vehicle_name ||
                message.vehicle_nickname ||
                message.vehicle_name ||
                null,
            }
          : null,
      }),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new Error(`Failed to mark message as read (${res.status})`);
    }

    const resolvedIds = new Set(
      (Array.isArray(data?.resolved) ? data.resolved : [])
        .map((item) => item?.id)
        .filter((id) => id != null)
        .map(String)
    );
    resolvedIds.add(String(queueItemId));
    rememberResolvedMessages(resolvedIds);

    setMessages((prev) =>
      prev.filter((msg) => !resolvedIds.has(String(msg.id)))
    );
    setNewMessageIds((prev) =>
      prev.filter((id) => !resolvedIds.has(String(id)))
    );
    for (const id of resolvedIds) {
      seenIdsRef.current.delete(id);
      knownQueueItemIdsRef.current.delete(id);
    }
    setUnreadCount((prev) =>
      Math.max(0, prev - Number(data?.resolved_count || ids.length))
    );
    notifyMessageStatsUpdated();
    
    // Force immediate refresh to ensure consistency
    // This prevents messages from reappearing due to cache timing issues
    try {
      setTimeout(() => {
        loadMessages(false);
      }, 250);
    } catch (err) {
      console.warn("Failed to schedule follow-up message refresh:", err);
    }
  } catch (err) {
    setMessages(previousMessages);
    setNewMessageIds(previousNewMessageIds);
    setUnreadCount(previousUnreadCount);
    knownQueueItemIdsRef.current.add(String(queueItemId));
    setError(err.message || "Failed to mark message as read");
  }
}

async function handleAckNotification(message) {
  const notificationId = message?.notification_event_id;
  if (!notificationId) {
    setError("No bridge notification id found");
    return;
  }

  try {
    setAckingNotificationId(notificationId);
    setError("");

    const res = await fetch(
      `${API_BASE}/api/messages/notifications/${notificationId}/ack`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ reason: "handled from dispatch queue" }),
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to acknowledge notification (${res.status})`);
    }

    rememberResolvedMessages([
      message.id,
      message.messageId,
      message.notification_event_id,
      `notification-gap:${notificationId}`,
    ]);
    setMessages((prev) => prev.filter((msg) => msg.id !== message.id));
    setNewMessageIds((prev) => prev.filter((id) => id !== message.id));
    seenIdsRef.current.delete(message.id);
    knownQueueItemIdsRef.current.delete(String(message.id));

    invalidateLiveQueueCache();
    notifyMessageStatsUpdated();

    // Reconcile against the persisted acknowledgement before this action finishes.
    await loadMessages(false);
  } catch (err) {
    setError(err.message || "Failed to acknowledge notification");
  } finally {
    setAckingNotificationId(null);
  }
}

async function handleResolveMaintenance(message) {
  const taskIds = (message?.maintenance_tasks || []).flatMap((task) =>
    Array.isArray(task?.task_ids) && task.task_ids.length
      ? task.task_ids
      : task?.id != null
      ? [task.id]
      : []
  );

  if (!taskIds.length) {
    setError("No maintenance task ids found");
    return;
  }

  try {
    setResolvingMaintenanceId(message.id);
    setError("");

    const res = await fetch(`${API_BASE}/api/messages/maintenance/resolve`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ task_ids: taskIds }),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new Error(data?.error || `Failed to resolve maintenance (${res.status})`);
    }

    setMessages((prev) => prev.filter((msg) => msg.id !== message.id));
    setNewMessageIds((prev) => prev.filter((id) => id !== message.id));
    seenIdsRef.current.delete(message.id);
    knownQueueItemIdsRef.current.delete(String(message.id));
    invalidateLiveQueueCache();
    notifyMessageStatsUpdated();
    
    // Force immediate refresh to ensure consistency
    try {
      setTimeout(() => {
        loadMessages(false);
      }, 250);
    } catch (err) {
      console.warn("Failed to schedule follow-up message refresh:", err);
    }
  } catch (err) {
    setError(err.message || "Failed to resolve maintenance");
  } finally {
    setResolvingMaintenanceId(null);
  }
}

async function handleSuppressDiagnostic(message, action = "acknowledge") {
  const diagnosticKey = message?.diagnostic_key;
  if (!diagnosticKey) {
    setError("No diagnostic alert key found");
    return;
  }
  const snoozeHours = Math.max(
    1,
    Math.min(72, Number(message?.diagnostic_snooze_hours || 12) || 12)
  );

  try {
    setSuppressingDiagnosticId(message.id);
    setError("");

    const res = await fetch(`${API_BASE}/api/messages/diagnostics/suppress`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        diagnostic_key: diagnosticKey,
        legacy_keys: Array.isArray(message?.diagnostic_legacy_keys)
          ? message.diagnostic_legacy_keys
          : [],
        action,
        hours: snoozeHours,
        reason:
          action === "snooze"
            ? `snoozed from dispatch queue for ${snoozeHours} hours`
            : "acknowledged from dispatch queue",
      }),
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new Error(data?.error || `Failed to update diagnostic (${res.status})`);
    }

    setMessages((prev) => prev.filter((msg) => msg.id !== message.id));
    setNewMessageIds((prev) => prev.filter((id) => id !== message.id));
    seenIdsRef.current.delete(message.id);
    knownQueueItemIdsRef.current.delete(String(message.id));
    invalidateLiveQueueCache();
    notifyMessageStatsUpdated();
    
    // Force immediate refresh to ensure consistency
    try {
      setTimeout(() => {
        loadMessages(false);
      }, 250);
    } catch (err) {
      console.warn("Failed to schedule follow-up message refresh:", err);
    }
  } catch (err) {
    setError(err.message || "Failed to update diagnostic alert");
  } finally {
    setSuppressingDiagnosticId(null);
  }
}

function handleReconnectGoogleCalendar() {
  window.location.href = `${API_BASE}/api/integrations/google-calendar/connect`;
}

async function handleFocusTrip(message) {
  if (!message?.trip_id) {
    return null;
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
    return trip;
  } catch (err) {
    setError(err.message || "Failed to focus trip");
    return null;
  } finally {
    setFocusingMessageId(null);
  }
}

async function handleEditTripFromMessage(message) {
  const trip = await handleFocusTrip(message);
  if (trip?.id) {
    onEditTrip?.(trip);
  }
}

async function handleAcknowledgeRefuel(message) {
  if (!message?.trip_id) {
    setError("No linked trip found for this refuel alert");
    return;
  }

  try {
    setAckingRefuelId(message.id);
    setError("");

    const res = await fetch(
      `${API_BASE}/api/messages/refuel/${message.trip_id}/ack`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          reason: "refuel alert acknowledged from dispatch queue",
        }),
      }
    );

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
      throw new Error(data?.error || `Failed to acknowledge refuel alert (${res.status})`);
    }

    setMessages((prev) => prev.filter((msg) => msg.id !== message.id));
    setNewMessageIds((prev) => prev.filter((id) => id !== message.id));
    seenIdsRef.current.delete(message.id);
    knownQueueItemIdsRef.current.delete(String(message.id));
    invalidateLiveQueueCache();
    notifyMessageStatsUpdated();
    
    // Force immediate refresh to ensure consistency
    try {
      setTimeout(() => {
        loadMessages(false);
      }, 250);
    } catch (err) {
      console.warn("Failed to schedule follow-up message refresh:", err);
    }
  } catch (err) {
    setError(err.message || "Failed to acknowledge refuel alert");
  } finally {
    setAckingRefuelId(null);
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
  invalidateLiveQueueCache();
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

    invalidateLiveQueueCache();
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

    invalidateLiveQueueCache();
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

async function buildGuestInspectionSheetPayload(message) {
    const vehicleSelector =
      message.vehicle_vin ||
      message.vehicle_nickname ||
      message.vehicle_name ||
      message.turo_vehicle_id;
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

    const guestName = await resolveGuestInspectionGuestName(message, vehicle);

    return {
      messageId: message.id,
      vehicle: buildGuestInspectionVehicle(message, vehicle, summary),
      guestName,
    };
  }

async function handlePreviewGuestInspectionSheet(message) {
  if (!isInspectionExportTask(message) || previewingInspectionMessageId) {
    return;
  }

  if (inspectionPreview?.messageId === message.id) {
    setInspectionPreview(null);
    return;
  }

  try {
    setPreviewingInspectionMessageId(message.id);
    setError("");
    const payload = await buildGuestInspectionSheetPayload(message);
    setInspectionPreview(payload);
  } catch (err) {
    console.error("Failed preparing guest inspection preview:", err);
    setError(err.message || "Could not preview guest inspection sheet");
  } finally {
    setPreviewingInspectionMessageId(null);
  }
}

async function handleExportGuestInspectionSheet(message) {
  if (!isInspectionExportTask(message) || exportingInspectionMessageId) {
    return;
  }

  try {
    setExportingInspectionMessageId(message.id);
    setError("");

    const payload =
      inspectionPreview?.messageId === message.id
        ? inspectionPreview
        : await buildGuestInspectionSheetPayload(message);

    setInspectionExport({
      ...payload,
      messageId: message.id,
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

  async function handleSuggestGuestReply(message) {
    const key = getGuestReplySuggestionKey(message);
    if (!key) return;

    setReplySuggestingMessageId(key);
    setReplySuggestionErrors((prev) => ({ ...prev, [key]: "" }));

    try {
      const res = await fetch(`${API_BASE}/api/messages/guest-reply-suggestion`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildGuestReplySuggestionPayload(message)),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};

      if (!res.ok) {
        throw new Error(data?.error || `Failed to suggest reply (${res.status})`);
      }

      const suggestion = String(data?.suggestion || "").trim();
      if (!suggestion) {
        throw new Error("No suggested reply came back");
      }

      setReplySuggestions((prev) => ({ ...prev, [key]: suggestion }));
    } catch (err) {
      setReplySuggestionErrors((prev) => ({
        ...prev,
        [key]: err.message || "Could not suggest a reply",
      }));
    } finally {
      setReplySuggestingMessageId(null);
    }
  }

  async function handleCopyGuestReplySuggestion(message, suggestion) {
    const key = getGuestReplySuggestionKey(message);
    const text = String(suggestion || "").trim();
    if (!text) return;

    try {
      await copyTextToClipboard(text);

      setCopiedReplySuggestionId(key);
      window.setTimeout(() => {
        setCopiedReplySuggestionId((current) => (current === key ? null : current));
      }, 1800);
    } catch (err) {
      setReplySuggestionErrors((prev) => ({
        ...prev,
        [key]: "Could not copy text from this browser",
      }));
    }
  }

  async function handleCopyDailyBrief(message) {
    const key = String(message?.id || message?.message_id || "daily-brief");
    const text = String(message?.daily_brief_text || "").trim();
    if (!text) return;

    try {
      await copyTextToClipboard(text);
      setCopiedDailyBriefId(key);
      window.setTimeout(() => {
        setCopiedDailyBriefId((current) => (current === key ? null : current));
      }, 1800);
    } catch (err) {
      console.error("Could not copy daily brief:", err);
    }
  }

  function setDailyBriefDisplayMode(message, mode) {
    const key = getDailyBriefDisplayKey(message);
    setDailyBriefDisplay((prev) => {
      const next = { ...prev, [key]: mode };
      saveDailyBriefDisplayState(next);
      return next;
    });
  }

  function setMaintenanceBriefDisplayMode(message, mode) {
    const key = getMaintenanceBriefDisplayKey(message);
    setMaintenanceBriefDisplay((prev) => {
      const next = { ...prev, [key]: mode };
      saveMaintenanceBriefDisplayState(next);
      return next;
    });
  }

  async function handleRefreshDailyBrief(message) {
    const key = getDailyBriefDisplayKey(message);
    if (refreshingDailyBriefId) return;

    try {
      setRefreshingDailyBriefId(key);
      setError("");

      const res = await fetch(`${API_BASE}/api/metrics/daily-brief`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};

      if (!res.ok) {
        throw new Error(data?.error || `Failed to refresh daily brief (${res.status})`);
      }

      clearLiveMessageQueueCache();
      forceMessageQueueRefreshRef.current = true;
      lastFullQueueRefreshAtRef.current = 0;
      setDailyBriefDisplayMode(message, "open");
      await loadMessages(false);
    } catch (err) {
      setError(err.message || "Failed to refresh daily brief");
    } finally {
      setRefreshingDailyBriefId(null);
    }
  }

  async function loadMessages(isInitialLoad = false) {
    let statusLabel = "";
    try {
      if (isInitialLoad) {
        setLoading(true);
      }

      const showingTripMessages = messageMode === "trip" && selectedTrip?.id;
      const shouldRefreshFullQueue =
        !isInitialLoad &&
        !showingTripMessages &&
        Date.now() - lastFullQueueRefreshAtRef.current > 60000;
      const useFastQueue = !showingTripMessages && !shouldRefreshFullQueue;
      if (shouldRefreshFullQueue) {
        lastFullQueueRefreshAtRef.current = Date.now();
      }
      const endpoint = showingTripMessages
        ? `/api/trips/${selectedTrip.id}/messages`
        : `/api/messages?limit=25${useFastQueue ? "&fast=1" : ""}&debug=1${
            forceMessageQueueRefreshRef.current ? `&cacheBust=${Date.now()}` : ""
          }`;
      forceMessageQueueRefreshRef.current = false;
      statusLabel = showingTripMessages
        ? "Loading trip messages..."
        : useFastQueue
          ? "Refreshing live queue..."
          : "Refreshing full queue with maintenance...";
      setQueueStatus(statusLabel);

      const requestStartedAt = performance.now();
      const res = await fetch(endpoint);
      const responseMs = Math.round(performance.now() - requestStartedAt);
      const serverTiming = res.headers.get("Server-Timing");

      if (!res.ok) {
        throw new Error(`Failed to load messages (${res.status})`);
      }

      const data = await res.json();
      const messageItems = Array.isArray(data) ? data : data?.items;
      const debugTiming = Array.isArray(data) ? null : data?.debugTiming;
      const totalMs = Math.round(performance.now() - requestStartedAt);
      let shouldLogTiming = totalMs >= 1000;
      try {
        shouldLogTiming =
          shouldLogTiming ||
          window.localStorage?.getItem("denmark.debugMessageTiming") === "1";
      } catch {
        // Ignore storage access failures in restricted browser contexts.
      }
      if (shouldLogTiming) {
        console.info(
          `[messages] ${isInitialLoad ? "initial" : "refresh"} ${
            useFastQueue ? "fast" : "full"
          } ${totalMs}ms response=${responseMs}ms endpoint=${endpoint}${
            serverTiming ? ` | server: ${serverTiming}` : ""
          }${
            debugTiming ? ` | debug: ${JSON.stringify(debugTiming)}` : ""
          }`
        );
      }
      const nextMessages = Array.isArray(messageItems)
        ? showingTripMessages
          ? messageItems
          : messageItems.slice(0, 10)
        : [];
      const mergedMessages =
        useFastQueue && !showingTripMessages
          ? [
              ...nextMessages,
              ...messagesRef.current.filter((message) => {
                if (!isFullQueueOnlyItem(message)) return false;
                return !nextMessages.some(
                  (nextMessage) => String(nextMessage.id) === String(message.id)
                );
              }),
            ]
          : nextMessages;
      const visibleMessages = mergedMessages.filter(
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
      const unsuppressedMessages = displayMessages.filter(
        (message) => !wasRecentlyResolved(message)
      );

      const nextIds = unsuppressedMessages.map((msg) => msg.id);
      const nextIdKeys = unsuppressedMessages.map((msg) => String(msg.id));
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
        const freshMessages = unsuppressedMessages.filter((message) => {
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

      messagesRef.current = unsuppressedMessages;
      setMessages(unsuppressedMessages);
      if (!showingTripMessages) {
        writeLiveMessageQueueCache(unsuppressedMessages);
      }
      setLastMessagesCheckedAt(new Date().toISOString());
      setError("");
      setQueueStatus(
        showingTripMessages
          ? "Trip messages updated"
          : `${useFastQueue ? "Live queue" : "Full queue"} updated in ${totalMs}ms${
              debugTiming ? ` (${formatQueueTimingSummary(debugTiming)})` : ""
            }`
      );
    } catch (err) {
      setError(err.message || "Failed to load messages");
      setQueueStatus(
        statusLabel ? `${statusLabel.replace(/\.\.\.$/, "")} failed` : ""
      );
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
    if (!rawFeedType) return;
    loadRawFeed(rawFeedType, rawFeedPage);
  }, [rawFeedType, rawFeedPage]);

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

    const cachedLiveQueue =
      !canUseInitialMessages &&
      messageMode === "live" &&
      !selectedTrip?.id
        ? readLiveMessageQueueCache()
        : null;
    const cachedLiveMessages = cachedLiveQueue?.items || null;
    const seededMessages = canUseInitialMessages
      ? initialMessages
      : cachedLiveMessages || [];
    const visibleSeededMessages = seededMessages.filter(
      (message) =>
        !wasRecentlyResolved(message) &&
        (!isCompletableSyntheticTask(message) ||
          !completedSyntheticTaskIdsRef.current.has(message.id))
    );

    setMessages(visibleSeededMessages);
    if (cachedLiveQueue?.createdAt) {
      setLastMessagesCheckedAt(new Date(cachedLiveQueue.createdAt).toISOString());
    } else if (canUseInitialMessages) {
      setLastMessagesCheckedAt(new Date().toISOString());
    }
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

    if (canUseInitialMessages || cachedLiveMessages) {
      setLoading(false);
    }

    if (canUseInitialMessages) {
      // Startup already fetched a light live queue; the interval will refresh it.
    } else if (cachedLiveMessages && messageMode === "live" && !selectedTrip?.id) {
      loadMessages(false);
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
    const handleBankingReconciliationUpdated = () => {
      try {
        window.sessionStorage?.removeItem(LIVE_MESSAGE_CACHE_STORAGE_KEY);
      } catch {
        // Ignore storage access failures in restricted browser contexts.
      }
      forceMessageQueueRefreshRef.current = true;
      lastFullQueueRefreshAtRef.current = 0;
      void loadMessages(false);
      void loadMessageStats();
    };
    window.addEventListener(
      "banking:reconciliation-updated",
      handleBankingReconciliationUpdated
    );
    return () =>
      window.removeEventListener(
        "banking:reconciliation-updated",
        handleBankingReconciliationUpdated
      );
  }, [selectedTrip?.id, messageMode]);

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
        if (cancelled || !inspectionExportRef.current) return;
        await waitForExportAssetPaint(inspectionExportRef.current);
        if (cancelled || !inspectionExportRef.current) return;

        const exportNode =
          inspectionExportRef.current.querySelector?.(".guest-snapshot-card") ||
          inspectionExportRef.current;

        const dataUrl = await toPng(exportNode, {
          cacheBust: true,
          pixelRatio: 2,
          backgroundColor: "#ffffff",
          width: exportNode.scrollWidth || exportNode.offsetWidth || 760,
          height: exportNode.scrollHeight || exportNode.offsetHeight || undefined,
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
  const visibleUnmatchedNotificationCount = showingTripMessages
    ? 0
    : messages.filter(isUnmatchedNotification).length;
  const rawFeedTotalPages = Math.max(
    1,
    Math.ceil(Number(rawFeed.total || 0) / Number(rawFeed.limit || RAW_FEED_PAGE_SIZE))
  );
  const activeRawFeedLabel =
    RAW_FEED_TYPES.find((type) => type.id === rawFeedType)?.label || "";

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
        {androidBridgeEnabled && bridgeHeartbeat?.stale ? (
          <div className="chip bridge-heartbeat bridge-heartbeat--stale">
            {formatBridgeHeartbeat(bridgeHeartbeat)}
          </div>
        ) : null}
        {androidBridgeEnabled ? (
          <div
            className={`chip bridge-heartbeat ${
              bridgeLastTuroNotification?.stale ? "bridge-heartbeat--stale" : ""
            }`}
          >
            {formatBridgeTuroNotification(bridgeLastTuroNotification)}
          </div>
        ) : null}
        {androidBridgeEnabled && visibleUnmatchedNotificationCount > 0 && (
          <div className="chip notification-gap-chip">
            {visibleUnmatchedNotificationCount} Bridge Notifications
          </div>
        )}

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

      {!showingTripMessages && (
        <div className="raw-feed-bar">
          <div className="raw-feed-status">
            {queueStatus || formatLastChecked(lastMessagesCheckedAt)}
          </div>
          <div className="raw-feed-controls">
            <span className="raw-feed-label">Raw feeds</span>
            {RAW_FEED_TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={`chip chip-filter raw-feed-chip ${
                  rawFeedType === type.id ? "is-active" : ""
                }`}
                onClick={() => selectRawFeed(type.id)}
              >
                {type.label}
              </button>
            ))}
            {rawFeedType && (
              <button
                type="button"
                className="message-action raw-feed-refresh"
                disabled={rawFeedLoading}
                onClick={() => loadRawFeed(rawFeedType, rawFeedPage)}
              >
                Refresh raw
              </button>
            )}
          </div>
        </div>
      )}

      {!showingTripMessages && rawFeedType && (
        <div className="raw-feed-panel">
          <div className="raw-feed-panel-head">
            <div>
              <strong>{activeRawFeedLabel}</strong>
              <span>
                {rawFeed.total} stored item{rawFeed.total === 1 ? "" : "s"} · page{" "}
                {rawFeed.page} of {rawFeedTotalPages}
              </span>
            </div>
            <div className="raw-feed-pager">
              <button
                type="button"
                className="message-action"
                disabled={rawFeedLoading || rawFeedPage <= 1}
                onClick={() => setRawFeedPage((page) => Math.max(1, page - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="message-action"
                disabled={rawFeedLoading || rawFeedPage >= rawFeedTotalPages}
                onClick={() =>
                  setRawFeedPage((page) => Math.min(rawFeedTotalPages, page + 1))
                }
              >
                Next
              </button>
            </div>
          </div>

          {rawFeedLoading && <div className="raw-feed-empty">Loading raw feed…</div>}
          {!rawFeedLoading && rawFeedError && (
            <div className="raw-feed-empty">{rawFeedError}</div>
          )}
          {!rawFeedLoading && !rawFeedError && rawFeed.items.length === 0 && (
            <div className="raw-feed-empty">No raw items in this lane yet.</div>
          )}
          {!rawFeedLoading && !rawFeedError && rawFeed.items.length > 0 && (
            <div className="raw-feed-list">
              {rawFeed.items.map((item) => (
                <div key={`${rawFeedType}:${item.id}`} className="raw-feed-item">
                  <div className="raw-feed-item-main">
                    <strong>{getRawItemTitle(rawFeedType, item)}</strong>
                    <span>{getRawItemMeta(rawFeedType, item)}</span>
                    {getRawItemBody(rawFeedType, item) ? (
                      <p>{getRawItemBody(rawFeedType, item)}</p>
                    ) : null}
                  </div>
                  <time>{formatTripTime(getRawItemTimestamp(rawFeedType, item))}</time>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="message-list">
        {loading && <div className="message-empty">Loading messages…</div>}

        {!loading && error && <div className="message-empty">{error}</div>}

        {!loading && !error && messages.length === 0 && (
          <div className="message-empty">
            {formatLastChecked(lastMessagesCheckedAt || countdownNow)}
          </div>
        )}

        {!loading &&
          !error &&
          messages.map((message) => {
            const isUnread = message.status === "unread";
            const isNew = newMessageIds.includes(message.id);
            const canAdvanceHandoff = isHandoffReadyTask(message);
            const canExportInspection = isInspectionExportTask(message);
            const canCloseoutTrip = isCloseoutTask(message);
            const canReviewRefuel = isRefuelTask(message);
            const canReviewLateToll = isLateTollTask(message);
            const canReviewOverlap = isTripOverlapTask(message);
            const canEditTripValues =
              isReimbursementInvoiceMessage(message) && Boolean(message.trip_id);
            const canReviewUnmatchedNotification = isUnmatchedNotification(message);
            const canVerifyReturnLocation = isReturnLocationCheck(message);
            const canReviewDiagnostic = isVehicleDiagnosticAlert(message);
            const canReconnectGoogleCalendar =
              isGoogleCalendarReconnectNotice(message);
            const canReviewBanking = isBankingReconciliationNotice(message);
            const canShowDailyBrief = isDailyBriefNotice(message);
            const canReviewGuestThread =
              (message.type || message.message_type) === "guest_message_thread";
            const canSuggestGuestReply = isGuestReplySuggestionCandidate(message);
            const replySuggestionKey = getGuestReplySuggestionKey(message);
            const replySuggestion = replySuggestions[replySuggestionKey] || "";
            const replySuggestionError =
              replySuggestionErrors[replySuggestionKey] || "";
            const dailyBriefDisplayKey = getDailyBriefDisplayKey(message);
            const dailyBriefMode = dailyBriefDisplay[dailyBriefDisplayKey] || "open";
            const isDailyBriefMinimized =
              canShowDailyBrief && dailyBriefMode === "minimized";
            const isDailyBriefDismissed =
              canShowDailyBrief && dailyBriefMode === "dismissed";
            const canConfirmBooking = isBookingConfirmationTask(message);
            const canShowOperationalTripNotice =
              isOperationalTripNotice(message) && !canConfirmBooking;
            const canShowMaintenance = isMaintenanceNotice(message);
            const canShowMaintenanceBrief = isMaintenanceBriefNotice(message);
            const maintenanceBriefDisplayKey = getMaintenanceBriefDisplayKey(message);
            const maintenanceBriefMode =
              maintenanceBriefDisplay[maintenanceBriefDisplayKey] || "open";
            const isMaintenanceBriefCollapsed =
              canShowMaintenanceBrief && maintenanceBriefMode === "collapsed";
            const isMaintenanceBriefDismissed =
              canShowMaintenanceBrief && maintenanceBriefMode === "dismissed";
            const maintenanceVehicleKey = getMaintenanceVehicleKey(message);
            const hasMaintenanceDetails =
              Number(message.maintenance_task_count || 0) > 0 &&
              Array.isArray(message.maintenance_tasks) &&
              message.maintenance_tasks.length > 0;
            const canCompleteSyntheticTask = isCompletableSyntheticTask(message);
            const canOpenMaintenanceQueue =
              Boolean(maintenanceVehicleKey) &&
              ((hasMaintenanceDetails &&
                (canShowMaintenance || canAdvanceHandoff || canExportInspection)) ||
                canExportInspection ||
                canReviewDiagnostic);
            const canReply =
              !!buildReplyUrl(message) &&
              !canCompleteSyntheticTask &&
              !canAdvanceHandoff &&
              !canExportInspection &&
              !canShowMaintenance;
            const canFocusTrip =
              (canAdvanceHandoff ||
                canExportInspection ||
                canCloseoutTrip ||
                canReviewRefuel ||
                canReviewLateToll ||
                canReviewOverlap ||
                canReviewUnmatchedNotification ||
                canVerifyReturnLocation ||
                canShowOperationalTripNotice ||
                canConfirmBooking ||
                canShowMaintenance) &&
              Boolean(message.trip_id);
            const canMarkAsRead =
              isUnread &&
              !canAdvanceHandoff &&
              !canExportInspection &&
              !canCloseoutTrip &&
              !canReviewRefuel &&
              !canConfirmBooking &&
              !canShowMaintenance;
            const maintenanceExpanded =
              canShowMaintenance && expandedMaintenanceIds.has(message.id);
            const maintenanceDetailsExpanded =
              canShowMaintenance ? maintenanceExpanded : true;
            const maintenanceCopy = canShowMaintenance
              ? getMaintenanceNoticeCopy(message)
              : hasMaintenanceDetails
              ? {
                  title: "Maintenance before handoff",
                  planLabel: "Plan around",
                }
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
            const canShowInvoiceSummary = isReimbursementInvoiceMessage(message);

            if (isDailyBriefDismissed || isMaintenanceBriefDismissed) {
              return null;
            }

            return (
              <article
                key={message.id}
                className={`message ${isUnread ? "unread" : ""} ${
                  isNew ? "message-new" : ""
                } ${canFocusTrip ? "message-focusable" : ""} ${
                  canCloseoutTrip ? "message-closeout-guide" : ""
                } ${
                  canReviewUnmatchedNotification ||
                  canVerifyReturnLocation ||
                  canReviewDiagnostic
                    ? "message-notification-gap"
                    : ""
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

                {!isDailyBriefDismissed && (
                  <div className="message-body">{buildMessageBody(message)}</div>
                )}

                {canShowDailyBrief && !isDailyBriefDismissed && (
                  <div
                    className={`message-daily-brief ${
                      isDailyBriefMinimized ? "message-daily-brief--minimized" : ""
                    }`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="message-booking-title">
                      Morning brief
                      <span className="message-daily-brief-meta">
                        <span>
                          {formatTripTime(message.daily_brief_generated_at) ||
                            message.daily_brief_date ||
                            "Latest"}
                        </span>
                        <button
                          type="button"
                          className="message-refresh-pill"
                          disabled={refreshingDailyBriefId === dailyBriefDisplayKey}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleRefreshDailyBrief(message);
                          }}
                        >
                          {refreshingDailyBriefId === dailyBriefDisplayKey
                            ? "Refreshing..."
                            : "Refresh"}
                        </button>
                      </span>
                    </div>
                    {!isDailyBriefMinimized ? (
                      <p className="message-daily-brief-text">
                        {message.daily_brief_text}
                      </p>
                    ) : null}
                    <div className="message-guest-reply-actions">
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDailyBriefDisplayMode(
                            message,
                            isDailyBriefMinimized ? "open" : "minimized"
                          );
                        }}
                      >
                        {isDailyBriefMinimized ? "Expand" : "Minimize"}
                      </button>
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCopyDailyBrief(message);
                        }}
                      >
                        {copiedDailyBriefId ===
                        String(message.id || message.message_id || "daily-brief")
                          ? "Copied"
                          : "Copy text"}
                      </button>
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDailyBriefDisplayMode(message, "dismissed");
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}

                {canShowMaintenanceBrief && (
                  <div
                    className={`message-maintenance-brief ${
                      isMaintenanceBriefCollapsed
                        ? "message-maintenance-brief--collapsed"
                        : ""
                    }`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="message-maintenance-brief-controls">
                      <strong>Maintenance brief</strong>
                      <div className="message-guest-reply-actions">
                        <button
                          type="button"
                          className="message-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMaintenanceBriefDisplayMode(
                              message,
                              isMaintenanceBriefCollapsed ? "open" : "collapsed"
                            );
                          }}
                        >
                          {isMaintenanceBriefCollapsed ? "Expand" : "Collapse"}
                        </button>
                        <button
                          type="button"
                          className="message-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMaintenanceBriefDisplayMode(message, "dismissed");
                          }}
                        >
                          Close for today
                        </button>
                      </div>
                    </div>
                    {!isMaintenanceBriefCollapsed ? (
                      <>
                    {[
                      {
                        key: "today",
                        title: "Can do today",
                        items: message.maintenance_brief_today || [],
                      },
                      {
                        key: "future",
                        title: "Future watchlist",
                        items: message.maintenance_brief_future || [],
                      },
                    ].map((section) => (
                      <div
                        key={section.key}
                        className="message-maintenance-brief-section"
                      >
                        <div className="message-booking-title">
                          {section.title}
                          <span>
                            {section.items.length} vehicle
                            {section.items.length === 1 ? "" : "s"}
                          </span>
                        </div>
                        {section.items.length ? (
                          <div className="message-maintenance-list">
                            {section.items.slice(0, 6).map((entry) => (
                              <div
                                key={`${section.key}:${
                                  entry.vehicle_vin ||
                                  entry.trip_id ||
                                  entry.vehicle_name
                                }`}
                                className="message-maintenance-item message-maintenance-brief-item"
                              >
                                <div>
                                  <strong>
                                    {entry.vehicle_name || "Vehicle"}
                                  </strong>
                                  <span>
                                    {getMaintenanceBriefEntryCopy(entry)} -{" "}
                                    {formatMaintenancePlanDate(entry.available_at)}
                                  </span>
                                  {(entry.tasks || []).slice(0, 3).map((task) => (
                                    <span key={task.id || task.title}>
                                      {task.title || "Maintenance task"}
                                      {Number(task.duplicate_count || 0) > 1
                                        ? ` (${Number(
                                            task.duplicate_count
                                          )} grouped)`
                                        : ""}
                                    </span>
                                  ))}
                                  {Number(entry.task_count || 0) > 3 ? (
                                    <span>
                                      +{Number(entry.task_count || 0) - 3} more
                                    </span>
                                  ) : null}
                                </div>
                                <em>
                                  {entry.has_high_priority ? "high" : "plan"}
                                </em>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="message-maintenance-empty">
                            Nothing in this bucket.
                          </div>
                        )}
                        {section.items.length > 6 ? (
                          <div className="message-maintenance-more">
                            +{section.items.length - 6} more vehicles
                          </div>
                        ) : null}
                      </div>
                    ))}
                      </>
                    ) : null}
                  </div>
                )}

                {canShowInvoiceSummary && (
                  <ReimbursementInvoiceSummary message={message} />
                )}

                {(canReviewUnmatchedNotification || canVerifyReturnLocation) && (
                  <div className="message-booking-task message-notification-gap-detail">
                    <div className="message-booking-title">
                      {canVerifyReturnLocation
                        ? "Verify returned vehicle location"
                        : "Notification arrived without a matching email"}
                      <span>{message.notification_device || "bridge device"}</span>
                    </div>
                    {canVerifyReturnLocation ? (
                      <div className="message-maintenance-plan-date">
                        <span>Expected return spot</span>
                        <strong>
                          {message.return_location_text ||
                            message.notification_body ||
                            "Check Turo return details"}
                        </strong>
                      </div>
                    ) : null}
                    <div className="message-maintenance-plan-date">
                      <span>Received</span>
                      <strong>
                        {formatTripTime(message.notification_received_at) || "Unknown"}
                      </strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Classification</span>
                      <strong>
                        {message.notification_classification || "unknown"}
                      </strong>
                    </div>
                    {message.reservation_id ? (
                      <div className="message-maintenance-plan-date">
                        <span>Reservation</span>
                        <strong>#{message.reservation_id}</strong>
                      </div>
                    ) : null}
                    <div className="message-inline-actions">
                      {canVerifyReturnLocation && message.trip_id ? (
                        <button
                          type="button"
                          className="message-action"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleFocusTrip(message);
                          }}
                        >
                          Open linked trip
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="message-action"
                        disabled={
                          ackingNotificationId === message.notification_event_id
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAckNotification(message);
                        }}
                      >
                        {ackingNotificationId === message.notification_event_id
                          ? "Acknowledging..."
                          : canVerifyReturnLocation
                          ? "GPS verified / acknowledge"
                          : "Acknowledge"}
                      </button>
                    </div>
                  </div>
                )}

                {canReviewDiagnostic && (
                  <div className="message-booking-task message-notification-gap-detail">
                    <div className="message-booking-title">
                      Vehicle diagnostics
                      <span>{message.diagnostic_source || "telematics"}</span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Status</span>
                      <strong>
                        {message.diagnostic_label || "Diagnostic warning"}
                      </strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>First reported</span>
                      <strong>
                        {formatTripTime(message.diagnostic_first_reported_at) ||
                          "Unknown"}
                      </strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Last seen</span>
                      <strong>
                        {formatTripTime(message.diagnostic_last_seen) || "Unknown"}
                      </strong>
                    </div>
                    <div className="message-inline-actions">
                      <button
                        type="button"
                        className="message-action"
                        disabled={suppressingDiagnosticId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSuppressDiagnostic(message, "acknowledge");
                        }}
                      >
                        {suppressingDiagnosticId === message.id
                          ? "Updating..."
                          : "Acknowledge"}
                      </button>
                      <button
                        type="button"
                        className="message-action"
                        disabled={suppressingDiagnosticId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSuppressDiagnostic(message, "snooze");
                        }}
                      >
                        Snooze {Number(message.diagnostic_snooze_hours || 12) || 12}h
                      </button>
                    </div>
                  </div>
                )}

                {canReviewGuestThread && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Guest conversation
                      <span>
                        {Number(message.guest_message_count || 0)} unread
                      </span>
                    </div>
                    <div className="message-maintenance-list">
                      {(message.guest_messages || []).map((guestMessage) => (
                        <div
                          key={guestMessage.id}
                          className="message-maintenance-item"
                        >
                          <div>
                            <strong>
                              {formatTimeAgo(guestMessage.timestamp)}
                            </strong>
                            <span>
                              {guestMessage.guest_message ||
                                guestMessage.subject ||
                                "Guest message"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canSuggestGuestReply && (replySuggestion || replySuggestionError) && (
                  <div
                    className="message-guest-reply"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="message-booking-title">
                      Suggested reply
                      <span>
                        {replySuggestionError
                          ? "Review"
                          : copiedReplySuggestionId === replySuggestionKey
                          ? "Copied"
                          : "Draft"}
                      </span>
                    </div>
                    {replySuggestion ? (
                      <>
                        <p className="message-guest-reply-text">
                          {replySuggestion}
                        </p>
                        <div className="message-guest-reply-actions">
                          <button
                            type="button"
                            className="message-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleCopyGuestReplySuggestion(
                                message,
                                replySuggestion
                              );
                            }}
                          >
                            {copiedReplySuggestionId === replySuggestionKey
                              ? "Copied"
                              : "Copy text"}
                          </button>
                        </div>
                      </>
                    ) : null}
                    {replySuggestionError ? (
                      <div className="message-guest-reply-error">
                        {replySuggestionError}
                      </div>
                    ) : null}
                  </div>
                )}

                {canShowOperationalTripNotice && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Upcoming booking context
                      <span>
                        {message.trip_record_vehicle_nickname ||
                          message.vehicle_nickname ||
                          message.vehicle_name ||
                          "Vehicle"}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Pickup</span>
                      <strong>
                        {formatTripTime(
                          message.trip_record_start || message.trip_start
                        ) || "Unknown"}
                      </strong>
                    </div>
                    <div className="message-handoff-countdown">
                      {formatHandoffCountdown(
                        message.trip_record_start || message.trip_start,
                        countdownNow
                      )}
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Vehicle status</span>
                      <strong>{getVehicleOperationalStatus(message)}</strong>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Pickup location</span>
                      <strong>{message.pickup_location || "Unknown"}</strong>
                    </div>
                    {message.trip_id && (
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
                  </div>
                )}

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

                {canReviewRefuel && (
                  <div className="message-booking-task">
                    <div className="message-booking-title">
                      Refuel before turnover
                      <span>
                        {message.refuel_latest_fuel_level == null
                          ? "fuel low"
                          : `${Math.round(
                              Number(message.refuel_latest_fuel_level)
                            )}% fuel`}
                      </span>
                    </div>
                    <div className="message-maintenance-plan-date">
                      <span>Vehicle back</span>
                      <strong>
                        {formatTripTime(
                          message.refuel_returned_at || message.trip_end
                        ) || "Recently"}
                      </strong>
                    </div>
                    <div className="message-closeout-hint">
                      Fuel gauge is below{" "}
                      {Math.round(Number(message.refuel_threshold || 95))}%.
                      {message.refuel_latest_fuel_at
                        ? ` Last fuel reading ${formatTripTime(
                            message.refuel_latest_fuel_at
                          )}.`
                        : ""}
                      {message.refuel_next_trip_start
                        ? ` Next trip starts ${formatTripTime(
                            message.refuel_next_trip_start
                          )}.`
                        : ""}
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
                    {inspectionPreview?.messageId === message.id ? (
                      <div className="message-inspection-preview">
                        <GuestSafetySnapshotCard
                          vehicle={inspectionPreview.vehicle}
                          guestName={inspectionPreview.guestName}
                        />
                      </div>
                    ) : null}
                  </div>
                )}

                {hasMaintenanceDetails && (
                  <div
                    className={`message-maintenance-task ${
                      maintenanceDetailsExpanded
                        ? ""
                        : "message-maintenance-task--compact"
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
                            {Number(task.duplicate_count || 0) > 1 ? (
                              <span>
                                {Number(task.duplicate_count)} open records grouped
                              </span>
                            ) : null}
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
                  canReviewRefuel ||
                  canReviewLateToll ||
                  canEditTripValues ||
                  canCompleteSyntheticTask ||
                  canConfirmBooking ||
                  canSuggestGuestReply ||
                  hasMaintenanceDetails ||
                  canOpenMaintenanceQueue ||
                  canReconnectGoogleCalendar ||
                  canReviewBanking ||
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
                          : canReviewRefuel
                          ? "Open trip"
                          : canReviewLateToll
                          ? "Review tolls"
                          : canReviewOverlap
                          ? "Review overlap"
                          : canReviewUnmatchedNotification
                          ? "Open linked trip"
                          : canShowMaintenance || canAdvanceHandoff || canExportInspection
                          ? "View trip"
                          : "Verify details"}
                      </button>
                    )}

                    {canReconnectGoogleCalendar && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleReconnectGoogleCalendar();
                        }}
                      >
                        Reconnect Google
                      </button>
                    )}

                    {canReviewBanking && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenBankingReconciliation?.();
                        }}
                      >
                        Reconcile now
                      </button>
                    )}

                    {canReviewRefuel && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={ackingRefuelId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleAcknowledgeRefuel(message);
                        }}
                      >
                        {ackingRefuelId === message.id
                          ? "Acknowledging..."
                          : "Acknowledge fuel alert"}
                      </button>
                    )}

                    {canEditTripValues && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={focusingMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleEditTripFromMessage(message);
                        }}
                      >
                        {focusingMessageId === message.id
                          ? "Loading..."
                          : "Edit trip"}
                      </button>
                    )}

                    {hasMaintenanceDetails && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={resolvingMaintenanceId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleResolveMaintenance(message);
                        }}
                      >
                        {resolvingMaintenanceId === message.id
                          ? "Updating..."
                          : "Mark handled"}
                      </button>
                    )}

                    {canExportInspection && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={previewingInspectionMessageId === message.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          handlePreviewGuestInspectionSheet(message);
                        }}
                      >
                        {previewingInspectionMessageId === message.id
                          ? "Loading..."
                          : inspectionPreview?.messageId === message.id
                          ? "Hide preview"
                          : "Preview"}
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

                    {canOpenMaintenanceQueue && (
                      <button
                        type="button"
                        className="message-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenMaintenanceVehicle?.(maintenanceVehicleKey);
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

                    {canSuggestGuestReply && (
                      <button
                        type="button"
                        className="message-action"
                        disabled={replySuggestingMessageId === replySuggestionKey}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleSuggestGuestReply(message);
                        }}
                      >
                        {replySuggestingMessageId === replySuggestionKey
                          ? "Drafting..."
                          : replySuggestion
                          ? "Refresh suggestion"
                          : "Suggest reply"}
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
                          handleMarkAsRead(message);
                        }}
                      >
                        {canReviewGuestThread ? "Mark all as read" : "Mark as read"}
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
            guestName={inspectionExport.guestName}
          />
        </div>
      ) : null}
    </section>
  );
}


