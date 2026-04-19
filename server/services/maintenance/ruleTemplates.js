const DEFAULT_MAINTENANCE_RULE_TEMPLATES = [
  {
    ruleCode: "fluid_leak_check",
    title: "Fluid / Leak Inspection",
    description: null,
    category: "safety",
    intervalMiles: null,
    intervalDays: 7,
    dueSoonMiles: 0,
    dueSoonDays: 1,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: true,
    ruleConfig: {},
  },
  {
    ruleCode: "tire_pressure_check",
    title: "Tire Pressure Check",
    description: null,
    category: "safety",
    intervalMiles: null,
    intervalDays: 7,
    dueSoonMiles: 0,
    dueSoonDays: 1,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: true,
    ruleConfig: {},
  },
  {
    ruleCode: "tread_depth",
    title: "Tread Depth Inspection",
    description: null,
    category: "safety",
    intervalMiles: 2500,
    intervalDays: 30,
    dueSoonMiles: 250,
    dueSoonDays: 7,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: true,
    ruleConfig: {},
  },
  {
    ruleCode: "battery_test",
    title: "Battery Test",
    description: null,
    category: "safety",
    intervalMiles: null,
    intervalDays: 90,
    dueSoonMiles: 0,
    dueSoonDays: 14,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: true,
    ruleConfig: {},
  },
  {
    ruleCode: "brake_inspection",
    title: "Brake Inspection",
    description: null,
    category: "safety",
    intervalMiles: 10000,
    intervalDays: 90,
    dueSoonMiles: 1000,
    dueSoonDays: 14,
    blocksRentalWhenOverdue: true,
    blocksGuestExportWhenOverdue: true,
    requiresPassResult: true,
    ruleConfig: {},
  },
  {
    ruleCode: "tire_age_review",
    title: "Tire Age Review",
    description: null,
    category: "safety",
    intervalMiles: null,
    intervalDays: 1825,
    dueSoonMiles: 0,
    dueSoonDays: 180,
    blocksRentalWhenOverdue: true,
    blocksGuestExportWhenOverdue: true,
    requiresPassResult: true,
    ruleConfig: {
      type: "tire_age",
      fail_age_years: 7,
      tracks_dot_code: true,
      tracks_tread_depth: true,
      attention_age_years: 5,
      tracks_install_date: true,
    },
  },
  {
    ruleCode: "oil_change",
    title: "Oil Change",
    description: null,
    category: "service",
    intervalMiles: 5000,
    intervalDays: null,
    dueSoonMiles: 500,
    dueSoonDays: 14,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {},
  },
  {
    ruleCode: "tire_rotation",
    title: "Tire Rotation",
    description: null,
    category: "service",
    intervalMiles: 5000,
    intervalDays: null,
    dueSoonMiles: 500,
    dueSoonDays: 0,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {},
  },
  {
    ruleCode: "bearing_tie_rod_check",
    title: "Bearing / Tie Rod Check",
    description: "Check wheel bearings, tie rods, and steering play while the car is on stands",
    category: "safety",
    intervalMiles: 5000,
    intervalDays: null,
    dueSoonMiles: 500,
    dueSoonDays: 0,
    blocksRentalWhenOverdue: true,
    blocksGuestExportWhenOverdue: true,
    requiresPassResult: true,
    ruleConfig: {
      custom_trackable: true,
      service_type: "bearing_tie_rod_check",
      inspect_on_stands: true,
    },
  },
  {
    ruleCode: "engine_air_filter",
    title: "Engine Air Filter",
    description: null,
    category: "service",
    intervalMiles: 5000,
    intervalDays: null,
    dueSoonMiles: 500,
    dueSoonDays: 0,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {},
  },
  {
    ruleCode: "cabin_air_filter",
    title: "Cabin Air Filter",
    description: null,
    category: "service",
    intervalMiles: 5000,
    intervalDays: null,
    dueSoonMiles: 500,
    dueSoonDays: 0,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {},
  },
  {
    ruleCode: "wiper_replacement",
    title: "Wiper Replacement",
    description: null,
    category: "service",
    intervalMiles: null,
    intervalDays: 180,
    dueSoonMiles: 500,
    dueSoonDays: 14,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {},
  },
  {
    ruleCode: "automatic_transmission_flush",
    title: "Automatic Transmission Flush",
    description: "Automatic transmission fluid service",
    category: "service",
    intervalMiles: 60000,
    intervalDays: null,
    dueSoonMiles: 2500,
    dueSoonDays: 30,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {
      custom_trackable: true,
      service_type: "automatic_transmission_flush",
    },
  },
  {
    ruleCode: "ac_performance_check",
    title: "A/C Performance Check",
    description: "Measure A/C vent temperature drop and system pressures",
    category: "safety",
    intervalMiles: null,
    intervalDays: 90,
    dueSoonMiles: 0,
    dueSoonDays: 14,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: true,
    ruleConfig: {
      custom_trackable: true,
      service_type: "ac_performance_check",
      tracks_temperature_delta: true,
      tracks_system_pressure: true,
      target_min_temperature_delta_f: 20,
    },
  },
  {
    ruleCode: "cleaning",
    title: "Cleaning",
    description: "Interior and exterior cleaning status",
    category: "other",
    intervalMiles: null,
    intervalDays: 14,
    dueSoonMiles: 500,
    dueSoonDays: 3,
    blocksRentalWhenOverdue: false,
    blocksGuestExportWhenOverdue: false,
    requiresPassResult: false,
    ruleConfig: {
      type: "cleaning",
      blocking: false,
      guest_visible: true,
    },
  },
];

