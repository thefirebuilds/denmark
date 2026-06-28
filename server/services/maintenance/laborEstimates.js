const TASK_ESTIMATES = [
  {
    hours: 0.083,
    patterns: [/check\s+oil/i, /oil\s+level/i],
  },
  {
    hours: 0.083,
    patterns: [/check\s+tire/i, /tire\s+pressure/i],
  },
  {
    hours: 0.75,
    patterns: [/change\s+oil/i, /oil\s+change/i],
  },
  {
    hours: 2,
    patterns: [/install\s+tire/i, /tire\s+install/i, /replace\s+tire/i],
  },
  {
    hours: 1,
    patterns: [/clean/i, /turnaround/i, /turn\s+clean/i],
  },
  {
    hours: 0.167,
    patterns: [/lights?\s+check/i, /headlights?/i, /taillights?/i],
  },
];

const RULE_CODE_ESTIMATES = new Map([
  ["cleaning", 1],
  ["oil_change", 0.75],
  ["tire_pressure_check", 0.083],
  ["fluid_leak_check", 0.083],
  ["lights_check", 0.167],
]);

function normalizeLaborHours(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.round(num * 1000) / 1000;
}

function estimateLaborHours(input = {}) {
  const explicit = normalizeLaborHours(
    input.estimatedLaborHours ??
      input.estimated_labor_hours ??
      input.actualLaborHours ??
      input.actual_labor_hours
  );
  if (explicit != null) return explicit;

  const ruleCode = String(input.ruleCode || input.rule_code || "").trim().toLowerCase();
  if (RULE_CODE_ESTIMATES.has(ruleCode)) {
    return RULE_CODE_ESTIMATES.get(ruleCode);
  }

  const text = [
    input.taskType,
    input.task_type,
    input.title,
    input.description,
  ]
    .filter(Boolean)
    .join(" ");

  for (const estimate of TASK_ESTIMATES) {
    if (estimate.patterns.some((pattern) => pattern.test(text))) {
      return estimate.hours;
    }
  }

  return null;
}

module.exports = {
  estimateLaborHours,
  normalizeLaborHours,
};
