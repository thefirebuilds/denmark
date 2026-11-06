const { estimateLaborHours, normalizeLaborHours } = require('./laborEstimates');
const HISTORY_LIMIT = 20;
const TASK_RULE_CODE_MAP = new Map([
  ["battery_voltage_inspection", "battery_test"],
  ["post_trip_brake_inspection", "brake_inspection"],
  ["post_trip_tread_depth_check", "tread_depth"],
  ["post_trip_tire_pressure_check", "tire_pressure_check"],
  ["post_trip_fluid_leak_check", "fluid_leak_check"],
  ["post_trip_oil_level_check", "fluid_leak_check"],
  ["post_trip_condition_review", "cleaning"],
  ["handoff_prep", "cleaning"],
  ["vehicle_prep", "cleaning"],
]);



async function suggestMaintenanceLabor(db, { ruleCode, title, task = null }) {
  const positive = value => { const hours = normalizeLaborHours(value); return hours > 0 ? hours : null; };
  if (task?.source === 'manual' || task?.task_type === 'manual_todo') {
    return { hours: normalizeLaborHours(task.actual_labor_hours) ?? normalizeLaborHours(task.estimated_labor_hours), source: 'task_estimate', sampleCount: 0 };
  }
  if (positive(task?.actual_labor_hours) != null) {
    return { hours: positive(task.actual_labor_hours), source: 'existing_actual', sampleCount: 0 };
  }
  const code = String(ruleCode || '').trim().toLowerCase();
  if (code) {
    const taskTypes = [code, ...[...TASK_RULE_CODE_MAP].filter(([, rule]) => rule === code).map(([type]) => type)];
    const { rows } = await db.query(`WITH samples AS (
      SELECT me.actual_labor_hours AS hours, me.performed_at AS completed_at, me.id, 'event' AS kind
      FROM maintenance_events me JOIN maintenance_rules r ON r.id = me.rule_id
      WHERE LOWER(r.rule_code) = $1 AND me.actual_labor_hours > 0
        AND COALESCE(me.status, 'completed') = 'completed' AND me.performed_at <= NOW()
        AND COALESCE(me.result, '') <> 'not_applicable'
      UNION ALL
      SELECT mt.actual_labor_hours, mt.updated_at, mt.id, 'task'
      FROM maintenance_tasks mt LEFT JOIN maintenance_rules r ON r.id = mt.rule_id
      WHERE mt.status = 'resolved' AND mt.actual_labor_hours > 0 AND mt.updated_at <= NOW()
        AND COALESCE(mt.source, '') <> 'manual' AND mt.task_type <> 'manual_todo'
        AND (LOWER(COALESCE(r.rule_code, NULLIF(mt.trigger_context->>'ruleCode', ''), mt.task_type)) = $1
          OR (r.rule_code IS NULL AND NULLIF(mt.trigger_context->>'ruleCode', '') IS NULL AND mt.task_type = ANY($3::text[])))
        AND NOT EXISTS (SELECT 1 FROM maintenance_events e
          WHERE e.data->>'completedTaskId' = mt.id::text AND e.actual_labor_hours > 0
            AND COALESCE(e.status, 'completed') = 'completed' AND e.performed_at <= NOW()
            AND COALESCE(e.result, '') <> 'not_applicable')
    ), recent AS (
      SELECT hours FROM samples ORDER BY completed_at DESC, id DESC, kind LIMIT $2
    ) SELECT AVG(hours) AS hours, COUNT(*)::int AS sample_count FROM recent`, [code, HISTORY_LIMIT, taskTypes]);
    const mean = positive(rows[0]?.hours);
    const count = Number(rows[0]?.sample_count || 0);
    if (mean != null && count > 0) return { hours: mean, source: 'historical_mean', sampleCount: count, ruleCode: code };
  }
  const estimate = positive(task?.estimated_labor_hours) ?? positive(estimateLaborHours({ ruleCode: code, title, taskType: task?.task_type }));
  return { hours: estimate, source: estimate == null ? 'unavailable' : 'task_estimate', sampleCount: 0, ruleCode: code || null };
}
module.exports = { suggestMaintenanceLabor, HISTORY_LIMIT, TASK_RULE_CODE_MAP };
