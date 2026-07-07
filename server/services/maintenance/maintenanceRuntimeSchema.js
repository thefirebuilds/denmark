const pool = require("../../db");

let ensureMaintenanceRuntimeSchemaPromise = null;

async function ensureMaintenanceRuntimeSchema(client = pool) {
  if (!ensureMaintenanceRuntimeSchemaPromise) {
    const schemaClient = client === pool ? client : pool;
    ensureMaintenanceRuntimeSchemaPromise = (async () => {
      await schemaClient.query(`
        ALTER TABLE public.maintenance_tasks
          ADD COLUMN IF NOT EXISTS estimated_labor_hours NUMERIC(8,3),
          ADD COLUMN IF NOT EXISTS actual_labor_hours NUMERIC(8,3);
      `);

      await schemaClient.query(`
        ALTER TABLE public.maintenance_events
          ADD COLUMN IF NOT EXISTS estimated_labor_hours NUMERIC(8,3),
          ADD COLUMN IF NOT EXISTS actual_labor_hours NUMERIC(8,3),
          ADD COLUMN IF NOT EXISTS vendor TEXT,
          ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2),
          ADD COLUMN IF NOT EXISTS expense_id BIGINT,
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
      `);

      await schemaClient.query(`
        ALTER TABLE public.vehicle_odometer_history
          ADD COLUMN IF NOT EXISTS trip_id BIGINT,
          ADD COLUMN IF NOT EXISTS reservation_id BIGINT,
          ADD COLUMN IF NOT EXISTS note TEXT,
          ADD COLUMN IF NOT EXISTS is_correction BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP;
      `);

      await schemaClient.query(`
        CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_labor_missing
          ON public.maintenance_tasks (status, updated_at DESC)
          WHERE estimated_labor_hours IS NULL AND actual_labor_hours IS NULL;
      `);

      await schemaClient.query(`
        CREATE INDEX IF NOT EXISTS idx_maintenance_events_labor_missing
          ON public.maintenance_events (performed_at DESC)
          WHERE estimated_labor_hours IS NULL AND actual_labor_hours IS NULL;
      `);

      await schemaClient.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_history_vehicle_recorded
          ON public.vehicle_odometer_history (vehicle_id, recorded_at DESC, id DESC);
      `);

      await schemaClient.query(`
        CREATE INDEX IF NOT EXISTS idx_vehicle_odometer_history_trip
          ON public.vehicle_odometer_history (trip_id)
          WHERE trip_id IS NOT NULL;
      `);

      await schemaClient.query(`
        CREATE INDEX IF NOT EXISTS idx_maintenance_events_status
          ON public.maintenance_events (status, performed_at DESC);
      `);

      await schemaClient.query(`
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

      await schemaClient.query(`
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

      await schemaClient.query(`
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
