const SATISFYING_RESULTS = ["pass", "performed", "measured", "not_applicable"];
const ACTIVE_TASK_STATUSES = ["open", "scheduled", "in_progress", "deferred"];

function normalizeRuleCode(value) {
  return String(value || "").trim().toLowerCase();
}

function buildOkRuleLookup(ruleStatuses = []) {
  const okRuleCodes = new Set();
  const okRuleIds = new Set();

  for (const rule of Array.isArray(ruleStatuses) ? ruleStatuses : []) {
    if (String(rule?.status || "").toLowerCase() !== "ok") continue;

    const ruleCode = normalizeRuleCode(rule?.ruleCode || rule?.rule_code);
    if (ruleCode) okRuleCodes.add(ruleCode);

    const ruleId = Number(rule?.ruleId || rule?.rule_id || rule?.id);
    if (Number.isFinite(ruleId)) okRuleIds.add(ruleId);
  }

  return {
    okRuleCodes: Array.from(okRuleCodes),
    okRuleIds: Array.from(okRuleIds),
  };
}

function getRuleCodeForTaskSql(
  taskTypeExpression = "mt.task_type",
  titleExpression = "mt.title"
) {
  return `
    CASE
      WHEN ${taskTypeExpression} = 'battery_voltage_inspection'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%battery%'
        THEN 'battery_test'
      WHEN ${taskTypeExpression} = 'post_trip_brake_inspection'
        OR lower(COALESCE(${taskTypeExpression}, '')) LIKE '%brake%'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%brake%'
        THEN 'brake_inspection'
      WHEN ${taskTypeExpression} = 'post_trip_tread_depth_check'
        OR lower(COALESCE(${taskTypeExpression}, '')) LIKE '%tread%'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%tread%'
        THEN 'tread_depth'
      WHEN ${taskTypeExpression} = 'post_trip_tire_pressure_check'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%tire pressure%'
        THEN 'tire_pressure_check'
      WHEN ${taskTypeExpression} = 'post_trip_fluid_leak_check'
        OR ${taskTypeExpression} = 'post_trip_oil_level_check'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%fluid%'
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%leak%'
        THEN 'fluid_leak_check'
      WHEN ${taskTypeExpression} IN (
          'post_trip_condition_review',
          'handoff_prep',
          'vehicle_prep'
        )
        OR lower(COALESCE(${titleExpression}, '')) LIKE '%clean%'
        THEN 'cleaning'
      ELSE NULL
    END
  `;
}

async function closeSatisfiedMaintenanceTasks(client, vehicleVin, options = {}) {
  const vin = String(vehicleVin || "").trim();
  if (!vin) return { closedRuleTaskCount: 0, closedObjectiveTaskCount: 0 };

  const { okRuleCodes, okRuleIds } = buildOkRuleLookup(options.ruleStatuses);

  const linkedRuleResult = await client.query(
    `
      UPDATE maintenance_tasks mt
      SET
        status = 'resolved',
        updated_at = NOW()
      WHERE mt.vehicle_vin = $1
        AND mt.status = ANY($2::text[])
        AND COALESCE(mt.source, '') <> 'manual'
        AND COALESCE(mt.trigger_type, '') <> 'manual'
        AND COALESCE(mt.task_type, '') <> 'manual_todo'
        AND (
          EXISTS (
            SELECT 1
            FROM maintenance_events me
            LEFT JOIN maintenance_rules mr
              ON mr.id = me.rule_id
            WHERE me.vehicle_vin = mt.vehicle_vin
              AND me.result = ANY($3::text[])
              AND COALESCE(me.performed_at, me.created_at) >= mt.created_at
              AND (
                mt.rule_id = me.rule_id
                OR (
                  COALESCE(mt.trigger_context->>'ruleCode', '') <> ''
                  AND mr.rule_code = mt.trigger_context->>'ruleCode'
                )
                OR mr.rule_code = ${getRuleCodeForTaskSql("mt.task_type", "mt.title")}
              )
          )
          OR (
            mt.rule_id = ANY($4::bigint[])
            OR lower(COALESCE(mt.trigger_context->>'ruleCode', '')) = ANY($5::text[])
            OR ${getRuleCodeForTaskSql("mt.task_type", "mt.title")} = ANY($5::text[])
          )
        )
    `,
    [
      vin,
      ACTIVE_TASK_STATUSES,
      SATISFYING_RESULTS,
      okRuleIds,
      okRuleCodes,
    ]
  );

  const objectiveResult = await client.query(
    `
      UPDATE maintenance_tasks mt
      SET
        status = 'resolved',
        updated_at = NOW()
      WHERE mt.vehicle_vin = $1
        AND mt.status = ANY($2::text[])
        AND mt.rule_id IS NULL
        AND mt.task_type IN (
          'post_trip_condition_review',
          'handoff_prep',
          'maintenance_planning',
          'vehicle_prep'
        )
        AND EXISTS (
          SELECT 1
          FROM maintenance_events me
          WHERE me.vehicle_vin = mt.vehicle_vin
            AND me.result = ANY($3::text[])
            AND COALESCE(me.performed_at, me.created_at) >= COALESCE(
              NULLIF(mt.trigger_context->>'tripEnd', '')::timestamp,
              mt.created_at
            )
        )
    `,
    [vin, ACTIVE_TASK_STATUSES, SATISFYING_RESULTS]
  );

  return {
    closedRuleTaskCount: Number(linkedRuleResult.rowCount || 0),
    closedObjectiveTaskCount: Number(objectiveResult.rowCount || 0),
  };
}

async function cancelDuplicateRuleTasks(client, vehicleVin) {
  const vin = String(vehicleVin || "").trim();
  if (!vin) return { canceledDuplicateTaskCount: 0 };

  const result = await client.query(
    `
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY vehicle_vin, rule_id
            ORDER BY created_at ASC, id ASC
          ) AS duplicate_rank
        FROM maintenance_tasks
        WHERE vehicle_vin = $1
          AND rule_id IS NOT NULL
          AND status = ANY($2::text[])
      )
      UPDATE maintenance_tasks mt
      SET
        status = 'canceled',
        updated_at = NOW(),
        trigger_context = mt.trigger_context || jsonb_build_object(
          'canceledAsDuplicate', true,
          'canceledAsDuplicateAt', NOW()
        )
      FROM ranked
      WHERE mt.id = ranked.id
        AND ranked.duplicate_rank > 1
    `,
    [vin, ACTIVE_TASK_STATUSES]
  );

  return {
    canceledDuplicateTaskCount: Number(result.rowCount || 0),
  };
}

module.exports = {
  ACTIVE_TASK_STATUSES,
  SATISFYING_RESULTS,
  cancelDuplicateRuleTasks,
  closeSatisfiedMaintenanceTasks,
};
