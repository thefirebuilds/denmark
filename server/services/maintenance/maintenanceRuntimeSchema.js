const pool = require("../../db");

let ensureMaintenanceRuntimeSchemaPromise = null;

async function ensureMaintenanceRuntimeSchema(client = pool) {
  if (!ensureMaintenanceRuntimeSchemaPromise) {
    ensureMaintenanceRuntimeSchemaPromise = (async () => {
      await client.query(`
        ALTER TABLE public.maintenance_tasks
          ADD COLUMN IF NOT EXISTS estimated_labor_hours NUMERIC(8,3),
          ADD COLUMN IF NOT EXISTS actual_labor_hours NUMERIC(8,3);
      `);

      await client.query(`
        ALTER TABLE public.maintenance_events
          ADD COLUMN IF NOT EXISTS estimated_labor_hours NUMERIC(8,3),
          ADD COLUMN IF NOT EXISTS actual_labor_hours NUMERIC(8,3);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_labor_missing
          ON public.maintenance_tasks (status, updated_at DESC)
          WHERE estimated_labor_hours IS NULL AND actual_labor_hours IS NULL;
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_maintenance_events_labor_missing
          ON public.maintenance_events (performed_at DESC)
          WHERE estimated_labor_hours IS NULL AND actual_labor_hours IS NULL;
      `);

      await client.query(`
        UPDATE public.maintenance_tasks
        SET estimated_labor_hours = CASE
          WHEN title ~* '(check\\s+oil|oil\\s+level)' THEN 0.083
          WHEN title ~* '(check\\s+tire|tire\\s+pressure)' THEN 0.083
          WHEN title ~* '(change\\s+oil|oil\\s+change)' THEN 0.75
          WHEN title ~* '(install\\s+tire|tire\\s+install|replace\\s+tire)' THEN 2
          WHEN title ~* '(clean|turnaround|turn\\s+clean)' THEN 1
          WHEN title ~* '(lights?\\s+check|headlights?|taillights?)' THEN 0.167
          ELSE estimated_labor_hours
        END
        WHERE estimated_labor_hours IS NULL;
      `);

      await client.query(`
        UPDATE public.maintenance_events me
        SET estimated_labor_hours = CASE
          WHEN COALESCE(mr.rule_code, me.event_type, '') = 'cleaning' THEN 1
          WHEN COALESCE(mr.rule_code, me.event_type, '') = 'oil_change' THEN 0.75
          WHEN COALESCE(mr.rule_code, me.event_type, '') = 'tire_pressure_check' THEN 0.083
          WHEN COALESCE(mr.rule_code, me.event_type, '') = 'fluid_leak_check' THEN 0.083
          WHEN COALESCE(mr.rule_code, me.event_type, '') = 'lights_check' THEN 0.167
          WHEN me.title ~* '(check\\s+oil|oil\\s+level)' THEN 0.083
          WHEN me.title ~* '(check\\s+tire|tire\\s+pressure)' THEN 0.083
          WHEN me.title ~* '(change\\s+oil|oil\\s+change)' THEN 0.75
          WHEN me.title ~* '(install\\s+tire|tire\\s+install|replace\\s+tire)' THEN 2
          WHEN me.title ~* '(clean|turnaround|turn\\s+clean)' THEN 1
          WHEN me.title ~* '(lights?\\s+check|headlights?|taillights?)' THEN 0.167
          ELSE me.estimated_labor_hours
        END
        FROM public.maintenance_rules mr
        WHERE me.rule_id = mr.id
          AND me.estimated_labor_hours IS NULL;
      `);

      await client.query(`
        UPDATE public.maintenance_events
        SET estimated_labor_hours = CASE
          WHEN event_type = 'cleaning' THEN 1
          WHEN event_type = 'oil_change' THEN 0.75
          WHEN event_type = 'tire_pressure_check' THEN 0.083
          WHEN event_type = 'fluid_leak_check' THEN 0.083
          WHEN event_type = 'lights_check' THEN 0.167
          WHEN title ~* '(check\\s+oil|oil\\s+level)' THEN 0.083
          WHEN title ~* '(check\\s+tire|tire\\s+pressure)' THEN 0.083
          WHEN title ~* '(change\\s+oil|oil\\s+change)' THEN 0.75
          WHEN title ~* '(install\\s+tire|tire\\s+install|replace\\s+tire)' THEN 2
          WHEN title ~* '(clean|turnaround|turn\\s+clean)' THEN 1
          WHEN title ~* '(lights?\\s+check|headlights?|taillights?)' THEN 0.167
          ELSE estimated_labor_hours
        END
        WHERE rule_id IS NULL
          AND estimated_labor_hours IS NULL;
      `);
    })().catch((err) => {
      ensureMaintenanceRuntimeSchemaPromise = null;
      throw err;
    });
  }

  return ensureMaintenanceRuntimeSchemaPromise;
}

module.exports = {
  ensureMaintenanceRuntimeSchema,
};
