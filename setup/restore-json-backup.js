#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");

function requireAppDependency(name) {
  try {
    return require(name);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
    return require(path.join(ROOT_DIR, "server/node_modules", name));
  }
}

requireAppDependency("dotenv").config({ path: path.join(ROOT_DIR, ".env") });
const { chain } = requireAppDependency("stream-chain");
const { parser } = requireAppDependency("stream-json");
const pool = require("../server/db");
const {
  ensureVehicleIdentityConstraints,
} = require("../server/services/vehicles/vehicleIdentityConstraints");
const {
  ensureApplicationUniqueConstraints,
} = require("../server/services/database/applicationUniqueConstraints");

const DEFAULT_BATCH_SIZE = Number(process.env.JSON_RESTORE_BATCH_SIZE || 500);

function usage() {
  console.error(
    "Usage: npm run db:restore-json -- /app/imports/backup.json --force"
  );
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName) {
  return `${quoteIdent("public")}.${quoteIdent(tableName)}`;
}

function getTokenValue(token) {
  if (token.name === "nullValue") return null;
  if (token.name === "trueValue") return true;
  if (token.name === "falseValue") return false;
  return token.value;
}

function isScalarValue(token) {
  return (
    token.name === "stringValue" ||
    token.name === "numberValue" ||
    token.name === "nullValue" ||
    token.name === "trueValue" ||
    token.name === "falseValue"
  );
}

function addNestedValue(stack, value) {
  const parent = stack[stack.length - 1];
  if (!parent) return;

  if (Array.isArray(parent.value)) {
    parent.value.push(value);
    return;
  }

  parent.value[parent.key] = value;
  parent.key = null;
}

function consumeNestedToken(token, state) {
  if (token.name === "keyValue") {
    const parent = state.stack[state.stack.length - 1];
    if (parent && !Array.isArray(parent.value)) parent.key = token.value;
    return null;
  }

  if (token.name === "startObject" || token.name === "startArray") {
    const value = token.name === "startObject" ? {} : [];
    if (!state.stack.length) state.root = value;
    else addNestedValue(state.stack, value);
    state.stack.push({ value, key: null });
    return null;
  }

  if (isScalarValue(token)) {
    addNestedValue(state.stack, getTokenValue(token));
    return null;
  }

  if (token.name === "endObject" || token.name === "endArray") {
    state.stack.pop();
    return state.stack.length === 0 ? state.root : null;
  }

  return null;
}

async function getPublicTables(client) {
  const { rows } = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  return rows.map((row) => row.table_name);
}

async function getTableColumns(client, tableName) {
  const { rows } = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );

  return rows.map((row) => row.column_name);
}

