// --------------------------------------------------------------
// /src/components/maintenance/FleetMaintenancePanel.jsx
// Fleet maintenance snapshot + planning + inspection editing.
// --------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toPng } from "html-to-image";
import GuestSafetySnapshotCard from "./GuestSafetySnapshotCard";
import InspectionItemDrawer from "./InspectionItemDrawer";
import PreflightCard from "./PreflightCard";
import { openPrintDialogForElement } from "../../utils/printUtils";
import {
  getFleetLicensePlate,
  getFleetLicenseState,
  getFleetRegistrationMonth,
  getFleetRegistrationYear,
  formatRegistration,
  normalizeVehicleKey,
  findFleetVehicleBySelectedId,
  formatDotCodeForGuest,
  isTaskSatisfiedByRule,
  buildExportFileName,
  formatMiles,
  getVinLast6,
  getNextServiceDue,
  buildPreflightDueItems,
  buildInspectionHistoryMap,
  buildQueueItemsFromSummary,
  mapRuleStatusToInspectionItem,
  getEarliestAvailableDate,
  getEarliestAvailableLabel,
} from "../../utils/maintUtils";

function pickFirstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function formatRuleCountdown(item, currentOdometerMiles) {
  const currentMiles = Number(currentOdometerMiles);
  const nextDueMiles =
    item?.lastEvent?.nextDueMiles != null
      ? Number(item.lastEvent.nextDueMiles)
      : item?.nextDueMiles != null
      ? Number(item.nextDueMiles)
      : null;

  const nextDueDate =
    item?.lastEvent?.nextDueDate || item?.nextDueDate || null;

  const parts = [];

  if (Number.isFinite(currentMiles) && Number.isFinite(nextDueMiles)) {
    const milesRemaining = Math.round(nextDueMiles - currentMiles);

    if (milesRemaining < 0) {
      parts.push(`${Math.abs(milesRemaining).toLocaleString()} mi overdue`);
    } else if (milesRemaining === 0) {
      parts.push("due now");
    } else {
      parts.push(`${milesRemaining.toLocaleString()} mi left`);
    }
  }

  if (nextDueDate) {
    const dueDate = new Date(nextDueDate);
    if (!Number.isNaN(dueDate.getTime())) {
      const today = new Date();
      const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const daysRemaining = Math.ceil(
        (dueDay.getTime() - todayDay.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysRemaining < 0) {
        parts.push(`${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? "" : "s"} overdue`);
      } else if (daysRemaining === 0) {
        parts.push("due today");
      } else {
        parts.push(`${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left`);
      }
    }
  }

  if (!parts.length) return null;
  return parts.join(" • ");
}

function getRuleCountdownClass(item, currentOdometerMiles) {
  const currentMiles = Number(currentOdometerMiles);
  const nextDueMiles =
    item?.lastEvent?.nextDueMiles != null
      ? Number(item.lastEvent.nextDueMiles)
      : item?.nextDueMiles != null
      ? Number(item.nextDueMiles)
      : null;

  const nextDueDate =
    item?.lastEvent?.nextDueDate || item?.nextDueDate || null;

  let overdue = false;

  if (Number.isFinite(currentMiles) && Number.isFinite(nextDueMiles)) {
    overdue = currentMiles > nextDueMiles;
  }

  if (nextDueDate) {
    const dueDate = new Date(nextDueDate);
    if (!Number.isNaN(dueDate.getTime())) {
      const today = new Date();
      const dueDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
      const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      if (dueDay < todayDay) overdue = true;
    }
  }

  return overdue
    ? "fleet-maintenance-card-ticker fleet-maintenance-card-ticker--overdue"
    : "fleet-maintenance-card-ticker";
}

function buildPreflightData(trips, summary) {
  if (!summary) {
    return {
      windowLabel: "Unknown window",
      dueItems: [],
    };
  }

  const relevantTrips = Array.isArray(trips) ? trips : [];
  const now = new Date();
  let cutoff = null;

  for (const trip of relevantTrips) {
    const start = trip?.trip_start ? new Date(trip.trip_start) : null;
    const end = trip?.trip_end ? new Date(trip.trip_end) : null;

    if (start && end && start <= now && end >= now) {
      cutoff = end;
      break;
    }

    if (start && start > now) {
      cutoff = start;
      break;
    }
  }

  if (!cutoff) cutoff = now;

  const dueItems = buildPreflightDueItems(summary, { cutoff });

  const windowLabel = cutoff.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return {
    windowLabel: `Before ${windowLabel}`,
    dueItems,
  };
}

function normalizeTelematicsSourceLabel(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value === "bouncie") return "Bouncie";
  if (value === "dimo") return "DIMO";
  return value ? value.toUpperCase() : "";
}

function formatTelematicsLastCall(value) {
  if (!value) return "No call-in recorded";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown call-in";

  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes || 1} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;

  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function buildTelematicsStatus(fleetVehicle = null) {
  const sources = Array.isArray(fleetVehicle?.telemetry_source)
    ? fleetVehicle.telemetry_source
    : [];
  const sourceLabel = sources
    .map(normalizeTelematicsSourceLabel)
    .filter(Boolean)
    .join(" + ");
  const lastCallRaw =
    fleetVehicle?.telemetry?.last_comm ||
    fleetVehicle?.telemetry?.timestamps?.location_last_updated ||
    fleetVehicle?.telemetry?.timestamps?.ignition_last_updated ||
    null;
  const lastCallDate = lastCallRaw ? new Date(lastCallRaw) : null;
  const ageHours =
    lastCallDate && !Number.isNaN(lastCallDate.getTime())
      ? (Date.now() - lastCallDate.getTime()) / (1000 * 60 * 60)
      : null;
  const tone =
    ageHours == null
      ? "unknown"
      : ageHours <= 24
      ? "pass"
      : ageHours <= 72
      ? "attention"
      : "fail";

  return {
    sourceLabel: sourceLabel || "No telematics source",
    lastCallLabel: formatTelematicsLastCall(lastCallRaw),
    tone,
  };
}

function formatEngineTemp(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Math.round(num)} F`;
}

function buildEngineTemperatureStatus(fleetVehicle = null) {
  const engine = fleetVehicle?.telemetry?.engine || {};
  const latestTemp = Number(engine.coolant_temp);
  const range = engine.coolant_temp_range || {};
  const minTemp = Number(range.min_f);
  const maxTemp = Number(range.max_f);
  const sampleCount = Number(range.sample_count || 0);
  const latestText = Number.isFinite(latestTemp)
    ? formatEngineTemp(latestTemp)
    : "No reading";
  const rangeText =
    Number.isFinite(minTemp) && Number.isFinite(maxTemp)
      ? `${formatEngineTemp(minTemp)} - ${formatEngineTemp(maxTemp)}`
      : "Range unavailable";
  const overtemp = Boolean(
    engine.overtemp ||
      range.last_overtemp_at ||
      (Number.isFinite(latestTemp) && latestTemp >= 240) ||
      (Number.isFinite(maxTemp) && maxTemp >= 240)
  );
  const warm = !overtemp && Number.isFinite(maxTemp) && maxTemp >= 225;
  const tone = overtemp
    ? "fail"
    : warm
    ? "attention"
    : Number.isFinite(latestTemp) || sampleCount > 0
    ? "pass"
    : "unknown";
  const detail = overtemp
    ? `Overtemp alert${range.last_overtemp_at ? ` at ${formatTelematicsLastCall(range.last_overtemp_at)}` : ""}`
    : sampleCount > 0
    ? `14-day range: ${rangeText}`
    : "No DIMO engine temp history";

  return {
    latestText,
    rangeText,
    detail,
    tone,
  };
}

function formatEngineRpm(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Math.round(num).toLocaleString("en-US")} RPM`;
}

