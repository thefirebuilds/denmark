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
              )
          )
          OR (
            mt.task_type = 'trip_projection_maintenance_risk'
            AND (
              mt.rule_id = ANY($4::bigint[])
              OR lower(COALESCE(mt.trigger_context->>'ruleCode', '')) = ANY($5::text[])
            )
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

module.exports = {
  ACTIVE_TASK_STATUSES,
  SATISFYING_RESULTS,
  closeSatisfiedMaintenanceTasks,
};