async function resetSequences(client, tableName) {
  const { rows } = await client.query(
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

  for (const row of rows) {
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

async function truncateCurrentTables(client) {
  const tables = await getPublicTables(client);
  if (!tables.length) return;

  console.log(`[json-restore] truncating ${tables.length} public tables`);
  await client.query(
    `TRUNCATE ${tables.map(qualifiedTable).join(", ")} RESTART IDENTITY CASCADE`
  );
}

async function insertBatch(client, tableName, columns, rows) {
  if (!rows.length || !columns.length) return 0;

  const values = [];
  const placeholders = rows.map((row, rowIndex) => {
    const cells = columns.map((column, columnIndex) => {
      values.push(row[column] ?? null);
      return `$${rowIndex * columns.length + columnIndex + 1}`;
    });
    return `(${cells.join(", ")})`;
  });

  await client.query(
    `
      INSERT INTO ${qualifiedTable(tableName)}
        (${columns.map(quoteIdent).join(", ")})
      VALUES ${placeholders.join(", ")}
    `,
    values
  );

  return rows.length;
}

async function restoreJsonBackup(filePath) {
  const absolutePath = path.resolve(filePath);
  await fs.promises.access(absolutePath, fs.constants.R_OK);

  const client = await pool.connect();
  const currentTables = new Set();
  const tableColumns = new Map();

  try {
    for (const table of await getPublicTables(client)) {
      currentTables.add(table);
      tableColumns.set(table, new Set(await getTableColumns(client, table)));
    }

    await truncateCurrentTables(client);

    let inTables = false;
    let inTable = false;
    let inColumns = false;
    let inRows = false;
    let inRow = false;
    let key = null;
    let tableName = null;
    let backupColumns = [];
    let insertColumns = [];
    let rowState = null;
    let batch = [];
    let totalRows = 0;
    let tableRows = 0;
    let restoredTables = 0;
    let skippedTables = 0;

    async function flushBatch() {
      if (!batch.length || !tableName || !currentTables.has(tableName)) {
        batch = [];
        return;
      }

      const inserted = await insertBatch(client, tableName, insertColumns, batch);
      totalRows += inserted;
      tableRows += inserted;
      batch = [];

      if (tableRows > 0 && tableRows % 5000 === 0) {
        console.log(`[json-restore] ${tableName}: ${tableRows} rows`);
      }
    }

    const pipeline = chain([
      fs.createReadStream(absolutePath),
      parser({
        packKeys: true,
        packStrings: true,
        packNumbers: true,
      }),
    ]);

    for await (const token of pipeline) {
      if (inRow) {
        const completedRow = consumeNestedToken(token, rowState);
        if (completedRow) {
          inRow = false;
          if (currentTables.has(tableName) && insertColumns.length) {
            batch.push(completedRow);
            const maxBatchSize = Math.max(
              1,
              Math.min(DEFAULT_BATCH_SIZE, Math.floor(60000 / insertColumns.length))
            );
            if (batch.length >= maxBatchSize) await flushBatch();
          }
          rowState = null;
        }
        continue;
      }

      if (token.name === "keyValue") {
        key = token.value;
        continue;
      }

      if (token.name === "startArray" && key === "tables" && !inTables) {
        inTables = true;
        key = null;
        continue;
      }

      if (inTables && !inTable && token.name === "startObject") {
        inTable = true;
        tableName = null;
        backupColumns = [];
        insertColumns = [];
        tableRows = 0;
        key = null;
        continue;
      }

      if (inTable && token.name === "startArray" && key === "columns") {
        inColumns = true;
        key = null;
        continue;
      }

      if (inColumns && isScalarValue(token)) {
        backupColumns.push(String(getTokenValue(token)));
        continue;
      }

      if (inColumns && token.name === "endArray") {
        inColumns = false;
        continue;
      }

      if (inTable && token.name === "startArray" && key === "rows") {
        inRows = true;
        key = null;
        if (!currentTables.has(tableName)) {
          skippedTables += 1;
          console.log(`[json-restore] skipping missing table ${tableName}`);
        } else {
          const currentColumnSet = tableColumns.get(tableName) || new Set();
          insertColumns = backupColumns.filter((column) => currentColumnSet.has(column));
          restoredTables += 1;
          console.log(
            `[json-restore] restoring ${tableName} (${insertColumns.length}/${backupColumns.length} columns)`
          );
        }
        continue;
      }

      if (inRows && !inRow && token.name === "startObject") {
        inRow = true;
        rowState = { root: null, stack: [] };
        consumeNestedToken(token, rowState);
        continue;
      }

      if (inRows && token.name === "endArray") {
        await flushBatch();
        if (currentTables.has(tableName)) {
          await resetSequences(client, tableName);
          console.log(`[json-restore] restored ${tableName}: ${tableRows} rows`);
        }
        inRows = false;
        continue;
      }

      if (inTable && !inRows && !inColumns && isScalarValue(token)) {
        if (key === "name") tableName = String(getTokenValue(token));
        key = null;
        continue;
      }

      if (inTable && !inRows && token.name === "endObject") {
        inTable = false;
        tableName = null;
        backupColumns = [];
        insertColumns = [];
        key = null;
      }
    }

    console.log("[json-restore] repairing restored schema");
    await ensureVehicleIdentityConstraints(client);
    await ensureApplicationUniqueConstraints(client, {
      log(message) {
        console.log(message.replace("[db:schema]", "[json-restore]"));
      },
    });

    console.log(
      `[json-restore] complete | tables=${restoredTables} skipped=${skippedTables} rows=${totalRows}`
    );
  } finally {
    client.release();
  }
}

async function main() {
  const filePath = process.argv[2];
  const force = process.argv.includes("--force");

  if (!filePath || !force) {
    usage();
    process.exitCode = 2;
    return;
  }

  try {
    console.log(`[json-restore] reading ${path.resolve(filePath)}`);
    await restoreJsonBackup(filePath);
  } catch (error) {
    console.error("[json-restore] failed:", error.message || error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
