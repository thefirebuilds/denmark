// ------------------------------------------------------------
// /src/utils/maintUtils.js
// Shared helpers for maintenance + fleet vehicle normalization
// ------------------------------------------------------------

export function formatMiles(value) {
  if (value == null || value === "") return "Unknown";
  const n = Number(value);
  if (Number.isNaN(n)) return "Unknown";
  return `${n.toLocaleString()} mi`;
}

export function formatDateShort(value) {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";

  return d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

export function formatShortDate(value) {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";

  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function parseDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getNow() {
  return new Date();
}

export function formatChicagoDateTime(value) {
  const date = parseDateTime(value);
  if (!date) return "Unknown";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function normalizeVehicleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export function findFleetVehicleBySelectedId(fleetVehicles, selectedVehicleId) {
  if (!Array.isArray(fleetVehicles) || !fleetVehicles.length) return null;

  const selectedKey = normalizeVehicleKey(selectedVehicleId);

  return (
    fleetVehicles.find((vehicle) => {
      const nicknameKey = normalizeVehicleKey(vehicle.nickname);
      const vinKey = normalizeVehicleKey(vehicle.vin);
      const explicitIdKey = vehicle.id ? normalizeVehicleKey(vehicle.id) : "";
      const dimoTokenKey = normalizeVehicleKey(vehicle.dimo_token_id);
      const dimoExternalKey = normalizeVehicleKey(vehicle.external_vehicle_key);
      const providerVehicleKey = normalizeVehicleKey(vehicle.provider_vehicle_id);
      const bouncieVehicleKey = normalizeVehicleKey(vehicle.bouncie_vehicle_id);
      const turoVehicleKey = normalizeVehicleKey(vehicle.turo_vehicle_id);

      return (
        selectedKey === nicknameKey ||
        selectedKey === vinKey ||
        (explicitIdKey && selectedKey === explicitIdKey) ||
        (dimoTokenKey && selectedKey === dimoTokenKey) ||
        (dimoExternalKey && selectedKey === dimoExternalKey) ||
        (providerVehicleKey && selectedKey === providerVehicleKey) ||
        (bouncieVehicleKey && selectedKey === bouncieVehicleKey) ||
        (turoVehicleKey && selectedKey === turoVehicleKey)
      );
    }) || null
  );
}

export function getVinLast6(vin) {
  if (!vin) return "Unknown";
  const clean = String(vin).trim();
  return clean.length <= 6 ? clean : clean.slice(-6);
}

export function getFleetLicensePlate(vehicle) {
  return (
    vehicle?.license_plate ||
    vehicle?.licensePlate ||
    vehicle?.plate ||
    ""
  );
}

export function getFleetLicenseState(vehicle) {
  return (
    vehicle?.license_state ||
    vehicle?.registration?.state ||
    vehicle?.licenseState ||
    "TX"
  );
}

export function getFleetRegistrationMonth(vehicle) {
  return (
    vehicle?.registration_month ??
    vehicle?.registration?.month ??
    vehicle?.registrationMonth ??
    ""
  );
}

export function getFleetRegistrationYear(vehicle) {
  return (
    vehicle?.registration_year ??
    vehicle?.registration?.year ??
    vehicle?.registrationYear ??
    ""
  );
}

export function formatRegistration(month, year) {
  if (!month || !year) return "—";
  return `${String(month).padStart(2, "0")}/${year}`;
}

export function buildExportFileName(vehicle, suffix = "") {
  const name = vehicle?.nickname || "vehicle";
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const [month, day, year] = today.split("/");
  const formattedDate = `${year}-${month}-${day}`;
  const base = `${name} - ${formattedDate}`;

  return suffix ? `${base} - ${suffix}.png` : `${base}.png`;
}

export function parseDotCode(dotCode) {
  const raw = String(dotCode || "").trim();
  if (!/^\d{4}$/.test(raw)) return null;

  const week = Number(raw.slice(0, 2));
  const yearTwoDigit = Number(raw.slice(2, 4));
  const fullYear = 2000 + yearTwoDigit;

  if (week < 1 || week > 53) return null;

  const jan1 = new Date(fullYear, 0, 1);
  const manufacturedAt = new Date(
    jan1.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000
  );

  return {
    week,
    year: fullYear,
    manufacturedAt,
  };
}

export function formatDotCodeForGuest(dotCode) {
  const parsed = parseDotCode(dotCode);
  if (!parsed) return `DOT ${dotCode}`;

  const now = new Date();
  const monthsOld =
    (now.getFullYear() - parsed.manufacturedAt.getFullYear()) * 12 +
    (now.getMonth() - parsed.manufacturedAt.getMonth());

  const years = Math.floor(Math.max(monthsOld, 0) / 12);
  const months = Math.max(monthsOld, 0) % 12;

  const madeLabel = parsed.manufacturedAt.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });

  const ageLabel =
    years > 0 ? `${years} yr ${months} mo old` : `${months} mo old`;

  return `${madeLabel} • ${ageLabel}`;
}

export function isRuleActionableForQueue(rule, now = new Date()) {
  const status = String(rule?.status || "").toLowerCase();

  if (status === "failed" || status === "overdue") return true;

  if (status === "due") {
    if (!rule?.nextDueDate) return false;
    const dueDate = new Date(rule.nextDueDate);
    if (Number.isNaN(dueDate.getTime())) return false;
    return dueDate <= now;
  }

  return false;
}

export function getActionableQueueRules(rules = [], now = new Date()) {
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule) => isRuleActionableForQueue(rule, now));
}

