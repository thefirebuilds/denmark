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

function pickFirstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
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

  if (
    status === "failed" ||
    status === "overdue" ||
    status === "due_soon"
  ) {
    return true;
  }

  if (status === "due") {
    if (!rule?.nextDueDate) return true;
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

function formatMilesUntilDue(nextDueMiles, currentOdometerMiles) {
  const dueMiles = Number(nextDueMiles);
  const currentMiles = Number(currentOdometerMiles);

  if (!Number.isFinite(dueMiles) || !Number.isFinite(currentMiles)) return null;

  const milesRemaining = Math.round(dueMiles - currentMiles);

  if (milesRemaining < 0) {
    return `${Math.abs(milesRemaining).toLocaleString()} mi overdue`;
  }

  if (milesRemaining === 0) {
    return "due now";
  }

  return `${milesRemaining.toLocaleString()} mi left`;
}

export function getNextIntervalDueText(item, currentOdometerMiles = null) {
  const nextDueMiles =
    item?.lastEvent?.nextDueMiles != null
      ? Number(item.lastEvent.nextDueMiles)
      : item?.nextDueMiles != null
      ? Number(item.nextDueMiles)
      : null;
  const nextDueDate = item?.lastEvent?.nextDueDate || item?.nextDueDate || null;
  const parts = [];
  const milesText = formatMilesUntilDue(nextDueMiles, currentOdometerMiles);

  if (milesText) {
    parts.push(milesText);
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
  } else if (rule?.nextDueMiles != null || rule?.nextDueDate) {
    value = getNextIntervalDueText(
      rule,
      rule?.currentOdometerMiles ?? rule?.current_odometer_miles ?? null
    ).replace(/^Next interval due:\s*/, "");
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

  if (type.includes("battery") || title.includes("battery")) {
    return ["battery_test"];
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

function getRuleStatusById(summary, ruleId) {
  if (ruleId == null || ruleId === "") return null;
  const normalizedId = Number(ruleId);
  if (!Number.isFinite(normalizedId)) return null;

  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  return (
    rules.find((rule) => Number(rule?.ruleId) === normalizedId) || null
  );
}

export function getPrimaryLinkedRuleCode(task) {
  return getTaskLinkedRuleCodes(task)[0] || null;
}

function getLinkedRulesForTask(summary, task) {
  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  const matches = [];
  const seen = new Set();

  const addRule = (rule) => {
    if (!rule) return;
    const key =
      rule?.ruleId != null && rule?.ruleId !== ""
        ? `id:${rule.ruleId}`
        : `code:${normalizeRuleCode(rule?.ruleCode)}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(rule);
  };

  addRule(getRuleStatusById(summary, task?.rule_id));

  const triggerRuleCode = String(task?.trigger_context?.ruleCode || "")
    .trim()
    .toLowerCase();
  if (triggerRuleCode) {
    addRule(getRuleStatus(summary, triggerRuleCode));
  }

  const linkedRuleCodes = getTaskLinkedRuleCodes(task);
  linkedRuleCodes.forEach((ruleCode) => addRule(getRuleStatus(summary, ruleCode)));

  if (!matches.length && task?.rule_id != null) {
    const normalizedId = Number(task.rule_id);
    rules
      .filter((rule) => Number(rule?.ruleId) === normalizedId)
      .forEach(addRule);
  }

  return matches;
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
  const linkedRules = getLinkedRulesForTask(summary, task);
  if (!linkedRules.length) return false;

  const taskType = String(task?.task_type || "").toLowerCase();
  const createdAtRaw = task?.created_at || task?.updated_at || null;
  const taskCreatedAt = createdAtRaw ? new Date(createdAtRaw) : null;

  return linkedRules.some((rule) => {
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

function normalizeQueueText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getQueueFamilyFromRuleCode(ruleCode) {
  const code = normalizeRuleCode(ruleCode);

  if (["battery_test", "battery_check"].includes(code)) {
    return {
      key: "battery_test",
      title: "Battery test",
    };
  }

  if (
    [
      "fluid_leak_check",
      "leak_check",
      "oil_level_check",
      "engine_oil_level",
    ].includes(code)
  ) {
    return {
      key: "fluid_leak_check",
      title: "Fluid / leak inspection",
    };
  }

  if (
    [
      "tire_pressure_check",
      "tire_pressure_inspection",
      "tire_pressure",
    ].includes(code)
  ) {
    return {
      key: "tire_pressure_check",
      title: "Tire pressure check",
    };
  }

  return null;
}

function getQueueFamilyFromItem(item) {
  const linkedCodes = [
    item?.linkedRuleCode,
    ...(Array.isArray(item?.linkedRuleCodes) ? item.linkedRuleCodes : []),
  ].filter(Boolean);

  for (const code of linkedCodes) {
    const family = getQueueFamilyFromRuleCode(code);
    if (family) return family;
  }

  const title = normalizeQueueText(item?.title);
  const type = normalizeQueueText(item?.type || item?.task?.task_type);

  if (title.includes("battery") || type.includes("battery")) {
    return {
      key: "battery_test",
      title: "Battery test",
    };
  }

  if (
    title.includes("fluid") ||
    title.includes("leak") ||
    title.includes("oil level") ||
    type.includes("fluid") ||
    type.includes("leak") ||
    type.includes("oil level")
  ) {
    return {
      key: "fluid_leak_check",
      title: "Fluid / leak inspection",
    };
  }

  if (
    title.includes("tire pressure") ||
    type.includes("tire pressure") ||
    type.includes("tirepressure")
  ) {
    return {
      key: "tire_pressure_check",
      title: "Tire pressure check",
    };
  }

  return {
    key: `item:${title || item?.id || "unknown"}`,
    title: item?.title || "Open maintenance item",
  };
}

function getQueueItemUrgencyScore(item) {
  const status = String(item?.status || item?.ruleStatus || "").toLowerCase();
  const blocks =
    item?.blocksRentalWhenOverdue ||
    item?.blocksGuestExportWhenOverdue ||
    item?.task?.blocks_rental ||
    item?.task?.blocks_guest_export;

  let score = (blocks ? 1000 : 0) + getPriorityScore(item?.priority) * 10;

  if (status === "failed" || status === "overdue") score += 50;
  else if (status === "due") score += 35;
  else if (status === "due_soon") score += 20;

  if (item?.source === "rule") score += 3;
  return score;
}

function mergeQueueItems(items) {
  const byFamily = new Map();

  for (const item of items || []) {
    const family = getQueueFamilyFromItem(item);
    const key = family.key;
    const existing = byFamily.get(key);
    const normalizedItem = {
      ...item,
      title: family.title,
      queueFamilyKey: key,
    };

    if (!existing) {
      byFamily.set(key, {
        ...normalizedItem,
        mergedItems: [item],
        mergedCount: 1,
      });
      continue;
    }

    const currentScore = getQueueItemUrgencyScore(existing);
    const nextScore = getQueueItemUrgencyScore(normalizedItem);
    const winner = nextScore > currentScore ? normalizedItem : existing;
    const mergedItems = [...(existing.mergedItems || []), item];

    byFamily.set(key, {
      ...winner,
      title: family.title,
      queueFamilyKey: key,
      mergedItems,
      mergedCount: mergedItems.length,
      linkedRuleCodes: Array.from(
        new Set([
          ...(Array.isArray(existing.linkedRuleCodes) ? existing.linkedRuleCodes : []),
          ...(Array.isArray(normalizedItem.linkedRuleCodes)
            ? normalizedItem.linkedRuleCodes
            : []),
          existing.linkedRuleCode,
          normalizedItem.linkedRuleCode,
        ].filter(Boolean))
      ),
    });
  }

  return Array.from(byFamily.values());
}

export function buildQueueItemsFromSummary(summary, historyMap = {}) {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  const rules = Array.isArray(summary?.ruleStatuses) ? summary.ruleStatuses : [];
  const actionableRules = getActionableQueueRules(summary?.ruleStatuses);
  const currentOdometerMiles =
    summary?.vehicle?.currentOdometerMiles ??
    summary?.vehicle?.current_odometer_miles ??
    null;

  const taskItems = tasks
    .filter((task) => String(task?.status || "").toLowerCase() === "open")
    .filter((task) => !isTaskSatisfiedByRule(task, summary))
    .map((task) => {
      const linkedRuleCodes = getTaskLinkedRuleCodes(task);
      const linkedRules = getLinkedRulesForTask(summary, task);
      const linkedRule =
        linkedRules[0] ||
        rules.find((rule) =>
          linkedRuleCodes.includes(normalizeRuleCode(rule?.ruleCode))
        ) ||
        null;
      const linkedRuleCode = linkedRule?.ruleCode || getPrimaryLinkedRuleCode(task);

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
        ruleStatus: linkedRule?.status ?? null,
        nextDueText: getNextIntervalDueText(linkedRule, currentOdometerMiles),
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
    ruleStatus: rule.status ?? null,
    nextDueText: getNextIntervalDueText(rule, currentOdometerMiles),
    history: historyMap[rule.ruleCode] || [],
    blocksRentalWhenOverdue: Boolean(rule.blocksRentalWhenOverdue),
    blocksGuestExportWhenOverdue: Boolean(rule.blocksGuestExportWhenOverdue),
  }));

  const merged = [...taskItems, ...ruleItems];
  return mergeQueueItems(merged);
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

export function buildTelematicsStatus(fleetVehicle = null) {
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

export function buildTelemetryLocation(fleetVehicle = null) {
  const location = fleetVehicle?.telemetry?.location || {};
  const lat = Number(location.lat);
  const lon = Number(location.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    lat,
    lon,
    label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    lastUpdated:
      location.last_updated ||
      fleetVehicle?.telemetry?.timestamps?.location_last_updated ||
      fleetVehicle?.telemetry?.timestamps?.vehicle_last_updated ||
      fleetVehicle?.telemetry?.timestamps?.captured_at ||
      fleetVehicle?.telemetry?.last_comm ||
      null,
  };
}

export function buildMilStatus(fleetVehicle = null, liveDiagnostics = null) {
  const mil = liveDiagnostics?.mil || fleetVehicle?.telemetry?.mil || {};
  const count =
    mil.dtc_count === null || mil.dtc_count === undefined || mil.dtc_count === ""
      ? null
      : Number(mil.dtc_count);
  const dtcCountIsZero = Number.isFinite(count) && count === 0;
  const sourceLabel =
    liveDiagnostics?.source === "dimo_latest_signals" ||
    mil.source === "dimo_latest_signals"
      ? "DIMO latest signals"
      : null;
  const sourcedDetail = (detail) =>
    sourceLabel ? `${detail} from ${sourceLabel}` : detail;
  const codes = !dtcCountIsZero && Array.isArray(mil.qualified_dtc_list)
    ? mil.qualified_dtc_list
        .map((item) => {
          if (typeof item === "string") return item;
          return item?.code || item?.dtc || item?.name || "";
        })
        .map((item) => String(item || "").trim().toUpperCase())
        .filter(Boolean)
    : [];
  const lastUpdated = mil.last_updated || null;
  const firstReportedAt = mil.first_reported_at || null;

  if (mil.mil_on === true) {
    return {
      tone: "fail",
      label: codes.length ? `MIL on: ${codes.join(", ")}` : "MIL on",
      detail: sourcedDetail(
        codes.length
          ? `${codes.length} decoded DTC${codes.length === 1 ? "" : "s"} reported`
          : "Check-engine light is on, but no decoded DTCs were reported yet"
      ),
      lastUpdated,
      firstReportedAt,
      sourceLabel,
    };
  }

  if (codes.length || count > 0) {
    return {
      tone: "fail",
      label: codes.length ? `DTC: ${codes.join(", ")}` : `${count} DTC active`,
      detail: sourcedDetail("Diagnostic trouble code reported by telematics"),
      lastUpdated,
      firstReportedAt,
      sourceLabel,
    };
  }

  if (mil.mil_on === false) {
    return {
      tone: "pass",
      label: "MIL clear",
      detail: sourcedDetail("No active check-engine light reported"),
      lastUpdated,
      firstReportedAt,
      sourceLabel,
    };
  }

  return {
    tone: "unknown",
    label: "No MIL reading",
    detail: sourcedDetail("No diagnostic status reported yet"),
    lastUpdated,
    firstReportedAt,
    sourceLabel,
  };
}

function formatEngineTemp(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${Math.round(num)} F`;
}

export function buildEngineTemperatureStatus(fleetVehicle = null) {
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
    ? `Overtemp alert${
        range.last_overtemp_at
          ? ` at ${formatTelematicsLastCall(range.last_overtemp_at)}`
          : ""
      }`
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

export function buildEngineRpmStatus(fleetVehicle = null) {
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

export function mapMaintenanceSummaryToGuestInspectionVehicle(
  summary,
  {
    fallbackId = null,
    fallbackVehicle = null,
    fleetVehicle = null,
    liveDiagnostics = null,
  } = {}
) {
  const sourceVehicle = summary?.vehicle || fallbackVehicle || fleetVehicle || {};
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  const ruleStatuses = Array.isArray(summary?.ruleStatuses)
    ? summary.ruleStatuses
    : [];
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
  const oilServiceDue = getNextServiceDue(summary || {}, {
    ruleCodes: ["oil_change", "brake_inspection"],
    label: "Next service due",
  });
  const nextServiceDue =
    oilServiceDue?.text && oilServiceDue.text !== "Unknown"
      ? oilServiceDue
      : getNextServiceDue(summary || {});
  const actionableTasks = tasks.filter(
    (task) =>
      String(task?.status || "").toLowerCase() === "open" &&
      !isTaskSatisfiedByRule(task, summary || {})
  );
  const hasBlockingIssue = Boolean(summary?.blocksRental || summary?.blocksGuestExport);
  const hasNeedsReview = Boolean(summary?.needsReview);
  const hasOpenTasks = actionableTasks.length > 0;
  const overallStatus =
    hasBlockingIssue || hasNeedsReview || hasOpenTasks ? "attention" : "pass";
  const vin = pickFirstFilled(sourceVehicle.vin, fleetVehicle?.vin, fallbackVehicle?.vin);
  const plate = pickFirstFilled(
    sourceVehicle.license_plate,
    sourceVehicle.licensePlate,
    sourceVehicle.plate,
    fleetVehicle?.license_plate,
    fallbackVehicle?.license_plate,
    fallbackVehicle?.plate
  );
  const licenseState = pickFirstFilled(
    sourceVehicle.registration?.state,
    sourceVehicle.license_state,
    sourceVehicle.licenseState,
    fleetVehicle?.registration?.state,
    fleetVehicle?.license_state,
    fallbackVehicle?.license_state
  );
  const registrationMonth = pickFirstFilled(
    sourceVehicle.registration?.month,
    sourceVehicle.registration_month,
    sourceVehicle.registrationMonth,
    fleetVehicle?.registration?.month,
    fleetVehicle?.registration_month,
    fallbackVehicle?.registration_month
  );
  const registrationYear = pickFirstFilled(
    sourceVehicle.registration?.year,
    sourceVehicle.registration_year,
    sourceVehicle.registrationYear,
    fleetVehicle?.registration?.year,
    fleetVehicle?.registration_year,
    fallbackVehicle?.registration_year
  );

  return {
    id:
      fallbackId ||
      normalizeVehicleKey(sourceVehicle.nickname || sourceVehicle.vin || "vehicle"),
    nickname: sourceVehicle.nickname || fallbackVehicle?.nickname || "Vehicle",
    year: sourceVehicle.year || fallbackVehicle?.year || "",
    make: sourceVehicle.make || fallbackVehicle?.make || "",
    model: sourceVehicle.model || fallbackVehicle?.model || "",
    vin: vin || null,
    vin_last6: getVinLast6(vin),
    rockauto_url:
      sourceVehicle.rockauto_url ||
      sourceVehicle.rockautoUrl ||
      fleetVehicle?.rockauto_url ||
      fleetVehicle?.rockautoUrl ||
      fallbackVehicle?.rockauto_url ||
      fallbackVehicle?.rockautoUrl ||
      "",
    currentOdometerMiles:
      summary?.currentOdometerMiles ??
      sourceVehicle.currentOdometerMiles ??
      sourceVehicle.current_odometer_miles ??
      fallbackVehicle?.currentOdometerMiles ??
      fallbackVehicle?.current_odometer_miles ??
      null,
    currentOdometerSource:
      summary?.currentOdometerSource ??
      sourceVehicle.currentOdometerSource ??
      fallbackVehicle?.currentOdometerSource ??
      null,
    onboardingOdometerMiles:
      summary?.onboardingOdometerMiles ??
      sourceVehicle.onboardingOdometerMiles ??
      fallbackVehicle?.onboardingOdometerMiles ??
      null,
    totalTuroMiles:
      summary?.totalTuroMiles ?? sourceVehicle.totalTuroMiles ?? null,
    countedTuroMileageTrips:
      summary?.countedTuroMileageTrips ?? sourceVehicle.countedTuroMileageTrips ?? null,
    next_service_due: nextServiceDue,
    plate: plate || "-",
    license_plate: plate || "",
    license_state: licenseState || "TX",
    registration_month: registrationMonth ?? "",
    registration_year: registrationYear ?? "",
    registration_expires:
      sourceVehicle.registration?.code ||
      sourceVehicle.registration_expires ||
      fallbackVehicle?.registration_expires ||
      formatRegistration(registrationMonth, registrationYear),
    lockbox_pin:
      pickFirstFilled(
        sourceVehicle.lockbox_pin,
        sourceVehicle.lockboxPin,
        fleetVehicle?.lockbox_pin,
        fleetVehicle?.lockboxPin,
        fallbackVehicle?.lockbox_pin,
        fallbackVehicle?.lockboxPin
      ) || "",
    rentable: !summary?.blocksRental,
    in_service: fleetVehicle?.in_service !== false,
    map_vehicle_id: fleetVehicle?.id ?? sourceVehicle.id ?? fallbackId,
    overall_status: overallStatus,
    export_ready: !summary?.blocksGuestExport,
    telematics: buildTelematicsStatus(fleetVehicle || fallbackVehicle),
    telemetry_location: buildTelemetryLocation(fleetVehicle || fallbackVehicle),
    mil_status: buildMilStatus(fleetVehicle || fallbackVehicle, liveDiagnostics),
    engine_temperature: buildEngineTemperatureStatus(fleetVehicle || fallbackVehicle),
    engine_rpm: buildEngineRpmStatus(fleetVehicle || fallbackVehicle),
    body_condition: notes.length ? "documented" : "good",
    body_notes: notes.length
      ? notes
      : ["No guest-visible cosmetic notes recorded"],
    inspection_items: ruleStatuses.map((rule) =>
      mapRuleStatusToInspectionItem(rule, historyMap)
    ),
    queue_items: buildQueueItemsFromSummary(summary || {}, historyMap),
  };
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
  const now = getNow();

  return trips
    .map((trip) => ({
      ...trip,
      parsedStart: parseDateTime(trip?.trip_start),
      parsedEnd: parseDateTime(trip?.trip_end),
    }))
    .filter((trip) => {
      const bucket = String(trip?.queue_bucket || "").toLowerCase();
      const stage = String(trip?.workflow_stage || "").toLowerCase();
      const status = String(trip?.status || "").toLowerCase();

      if (["canceled", "cancelled"].includes(bucket)) return false;
      if (["canceled", "cancelled"].includes(stage)) return false;
      if (["canceled", "cancelled"].includes(status)) return false;
      if (!trip.parsedStart && !trip.parsedEnd) return false;

      if (
        ["in_progress", "needs_closeout", "unconfirmed", "upcoming"].includes(
          bucket
        )
      ) {
        return true;
      }

      if (
        [
          "booked",
          "confirmed",
          "ready_for_handoff",
          "in_progress",
          "turnaround",
        ].includes(stage)
      ) {
        return true;
      }

      if (["active", "started", "trip_started", "booked", "confirmed"].includes(status)) {
        return true;
      }

      return Boolean(
        trip.parsedStart &&
          trip.parsedEnd &&
          trip.parsedStart <= now &&
          trip.parsedEnd >= now
      );
    })
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
  const now = getNow();

  return getRelevantTrips(trips).find((trip) => {
    const bucket = String(trip?.queue_bucket || "").toLowerCase();
    const stage = String(trip?.workflow_stage || "").toLowerCase();
    const status = String(trip?.status || "").toLowerCase();
    const overlapsNow = Boolean(
      trip.parsedStart &&
        trip.parsedEnd &&
        trip.parsedStart <= now &&
        trip.parsedEnd >= now
    );

    if (trip.parsedStart && trip.parsedStart > now) {
      return false;
    }

    if (
      bucket === "in_progress" ||
      stage === "in_progress" ||
      ["active", "started", "trip_started", "in_progress"].includes(status)
    ) {
      return overlapsNow || !trip.parsedStart;
    }

    return overlapsNow;
  });
}

export function getNextUpcomingTrip(trips) {
  const now = getNow();

  return getRelevantTrips(trips).find((trip) => {
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
