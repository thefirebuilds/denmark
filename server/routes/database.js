const express = require("express");
const zlib = require("zlib");
const db = require("../db");
const {
  getRequestMeta,
  logRequestActivity,
  logSystemActivity,
} = require("../services/systemActivityLog");

const router = express.Router();

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName) {
  return `${quoteIdent("public")}.${quoteIdent(tableName)}`;
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function getPublicTables(client) {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  return result.rows.map((row) => row.table_name);
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function getPrimaryKeyColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
       AND tc.table_name = kcu.table_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
    `,
    [tableName]
  );

  return result.rows.map((row) => row.column_name);
}

async function getForeignKeyDependencies(client, tables) {
  const result = await client.query(
    `
      SELECT
        tc.table_name AS child_table,
        ccu.table_name AS parent_table
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ANY($1::text[])
        AND ccu.table_name = ANY($1::text[])
    `,
    [tables]
  );

  const deps = new Map(tables.map((table) => [table, new Set()]));

  for (const row of result.rows) {
    if (row.child_table !== row.parent_table) {
      deps.get(row.child_table)?.add(row.parent_table);
    }
  }

  return deps;
}

function orderTablesByDependencies(tables, deps) {
  const remaining = new Set(tables);
  const ordered = [];

  while (remaining.size) {
    const ready = [...remaining]
      .filter((table) =>
        [...(deps.get(table) || [])].every((parent) => !remaining.has(parent))
      )
      .sort();

    if (!ready.length) {
      ordered.push(...[...remaining].sort());
      break;
    }

    ready.forEach((table) => {
      ordered.push(table);
      remaining.delete(table);
    });
  }

  return ordered;
}

function writeChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    const ok = res.write(chunk, (error) => {
      if (error) reject(error);
    });

    if (ok) {
      resolve();
      return;
    }

    res.once("drain", resolve);
    res.once("error", reject);
  });
}

async function streamBackup(res) {
  const client = await db.connect();
  const batchSize = 1000;

  try {
    const tables = await getPublicTables(client);
    const deps = await getForeignKeyDependencies(client, tables);
    const orderedTables = orderTablesByDependencies(tables, deps);

    await writeChunk(
      res,
      JSON.stringify({
        format: "denmark-postgres-json-backup",
        version: 2,
        capturedAt: new Date().toISOString(),
        database: process.env.PGDATABASE || "denmark",
      }).replace(/}$/, ',"tables":[')
    );

    for (let tableIndex = 0; tableIndex < orderedTables.length; tableIndex += 1) {
      const tableName = orderedTables[tableIndex];
      const columns = await getTableColumns(client, tableName);
      const primaryKeyColumns = await getPrimaryKeyColumns(client, tableName);
      const orderClause = primaryKeyColumns.length
        ? ` ORDER BY ${primaryKeyColumns.map(quoteIdent).join(", ")}`
        : "";

      if (tableIndex > 0) await writeChunk(res, ",");

      await writeChunk(
        res,
        `${JSON.stringify({
          name: tableName,
          columns,
        }).replace(/}$/, ',"rows":[')}`
      );

      let offset = 0;
      let wroteRow = false;

      while (true) {
        const rowsResult = await client.query(
          `
            SELECT ${columns.map(quoteIdent).join(", ")}
            FROM ${qualifiedTable(tableName)}
            ${orderClause}
            LIMIT $1 OFFSET $2
          `,
          [batchSize, offset]
        );

        if (!rowsResult.rows.length) break;

        for (const row of rowsResult.rows) {
          if (wroteRow) await writeChunk(res, ",");
          await writeChunk(res, JSON.stringify(row));
          wroteRow = true;
        }

        offset += rowsResult.rows.length;
        if (rowsResult.rows.length < batchSize) break;
      }

      await writeChunk(res, "]}");
    }

    await writeChunk(res, "]}");
    res.end();
  } finally {
    client.release();
  }
}

async function buildBackup() {
  const client = await db.connect();

  try {
    const tables = await getPublicTables(client);
    const deps = await getForeignKeyDependencies(client, tables);
    const orderedTables = orderTablesByDependencies(tables, deps);
    const tablePayloads = [];

    for (const tableName of orderedTables) {
      const columns = await getTableColumns(client, tableName);
      const rowsResult = await client.query(
        `SELECT ${columns.map(quoteIdent).join(", ")} FROM ${qualifiedTable(tableName)}`
      );

      tablePayloads.push({
        name: tableName,
        columns,
        rows: rowsResult.rows,
      });
    }

    return {
      format: "denmark-postgres-json-backup",
      version: 1,
      capturedAt: new Date().toISOString(),
      database: process.env.PGDATABASE || "denmark",
      tables: tablePayloads,
    };
  } finally {
    client.release();
  }
}

async function resetSequences(client, tableName) {
  const result = await client.query(
    `
      SELECT
        c.column_name,
        pg_get_serial_sequence($1, c.column_name) AS sequence_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = $2
        AND pg_get_serial_sequence($1, c.column_name) IS NOT NULL
    `,
    [`public.${tableName}`, tableName]
  );

  for (const row of result.rows) {
    await client.query(
      `
        SELECT setval(
          $1,
          COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${qualifiedTable(
        tableName
      )}), 1),
          COALESCE((SELECT MAX(${quoteIdent(row.column_name)}) FROM ${qualifiedTable(
        tableName
      )}), 0) > 0
        )
      `,
      [row.sequence_name]
    );
  }
}

async function restoreBackup(backup) {
  if (backup?.format !== "denmark-postgres-json-backup") {
    const err = new Error("Unsupported backup format");
    err.status = 400;
    throw err;
  }

  if (!Array.isArray(backup.tables)) {
    const err = new Error("Backup is missing table data");
    err.status = 400;
    throw err;
  }

  const client = await db.connect();

  try {
    const currentTables = await getPublicTables(client);
    const currentTableSet = new Set(currentTables);
    const backupTables = backup.tables.filter((table) =>
      currentTableSet.has(table?.name)
    );
    const deps = await getForeignKeyDependencies(
      client,
      backupTables.map((table) => table.name)
    );
    const restoreOrder = orderTablesByDependencies(
      backupTables.map((table) => table.name),
      deps
    );
    const tableByName = new Map(backupTables.map((table) => [table.name, table]));

    await client.query("BEGIN");

    if (currentTables.length) {
      await client.query(
        `TRUNCATE ${currentTables.map(qualifiedTable).join(", ")} RESTART IDENTITY CASCADE`
      );
    }

    let restoredRows = 0;

    for (const tableName of restoreOrder) {
      const table = tableByName.get(tableName);
      const columns = Array.isArray(table?.columns) ? table.columns : [];
      const rows = Array.isArray(table?.rows) ? table.rows : [];

      if (!columns.length || !rows.length) continue;

      const insertSql = `
        INSERT INTO ${qualifiedTable(tableName)}
          (${columns.map(quoteIdent).join(", ")})
        VALUES
          (${columns.map((_, index) => `$${index + 1}`).join(", ")})
      `;

      for (const row of rows) {
        await client.query(
          insertSql,
          columns.map((column) => row[column])
        );
        restoredRows += 1;
      }

      await resetSequences(client, tableName);
    }

    await client.query("COMMIT");

    return {
      restoredTables: backupTables.length,
      restoredRows,
      skippedTables: backup.tables.length - backupTables.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => null);
    throw err;
  } finally {
    client.release();
  }
}

router.get("/backup", async (req, res) => {
  const compressed =
    String(req.query.compress || req.query.format || "").toLowerCase() === "gzip";
  const filename = `denmark-db-backup-${isoStamp()}.json${compressed ? ".gz" : ""}`;

  try {
    await logRequestActivity(req, {
      category: "database",
      eventType: "database_backup_started",
      severity: "notice",
      subjectType: "database",
      subjectId: process.env.PGDATABASE || "denmark",
      subjectLabel: process.env.PGDATABASE || "denmark",
      source: "database.backup",
      details: {
        compressed,
        filename,
      },
    }).catch(() => null);

    res.setHeader("Content-Type", compressed ? "application/gzip" : "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    if (!compressed) {
      await streamBackup(res);
      return;
    }

    const gzip = zlib.createGzip({ level: 9 });
    gzip.on("error", (error) => res.destroy(error));
    gzip.pipe(res);
    await streamBackup(gzip);
  } catch (err) {
    console.error("database backup failed:", err);
    await logRequestActivity(req, {
      category: "database",
      eventType: "database_backup_failed",
      severity: "error",
      outcome: "failure",
      subjectType: "database",
      subjectId: process.env.PGDATABASE || "denmark",
      source: "database.backup",
      details: {
        compressed,
        filename,
        error: err.message || String(err),
      },
    }).catch(() => null);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Database backup failed" });
      return;
    }

    res.destroy(err);
  }
});

router.post("/restore", async (req, res) => {
  try {
    if (req.body?.confirm !== "RESTORE") {
      return res.status(400).json({ error: "Type RESTORE to confirm restore" });
    }

    const result = await restoreBackup(req.body.backup);
    const requestMeta = getRequestMeta(req);
    await logSystemActivity({
      ...requestMeta,
      actorUserId: null,
      category: "database",
      eventType: "database_restore_completed",
      severity: "warning",
      subjectType: "database",
      subjectId: process.env.PGDATABASE || "denmark",
      subjectLabel: process.env.PGDATABASE || "denmark",
      source: "database.restore",
      details: {
        backupCapturedAt: req.body?.backup?.capturedAt || null,
        backupVersion: req.body?.backup?.version || null,
        ...result,
      },
    }).catch(() => null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("database restore failed:", err);
    const requestMeta = getRequestMeta(req);
    await logSystemActivity({
      ...requestMeta,
      actorUserId: null,
      category: "database",
      eventType: "database_restore_failed",
      severity: "error",
      outcome: "failure",
      subjectType: "database",
      subjectId: process.env.PGDATABASE || "denmark",
      source: "database.restore",
      details: {
        backupCapturedAt: req.body?.backup?.capturedAt || null,
        error: err.message || String(err),
      },
    }).catch(() => null);
    res
      .status(err.status || 500)
      .json({ error: err.message || "Database restore failed" });
  }
});

module.exports = router;