export function getNextIntervalDueText(item) {
  const nextDueMiles =
    item?.lastEvent?.nextDueMiles != null
      ? Number(item.lastEvent.nextDueMiles)
      : item?.nextDueMiles != null
      ? Number(item.nextDueMiles)
      : null;
  const nextDueDate = item?.lastEvent?.nextDueDate || item?.nextDueDate || null;
  const parts = [];

  if (Number.isFinite(nextDueMiles)) {
    parts.push(`${Math.round(nextDueMiles).toLocaleString()} mi`);
  }

  if (nextDueDate) {
    const date = new Date(nextDueDate);
    parts.push(Number.isNaN(date.getTime()) ? nextDueDate : formatDateShort(date));
  }

  return parts.length
    ? `Next interval due: ${parts.join(" / ")}`
    : "Next interval due: No interval scheduled";
}

export function buildInspectionHistoryMap(summary) {
  const map = {};
  const history = summary?.ruleHistory || {};

  Object.entries(history).forEach(([ruleCode, entries]) => {
    map[ruleCode] = Array.isArray(entries) ? entries : [];
  });

  return map;
}

export function mapRuleStatusToInspectionItem(rule, historyMap = {}) {
  const status = String(rule?.status || "").toLowerCase();

  let itemStatus = "attention";
  if (status === "ok") itemStatus = "pass";
  else if (status === "overdue" || status === "failed") itemStatus = "fail";
  else if (status === "due" || status === "unknown") itemStatus = "attention";

  let value = "No recorded result";

  if (rule?.ruleCode === "tire_age_review" && rule?.tireAge?.dotCode) {
    const rawDot =
      rule?.lastEvent?.data?.dot_code ||
      rule?.lastEvent?.data?.dotCode ||
      rule?.tireAge?.dotCode;
    value = `Manufactured ${formatDotCodeForGuest(rawDot)}`;
  } else if (
    rule?.ruleCode === "tread_depth" &&
    rule?.lastEvent?.data?.lowest_tread_32nds != null
  ) {
    value = `${rule.lastEvent.data.lowest_tread_32nds}/32" lowest`;
  } else if (rule?.lastEvent?.performedAt) {
    const performedDate = new Date(rule.lastEvent.performedAt);
    const formattedDate = Number.isNaN(performedDate.getTime())
      ? rule.lastEvent.performedAt
      : performedDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });

    const odometerText =
      rule?.lastEvent?.odometerMiles != null
        ? `${Number(rule.lastEvent.odometerMiles).toLocaleString()} mi`
        : null;

    value = [odometerText, formattedDate].filter(Boolean).join(" • ");
  } else if (rule?.nextDueMiles != null) {
    value = `Next due at ${Number(rule.nextDueMiles).toLocaleString()} mi`;
  } else if (rule?.nextDueDate) {
    const nextDue = new Date(rule.nextDueDate);
    value = Number.isNaN(nextDue.getTime())
      ? rule.nextDueDate
      : `Due ${nextDue.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`;
  } else if (rule?.ruleCode === "windshield_condition") {
    const chipCount = rule?.lastEvent?.data?.chip_count;
    const crackLength = rule?.lastEvent?.data?.crack_length_in;
    const repairNeeded = rule?.lastEvent?.data?.repair_needed;

    const bits = [];
    if (repairNeeded === true) bits.push("Repair needed");
    if (chipCount != null) bits.push(`${chipCount} chip${Number(chipCount) === 1 ? "" : "s"}`);
    if (crackLength != null) bits.push(`${crackLength}" crack`);
    value = bits.length ? bits.join(" • ") : "No recorded result";
  } else if (rule?.ruleCode === "brake_inspection") {
    const frontPadMm = rule?.lastEvent?.data?.front_pad_mm;
    const rearPadMm = rule?.lastEvent?.data?.rear_pad_mm;
    const rotorCondition = rule?.lastEvent?.data?.rotor_condition;

    const bits = [];
    if (frontPadMm != null) bits.push(`Front ${frontPadMm} mm`);
    if (rearPadMm != null) bits.push(`Rear ${rearPadMm} mm`);
    if (rotorCondition) bits.push(`Rotors: ${rotorCondition}`);
    value = bits.length ? bits.join(" • ") : "No recorded result";
  } else if (rule?.ruleCode === "bearing_tie_rod_check") {
    const data = rule?.lastEvent?.data || {};
    const bits = [];
    if (data.wheel_bearings_ok === true) bits.push("Wheel bearings OK");
    if (data.tie_rods_ok === true) bits.push("Tie rods OK");
    if (data.ball_joints_ok === true) bits.push("Ball joints OK");
    if (data.steering_play_ok === true) bits.push("No steering play");
    value = bits.length ? bits.join(" - ") : "No recorded result";
  }

  return {
  ruleId: rule?.ruleId || null,
  ruleCode: rule?.ruleCode || null,
  label: rule?.title || "Unknown item",
  category: rule?.category || "other",
  value,
  status: itemStatus,
  lastEvent: rule?.lastEvent || null,
  nextDueMiles: rule?.nextDueMiles ?? null,
  nextDueDate: rule?.nextDueDate ?? null,
  history: historyMap[rule?.ruleCode] || [],
  requiresPassResult: Boolean(rule?.requiresPassResult),
  blocksRentalWhenOverdue: Boolean(rule?.blocksRentalWhenOverdue),
  blocksGuestExportWhenOverdue: Boolean(rule?.blocksGuestExportWhenOverdue),
};
}

