// Helper functions for maintenance task management

const pool = require("../../db");

async function findOpenTaskBySignature(
  client,
  {
    vehicleVin,
    taskType,
    ruleId = null,
    relatedTripId = null,
    triggerType = null,
    sourceKey = null,
  }
) {
  if (sourceKey) {
    const bySourceKey = await client.query(
      `
        SELECT *
        FROM maintenance_tasks
        WHERE source_key = $1
        LIMIT 1
      `,
      [sourceKey]
    );

    return bySourceKey.rows[0] || null;
  }

  const result = await client.query(
    `
      SELECT *
      FROM maintenance_tasks
      WHERE vehicle_vin = $1
        AND task_type = $2
        AND (
          ($3::bigint IS NULL AND rule_id IS NULL)
          OR rule_id = $3
        )
        AND (
          ($4::bigint IS NULL AND related_trip_id IS NULL)
          OR related_trip_id = $4
        )
        AND (
          ($5::text IS NULL AND trigger_type IS NULL)
          OR trigger_type = $5
        )
        AND status IN ('open', 'scheduled', 'in_progress', 'deferred')
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [vehicleVin, taskType, ruleId, relatedTripId, triggerType]
  );

  return result.rows[0] || null;
}

async function createTaskIfMissing(
  clientOrArgs,
  maybeArgs = null
) {
  const client = maybeArgs ? clientOrArgs : pool;
  const args = maybeArgs || clientOrArgs;

  const {
    vehicleVin,
    ruleId = null,
    relatedEventId = null,
    relatedTripId = null,
    taskType,
    title,
    description = null,
    priority = "medium",
    status = "open",
    scheduledFor = null,
    dueBy = null,
    blocksRental = false,
    blocksGuestExport = false,
    needsReview = false,
    source = "system",
    triggerType = null,
    triggerContext = {},
    sourceKey = null,
  } = args;

  if (!vehicleVin) {
    throw new Error("createTaskIfMissing requires vehicleVin");
  }

  if (!taskType) {
    throw new Error("createTaskIfMissing requires taskType");
  }

  if (!title) {
    throw new Error("createTaskIfMissing requires title");
  }

  if (sourceKey) {
    const result = await client.query(
      `
        INSERT INTO maintenance_tasks (
          vehicle_vin,
          rule_id,
          related_event_id,
          related_trip_id,
          task_type,
          title,
          description,
          priority,
          status,
          scheduled_for,
          due_by,
          blocks_rental,
          blocks_guest_export,
          needs_review,
          source,
          trigger_type,
          trigger_context,
          source_key
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17::jsonb, $18
        )
        ON CONFLICT (source_key) DO NOTHING
        RETURNING *
      `,
      [
        vehicleVin,
        ruleId,
        relatedEventId,
        relatedTripId,
        taskType,
        title,
        description,
        priority,
        status,
        scheduledFor,
        dueBy,
        blocksRental,
        blocksGuestExport,
        needsReview,
        source,
        triggerType,
        JSON.stringify(triggerContext || {}),
        sourceKey,
      ]
    );

    if (result.rows[0]) {
      return {
        task: result.rows[0],
        created: true,
      };
    }

    const existing = await client.query(
      `
        SELECT *
        FROM maintenance_tasks
        WHERE source_key = $1
        LIMIT 1
      `,
      [sourceKey]
    );

    return {
      task: existing.rows[0] || null,
      created: false,
    };
  }

  const existing = await findOpenTaskBySignature(client, {
    vehicleVin,
    taskType,
    ruleId,
    relatedTripId,
    triggerType,
    sourceKey,
  });

  if (existing) {
    return {
      task: existing,
      created: false,
    };
  }

  const result = await client.query(
    `
      INSERT INTO maintenance_tasks (
        vehicle_vin,
        rule_id,
        related_event_id,
        related_trip_id,
        task_type,
        title,
        description,
        priority,
        status,
        scheduled_for,
        due_by,
        blocks_rental,
        blocks_guest_export,
        needs_review,
        source,
        trigger_type,
        trigger_context,
        source_key
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, $17::jsonb, $18
      )
      RETURNING *
    `,
    [
      vehicleVin,
      ruleId,
      relatedEventId,
      relatedTripId,
      taskType,
      title,
      description,
      priority,
      status,
      scheduledFor,
      dueBy,
      blocksRental,
      blocksGuestExport,
      needsReview,
      source,
      triggerType,
      JSON.stringify(triggerContext || {}),
      sourceKey,
    ]
  );

  return {
    task: result.rows[0],
    created: true,
  };
}

module.exports = {
  findOpenTaskBySignature,
  createTaskIfMissing,
};