function buildEngineRpmStatus(fleetVehicle = null) {
  const engine = fleetVehicle?.telemetry?.engine || {};
  const latestRpm = Number(engine.rpm);
  const range = engine.rpm_range || {};
  const maxRpm = Number(range.max_rpm);
  const sampleCount = Number(range.sample_count || 0);
  const latestText = Number.isFinite(latestRpm)
    ? formatEngineRpm(latestRpm)
    : "No reading";
  const maxText = Number.isFinite(maxRpm)
    ? formatEngineRpm(maxRpm)
    : "Max unavailable";
  const detail =
    sampleCount > 0
      ? `14-day observed max: ${maxText}`
      : "No DIMO tachometer history";

  return {
    latestText,
    maxText,
    detail,
    tone: Number.isFinite(latestRpm) || sampleCount > 0 ? "pass" : "unknown",
  };
}

function mapMaintenanceSummaryToVehicle(summary, fallbackId, fleetVehicle = null) {
  if (!summary?.vehicle) return null;

  const sourceVehicle = summary.vehicle;
  const tasks = Array.isArray(summary.tasks) ? summary.tasks : [];
  const ruleStatuses = Array.isArray(summary.ruleStatuses)
    ? summary.ruleStatuses
    : [];
  const notes = Array.isArray(summary.guestVisibleConditionNotes)
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

  const historyMap = buildInspectionHistoryMap(summary);
  const oilServiceDue = getNextServiceDue(summary, {
    ruleCodes: ["oil_change", "brake_inspection"],
    label: "Next service due",
  });
  const nextServiceDue =
    oilServiceDue?.text && oilServiceDue.text !== "Unknown"
      ? oilServiceDue
      : getNextServiceDue(summary);

  const actionableTasks = tasks.filter(
    (task) =>
      String(task?.status || "").toLowerCase() === "open" &&
      !isTaskSatisfiedByRule(task, summary)
  );

  const hasBlockingIssue = Boolean(
    summary.blocksRental || summary.blocksGuestExport
  );
  const hasNeedsReview = Boolean(summary.needsReview);
  const hasOpenTasks = actionableTasks.length > 0;

  const overallStatus =
    hasBlockingIssue || hasNeedsReview || hasOpenTasks ? "attention" : "pass";

  const plate = pickFirstFilled(
    sourceVehicle.license_plate,
    sourceVehicle.licensePlate,
    sourceVehicle.plate,
    fleetVehicle?.license_plate
  );

  const licenseState = pickFirstFilled(
    sourceVehicle.registration?.state,
    sourceVehicle.license_state,
    sourceVehicle.licenseState,
    fleetVehicle?.registration?.state,
    fleetVehicle?.license_state
  );

  const registrationMonth = pickFirstFilled(
    sourceVehicle.registration?.month,
    sourceVehicle.registration_month,
    sourceVehicle.registrationMonth,
    fleetVehicle?.registration?.month,
    fleetVehicle?.registration_month
  );

  const registrationYear = pickFirstFilled(
    sourceVehicle.registration?.year,
    sourceVehicle.registration_year,
    sourceVehicle.registrationYear,
    fleetVehicle?.registration?.year,
    fleetVehicle?.registration_year
  );

  return {
    id:
      fallbackId ||
      normalizeVehicleKey(sourceVehicle.nickname || sourceVehicle.vin || "vehicle"),
    nickname: sourceVehicle.nickname,
    year: sourceVehicle.year,
    make: sourceVehicle.make,
    model: sourceVehicle.model,
    vin: sourceVehicle.vin || null,
    vin_last6: getVinLast6(sourceVehicle.vin),
    rockauto_url:
      sourceVehicle.rockauto_url ||
      sourceVehicle.rockautoUrl ||
      fleetVehicle?.rockauto_url ||
      fleetVehicle?.rockautoUrl ||
      "",
    currentOdometerMiles:
      summary.currentOdometerMiles ?? sourceVehicle.currentOdometerMiles ?? null,
    next_service_due: nextServiceDue,
    plate: plate || "—",
    license_plate: plate || "",
    license_state: licenseState || "TX",
    registration_month: registrationMonth ?? "",
    registration_year: registrationYear ?? "",
    registration_expires:
      sourceVehicle.registration?.code ||
      formatRegistration(registrationMonth, registrationYear),
    rentable: !summary.blocksRental,
    overall_status: overallStatus,
    export_ready: !summary.blocksGuestExport,
    telematics: buildTelematicsStatus(fleetVehicle),
    engine_temperature: buildEngineTemperatureStatus(fleetVehicle),
    engine_rpm: buildEngineRpmStatus(fleetVehicle),
    body_condition: notes.length ? "documented" : "good",
    body_notes: notes.length
      ? notes
      : ["No guest-visible cosmetic notes recorded"],
    inspection_items: ruleStatuses.map((rule) =>
      mapRuleStatusToInspectionItem(rule, historyMap)
    ),
    queue_items: buildQueueItemsFromSummary(summary, historyMap),
  };
}

function getStatusLabel(status) {
  if (status === "pass") return "Pass";
  if (status === "fail") return "Fail";
  if (status === "attention") return "Needs attention";
  return "Unknown";
}

function getStatusIcon(status) {
  if (status === "pass") return "✅";
  if (status === "fail") return "❌";
  if (status === "attention") return "🟡";
  return "•";
}

function buildFleetPlanningCard(vehicle, trips, summary) {
  const historyMap = buildInspectionHistoryMap(summary);
  const queueItems = buildQueueItemsFromSummary(summary, historyMap);

  const blockingItems = queueItems.filter(
    (item) =>
      item?.task?.blocks_rental ||
      item?.task?.blocks_guest_export ||
      item?.blocksRentalWhenOverdue ||
      item?.blocksGuestExportWhenOverdue
  );

  const attentionItems = queueItems.filter((item) => !blockingItems.includes(item));

  return {
    id: normalizeVehicleKey(vehicle.nickname || vehicle.vin || vehicle.id),
    vin: vehicle.vin || null,
    nickname: vehicle.nickname || "Unknown",
    year: vehicle.year || "—",
    make: vehicle.make || "",
    model: vehicle.model || "",
    nextAvailableDate: getEarliestAvailableDate(trips),
    nextOffTrip: getEarliestAvailableLabel(trips),
    totalOpenItems: queueItems.length,
    blockingCount: blockingItems.length,
    attentionCount: attentionItems.length,
    topItems: queueItems.slice(0, 4),
  };
}

function sortFleetPlanningCards(cards) {
  return [...cards].sort((a, b) => {
    const aDate = new Date(a.nextAvailableDate || 0).getTime();
    const bDate = new Date(b.nextAvailableDate || 0).getTime();
    if (aDate !== bDate) return aDate - bDate;

    if (b.blockingCount !== a.blockingCount) {
      return b.blockingCount - a.blockingCount;
    }

    if (b.totalOpenItems !== a.totalOpenItems) {
      return b.totalOpenItems - a.totalOpenItems;
    }

    return String(a.nickname || "").localeCompare(String(b.nickname || ""));
  });
}