function normalizeTaskType(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRuleCode(value) {
  return String(value || "").trim().toLowerCase();
}

export function getTaskLinkedRuleCodes(task) {
  const rawType = String(task?.task_type || "").toLowerCase();
  const title = String(task?.title || "").toLowerCase();
  const type = rawType.replace(/[^a-z]/g, "");

  const triggerRuleCode = String(task?.trigger_context?.ruleCode || "")
    .trim()
    .toLowerCase();

  if (triggerRuleCode) {
    return [triggerRuleCode];
  }

  if (type.includes("oillevel")) {
    return ["fluid_leak_check", "leak_check"];
  }

  if (type.includes("conditionreview")) {
    return ["cleaning"];
  }

  if (type.includes("tirepressure") || title.includes("tire pressure")) {
    return ["tire_pressure_inspection", "tire_pressure_check"];
  }

  if (type.includes("leak") || title.includes("leak check")) {
    return ["fluid_leak_check", "leak_check"];
  }

  if (
    type.includes("wiper") ||
    title.includes("wiper") ||
    title.includes("windshield wiper")
  ) {
    return ["wiper_replacement"];
  }

  return [];
}

function getRuleStatus(summary, ruleCode) {
  const normalized = normalizeRuleCode(ruleCode);
  if (!normalized) return null;

  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  return (
    rules.find((rule) => normalizeRuleCode(rule?.ruleCode) === normalized) || null
  );
}

export function getPrimaryLinkedRuleCode(task) {
  return getTaskLinkedRuleCodes(task)[0] || null;
}

function getLatestRuleEvent(summary, ruleCode) {
  const normalized = normalizeRuleCode(ruleCode);
  if (!normalized) return null;

  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  const matchingRule = rules.find(
    (rule) => normalizeRuleCode(rule?.ruleCode) === normalized
  );

  return matchingRule?.lastEvent || null;
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function isEventRecentEnoughForTask(event, summary) {
  if (!event) return false;

  const performedAtRaw =
    event?.performedAt ||
    event?.performed_at ||
    event?.recorded_at ||
    event?.created_at;

  const performedAt = performedAtRaw ? new Date(performedAtRaw) : null;
  if (!performedAt || Number.isNaN(performedAt.getTime())) return false;

  if (isSameCalendarDay(performedAt, new Date())) return true;

  const currentOdometer =
    summary?.currentOdometerMiles != null
      ? Number(summary.currentOdometerMiles)
      : null;

  const eventOdometer =
    event?.odometerMiles != null
      ? Number(event.odometerMiles)
      : event?.odometer_miles != null
      ? Number(event.odometer_miles)
      : null;

  if (
    Number.isFinite(currentOdometer) &&
    Number.isFinite(eventOdometer) &&
    Math.abs(currentOdometer - eventOdometer) <= 5
  ) {
    return true;
  }

  return false;
}

export function isTaskSatisfiedByRule(task, summary) {
  const ruleCodes = getTaskLinkedRuleCodes(task);
  if (!ruleCodes.length) return false;

  const taskType = String(task?.task_type || "").toLowerCase();
  const createdAtRaw = task?.created_at || task?.updated_at || null;
  const taskCreatedAt = createdAtRaw ? new Date(createdAtRaw) : null;

  return ruleCodes.some((ruleCode) => {
    const rule = getRuleStatus(summary, ruleCode);
    if (!rule) return false;

    const ruleStatus = String(rule?.status || "").toLowerCase();

    // For projection / due-risk tasks, if the rule is currently OK, the task is satisfied.
    if (
      taskType === "trip_projection_maintenance_risk" ||
      taskType.includes("projection") ||
      taskType.includes("maintenance_risk")
    ) {
      return ruleStatus === "ok";
    }

    const event = rule?.lastEvent || null;
    if (!event) return false;

    // If the task was created before the latest event, the event satisfied the task.
    if (taskCreatedAt) {
      const eventPerformedAtRaw =
        event?.performedAt ||
        event?.performed_at ||
        event?.recorded_at ||
        event?.created_at;

      const eventPerformedAt = eventPerformedAtRaw
        ? new Date(eventPerformedAtRaw)
        : null;

      if (
        eventPerformedAt &&
        !Number.isNaN(eventPerformedAt.getTime()) &&
        eventPerformedAt >= taskCreatedAt
      ) {
        return true;
      }
    }

    return isEventRecentEnoughForTask(event, summary);
  });
}

export function getPriorityScore(priority) {
  if (priority === "urgent") return 5;
  if (priority === "high") return 4;
  if (priority === "medium") return 3;
  if (priority === "low") return 2;
  return 1;
}

export function buildQueueItemsFromSummary(summary, historyMap = {}) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  const actionableRules = getActionableQueueRules(summary?.ruleStatuses);

  const taskItems = tasks
    .filter((task) => String(task?.status || "").toLowerCase() === "open")
    .filter((task) => !isTaskSatisfiedByRule(task, summary))
    .map((task) => {
      const linkedRuleCodes = getTaskLinkedRuleCodes(task);
      const linkedRuleCode = getPrimaryLinkedRuleCode(task);
      const linkedRule = rules.find((rule) =>
        linkedRuleCodes.includes(normalizeRuleCode(rule?.ruleCode))
      );

      return {
        id: `task-${task.id}`,
        title: task.title || task.task_type || "Open maintenance item",
        type: task.task_type || "maintenance",
        priority: task.priority || "medium",
        notes: task.description || "",
        source: "task",
        task,
        linkedRuleCode,
        linkedRuleCodes,
        nextDueMiles: linkedRule?.nextDueMiles ?? null,
        nextDueDate: linkedRule?.nextDueDate ?? null,
        nextDueText: getNextIntervalDueText(linkedRule),
        blocksRentalWhenOverdue: Boolean(task?.blocks_rental),
        blocksGuestExportWhenOverdue: Boolean(task?.blocks_guest_export),
      };
    });

  const ruleItems = actionableRules.map((rule) => ({
    id: `rule-${rule.ruleId || rule.ruleCode}`,
    title: rule.title || rule.ruleCode || "Inspection item",
    type: "inspection rule",
    priority:
      rule.blocksRentalWhenOverdue || rule.blocksGuestExportWhenOverdue
        ? "high"
        : "medium",
    notes:
      String(rule.status || "").toLowerCase() === "failed"
        ? "Inspection result failed and needs attention."
        : "Inspection item is due now or overdue.",
    source: "rule",
    linkedRuleCode: rule.ruleCode,
    linkedRuleCodes: [rule.ruleCode].filter(Boolean),
    nextDueMiles: rule.nextDueMiles ?? null,
    nextDueDate: rule.nextDueDate ?? null,
    nextDueText: getNextIntervalDueText(rule),
    history: historyMap[rule.ruleCode] || [],
    blocksRentalWhenOverdue: Boolean(rule.blocksRentalWhenOverdue),
    blocksGuestExportWhenOverdue: Boolean(rule.blocksGuestExportWhenOverdue),
  }));

  const merged = [...taskItems, ...ruleItems];
  const seen = new Set();

  return merged.filter((item) => {
    const key = `${item.title}::${item.linkedRuleCode || ""}::${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sortQueue(items) {
  return [...items].sort(
    (a, b) => getPriorityScore(b.priority) - getPriorityScore(a.priority)
  );
}

function normalizePrepDueTitle(rawTitle, rawType, reason = "") {
  const type = String(rawType || "").toLowerCase();
  const title = String(rawTitle || "").toLowerCase();

  let label = String(rawTitle || rawType || "Open maintenance item").trim();

  if (type.includes("oil_change") || title.includes("oil change")) {
    label = "Oil change";
  } else if (
    type.includes("wiper") ||
    title.includes("wiper") ||
    title.includes("windshield wiper")
  ) {
    label = "Change wipers";
  } else if (type.includes("air_filter") || title.includes("air filter")) {
    label = title.includes("cabin") ? "Cabin air filter" : "Engine air filter";
  } else if (title.includes("tire rotation")) {
    label = "Tire rotation";
  } else if (title.includes("transmission")) {
    label = "Transmission service";
  } else if (title.includes("battery")) {
    label = "Battery test";
  } else if (title.includes("brake")) {
    label = "Brake inspection";
  } else if (title.includes("tread")) {
    label = "Tread depth inspection";
  } else if (title.includes("tire pressure")) {
    label = "Set tire pressures";
  } else if (title.includes("clean")) {
    label = "Clean vehicle";
  } else if (title.includes("registration")) {
    label = "Verify registration";
  } else if (title.includes("leak")) {
    label = "Leak check";
  }

  return reason ? `${label} - ${reason}` : label;
}

function getPrepRuleReason(rule, cutoff = new Date()) {
  const status = String(rule?.status || "").toLowerCase();
  const currentOdometer = Number(rule?.currentOdometerMiles);

  if (!rule?.lastEvent) return "never recorded";
  if (status === "failed") return "failed";
  if (status === "overdue") return "overdue";

  const nextDueMiles =
    rule?.nextDueMiles != null ? Number(rule.nextDueMiles) : null;
  if (
    Number.isFinite(currentOdometer) &&
    Number.isFinite(nextDueMiles) &&
    nextDueMiles <= currentOdometer
  ) {
    return "due now";
  }

  if (rule?.nextDueDate) {
    const nextDue = new Date(rule.nextDueDate);
    if (!Number.isNaN(nextDue.getTime()) && nextDue <= cutoff) {
      return nextDue <= new Date() ? "due now" : "due before trip";
    }
  }

  if (status === "due") return "due now";
  if (status === "unknown") return "never recorded";

  return "";
}

export function buildPreflightDueItems(summary, options = {}) {
  const cutoff = options.cutoff ? new Date(options.cutoff) : new Date();
  const safeCutoff = Number.isNaN(cutoff.getTime()) ? new Date() : cutoff;
  const currentOdometer = Number(summary?.currentOdometerMiles);
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];

  const ruleItems = rules
    .map((rule) => ({
      ...rule,
      currentOdometerMiles: Number.isFinite(currentOdometer)
        ? currentOdometer
        : null,
    }))
    .map((rule) => {
      const reason = getPrepRuleReason(rule, safeCutoff);
      if (!reason) return null;

      return {
        id: `rule-${rule.ruleCode || rule.ruleId || rule.title}`,
        title: normalizePrepDueTitle(rule.title, rule.ruleCode, reason),
        source: "rule",
        blocks:
          Boolean(rule.blocksRentalWhenOverdue) ||
          Boolean(rule.blocksGuestExportWhenOverdue),
        priority:
          reason === "failed" || reason === "overdue"
            ? 4
            : reason === "due now"
            ? 3
            : reason === "never recorded"
            ? 2
            : 1,
      };
    })
    .filter(Boolean);

  const taskItems = tasks
    .filter((task) => String(task?.status || "").toLowerCase() === "open")
    .filter((task) => !isTaskSatisfiedByRule(task, summary))
    .map((task) => ({
      id: `task-${task.id}`,
      title: normalizePrepDueTitle(task.title, task.task_type),
      source: "task",
      blocks: Boolean(task.blocks_rental) || Boolean(task.blocks_guest_export),
      priority:
        task.priority === "urgent"
          ? 5
          : task.priority === "high"
          ? 4
          : task.priority === "medium"
          ? 3
          : 2,
    }));

  const dedupedMap = new Map();

  for (const item of [...ruleItems, ...taskItems]) {
    const key = item.title
      .replace(/\s+-\s+(never recorded|due now|due before trip|overdue|failed)$/i, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const existing = dedupedMap.get(key);

    if (!existing) {
      dedupedMap.set(key, item);
      continue;
    }

    const existingScore =
      (existing.blocks ? 100 : 0) + (existing.priority || 0);
    const itemScore = (item.blocks ? 100 : 0) + (item.priority || 0);

    if (itemScore > existingScore) {
      dedupedMap.set(key, item);
    }
  }

  return Array.from(dedupedMap.values())
    .sort((a, b) => {
      const aScore = (a.blocks ? 100 : 0) + (a.priority || 0);
      const bScore = (b.blocks ? 100 : 0) + (b.priority || 0);
      return bScore - aScore || a.title.localeCompare(b.title);
    })
    .map(({ id, title }) => ({ id, title }));
}

function getOdometerHistoryPoints(summary) {
  const points = [];
  const history = summary?.ruleHistory || {};

  Object.values(history).forEach((entries) => {
    if (!Array.isArray(entries)) return;

    entries.forEach((entry) => {
      const odometer = Number(
        entry?.odometerMiles ??
          entry?.odometer_miles ??
          entry?.data?.odometerMiles ??
          entry?.data?.odometer_miles
      );

      const performedAtRaw =
        entry?.performedAt ||
        entry?.performed_at ||
        entry?.recorded_at ||
        entry?.created_at;

      const performedAt = performedAtRaw ? new Date(performedAtRaw) : null;

      if (
        Number.isFinite(odometer) &&
        performedAt instanceof Date &&
        !Number.isNaN(performedAt.getTime())
      ) {
        points.push({
          odometerMiles: odometer,
          performedAt,
        });
      }
    });
  });

  points.sort((a, b) => a.performedAt.getTime() - b.performedAt.getTime());

  const deduped = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (
      prev &&
      prev.odometerMiles === point.odometerMiles &&
      prev.performedAt.getTime() === point.performedAt.getTime()
    ) {
      continue;
    }
    deduped.push(point);
  }

  return deduped;
}

function estimateDailyMilesFromSummary(summary) {
  const points = getOdometerHistoryPoints(summary);
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];

  const milesDelta = last.odometerMiles - first.odometerMiles;
  const daysDelta =
    (last.performedAt.getTime() - first.performedAt.getTime()) /
    (1000 * 60 * 60 * 24);

  if (milesDelta <= 0 || daysDelta <= 0) return null;
  return milesDelta / daysDelta;
}

export function getNextServiceDue(summary, options = {}) {
  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  const currentOdometer = Number(summary?.currentOdometerMiles);
  const ruleCodes = Array.isArray(options.ruleCodes)
    ? new Set(options.ruleCodes.map((code) => normalizeRuleCode(code)).filter(Boolean))
    : null;

  const candidates = rules
    .filter((rule) => {
      if (!ruleCodes || ruleCodes.size === 0) return true;
      return ruleCodes.has(normalizeRuleCode(rule?.ruleCode));
    })
    .map((rule) => ({
      ruleCode: rule?.ruleCode || null,
      title: rule?.title || "Maintenance",
      nextDueMiles:
        rule?.nextDueMiles != null ? Number(rule.nextDueMiles) : null,
      nextDueDate: rule?.nextDueDate || null,
    }))
    .filter((rule) => rule.nextDueMiles != null || rule.nextDueDate);

  if (!candidates.length) {
    return {
      ruleCode: null,
      title: null,
      label: options.label || "Next service due",
      miles: null,
      date: null,
      estimatedDate: null,
      avgDailyMiles: null,
      text: "Unknown",
    };
  }

  candidates.sort((a, b) => {
    const aMiles = a.nextDueMiles ?? Number.MAX_SAFE_INTEGER;
    const bMiles = b.nextDueMiles ?? Number.MAX_SAFE_INTEGER;
    if (aMiles !== bMiles) return aMiles - bMiles;

    const aDate = a.nextDueDate
      ? new Date(a.nextDueDate).getTime()
      : Number.MAX_SAFE_INTEGER;
    const bDate = b.nextDueDate
      ? new Date(b.nextDueDate).getTime()
      : Number.MAX_SAFE_INTEGER;

    return aDate - bDate;
  });

  const next = candidates[0];
  const avgDailyMiles = estimateDailyMilesFromSummary(summary);

  let estimatedDate = null;

  if (
    Number.isFinite(currentOdometer) &&
    Number.isFinite(next.nextDueMiles) &&
    Number.isFinite(avgDailyMiles) &&
    avgDailyMiles > 0 &&
    next.nextDueMiles >= currentOdometer
  ) {
    const milesRemaining = next.nextDueMiles - currentOdometer;
    const daysRemaining = milesRemaining / avgDailyMiles;

    const estimate = new Date();
    estimate.setDate(estimate.getDate() + Math.ceil(daysRemaining));
    estimatedDate = estimate.toISOString();
  }

  const remainingMiles =
    Number.isFinite(currentOdometer) && Number.isFinite(next.nextDueMiles)
      ? next.nextDueMiles - currentOdometer
      : null;

  const milesText = remainingMiles != null
    ? remainingMiles <= 0
      ? "Due now"
      : `in ${remainingMiles.toLocaleString()} mi`
    : next.nextDueMiles != null
    ? `@ ${next.nextDueMiles.toLocaleString()} mi`
    : null;

  const dateText = estimatedDate
    ? `est. ${formatShortDate(estimatedDate)}`
    : next.nextDueDate
    ? formatShortDate(next.nextDueDate)
    : null;

  return {
    ruleCode: next.ruleCode,
    title: next.title,
    label: options.label || next.title || "Next service due",
    miles: next.nextDueMiles,
    date: next.nextDueDate,
    estimatedDate,
    avgDailyMiles,
    text: [milesText, dateText].filter(Boolean).join(" • ") || "Unknown",
  };
}

export function getRelevantTrips(trips) {
  if (!Array.isArray(trips)) return [];

  return trips
    .filter((trip) =>
      ["in_progress", "unconfirmed", "upcoming"].includes(trip?.queue_bucket)
    )
    .map((trip) => ({
      ...trip,
      parsedStart: parseDateTime(trip?.trip_start),
      parsedEnd: parseDateTime(trip?.trip_end),
    }))
    .filter((trip) => trip.parsedStart || trip.parsedEnd)
    .sort((a, b) => {
      const aTime =
        a.parsedStart?.getTime() ??
        a.parsedEnd?.getTime() ??
        Number.POSITIVE_INFINITY;
      const bTime =
        b.parsedStart?.getTime() ??
        b.parsedEnd?.getTime() ??
        Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
}

export function getActiveTrip(trips) {
  return getRelevantTrips(trips).find(
    (trip) => trip?.queue_bucket === "in_progress"
  );
}

export function getNextUpcomingTrip(trips) {
  const now = getNow();

  return getRelevantTrips(trips).find((trip) => {
    if (!["unconfirmed", "upcoming"].includes(trip?.queue_bucket)) return false;
    if (!trip.parsedStart) return false;
    return trip.parsedStart > now;
  });
}

export function getEarliestAvailableDate(trips) {
  const activeTrip = getActiveTrip(trips);

  if (activeTrip?.trip_end) {
    const end = parseDateTime(activeTrip.trip_end);
    const now = getNow();

    if (end && end < now) {
      return "9999-12-31T23:59:59.999Z";
    }

    return activeTrip.trip_end;
  }

  return new Date().toISOString();
}

export function getEarliestAvailableLabel(trips) {
  if (!Array.isArray(trips) || trips.length === 0) {
    return "Available now";
  }

  const activeTrip = getActiveTrip(trips);

  if (activeTrip?.trip_end) {
    const end = parseDateTime(activeTrip.trip_end);
    const now = getNow();

    if (end && end < now) {
      return `Overdue — was due ${formatChicagoDateTime(activeTrip.trip_end)}`;
    }

    return formatChicagoDateTime(activeTrip.trip_end);
  }

  const nextTrip = getNextUpcomingTrip(trips);

  if (nextTrip?.trip_start) {
    return `Available until ${formatChicagoDateTime(nextTrip.trip_start)}`;
  }

  return "Available now";
}