const VALID_CATEGORIES = new Set([
  "inspection",
  "service",
  "safety",
  "compliance",
  "other",
]);

function cleanString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toNullableInt(value) {
  if (value === "" || value == null) return null;
  const num = Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function toNonNegativeInt(value, fallback) {
  if (value === "" || value == null) return fallback;
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function slugifyRuleCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRuleInput(input = {}) {
  const title = cleanString(input.title);
  if (!title) {
    const err = new Error("Maintenance rule title is required");
    err.statusCode = 400;
    throw err;
  }

  const ruleCode = slugifyRuleCode(input.ruleCode || input.rule_code || title);
  if (!ruleCode) {
    const err = new Error("Maintenance rule code is required");
    err.statusCode = 400;
    throw err;
  }

  const category = cleanString(input.category) || "service";
  if (!VALID_CATEGORIES.has(category)) {
    const err = new Error(
      `Maintenance rule category must be one of ${[...VALID_CATEGORIES].join(", ")}`
    );
    err.statusCode = 400;
    throw err;
  }

  const intervalMiles = toNullableInt(input.intervalMiles ?? input.interval_miles);
  const intervalDays = toNullableInt(input.intervalDays ?? input.interval_days);

  if (intervalMiles == null && intervalDays == null) {
    const err = new Error("Maintenance rule needs intervalMiles or intervalDays");
    err.statusCode = 400;
    throw err;
  }

  return {
    ruleCode,
    title,
    description: cleanString(input.description),
    category,
    intervalMiles,
    intervalDays,
    dueSoonMiles: toNonNegativeInt(input.dueSoonMiles ?? input.due_soon_miles, 500),
    dueSoonDays: toNonNegativeInt(input.dueSoonDays ?? input.due_soon_days, 14),
    blocksRentalWhenOverdue: toBoolean(
      input.blocksRentalWhenOverdue ?? input.blocks_rental_when_overdue,
      false
    ),
    blocksGuestExportWhenOverdue: toBoolean(
      input.blocksGuestExportWhenOverdue ?? input.blocks_guest_export_when_overdue,
      false
    ),
    requiresPassResult: toBoolean(input.requiresPassResult ?? input.requires_pass_result, false),
    ruleConfig:
      input.ruleConfig && typeof input.ruleConfig === "object"
        ? input.ruleConfig
        : input.rule_config && typeof input.rule_config === "object"
        ? input.rule_config
        : { custom_trackable: true },
  };
}

function mapDbTemplate(row) {
  if (!row) return null;

  return {
    id: row.id,
    ruleCode: row.rule_code,
    title: row.title,
    description: row.description,
    category: row.category,
    intervalMiles: row.interval_miles,
    intervalDays: row.interval_days,
    dueSoonMiles: row.due_soon_miles,
    dueSoonDays: row.due_soon_days,
    blocksRentalWhenOverdue: Boolean(row.blocks_rental_when_overdue),
    blocksGuestExportWhenOverdue: Boolean(row.blocks_guest_export_when_overdue),
    requiresPassResult: Boolean(row.requires_pass_result),
    ruleConfig: row.rule_config || {},
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMissingTemplateTableError(err) {
  return err?.code === "42P01" || String(err?.message || "").includes("maintenance_rule_templates");
}

async function upsertRuleTemplate(client, rule, { reactivate = false } = {}) {
  const normalized = normalizeRuleInput(rule);

  const result = await client.query(
    `
      INSERT INTO maintenance_rule_templates (
        rule_code,
        title,
        description,
        category,
        interval_miles,
        interval_days,
        due_soon_miles,
        due_soon_days,
        blocks_rental_when_overdue,
        blocks_guest_export_when_overdue,
        requires_pass_result,
        rule_config,
        is_active,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb,
        true,
        NOW(),
        NOW()
      )
      ON CONFLICT (rule_code)
      DO UPDATE SET
        title = COALESCE(maintenance_rule_templates.title, EXCLUDED.title),
        description = COALESCE(maintenance_rule_templates.description, EXCLUDED.description),
        category = COALESCE(maintenance_rule_templates.category, EXCLUDED.category),
        interval_miles = COALESCE(maintenance_rule_templates.interval_miles, EXCLUDED.interval_miles),
        interval_days = COALESCE(maintenance_rule_templates.interval_days, EXCLUDED.interval_days),
        due_soon_miles = maintenance_rule_templates.due_soon_miles,
        due_soon_days = maintenance_rule_templates.due_soon_days,
        blocks_rental_when_overdue = maintenance_rule_templates.blocks_rental_when_overdue,
        blocks_guest_export_when_overdue = maintenance_rule_templates.blocks_guest_export_when_overdue,
        requires_pass_result = maintenance_rule_templates.requires_pass_result,
        rule_config = COALESCE(maintenance_rule_templates.rule_config, EXCLUDED.rule_config),
        is_active = CASE
          WHEN $13::boolean THEN true
          ELSE maintenance_rule_templates.is_active
        END,
        updated_at = maintenance_rule_templates.updated_at
      RETURNING *
    `,
    [
      normalized.ruleCode,
      normalized.title,
      normalized.description,
      normalized.category,
      normalized.intervalMiles,
      normalized.intervalDays,
      normalized.dueSoonMiles,
      normalized.dueSoonDays,
      normalized.blocksRentalWhenOverdue,
      normalized.blocksGuestExportWhenOverdue,
      normalized.requiresPassResult,
      JSON.stringify(normalized.ruleConfig || {}),
      Boolean(reactivate),
    ]
  );

  return mapDbTemplate(result.rows[0]);
}

async function ensureTemplateCatalogSeeded(client) {
  try {
    const countResult = await client.query(
      "SELECT COUNT(*)::int AS count FROM maintenance_rule_templates"
    );

    let seededCount = 0;
    for (const template of DEFAULT_MAINTENANCE_RULE_TEMPLATES) {
      const before = await client.query(
        "SELECT 1 FROM maintenance_rule_templates WHERE rule_code = $1",
        [template.ruleCode]
      );
      await upsertRuleTemplate(client, template, { reactivate: true });
      if (!before.rows.length) seededCount += 1;
    }

    return {
      source: "database",
      seededCount,
      existingCount: Number(countResult.rows[0]?.count || 0),
    };
  } catch (err) {
    if (isMissingTemplateTableError(err)) {
      return { source: "code", seededCount: 0, missingTable: true };
    }
    throw err;
  }
}

async function getActiveRuleTemplates(client) {
  const seedResult = await ensureTemplateCatalogSeeded(client);

  if (seedResult.missingTable) {
    return DEFAULT_MAINTENANCE_RULE_TEMPLATES;
  }

  const result = await client.query(
    `
      SELECT *
      FROM maintenance_rule_templates
      WHERE is_active = true
      ORDER BY category, title, rule_code
    `
  );

  return result.rows.map(mapDbTemplate);
}

async function listMaintenanceRuleTemplates(client, { includeInactive = false } = {}) {
  const seedResult = await ensureTemplateCatalogSeeded(client);

  if (seedResult.missingTable) {
    return DEFAULT_MAINTENANCE_RULE_TEMPLATES.map((template, index) => ({
      ...template,
      id: `code:${index + 1}`,
      isActive: true,
      source: "code",
    }));
  }

  const result = await client.query(
    `
      SELECT *
      FROM maintenance_rule_templates
      WHERE ($1::boolean = true OR is_active = true)
      ORDER BY is_active DESC, category, title, rule_code
    `,
    [Boolean(includeInactive)]
  );

  return result.rows.map(mapDbTemplate);
}

async function createMaintenanceRuleTemplate(client, input) {
  await ensureTemplateCatalogSeeded(client);
  const normalized = normalizeRuleInput(input);

  try {
    const result = await client.query(
      `
        INSERT INTO maintenance_rule_templates (
          rule_code,
          title,
          description,
          category,
          interval_miles,
          interval_days,
          due_soon_miles,
          due_soon_days,
          blocks_rental_when_overdue,
          blocks_guest_export_when_overdue,
          requires_pass_result,
          rule_config,
          is_active,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12::jsonb,
          true,
          NOW(),
          NOW()
        )
        RETURNING *
      `,
      [
        normalized.ruleCode,
        normalized.title,
        normalized.description,
        normalized.category,
        normalized.intervalMiles,
        normalized.intervalDays,
        normalized.dueSoonMiles,
        normalized.dueSoonDays,
        normalized.blocksRentalWhenOverdue,
        normalized.blocksGuestExportWhenOverdue,
        normalized.requiresPassResult,
        JSON.stringify({
          custom_trackable: true,
          ...(normalized.ruleConfig || {}),
        }),
      ]
    );

    return mapDbTemplate(result.rows[0]);
  } catch (err) {
    if (err?.code === "23505") {
      const conflict = new Error(`Maintenance template already exists for ${normalized.ruleCode}`);
      conflict.statusCode = 409;
      throw conflict;
    }

    throw err;
  }
}

async function insertRuleIfMissing(client, vin, rule) {
  const result = await client.query(
    `
      INSERT INTO maintenance_rules (
        vehicle_vin,
        rule_code,
        title,
        description,
        category,
        interval_miles,
        interval_days,
        due_soon_miles,
        due_soon_days,
        blocks_rental_when_overdue,
        blocks_guest_export_when_overdue,
        requires_pass_result,
        is_active,
        rule_config,
        created_at,
        updated_at
      )
      SELECT
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        true,
        $13::jsonb,
        NOW(),
        NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM maintenance_rules
        WHERE vehicle_vin = $1
          AND rule_code = $2
      )
      RETURNING *
    `,
    [
      vin,
      rule.ruleCode,
      rule.title,
      rule.description,
      rule.category,
      rule.intervalMiles,
      rule.intervalDays,
      rule.dueSoonMiles,
      rule.dueSoonDays,
      rule.blocksRentalWhenOverdue,
      rule.blocksGuestExportWhenOverdue,
      rule.requiresPassResult,
      JSON.stringify(rule.ruleConfig || {}),
    ]
  );

  return result.rows[0] || null;
}

async function ensureDefaultMaintenanceRulesForVehicle(client, vin) {
  const cleanVin = cleanString(vin);
  if (!cleanVin) return [];

  const templates = await getActiveRuleTemplates(client);
  const inserted = [];
  for (const rule of templates) {
    const row = await insertRuleIfMissing(client, cleanVin, rule);
    if (row) inserted.push(row);
  }

  return inserted;
}

async function createCustomMaintenanceRule(client, vin, input) {
  const cleanVin = cleanString(vin);
  if (!cleanVin) {
    const err = new Error("Vehicle VIN is required");
    err.statusCode = 400;
    throw err;
  }

  const rule = normalizeRuleInput(input);
  const inserted = await insertRuleIfMissing(client, cleanVin, rule);

  if (!inserted) {
    const err = new Error(`Maintenance rule already exists for ${rule.ruleCode}`);
    err.statusCode = 409;
    throw err;
  }

  return inserted;
}

module.exports = {
  DEFAULT_MAINTENANCE_RULE_TEMPLATES,
  createMaintenanceRuleTemplate,
  createCustomMaintenanceRule,
  ensureDefaultMaintenanceRulesForVehicle,
  ensureTemplateCatalogSeeded,
  listMaintenanceRuleTemplates,
  normalizeRuleInput,
};