export default function FleetMaintenancePanel({ selectedVehicleId }) {
  const cardRef = useRef(null);
  const preflightRef = useRef(null);

  const [vehicleTrips, setVehicleTrips] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingInspection, setSavingInspection] = useState(false);

  const [fleetVehicles, setFleetVehicles] = useState([]);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [fleetLoadError, setFleetLoadError] = useState("");

  const isFleetPlanningMode = !selectedVehicleId;
  const [fleetPlanningCards, setFleetPlanningCards] = useState([]);
  const [fleetPlanningLoading, setFleetPlanningLoading] = useState(false);
  const [fleetPlanningError, setFleetPlanningError] = useState("");

  const [maintenanceSummary, setMaintenanceSummary] = useState(null);
  const [summaryLoadError, setSummaryLoadError] = useState("");

  const [editingBodyNotes, setEditingBodyNotes] = useState(false);
  const [savingBodyNotes, setSavingBodyNotes] = useState(false);
  const [bodyNotesError, setBodyNotesError] = useState("");
  const [bodyNotesText, setBodyNotesText] = useState("");

  const [editingRegistration, setEditingRegistration] = useState(false);
  const [savingRegistration, setSavingRegistration] = useState(false);
  const [registrationError, setRegistrationError] = useState("");
  const [registrationForm, setRegistrationForm] = useState({
    license_plate: "",
    license_state: "TX",
    registration_month: "",
    registration_year: "",
  });

  const [addingCustomRule, setAddingCustomRule] = useState(false);
  const [savingCustomRule, setSavingCustomRule] = useState(false);
  const [customRuleError, setCustomRuleError] = useState("");
  const [customRuleForm, setCustomRuleForm] = useState({
    title: "",
    category: "service",
    intervalMiles: "",
    intervalDays: "",
    dueSoonMiles: "500",
    dueSoonDays: "14",
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    saveAsTemplate: false,
  });
  const [maintenanceTemplates, setMaintenanceTemplates] = useState([]);
  const [templateLoadError, setTemplateLoadError] = useState("");

  const [selectedInspectionItem, setSelectedInspectionItem] = useState(null);
  const [inspectionDrawerOpen, setInspectionDrawerOpen] = useState(false);
  const [inspectionVehicle, setInspectionVehicle] = useState(null);

  const selectedFleetVehicle = useMemo(() => {
    return findFleetVehicleBySelectedId(fleetVehicles, selectedVehicleId);
  }, [fleetVehicles, selectedVehicleId]);

  const liveVehicle = useMemo(() => {
    if (!maintenanceSummary) return null;

    return mapMaintenanceSummaryToVehicle(
      maintenanceSummary,
      normalizeVehicleKey(selectedVehicleId),
      selectedFleetVehicle
    );
  }, [maintenanceSummary, selectedVehicleId, selectedFleetVehicle]);

  useEffect(() => {
    let cancelled = false;

    async function loadFleetVehicles() {
      try {
        if (!cancelled) {
          setFleetLoading(true);
          setFleetLoadError("");
        }

        const res = await fetch("http://localhost:5000/api/vehicles/live-status");

        if (!res.ok) {
          const errorBody = await res.json().catch(() => null);
          throw new Error(errorBody?.error || `HTTP ${res.status}`);
        }

        const vehicles = await res.json();

        if (!cancelled) {
          setFleetVehicles(Array.isArray(vehicles) ? vehicles : []);
        }
      } catch (err) {
        console.error("Failed to load fleet vehicles:", err);

        if (!cancelled) {
          setFleetVehicles([]);
          setFleetLoadError(err.message || "Failed to load fleet vehicles");
        }
      } finally {
        if (!cancelled) setFleetLoading(false);
      }
    }

    loadFleetVehicles();

    return () => {
      cancelled = true;
    };
  }, []);

  const loadMaintenanceTemplates = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:5000/api/maintenance-rule-templates");

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null);
        throw new Error(errorBody?.error || `HTTP ${res.status}`);
      }

      const body = await res.json();
      setMaintenanceTemplates(Array.isArray(body?.templates) ? body.templates : []);
      setTemplateLoadError("");
    } catch (err) {
      console.error("Failed to load maintenance templates:", err);
      setMaintenanceTemplates([]);
      setTemplateLoadError(err.message || "Failed to load maintenance templates.");
    }
  }, []);

  useEffect(() => {
    loadMaintenanceTemplates();
  }, [loadMaintenanceTemplates]);

  const loadSelectedVehicleMaintenance = useCallback(async () => {
    if (!selectedFleetVehicle?.vin) {
      setMaintenanceSummary(null);
      setSummaryLoadError("");
      return;
    }

    const res = await fetch(
      `http://localhost:5000/api/vehicles/${encodeURIComponent(
        selectedFleetVehicle.vin
      )}/maintenance-summary`
    );

    if (!res.ok) {
      const errorBody = await res.json().catch(() => null);
      throw new Error(errorBody?.error || `HTTP ${res.status}`);
    }

    const summary = await res.json();

    setSummaryLoadError("");
    setMaintenanceSummary(summary);
  }, [selectedFleetVehicle?.vin]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedFleetVehicle?.vin) {
        if (!cancelled) {
          setMaintenanceSummary(null);
          setSummaryLoadError("");
        }
        return;
      }

      try {
        if (!cancelled) setLoading(true);

        const res = await fetch(
          `http://localhost:5000/api/vehicles/${encodeURIComponent(
            selectedFleetVehicle.vin
          )}/maintenance-summary`
        );

        if (!res.ok) {
          const errorBody = await res.json().catch(() => null);
          throw new Error(errorBody?.error || `HTTP ${res.status}`);
        }

        const summary = await res.json();

        if (!cancelled) {
          setSummaryLoadError("");
          setMaintenanceSummary(summary);
        }
      } catch (err) {
        console.error(
          `Failed to load maintenance summary for ${selectedVehicleId}:`,
          err
        );

        if (!cancelled) {
          setMaintenanceSummary(null);
          setSummaryLoadError(
            err.message || "Failed to load live maintenance summary."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [selectedFleetVehicle?.vin, selectedVehicleId]);

  useEffect(() => {
    let cancelled = false;

    async function loadFleetPlanningCards() {
      if (!isFleetPlanningMode) {
        if (!cancelled) {
          setFleetPlanningCards([]);
          setFleetPlanningError("");
          setFleetPlanningLoading(false);
        }
        return;
      }

      try {
        if (!cancelled) {
          setFleetPlanningLoading(true);
          setFleetPlanningError("");
        }

        const vehicleRes = await fetch("http://localhost:5000/api/vehicles/live-status");
        if (!vehicleRes.ok) throw new Error(`Vehicle status HTTP ${vehicleRes.status}`);

        const vehicleData = await vehicleRes.json();
        const vehicles = Array.isArray(vehicleData) ? vehicleData : [];

        const vehicleTripPairs = await Promise.all(
          vehicles.map(async (vehicle) => {
            const vehicleId = normalizeVehicleKey(
              vehicle.nickname ||
                vehicle.vin ||
                vehicle.id ||
                vehicle.dimo_token_id ||
                vehicle.bouncie_vehicle_id
            );

            try {
              const tripsRes = await fetch(
                `http://localhost:5000/api/trips/vehicle/${vehicleId}?mode=relevant`
              );

              if (!tripsRes.ok) throw new Error(`Trip status HTTP ${tripsRes.status}`);

              const tripData = await tripsRes.json();
              return { vehicle, trips: Array.isArray(tripData) ? tripData : [] };
            } catch (err) {
              console.error(`Failed to load trips for ${vehicleId}:`, err);
              return { vehicle, trips: [] };
            }
          })
        );

        const planningCards = await Promise.all(
          vehicleTripPairs.map(async ({ vehicle, trips }) => {
            try {
              const summaryRes = await fetch(
                `http://localhost:5000/api/vehicles/${encodeURIComponent(
                  vehicle.vin
                )}/maintenance-summary`
              );

              if (!summaryRes.ok) {
                throw new Error(`Maintenance summary HTTP ${summaryRes.status}`);
              }

              const summary = await summaryRes.json();
              return buildFleetPlanningCard(vehicle, trips, summary);
            } catch (err) {
              console.error(
                `Failed to load planning card for ${vehicle.nickname}:`,
                err
              );
              return null;
            }
          })
        );

        if (!cancelled) {
          setFleetPlanningCards(sortFleetPlanningCards(planningCards.filter(Boolean)));
        }
      } catch (err) {
        console.error("Failed to load fleet planning cards:", err);
        if (!cancelled) {
          setFleetPlanningCards([]);
          setFleetPlanningError(
            err.message || "Failed to load fleet planning cards."
          );
        }
      } finally {
        if (!cancelled) setFleetPlanningLoading(false);
      }
    }

    loadFleetPlanningCards();

    return () => {
      cancelled = true;
    };
  }, [isFleetPlanningMode]);

  useEffect(() => {
    let cancelled = false;

    async function loadTrips() {
      if (!selectedFleetVehicle) return;

      try {
        const vehicleId = normalizeVehicleKey(
          selectedFleetVehicle.nickname ||
            selectedFleetVehicle.vin ||
            selectedFleetVehicle.id ||
            selectedFleetVehicle.dimo_token_id ||
            selectedFleetVehicle.bouncie_vehicle_id
        );

        const res = await fetch(
          `http://localhost:5000/api/trips/vehicle/${vehicleId}?mode=relevant`
        );

        if (!res.ok) throw new Error("Trip load failed");

        const data = await res.json();

        if (!cancelled) setVehicleTrips(Array.isArray(data) ? data : []);
      } catch (err) {
        console.error("Failed to load trips:", err);
        if (!cancelled) setVehicleTrips([]);
      }
    }

    loadTrips();

    return () => {
      cancelled = true;
    };
  }, [selectedFleetVehicle]);

  const preflightData = useMemo(() => {
    return buildPreflightData(vehicleTrips, maintenanceSummary);
  }, [vehicleTrips, maintenanceSummary]);

  const vehicle = useMemo(() => {
    if (liveVehicle) return liveVehicle;

    if (selectedFleetVehicle) {
      return {
        id: normalizeVehicleKey(
          selectedFleetVehicle.nickname || selectedFleetVehicle.vin
        ),
        nickname: selectedFleetVehicle.nickname || "Unknown vehicle",
        year: selectedFleetVehicle.year,
        make: selectedFleetVehicle.make,
        model: selectedFleetVehicle.model,
        vin: selectedFleetVehicle.vin || null,
        vin_last6: getVinLast6(selectedFleetVehicle?.vin),
        rockauto_url:
          selectedFleetVehicle.rockauto_url ||
          selectedFleetVehicle.rockautoUrl ||
          "",
        next_service_due: {
          miles: null,
          date: null,
          estimatedDate: null,
          avgDailyMiles: null,
          text: "Unknown",
        },
        currentOdometerMiles: null,
        plate: selectedFleetVehicle.license_plate || "—",
        license_plate: selectedFleetVehicle.license_plate || "",
        license_state: selectedFleetVehicle.license_state || "TX",
        registration_month: selectedFleetVehicle.registration_month ?? "",
        registration_year: selectedFleetVehicle.registration_year ?? "",
        registration_expires: formatRegistration(
          selectedFleetVehicle.registration_month,
          selectedFleetVehicle.registration_year
        ),
        rentable: true,
        overall_status: "attention",
        export_ready: false,
        telematics: buildTelematicsStatus(selectedFleetVehicle),
        engine_temperature: buildEngineTemperatureStatus(selectedFleetVehicle),
        engine_rpm: buildEngineRpmStatus(selectedFleetVehicle),
        body_condition: "unknown",
        body_notes: ["Loading live maintenance summary…"],
        inspection_items: [],
        outstanding_items: [],
      };
    }

    return {
      id: normalizeVehicleKey(selectedVehicleId || "vehicle"),
      nickname: "Unknown vehicle",
      year: "—",
      make: "",
      model: "",
      vin: null,
      vin_last6: "Unknown",
      next_service_due: {
        miles: null,
        date: null,
        estimatedDate: null,
        avgDailyMiles: null,
        text: "Unknown",
      },
      currentOdometerMiles: null,
      plate: "—",
      registration_expires: "—",
      rentable: false,
      overall_status: "attention",
      export_ready: false,
      telematics: buildTelematicsStatus(null),
      engine_temperature: buildEngineTemperatureStatus(null),
      engine_rpm: buildEngineRpmStatus(null),
      body_condition: "unknown",
      body_notes: fleetLoadError
        ? [fleetLoadError]
        : summaryLoadError
        ? [summaryLoadError]
        : fleetLoading
        ? ["Loading fleet vehicles…"]
        : loading
        ? ["Loading live maintenance summary…"]
        : ["Vehicle not found in live fleet feed."],
      inspection_items: [],
      outstanding_items: [],
    };
  }, [
    selectedVehicleId,
    liveVehicle,
    selectedFleetVehicle,
    fleetLoadError,
    fleetLoading,
    summaryLoadError,
    loading,
  ]);

  const title = `${vehicle.nickname} • ${vehicle.year} ${vehicle.make} ${vehicle.model}`;

  useEffect(() => {
    setBodyNotesText(
      Array.isArray(vehicle.body_notes) ? vehicle.body_notes.join("\n") : ""
    );
    setEditingBodyNotes(false);
    setBodyNotesError("");
  }, [vehicle.id, vehicle.body_notes]);

  useEffect(() => {
    setRegistrationForm({
      license_plate: getFleetLicensePlate(selectedFleetVehicle) || "",
      license_state: getFleetLicenseState(selectedFleetVehicle) || "TX",
      registration_month: getFleetRegistrationMonth(selectedFleetVehicle) ?? "",
      registration_year: getFleetRegistrationYear(selectedFleetVehicle) ?? "",
    });

    setEditingRegistration(false);
    setRegistrationError("");
  }, [
    selectedFleetVehicle?.vin,
    selectedFleetVehicle?.license_state,
    selectedFleetVehicle?.registration_month,
    selectedFleetVehicle?.registration_year,
    selectedFleetVehicle?.license_plate,
  ]);

  const groupedInspectionItems = useMemo(() => {
    const items = Array.isArray(vehicle.inspection_items)
      ? vehicle.inspection_items
      : [];

    return {
      safety: items.filter((item) => item.category === "safety"),
      service: items.filter((item) => item.category === "service"),
      major: items.filter(
        (item) =>
          item.category === "major" || item.category === "uncategorized"
      ),
      other: items.filter(
        (item) =>
          !["safety", "service", "major", "uncategorized"].includes(item.category)
      ),
    };
  }, [vehicle.inspection_items]);

  async function handleDeleteMaintenanceEntry(entry) {
    try {
      const vin = inspectionVehicle?.vin || selectedFleetVehicle?.vin;
      if (!vin) throw new Error("No vehicle VIN available for delete.");
      if (!entry?.id) throw new Error("No maintenance event id provided.");

      setSavingInspection(true);

      const res = await fetch(
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
          vin
        )}/maintenance-events/${entry.id}`,
        { method: "DELETE" }
      );

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `Delete failed: HTTP ${res.status}`);
      }

      await loadSelectedVehicleMaintenance();

      setSelectedInspectionItem((current) => {
        if (!current) return current;

        const nextHistory = Array.isArray(current.history)
          ? current.history.filter((historyEntry) => historyEntry?.id !== entry.id)
          : [];

        const nextLastEvent =
          current.lastEvent?.id === entry.id ? nextHistory[0] || null : current.lastEvent;

        return {
          ...current,
          history: nextHistory,
          lastEvent: nextLastEvent,
        };
      });
    } catch (err) {
      console.error("Failed to delete maintenance entry:", err);
      window.alert(err.message || "Could not delete maintenance entry.");
    } finally {
      setSavingInspection(false);
    }
  }

  async function handleSaveBodyNotes() {
    try {
      if (!selectedFleetVehicle?.vin) {
        throw new Error("No selected vehicle VIN available.");
      }

      setSavingBodyNotes(true);
      setBodyNotesError("");

      const guestVisibleConditionNotes = bodyNotesText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const res = await fetch(
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
          selectedFleetVehicle.vin
        )}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            guest_visible_condition_notes: guestVisibleConditionNotes,
          }),
        }
      );

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      await loadSelectedVehicleMaintenance();
      setEditingBodyNotes(false);
    } catch (err) {
      console.error("Failed to save cosmetic notes:", err);
      setBodyNotesError(err.message || "Could not save cosmetic notes.");
    } finally {
      setSavingBodyNotes(false);
    }
  }

  async function handleSaveRegistration() {
    try {
      if (!selectedFleetVehicle?.vin) {
        throw new Error("No selected vehicle VIN available.");
      }

      setSavingRegistration(true);
      setRegistrationError("");

      const res = await fetch(
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
          selectedFleetVehicle.vin
        )}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            license_plate: registrationForm.license_plate || null,
            license_state: registrationForm.license_state || null,
            registration_month:
              registrationForm.registration_month === ""
                ? null
                : Number(registrationForm.registration_month),
            registration_year:
              registrationForm.registration_year === ""
                ? null
                : Number(registrationForm.registration_year),
          }),
        }
      );

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      setFleetVehicles((prev) =>
        prev.map((item) =>
          String(item.vin || "") === String(selectedFleetVehicle.vin || "")
            ? {
                ...item,
                license_plate: body.license_plate,
                license_state: body.license_state,
                registration_month: body.registration_month,
                registration_year: body.registration_year,
              }
            : item
        )
      );

      setEditingRegistration(false);
    } catch (err) {
      console.error("Failed to save registration:", err);
      setRegistrationError(err.message || "Could not save registration.");
    } finally {
      setSavingRegistration(false);
    }
  }

  function handleCancelRegistrationEdit() {
    setRegistrationForm({
      license_plate: getFleetLicensePlate(selectedFleetVehicle),
      license_state: getFleetLicenseState(selectedFleetVehicle),
      registration_month: getFleetRegistrationMonth(selectedFleetVehicle),
      registration_year: getFleetRegistrationYear(selectedFleetVehicle),
    });
    setEditingRegistration(false);
    setRegistrationError("");
  }

  function resetCustomRuleForm() {
    setCustomRuleForm({
      title: "",
      category: "service",
      intervalMiles: "",
      intervalDays: "",
      dueSoonMiles: "500",
      dueSoonDays: "14",
      blocksRentalWhenOverdue: false,
      blocksGuestExportWhenOverdue: false,
      requiresPassResult: false,
      saveAsTemplate: false,
    });
    setCustomRuleError("");
  }

  async function handleSaveCustomRule() {
    try {
      if (!selectedFleetVehicle?.vin) {
        throw new Error("No selected vehicle VIN available.");
      }

      if (!String(customRuleForm.title || "").trim()) {
        throw new Error("Give the maintenance item a title.");
      }

      if (!customRuleForm.intervalMiles && !customRuleForm.intervalDays) {
        throw new Error("Set a mileage interval or a day interval.");
      }

      setSavingCustomRule(true);
      setCustomRuleError("");

      const endpoint = customRuleForm.saveAsTemplate
        ? "http://localhost:5000/api/maintenance-rule-templates"
        : `http://localhost:5000/api/vehicles/${encodeURIComponent(
            selectedFleetVehicle.vin
          )}/maintenance-rules`;

      const res = await fetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: customRuleForm.title,
            category: customRuleForm.category,
            intervalMiles:
              customRuleForm.intervalMiles === ""
                ? null
                : Number(customRuleForm.intervalMiles),
            intervalDays:
              customRuleForm.intervalDays === ""
                ? null
                : Number(customRuleForm.intervalDays),
            dueSoonMiles:
              customRuleForm.dueSoonMiles === ""
                ? 0
                : Number(customRuleForm.dueSoonMiles),
            dueSoonDays:
              customRuleForm.dueSoonDays === ""
                ? 0
                : Number(customRuleForm.dueSoonDays),
            blocksRentalWhenOverdue: customRuleForm.blocksRentalWhenOverdue,
            blocksGuestExportWhenOverdue:
              customRuleForm.blocksGuestExportWhenOverdue,
            requiresPassResult: customRuleForm.requiresPassResult,
          }),
        }
      );

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error || `HTTP ${res.status}`);
      }

      await loadSelectedVehicleMaintenance();
      if (customRuleForm.saveAsTemplate) {
        await loadMaintenanceTemplates();
      }
      resetCustomRuleForm();
      setAddingCustomRule(false);
    } catch (err) {
      console.error("Failed to create maintenance rule:", err);
      setCustomRuleError(err.message || "Could not create maintenance rule.");
    } finally {
      setSavingCustomRule(false);
    }
  }

  function handleOpenInspectionItem(item) {
    setSelectedInspectionItem(item);
    setInspectionVehicle({
      nickname: vehicle.nickname || "Unknown vehicle",
      year: vehicle.year || "—",
      make: vehicle.make || "",
      model: vehicle.model || "",
      vin: vehicle.vin || null,
      currentOdometerMiles:
        maintenanceSummary?.currentOdometerMiles ??
        selectedFleetVehicle?.telemetry?.odometer ??
        null,
      exteriorAirTempF:
        selectedFleetVehicle?.telemetry?.environment?.exterior_air_temp ??
        null,
    });
    setInspectionDrawerOpen(true);
  }

  async function handleOpenFleetInspection(vin, ruleCode) {
    if (!vin || !ruleCode) {
      window.alert("Unable to open inspection — missing vehicle or rule code.");
      return;
    }

    try {
      const res = await fetch(
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
          vin
        )}/maintenance-summary`
      );

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || `HTTP ${res.status}`);
      }

      const summary = await res.json();
      const history = buildInspectionHistoryMap(summary);
      const rule = (
        Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : []
      ).find((r) => String(r.ruleCode) === String(ruleCode));

      if (!rule) {
        window.alert(
          `No inspection record found for rule ${ruleCode} on vehicle ${vin}.`
        );
        return;
      }

      const item = mapRuleStatusToInspectionItem(rule, history);
      setSelectedInspectionItem(item);
      setInspectionVehicle({
        nickname:
          summary?.vehicle?.nickname || summary?.vehicle?.vin || "Unknown vehicle",
        year: summary?.vehicle?.year || "—",
        make: summary?.vehicle?.make || "",
        model: summary?.vehicle?.model || "",
        vin: summary?.vehicle?.vin || vin,
        currentOdometerMiles:
          summary?.currentOdometerMiles ??
          summary?.vehicle?.currentOdometerMiles ??
          null,
        exteriorAirTempF: null,
      });
      setInspectionDrawerOpen(true);
    } catch (err) {
      console.error("Failed to open fleet inspection:", err);
      window.alert(err.message || "Could not open inspection.");
    }
  }

  function handleCloseInspectionDrawer() {
    if (savingInspection) return;
    setInspectionDrawerOpen(false);
    setSelectedInspectionItem(null);
    setInspectionVehicle(null);
  }

  async function handleSaveInspectionItem(payload) {
    try {
      const vin = inspectionVehicle?.vin || selectedFleetVehicle?.vin;
      if (!vin) {
        throw new Error("Selected vehicle is not available in the live fleet feed.");
      }

      setSavingInspection(true);

      const saveRes = await fetch(
        `http://localhost:5000/api/vehicles/${encodeURIComponent(
          vin
        )}/maintenance-events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ruleId: payload.ruleId,
            ruleCode: payload.ruleCode,
            performedAt: payload.performedAt,
            odometerMiles: payload.odometerMiles,
            result: payload.result,
            notes: payload.notes,
            data: payload.data,
            performedBy: payload.performedBy,
            source: payload.source,
          }),
        }
      );

      if (!saveRes.ok) {
        const errorBody = await saveRes.json().catch(() => null);
        throw new Error(errorBody?.error || `Save failed: HTTP ${saveRes.status}`);
      }

      await saveRes.json();
      await loadSelectedVehicleMaintenance();
      handleCloseInspectionDrawer();
    } catch (err) {
      console.error("Failed to save inspection item:", err);
      window.alert(err.message || "Could not save inspection item.");
    } finally {
      setSavingInspection(false);
    }
  }

  async function handleExportPng() {
    if (!cardRef.current || exporting) return;

    try {
      setExporting(true);

      const dataUrl = await toPng(cardRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });

      const link = document.createElement("a");
      link.download = buildExportFileName(vehicle, "Inspection");
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("PNG export failed:", err);
      window.alert("Could not export PNG.");
    } finally {
      setExporting(false);
    }
  }

  async function handleExportPreflight() {
    if (!preflightRef.current || exporting) return;

    try {
      setExporting(true);

      const dataUrl = await toPng(preflightRef.current, {
        cacheBust: true,
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });

      const link = document.createElement("a");
      link.download = buildExportFileName(vehicle, "Service");
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error("Preflight export failed:", err);
      window.alert("Could not export prep card.");
    } finally {
      setExporting(false);
    }
  }

  function handlePrintElement(element, title) {
    try {
      openPrintDialogForElement(element, title);
    } catch (err) {
      console.error("Print dialog failed:", err);
      window.alert(err.message || "Could not open print dialog.");
    }
  }

  function handlePrintInspectionReport() {
    handlePrintElement(
      cardRef.current,
      `${vehicle.nickname || "Vehicle"} inspection report`
    );
  }

  function handlePrintPreflight() {
    handlePrintElement(
      preflightRef.current,
      `${vehicle.nickname || "Vehicle"} prep card`
    );
  }

  return (
    <section className="panel messages-panel fleet-maintenance-panel">
      <div className="panel-header">
        <h2>Fleet Maintenance</h2>
        <span>inspection snapshot</span>
      </div>

      <div className="panel-subbar">
        <div className="chip search">{vehicle.nickname}</div>
        <div className="chip">
          {fleetLoading
            ? "Loading fleet"
            : loading
            ? "Loading live summary"
            : vehicle.overall_status === "pass"
            ? "Guest-ready"
            : "Needs review"}
        </div>
      </div>

      <div className="message-list">
        {isFleetPlanningMode ? (
          fleetPlanningLoading ? (
            <div className="fleet-planning-loading detail-card">
              <div className="detail-label">Fleet planning</div>
              <div className="detail-value">Loading fleet planning cards…</div>
            </div>
          ) : fleetPlanningError ? (
            <div className="fleet-planning-error detail-card">
              <div className="detail-label">Fleet planning</div>
              <div className="detail-value">{fleetPlanningError}</div>
            </div>
          ) : fleetPlanningCards.length === 0 ? (
            <div className="fleet-planning-empty detail-card">
              <div className="detail-label">Fleet planning</div>
              <div className="detail-value">
                No open maintenance items across the fleet.
              </div>
            </div>
          ) : (
            <div className="fleet-planning-grid">
              {fleetPlanningCards.map((card) => (
                <article
                  key={card.id}
                  className="fleet-planning-card message fleet-maintenance-card"
                >
                  <div className="message-head">
                    <div>
                      <div className="message-title">
                        {card.nickname} • {card.year} {card.make} {card.model}
                      </div>
                      <div className="message-sub">
                        VIN {card.vin || "Unknown"}
                      </div>
                    </div>

                    <div className="fleet-maintenance-badge fleet-maintenance-badge--attention">
                      {card.blockingCount > 0
                        ? `${card.blockingCount} blocking`
                        : `${card.totalOpenItems} open`}
                    </div>
                  </div>

                  <div className="fleet-maintenance-meta">
                    <div className="fleet-maintenance-meta-item">
                      <span className="fleet-maintenance-meta-label">
                        Next available
                      </span>
                      <span className="fleet-maintenance-meta-value">
                        {card.nextOffTrip || "Available now"}
                      </span>
                    </div>

                    <div className="fleet-maintenance-meta-item">
                      <span className="fleet-maintenance-meta-label">
                        Open items
                      </span>
                      <span className="fleet-maintenance-meta-value">
                        {card.totalOpenItems}
                      </span>
                    </div>
                  </div>

                  <div className="fleet-maintenance-inspections">
                    <div className="fleet-maintenance-section-title">
                      Top items
                    </div>
                    <div className="fleet-maintenance-grid">
                      {Array.isArray(card.topItems) && card.topItems.length ? (
                        card.topItems.map((it) => (
                          <button
                            key={it.id || it.title}
                            type="button"
                            className="fleet-maintenance-grid-item fleet-maintenance-grid-item--attention"
                            onClick={() =>
                              it.linkedRuleCode
                                ? handleOpenFleetInspection(card.vin, it.linkedRuleCode)
                                : window.alert(
                                    "This task is not linked to a specific inspection rule yet."
                                  )
                            }
                          >
                            <div className="fleet-maintenance-grid-head">
                              <span>{it.title}</span>
                            </div>
                            <div className="fleet-maintenance-grid-value">
                              {it.notes || ""}
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="fleet-maintenance-note">
                          No notable items.
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )
        ) : (
          <>
            <article className="message fleet-maintenance-card">
              <div className="message-head">
                <div>
                  <div className="message-title">{title}</div>
                  <div className="message-sub">
                    VIN {vehicle.vin || "Unknown"} • Plate{" "}
                    {vehicle.license_plate || vehicle.plate || "—"}
                  </div>

                  <div className="message-sub">
                    Odometer {formatMiles(vehicle.currentOdometerMiles)} • Next
                    maint due {vehicle.next_service_due?.text || "Unknown"}
                  </div>

                  {vehicle.rockauto_url ? (
                    <div className="message-actions">
                      <a
                        className="message-action"
                        href={vehicle.rockauto_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        RockAuto parts
                      </a>
                    </div>
                  ) : null}
                </div>

                <div
                  className={`fleet-maintenance-badge fleet-maintenance-badge--${vehicle.overall_status}`}
                >
                  {loading
                    ? "Loading…"
                    : vehicle.overall_status === "pass"
                    ? "Guest-ready"
                    : "Needs review"}
                </div>
              </div>

              <div className="fleet-maintenance-meta">
                <div className="fleet-maintenance-meta-item fleet-maintenance-meta-item--registration">
                  <div className="fleet-maintenance-meta-row">
                    <span className="fleet-maintenance-meta-label">
                      Registration
                    </span>

                    {!editingRegistration ? (
                      <button
                        type="button"
                        className="fleet-maintenance-inline-action fleet-maintenance-action-button"
                        onClick={() => setEditingRegistration(true)}
                        disabled={!selectedFleetVehicle?.vin}
                      >
                        Edit
                      </button>
                    ) : null}
                  </div>

                  {!editingRegistration ? (
                    <div className="fleet-maintenance-registration-readonly">
                      <span className="fleet-maintenance-meta-value">
                        {vehicle.registration_expires}
                      </span>
                      <span className="fleet-maintenance-registration-subvalue">
                        {vehicle.license_state || "TX"} •{" "}
                        {vehicle.license_plate || vehicle.plate || "—"}
                      </span>
                    </div>
                  ) : (
                    <div className="fleet-maintenance-registration-editor">
                      <div className="fleet-maintenance-registration-grid">
                        <label>
                          <span>Plate</span>
                          <input
                            value={registrationForm.license_plate}
                            onChange={(e) =>
                              setRegistrationForm((prev) => ({
                                ...prev,
                                license_plate: e.target.value.toUpperCase(),
                              }))
                            }
                            placeholder="ABC1234"
                          />
                        </label>

                        <label>
                          <span>State</span>
                          <input
                            value={registrationForm.license_state}
                            maxLength={2}
                            onChange={(e) =>
                              setRegistrationForm((prev) => ({
                                ...prev,
                                license_state: e.target.value.toUpperCase(),
                              }))
                            }
                            placeholder="TX"
                          />
                        </label>

                        <label>
                          <span>Month</span>
                          <select
                            value={registrationForm.registration_month}
                            onChange={(e) =>
                              setRegistrationForm((prev) => ({
                                ...prev,
                                registration_month: e.target.value,
                              }))
                            }
                          >
                            <option value="">Month</option>
                            {Array.from({ length: 12 }, (_, index) => {
                              const month = index + 1;
                              return (
                                <option key={month} value={month}>
                                  {String(month).padStart(2, "0")}
                                </option>
                              );
                            })}
                          </select>
                        </label>

                        <label>
                          <span>Year</span>
                          <select
                            value={registrationForm.registration_year}
                            onChange={(e) =>
                              setRegistrationForm((prev) => ({
                                ...prev,
                                registration_year: e.target.value,
                              }))
                            }
                          >
                            <option value="">Year</option>
                            {Array.from({ length: 7 }, (_, index) => {
                              const year = new Date().getFullYear() - 1 + index;
                              return (
                                <option key={year} value={year}>
                                  {year}
                                </option>
                              );
                            })}
                          </select>
                        </label>
                      </div>

                      {registrationError ? (
                        <div className="fleet-maintenance-note fleet-maintenance-note--error">
                          {registrationError}
                        </div>
                      ) : null}

                      <div className="fleet-maintenance-registration-actions">
                        <button
                          type="button"
                          className="fleet-maintenance-action-button"
                          onClick={handleCancelRegistrationEdit}
                          disabled={savingRegistration}
                        >
                          Cancel
                        </button>

                        <button
                          type="button"
                          className="fleet-maintenance-action-button fleet-maintenance-action-button--primary"
                          onClick={handleSaveRegistration}
                          disabled={savingRegistration}
                        >
                          {savingRegistration ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="fleet-maintenance-meta-item">
                  <span className="fleet-maintenance-meta-label">
                    Recall status
                  </span>
                  <span className="fleet-maintenance-meta-value">
                    ✅ No Open Recalls
                  </span>
                </div>

                <div className="fleet-maintenance-meta-item">
                  <span className="fleet-maintenance-meta-label">
                    Body condition
                  </span>
                  <span className="fleet-maintenance-meta-value">
                    {vehicle.body_condition}
                  </span>
                </div>

                <div
                  className={`fleet-maintenance-meta-item fleet-maintenance-telematics fleet-maintenance-telematics--${
                    vehicle.telematics?.tone || "unknown"
                  }`}
                >
                  <span className="fleet-maintenance-meta-label">
                    Telematics
                  </span>
                  <span className="fleet-maintenance-meta-value">
                    {vehicle.telematics?.sourceLabel || "No telematics source"}
                  </span>
                  <span className="fleet-maintenance-registration-subvalue">
                    Last call-in:{" "}
                    {vehicle.telematics?.lastCallLabel || "No call-in recorded"}
                  </span>
                </div>

                <div
                  className={`fleet-maintenance-meta-item fleet-maintenance-telematics fleet-maintenance-telematics--${
                    vehicle.engine_temperature?.tone || "unknown"
                  }`}
                >
                  <span className="fleet-maintenance-meta-label">
                    Engine temp
                  </span>
                  <span className="fleet-maintenance-meta-value">
                    {vehicle.engine_temperature?.latestText || "No reading"}
                  </span>
                  <span className="fleet-maintenance-registration-subvalue">
                    {vehicle.engine_temperature?.detail ||
                      "No DIMO engine temp history"}
                  </span>
                </div>

                <div
                  className={`fleet-maintenance-meta-item fleet-maintenance-telematics fleet-maintenance-telematics--${
                    vehicle.engine_rpm?.tone || "unknown"
                  }`}
                >
                  <span className="fleet-maintenance-meta-label">
                    Tachometer
                  </span>
                  <span className="fleet-maintenance-meta-value">
                    {vehicle.engine_rpm?.latestText || "No reading"}
                  </span>
                  <span className="fleet-maintenance-registration-subvalue">
                    {vehicle.engine_rpm?.detail || "No DIMO tachometer history"}
                  </span>
                </div>
              </div>

              <div className="fleet-maintenance-inspections">
                <div className="fleet-maintenance-meta-row">
                  <div className="fleet-maintenance-section-title">
                    Current inspection status
                  </div>

                  {!isFleetPlanningMode ? (
                    <button
                      type="button"
                      className="fleet-maintenance-inline-action fleet-maintenance-action-button"
                      onClick={() => {
                        if (addingCustomRule) {
                          resetCustomRuleForm();
                        }
                        setAddingCustomRule((current) => !current);
                      }}
                      disabled={!selectedFleetVehicle?.vin || savingCustomRule}
                    >
                      {addingCustomRule ? "Cancel" : "Add item"}
                    </button>
                  ) : null}
                </div>

                {addingCustomRule && !isFleetPlanningMode ? (
                  <div className="fleet-maintenance-registration-editor">
                    <div className="fleet-maintenance-registration-grid">
                      <label>
                        <span>Item</span>
                        <input
                          value={customRuleForm.title}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              title: e.target.value,
                            }))
                          }
                          placeholder="Automatic transmission flush"
                          disabled={savingCustomRule}
                        />
                      </label>

                      <label>
                        <span>Category</span>
                        <select
                          value={customRuleForm.category}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              category: e.target.value,
                            }))
                          }
                          disabled={savingCustomRule}
                        >
                          <option value="service">Service</option>
                          <option value="safety">Safety</option>
                          <option value="inspection">Inspection</option>
                          <option value="compliance">Compliance</option>
                          <option value="other">Other</option>
                        </select>
                      </label>

                      <label>
                        <span>Miles</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={customRuleForm.intervalMiles}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              intervalMiles: e.target.value,
                            }))
                          }
                          placeholder="60000"
                          disabled={savingCustomRule}
                        />
                      </label>

                      <label>
                        <span>Days</span>
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={customRuleForm.intervalDays}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              intervalDays: e.target.value,
                            }))
                          }
                          placeholder="Optional"
                          disabled={savingCustomRule}
                        />
                      </label>

                      <label>
                        <span>Due soon mi</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={customRuleForm.dueSoonMiles}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              dueSoonMiles: e.target.value,
                            }))
                          }
                          disabled={savingCustomRule}
                        />
                      </label>

                      <label>
                        <span>Due soon days</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={customRuleForm.dueSoonDays}
                          onChange={(e) =>
                            setCustomRuleForm((prev) => ({
                              ...prev,
                              dueSoonDays: e.target.value,
                            }))
                          }
                          disabled={savingCustomRule}
                        />
                      </label>
                    </div>

                    <div className="fleet-maintenance-registration-actions">
                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() =>
                          setCustomRuleForm((prev) => ({
                            ...prev,
                            blocksRentalWhenOverdue:
                              !prev.blocksRentalWhenOverdue,
                          }))
                        }
                        disabled={savingCustomRule}
                      >
                        {customRuleForm.blocksRentalWhenOverdue
                          ? "Blocks rental"
                          : "Does not block rental"}
                      </button>

                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() =>
                          setCustomRuleForm((prev) => ({
                            ...prev,
                            blocksGuestExportWhenOverdue:
                              !prev.blocksGuestExportWhenOverdue,
                          }))
                        }
                        disabled={savingCustomRule}
                      >
                        {customRuleForm.blocksGuestExportWhenOverdue
                          ? "Blocks guest export"
                          : "Does not block guest export"}
                      </button>

                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() =>
                          setCustomRuleForm((prev) => ({
                            ...prev,
                            requiresPassResult: !prev.requiresPassResult,
                          }))
                        }
                        disabled={savingCustomRule}
                      >
                        {customRuleForm.requiresPassResult
                          ? "Pass result required"
                          : "Any result allowed"}
                      </button>

                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() =>
                          setCustomRuleForm((prev) => ({
                            ...prev,
                            saveAsTemplate: !prev.saveAsTemplate,
                          }))
                        }
                        disabled={savingCustomRule}
                      >
                        {customRuleForm.saveAsTemplate
                          ? "Fleet template"
                          : "This vehicle only"}
                      </button>
                    </div>

                    <div className="fleet-maintenance-note">
                      Fleet templates:{" "}
                      {templateLoadError
                        ? templateLoadError
                        : maintenanceTemplates.length
                        ? maintenanceTemplates
                            .slice(0, 8)
                            .map((template) => template.title || template.ruleCode)
                            .join(", ")
                        : "No templates found."}
                      {maintenanceTemplates.length > 8
                        ? `, +${maintenanceTemplates.length - 8} more`
                        : ""}
                    </div>

                    {customRuleError ? (
                      <div className="fleet-maintenance-note fleet-maintenance-note--error">
                        {customRuleError}
                      </div>
                    ) : null}

                    <div className="fleet-maintenance-registration-actions">
                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() => {
                          resetCustomRuleForm();
                          setAddingCustomRule(false);
                        }}
                        disabled={savingCustomRule}
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        className="fleet-maintenance-action-button fleet-maintenance-action-button--primary"
                        onClick={handleSaveCustomRule}
                        disabled={savingCustomRule}
                      >
                        {savingCustomRule
                          ? "Adding..."
                          : customRuleForm.saveAsTemplate
                          ? "Add fleet template"
                          : "Add maintenance item"}
                      </button>
                    </div>
                  </div>
                ) : null}

                {[
                  ["Safety", groupedInspectionItems.safety],
                  ["Service", groupedInspectionItems.service],
                  [
                    "Major / General Repairs",
                    [
                      ...groupedInspectionItems.major,
                      ...groupedInspectionItems.other,
                    ],
                  ],
                ].map(([sectionTitle, items]) => (
                  <div key={sectionTitle} className="fleet-maintenance-group">
                    <div className="fleet-maintenance-subtitle">
                      {sectionTitle}
                    </div>

                    <div className="fleet-maintenance-grid">
                      {items.length ? (
                        items.map((item) => (
                          <button
                            key={item.ruleId || item.label}
                            type="button"
                            className={`fleet-maintenance-grid-item fleet-maintenance-grid-item--${item.status}`}
                            onClick={() => handleOpenInspectionItem(item)}
                          >
                            <div className="fleet-maintenance-grid-head">
                              <span>{item.label}</span>
                              <span>{getStatusIcon(item.status)}</span>
                            </div>

                            <div className="fleet-maintenance-grid-value">
                              {item.value}
                            </div>

                            {item.ruleCode === "oil_change" ? (
                              <div className={getRuleCountdownClass(item, vehicle.currentOdometerMiles)}>
                                {formatRuleCountdown(item, vehicle.currentOdometerMiles) || "Countdown unavailable"}
                              </div>
                            ) : null}

                            <div className="fleet-maintenance-grid-status">
                              {getStatusLabel(item.status)}
                            </div>
                          </button>
                        ))
                      ) : (
                        <div className="fleet-maintenance-note">
                          No items in this section.
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="fleet-maintenance-condition">
                <div className="fleet-maintenance-section-title">
                  Known cosmetic condition
                </div>

                {!editingBodyNotes ? (
                  <>
                    <ul className="fleet-maintenance-list">
                      {vehicle.body_notes.map((note, index) => {
                        const text =
                          typeof note === "string"
                            ? note
                            : String(note?.description || note?.title || "").trim();

                        return <li key={`${index}-${text}`}>{text}</li>;
                      })}
                    </ul>

                    <div className="fleet-maintenance-note">
                      These items are documented and not the responsibility of
                      the current guest.
                    </div>

                    <div className="fleet-maintenance-registration-actions">
                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() => setEditingBodyNotes(true)}
                        disabled={!selectedFleetVehicle?.vin}
                      >
                        Edit notes
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="fleet-maintenance-notes-editor">
                    <label className="fleet-maintenance-notes-field">
                      <span className="fleet-maintenance-notes-label">
                        One note per line
                      </span>
                      <textarea
                        className="fleet-maintenance-notes-textarea"
                        rows={6}
                        value={bodyNotesText}
                        onChange={(e) => setBodyNotesText(e.target.value)}
                        placeholder={
                          "Small scuff on rear bumper\nRock chip on hood\nScratch on right rear door"
                        }
                      />
                    </label>

                    {bodyNotesError ? (
                      <div className="fleet-maintenance-note fleet-maintenance-note--error">
                        {bodyNotesError}
                      </div>
                    ) : null}

                    <div className="fleet-maintenance-registration-actions">
                      <button
                        type="button"
                        className="fleet-maintenance-action-button"
                        onClick={() => {
                          setBodyNotesText(
                            Array.isArray(vehicle.body_notes)
                              ? vehicle.body_notes.join("\n")
                              : ""
                          );
                          setEditingBodyNotes(false);
                          setBodyNotesError("");
                        }}
                        disabled={savingBodyNotes}
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        className="fleet-maintenance-action-button fleet-maintenance-action-button--primary"
                        onClick={handleSaveBodyNotes}
                        disabled={savingBodyNotes}
                      >
                        {savingBodyNotes ? "Saving…" : "Save notes"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {!isFleetPlanningMode ? (
                <div className="message-actions fleet-maintenance-actions">
                  <button
                    type="button"
                    className="message-action"
                    onClick={handleExportPng}
                    disabled={exporting}
                  >
                    {exporting ? "Exporting…" : "Export inspection report"}
                  </button>

                  <button
                    type="button"
                    className="message-action"
                    onClick={handlePrintInspectionReport}
                    disabled={exporting}
                  >
                    Print inspection report
                  </button>

                  <button
                    type="button"
                    className="message-action"
                    onClick={handleExportPreflight}
                    disabled={exporting}
                  >
                    Export prep card
                  </button>

                  <button
                    type="button"
                    className="message-action"
                    onClick={handlePrintPreflight}
                    disabled={exporting}
                  >
                    Print prep card
                  </button>
                </div>
              ) : null}
            </article>

            {!isFleetPlanningMode ? (
              <div className="fleet-export-preview">
                <div className="fleet-maintenance-section-title">
                  Guest snapshot preview
                </div>
                <GuestSafetySnapshotCard vehicle={vehicle} cardRef={cardRef} />
              </div>
            ) : null}

            <div className="fleet-export-hidden">
              <PreflightCard
                vehicle={vehicle}
                windowLabel={preflightData.windowLabel}
                dueItems={preflightData.dueItems}
                cardRef={preflightRef}
              />
            </div>
          </>
        )}
      </div>

      <InspectionItemDrawer
        open={inspectionDrawerOpen}
        item={selectedInspectionItem}
        vehicle={inspectionVehicle}
        onClose={handleCloseInspectionDrawer}
        onSave={handleSaveInspectionItem}
        onDeleteHistoryEntry={handleDeleteMaintenanceEntry}
        saving={savingInspection}
      />
    </section>
  );
}
