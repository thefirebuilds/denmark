const express = require("express");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const db = require("../db");
const {
  markDatabaseReady,
} = require("../dbHealth");
const {
  getRequestMeta,
  logRequestActivity,
  logSystemActivity,
} = require("../services/systemActivityLog");
const {
  ensureVehicleIdentityConstraints,
} = require("../services/vehicles/vehicleIdentityConstraints");
const {
  ensureApplicationUniqueConstraints,
} = require("../services/database/applicationUniqueConstraints");

const router = express.Router();
const IMPORT_DIR = path.resolve(
  process.env.DATABASE_IMPORT_DIR || path.join(__dirname, "../../imports")
);
const IMPORT_MAX_BYTES = Number(process.env.DATABASE_IMPORT_MAX_BYTES || 5 * 1024 * 1024 * 1024);
const activeImportJobs = new Set();
const activeRestoreJobs = new Set();
const IMPORT_JOB_STATUSES = [
  "queued",
  "downloading",
  "downloaded",
  "validating",
  "validated",
  "validation_failed",
  "restoring",
  "restored",
  "failed",
];
const BACKUP_IMPORTANT_TABLES = [
  "vehicles",
  "trips",
  "messages",
  "vehicle_telemetry_snapshots",
  "maintenance_tasks",
  "maintenance_events",
  "expenses",
  "notification_events",
  "app_settings",
  "google_calendar_connections",
];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function qualifiedTable(tableName) {
  return `${quoteIdent("public")}.${quoteIdent(tableName)}`;
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function cleanFilename(value, fallback = "denmark-backup.dump") {
  const cleaned = String(value || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);

  return cleaned || fallback;
}

function truncateText(value, maxLength = 12000) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...[truncated ${text.length - maxLength} chars]`;
}

async function getTenantDataSummary(client = db) {
  const { rows: existingRows } = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name = ANY($1::text[])
    `,
    [BACKUP_IMPORTANT_TABLES]
  );
  const existing = new Set(existingRows.map((row) => row.table_name));
  const tableCounts = [];

  for (const tableName of BACKUP_IMPORTANT_TABLES) {
    if (!existing.has(tableName)) {
      tableCounts.push({ table: tableName, exists: false, rows: null });
      continue;
    }

    const { rows } = await client.query(
      `SELECT COUNT(*)::bigint AS count FROM ${qualifiedTable(tableName)}`
    );
    tableCounts.push({
      table: tableName,
      exists: true,
      rows: Number(rows[0]?.count || 0),
    });
  }

  return {
    database: process.env.PGDATABASE || "denmark",
    capturedAt: new Date().toISOString(),
    tables: tableCounts,
    totalRows: tableCounts.reduce(
      (sum, table) => sum + (Number.isFinite(table.rows) ? table.rows : 0),
      0
    ),
  };
}

function formatTenantSummary(summary) {
  if (!summary?.tables?.length) return "unavailable";
  const keyTables = new Set([
    "vehicles",
    "trips",
    "messages",
    "vehicle_telemetry_snapshots",
  ]);
  const keyCounts = summary.tables
    .filter((table) => keyTables.has(table.table))
    .map((table) => `${table.table}: ${table.exists ? table.rows : "missing"}`)
    .join(" | ");

  return `${keyCounts} | tracked total: ${summary.totalRows}`;
}

function parsePgRestoreTableDataNames(listOutput) {
  const names = new Set();
  const pattern = /;\s+\d+\s+\d+\s+TABLE DATA\s+public\s+([^\s]+)\s+/g;
  let match;

  while ((match = pattern.exec(String(listOutput || "")))) {
    names.add(match[1]);
  }

  return [...names].sort();
}

function getPgCommandEnv() {
  return {
    ...process.env,
    PGPASSWORD: String(process.env.PGPASSWORD || ""),
  };
}

function getPgConnectionArgs() {
  return [
    "-h",
    process.env.PGHOST || "localhost",
    "-p",
    String(process.env.PGPORT || 5432),
    "-U",
    process.env.PGUSER || "postgres",
    "-d",
    process.env.PGDATABASE || "denmark",
  ];
}

function getSafeImportPath(value) {
  const resolved = path.resolve(String(value || ""));
  const importRoot = `${path.resolve(IMPORT_DIR)}${path.sep}`;

  if (!resolved.startsWith(importRoot)) {
    const err = new Error("Import file is outside the configured import directory");
    err.status = 400;
    throw err;
  }

  return resolved;
}

function runPgCommand(command, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: getPgCommandEnv(),
      windowsHide: true,
    });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = truncateText(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = truncateText(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };

      if (code === 0) {
        resolve(result);
        return;
      }

      const error = new Error(
        `${command} failed with exit code ${code}: ${stderr || stdout || "no output"}`
      );
      error.result = result;
      reject(error);
    });
  });
}

function describePgToolError(error, command) {
  const message = error.message || String(error);
  if (error.code === "ENOENT" || /ENOENT|not found|not recognized/i.test(message)) {
    return `${command} is not available in the running Denmark app container. Pull/rebuild the latest image with PostgreSQL client tools, then restart the app.`;
  }
  if (/unsupported version .* in file header/i.test(message)) {
    return `${command} is too old for this backup file. Pull/rebuild the latest Denmark image with PostgreSQL 18 client tools, then validate the staged backup again. Original error: ${message}`;
  }
  return message;
}

function isIgnorablePgRestoreCompatibilityFailure(result) {
  const stderr = String(result?.stderr || "");
  if (!/transaction_timeout/i.test(stderr)) return false;

  const remaining = stderr
    .replace(
      /pg_restore:\s*error:\s*could not execute query:\s*ERROR:\s*unrecognized configuration parameter "transaction_timeout"\s*Command was:\s*SET transaction_timeout = 0;?/gis,
      ""
    )
    .replace(/Command was:\s*SET transaction_timeout = 0;?/gi, "")
    .replace(/pg_restore:\s*warning:\s*errors ignored on restore:\s*\d+/gi, "")
    .trim();

  return !/pg_restore:\s*error:/i.test(remaining);
}

function buildRestoreSuccessLog(result, { compatibilityWarningIgnored = false } = {}) {
  return truncateText(
    [
      compatibilityWarningIgnored
        ? "pg_restore completed with an ignored compatibility warning: target PostgreSQL does not support transaction_timeout."
        : "pg_restore completed.",
      result.stderr,
      result.stdout,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function parseContentDispositionFilename(value) {
  const header = String(value || "");
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1].replace(/"/g, ""));

  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1];

  const plainMatch = header.match(/filename=([^;]+)/i);
  return plainMatch ? plainMatch[1].trim() : "";
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/\\u003d/g, "=")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function getResponseCookies(response) {
  const getSetCookie = response.headers.getSetCookie?.();
  if (Array.isArray(getSetCookie) && getSetCookie.length) {
    return getSetCookie.map((cookie) => cookie.split(";")[0]).join("; ");
  }

  const singleHeader = response.headers.get("set-cookie");
  return singleHeader ? singleHeader.split(/,(?=[^;,]+=)/).map((cookie) => cookie.split(";")[0]).join("; ") : "";
}

function isAllowedGoogleDownloadHost(url) {
  const host = url.hostname.toLowerCase();
  return (
    host === "drive.google.com" ||
    host === "docs.google.com" ||
    host === "drive.usercontent.google.com"
  );
}

function extractDriveDownloadUrlFromHtml(html) {
  const text = String(html || "");
  const hrefPattern = /href=(?:"([^"]+)"|'([^']+)'|([^>\s]+))/gi;
  let match;

  while ((match = hrefPattern.exec(text))) {
    const href = decodeHtmlAttribute(match[1] || match[2] || match[3]);
    if (!href) continue;

    let candidate;
    try {
      candidate = new URL(href, "https://drive.google.com");
    } catch {
      continue;
    }

    const candidateText = candidate.toString();
    if (
      isAllowedGoogleDownloadHost(candidate) &&
      (candidate.pathname.includes("/uc") ||
        candidate.pathname.includes("/download") ||
        candidateText.includes("export=download") ||
        candidateText.includes("confirm="))
    ) {
      return candidate;
    }
  }

  const actionMatch = text.match(/<form[^>]+action=(?:"([^"]+)"|'([^']+)'|([^>\s]+))[^>]*>/i);
  if (!actionMatch) return null;

  let actionUrl;
  try {
    actionUrl = new URL(
      decodeHtmlAttribute(actionMatch[1] || actionMatch[2] || actionMatch[3]),
      "https://drive.google.com"
    );
  } catch {
    return null;
  }

  if (!isAllowedGoogleDownloadHost(actionUrl)) return null;

  const inputPattern = /<input[^>]+>/gi;
  while ((match = inputPattern.exec(text))) {
    const input = match[0];
    const nameMatch = input.match(/\sname=(?:"([^"]+)"|'([^']+)'|([^>\s]+))/i);
    const valueMatch = input.match(/\svalue=(?:"([^"]*)"|'([^']*)'|([^>\s]*))/i);
    const name = decodeHtmlAttribute(nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3]);
    const value = decodeHtmlAttribute(valueMatch?.[1] || valueMatch?.[2] || valueMatch?.[3]);
    if (name) actionUrl.searchParams.set(name, value || "");
  }

  return actionUrl;
}

function parseGoogleDriveFileId(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return "";
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "drive.google.com" && host !== "docs.google.com") return "";

  const filePathMatch = parsed.pathname.match(/\/file\/d\/([^/]+)/);
  if (filePathMatch) return filePathMatch[1];

  return parsed.searchParams.get("id") || "";
}

function buildGoogleDriveDownloadUrls(fileId, sourceUrl) {
  let resourceKey = "";
  try {
    resourceKey = new URL(sourceUrl).searchParams.get("resourcekey") || "";
  } catch {
    resourceKey = "";
  }

  const params = new URLSearchParams({
    id: fileId,
    export: "download",
  });
  const confirmedParams = new URLSearchParams({
    id: fileId,
    export: "download",
    confirm: "t",
  });
  const userContentParams = new URLSearchParams({
    id: fileId,
    export: "download",
  });

  if (resourceKey) {
    params.set("resourcekey", resourceKey);
    confirmedParams.set("resourcekey", resourceKey);
    userContentParams.set("resourcekey", resourceKey);
  }

  return [
    `https://drive.google.com/uc?${params.toString()}`,
    `https://drive.google.com/uc?${confirmedParams.toString()}`,
    `https://drive.usercontent.google.com/download?${userContentParams.toString()}`,
  ];
}

function normalizeCloudBackupUrl(rawUrl) {
  const sourceUrl = String(rawUrl || "").trim();
  const googleDriveFileId = parseGoogleDriveFileId(sourceUrl);

  if (!googleDriveFileId) {
    const err = new Error("Use a public Google Drive file link with a file id.");
    err.status = 400;
    throw err;
  }

  return {
    provider: "google_drive_public",
    remoteFileId: googleDriveFileId,
    sourceUrl,
    downloadUrls: buildGoogleDriveDownloadUrls(googleDriveFileId, sourceUrl),
  };
}

async function ensureDatabaseImportJobsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.database_import_jobs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      provider text NOT NULL,
      source_url text NOT NULL,
      remote_file_id text,
      remote_file_name text,
      status text NOT NULL DEFAULT 'queued',
      local_path text,
      content_type text,
      bytes_total bigint,
      bytes_downloaded bigint NOT NULL DEFAULT 0,
      format text,
      sha256 text,
      error text,
      restore_log text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      started_at timestamp with time zone,
      validated_at timestamp with time zone,
      restore_started_at timestamp with time zone,
      restore_completed_at timestamp with time zone,
      completed_at timestamp with time zone,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    )
  `);

  await db.query(`ALTER TABLE public.database_import_jobs ADD COLUMN IF NOT EXISTS format text`);
  await db.query(`ALTER TABLE public.database_import_jobs ADD COLUMN IF NOT EXISTS restore_log text`);
  await db.query(`ALTER TABLE public.database_import_jobs ADD COLUMN IF NOT EXISTS validated_at timestamp with time zone`);
  await db.query(`ALTER TABLE public.database_import_jobs ADD COLUMN IF NOT EXISTS restore_started_at timestamp with time zone`);
  await db.query(`ALTER TABLE public.database_import_jobs ADD COLUMN IF NOT EXISTS restore_completed_at timestamp with time zone`);
  await db.query(`ALTER TABLE public.database_import_jobs DROP CONSTRAINT IF EXISTS database_import_jobs_status_check`);
  await db.query(
    `
      ALTER TABLE public.database_import_jobs
      ADD CONSTRAINT database_import_jobs_status_check CHECK (status = ANY(${
        `ARRAY[${IMPORT_JOB_STATUSES.map((status) => `'${status}'::text`).join(", ")}]`
      }))
    `
  );

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_database_import_jobs_created_at
     ON public.database_import_jobs USING btree (created_at DESC)`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_database_import_jobs_status
     ON public.database_import_jobs USING btree (status, updated_at DESC)`
  );
}

function mapImportJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    sourceUrl: row.source_url,
    remoteFileId: row.remote_file_id,
    remoteFileName: row.remote_file_name,
    status: row.status,
    localPath: row.local_path,
    contentType: row.content_type,
    bytesTotal: row.bytes_total === null ? null : Number(row.bytes_total),
    bytesDownloaded: Number(row.bytes_downloaded || 0),
    bytesDownloadedLabel: formatBytes(row.bytes_downloaded),
    bytesTotalLabel: row.bytes_total === null ? null : formatBytes(row.bytes_total),
    format: row.format,
    sha256: row.sha256,
    error: row.error,
    restoreLog: row.restore_log,
    createdAt: row.created_at,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    restoreStartedAt: row.restore_started_at,
    restoreCompletedAt: row.restore_completed_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

async function updateImportJob(jobId, fields) {
  const keys = Object.keys(fields).filter((key) => fields[key] !== undefined);
  if (!keys.length) return;

  const assignments = keys.map((key, index) => `${key} = $${index + 2}`);
  await db.query(
    `
      UPDATE public.database_import_jobs
      SET ${assignments.join(", ")}, updated_at = now()
      WHERE id = $1
    `,
    [jobId, ...keys.map((key) => fields[key])]
  );
}

async function upsertImportJobSnapshot(job, fields) {
  await ensureDatabaseImportJobsTable();
  await db.query(
    `
      INSERT INTO public.database_import_jobs
        (id, provider, source_url, remote_file_id, remote_file_name, status,
         local_path, content_type, bytes_total, bytes_downloaded, format, sha256,
         error, restore_log, created_at, started_at, validated_at,
         restore_started_at, restore_completed_at, completed_at, updated_at)
      OVERRIDING SYSTEM VALUE
      VALUES
        ($1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, COALESCE($15, now()), $16, $17,
         $18, $19, $20, now())
      ON CONFLICT (id)
      DO UPDATE SET
        provider = EXCLUDED.provider,
        source_url = EXCLUDED.source_url,
        remote_file_id = EXCLUDED.remote_file_id,
        remote_file_name = EXCLUDED.remote_file_name,
        status = EXCLUDED.status,
        local_path = EXCLUDED.local_path,
        content_type = EXCLUDED.content_type,
        bytes_total = EXCLUDED.bytes_total,
        bytes_downloaded = EXCLUDED.bytes_downloaded,
        format = EXCLUDED.format,
        sha256 = EXCLUDED.sha256,
        error = EXCLUDED.error,
        restore_log = EXCLUDED.restore_log,
        started_at = EXCLUDED.started_at,
        validated_at = EXCLUDED.validated_at,
        restore_started_at = EXCLUDED.restore_started_at,
        restore_completed_at = EXCLUDED.restore_completed_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = now()
    `,
    [
      job.id,
      job.provider,
      job.sourceUrl,
      job.remoteFileId,
      fields.remote_file_name ?? job.remoteFileName,
      fields.status ?? job.status,
      fields.local_path ?? job.localPath,
      fields.content_type ?? job.contentType,
      fields.bytes_total ?? job.bytesTotal,
      fields.bytes_downloaded ?? job.bytesDownloaded,
      fields.format ?? job.format,
      fields.sha256 ?? job.sha256,
      fields.error ?? job.error,
      fields.restore_log ?? job.restoreLog,
      job.createdAt,
      fields.started_at ?? job.startedAt,
      fields.validated_at ?? job.validatedAt,
      fields.restore_started_at ?? job.restoreStartedAt,
      fields.restore_completed_at ?? job.restoreCompletedAt,
      fields.completed_at ?? job.completedAt,
    ]
  );
}

async function fetchDriveDownloadResponse(downloadUrls) {
  const urls = Array.isArray(downloadUrls) ? downloadUrls : [downloadUrls];
  const errors = [];

  for (const downloadUrl of urls) {
    const firstResponse = await fetch(downloadUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; DenmarkBackupRestore/1.0; +https://freshcoastgarage.com)",
        Accept: "application/octet-stream,text/html;q=0.9,*/*;q=0.8",
      },
    });
    const firstContentType = firstResponse.headers.get("content-type") || "";
    const firstDisposition = firstResponse.headers.get("content-disposition") || "";

    if (!firstContentType.includes("text/html") || firstDisposition) {
      return firstResponse;
    }

    const html = await firstResponse.text();
    if (!html.trim()) {
      errors.push(`${downloadUrl}: Google returned an empty HTML handoff page`);
      continue;
    }

    const confirmUrl = extractDriveDownloadUrlFromHtml(html);
    if (!confirmUrl) {
      errors.push(`${downloadUrl}: no direct download link found in Google handoff page`);
      continue;
    }

    const cookie = getResponseCookies(firstResponse);
    const confirmedResponse = await fetch(confirmUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; DenmarkBackupRestore/1.0; +https://freshcoastgarage.com)",
        Accept: "application/octet-stream,text/html;q=0.9,*/*;q=0.8",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const confirmedContentType = confirmedResponse.headers.get("content-type") || "";
    const confirmedDisposition = confirmedResponse.headers.get("content-disposition") || "";
    if (!confirmedContentType.includes("text/html") || confirmedDisposition) {
      return confirmedResponse;
    }

    errors.push(`${downloadUrl}: confirmed download still returned an HTML page`);
  }

  throw new Error(
    `Google Drive did not provide a downloadable file. Confirm the file is shared to anyone with the link. Tried ${urls.length} download URL(s): ${errors.join("; ")}`
  );
}

async function downloadCloudBackupJob(jobId, normalized) {
  if (activeImportJobs.has(jobId)) return;
  activeImportJobs.add(jobId);

  try {
    await fs.promises.mkdir(IMPORT_DIR, { recursive: true });
    await updateImportJob(jobId, {
      status: "downloading",
      started_at: new Date(),
      error: null,
    });

    const response = await fetchDriveDownloadResponse(normalized.downloadUrls);
    if (!response.ok) {
      throw new Error(`Cloud download failed: HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Cloud download did not return a readable body");
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > IMPORT_MAX_BYTES) {
      throw new Error(
        `Cloud file is ${formatBytes(contentLength)}, above the ${formatBytes(
          IMPORT_MAX_BYTES
        )} import limit`
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") && !response.headers.get("content-disposition")) {
      throw new Error(
        "Google Drive returned a web page instead of the backup file. Check that the file is public to anyone with the link."
      );
    }

    const dispositionName = parseContentDispositionFilename(
      response.headers.get("content-disposition")
    );
    const fallbackName = `${normalized.remoteFileId}.backup`;
    const remoteFileName = cleanFilename(dispositionName, fallbackName);
    const localPath = path.join(IMPORT_DIR, `${jobId}-${remoteFileName}`);
    const hash = crypto.createHash("sha256");
    let bytesDownloaded = 0;

    const metered = new Transform({
      transform(chunk, encoding, callback) {
        bytesDownloaded += chunk.byteLength;
        if (bytesDownloaded > IMPORT_MAX_BYTES) {
          callback(
            new Error(
              `Cloud file exceeded the ${formatBytes(IMPORT_MAX_BYTES)} import limit`
            )
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body),
      metered,
      fs.createWriteStream(localPath, { flags: "wx" })
    );

    await updateImportJob(jobId, {
      status: "downloaded",
      remote_file_name: remoteFileName,
      local_path: localPath,
      content_type: contentType,
      bytes_total: contentLength || bytesDownloaded,
      bytes_downloaded: bytesDownloaded,
      sha256: hash.digest("hex"),
      completed_at: new Date(),
    });

    await logSystemActivity({
      category: "database",
      eventType: "database_import_downloaded",
      severity: "notice",
      subjectType: "database_import_job",
      subjectId: String(jobId),
      subjectLabel: remoteFileName,
      source: "database.import",
      details: {
        provider: normalized.provider,
        remoteFileId: normalized.remoteFileId,
        bytesDownloaded,
      },
    }).catch(() => null);
  } catch (error) {
    await updateImportJob(jobId, {
      status: "failed",
      error: error.message || String(error),
      completed_at: new Date(),
    }).catch(() => null);

    await logSystemActivity({
      category: "database",
      eventType: "database_import_failed",
      severity: "error",
      outcome: "failure",
      subjectType: "database_import_job",
      subjectId: String(jobId),
      source: "database.import",
      details: {
        provider: normalized.provider,
        remoteFileId: normalized.remoteFileId,
        error: error.message || String(error),
      },
    }).catch(() => null);
  } finally {
    activeImportJobs.delete(jobId);
  }
}

async function getImportJob(jobId) {
  await ensureDatabaseImportJobsTable();
  const { rows } = await db.query(
    `
      SELECT *
      FROM public.database_import_jobs
      WHERE id = $1
    `,
    [jobId]
  );

  return mapImportJob(rows[0]);
}

async function validateImportJob(jobId) {
  const job = await getImportJob(jobId);
  if (!job) {
    const err = new Error("Import job not found");
    err.status = 404;
    throw err;
  }

  const localPath = getSafeImportPath(job.localPath);
  await fs.promises.access(localPath, fs.constants.R_OK);

  await updateImportJob(jobId, {
    status: "validating",
    error: null,
    restore_log: null,
  });

  try {
    const result = await runPgCommand("pg_restore", ["--list", localPath], {
      timeoutMs: 5 * 60 * 1000,
    });
    const tableCount = (result.stdout.match(/ TABLE DATA /g) || []).length;
    const schemaCount = (result.stdout.match(/ TABLE /g) || []).length;
    const tableDataNames = parsePgRestoreTableDataNames(result.stdout);
    const tableDataSet = new Set(tableDataNames);
    const presentImportantTables = BACKUP_IMPORTANT_TABLES.filter((table) =>
      tableDataSet.has(table)
    );
    const missingImportantTables = BACKUP_IMPORTANT_TABLES.filter(
      (table) => !tableDataSet.has(table)
    );
    const restoreLog = truncateText(
      [
        "pg_restore --list completed.",
        `Tables: ${schemaCount}`,
        `Table data entries: ${tableCount}`,
        `Key data tables present: ${
          presentImportantTables.length ? presentImportantTables.join(", ") : "none"
        }`,
        `Key data tables missing: ${
          missingImportantTables.length ? missingImportantTables.join(", ") : "none"
        }`,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n")
    );

    await updateImportJob(jobId, {
      status: "validated",
      format: "postgres_custom",
      restore_log: restoreLog,
      error: null,
      validated_at: new Date(),
    });

    return getImportJob(jobId);
  } catch (error) {
    const message = describePgToolError(error, "pg_restore");
    await updateImportJob(jobId, {
      status: "validation_failed",
      error: message,
      restore_log: truncateText(error.result?.stderr || error.result?.stdout || ""),
      completed_at: new Date(),
    });
    error.message = message;
    throw error;
  }
}

async function repairRestoredSchema() {
  await ensureDatabaseImportJobsTable();
  await ensureVehicleIdentityConstraints();
  await ensureApplicationUniqueConstraints();
}

async function runRestoreJob(jobId) {
  if (activeRestoreJobs.has(jobId)) return;
  activeRestoreJobs.add(jobId);

  const job = await getImportJob(jobId);
  try {
    if (!job) throw new Error("Import job not found");
    const localPath = getSafeImportPath(job.localPath);
    await fs.promises.access(localPath, fs.constants.R_OK);
    const restoreStartedAt = new Date();

    await updateImportJob(jobId, {
      status: "restoring",
      error: null,
      restore_started_at: restoreStartedAt,
    });

    let result;
    let compatibilityWarningIgnored = false;
    try {
      result = await runPgCommand(
        "pg_restore",
        [
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-privileges",
          ...getPgConnectionArgs(),
          localPath,
        ],
        { timeoutMs: Number(process.env.DATABASE_RESTORE_TIMEOUT_MS || 2 * 60 * 60 * 1000) }
      );
    } catch (error) {
      if (!isIgnorablePgRestoreCompatibilityFailure(error.result)) {
        throw error;
      }
      result = error.result;
      compatibilityWarningIgnored = true;
    }

    await repairRestoredSchema();
    const postRestoreSummary = await getTenantDataSummary();
    markDatabaseReady();

    await upsertImportJobSnapshot(job, {
      status: "restored",
      error: null,
      restore_log: truncateText(
        [
          buildRestoreSuccessLog(result, { compatibilityWarningIgnored }),
          `Post-restore database: ${formatTenantSummary(postRestoreSummary)}`,
        ].join("\n")
      ),
      restore_started_at: job.restoreStartedAt || restoreStartedAt,
      restore_completed_at: new Date(),
      completed_at: new Date(),
    });

    await logSystemActivity({
      category: "database",
      eventType: "database_restore_completed",
      severity: "warning",
      subjectType: "database_import_job",
      subjectId: String(jobId),
      subjectLabel: job.remoteFileName || job.remoteFileId || String(jobId),
      source: "database.restore",
      details: {
        format: "postgres_custom",
        localPath,
      },
    }).catch(() => null);
  } catch (error) {
    const message = describePgToolError(error, "pg_restore");
    const fields = {
      status: "failed",
      error: message,
      restore_log: truncateText(error.result?.stderr || error.result?.stdout || ""),
      restore_completed_at: new Date(),
      completed_at: new Date(),
    };

    if (job) {
      await upsertImportJobSnapshot(job, fields).catch(() => null);
    } else {
      await updateImportJob(jobId, fields).catch(() => null);
    }

    await logSystemActivity({
      category: "database",
      eventType: "database_restore_failed",
      severity: "error",
      outcome: "failure",
      subjectType: "database_import_job",
      subjectId: String(jobId),
      source: "database.restore",
      details: {
        error: error.message || String(error),
      },
    }).catch(() => null);
  } finally {
    activeRestoreJobs.delete(jobId);
  }
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
  const filename = `denmark-tenant-backup-${isoStamp()}.dump`;

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
        format: "postgres_custom",
        filename,
      },
    }).catch(() => null);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");

    const child = spawn(
      "pg_dump",
      [
        "-Fc",
        "--no-owner",
        "--no-privileges",
        ...getPgConnectionArgs(),
      ],
      {
        env: getPgCommandEnv(),
        windowsHide: true,
      }
    );
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr = truncateText(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      res.destroy(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        res.end();
        return;
      }

      const error = new Error(`pg_dump failed with exit code ${code}: ${stderr}`);
      console.error("database backup failed:", error);
      res.destroy(error);
    });
    child.stdout.pipe(res, { end: false });
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
        format: "postgres_custom",
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

router.get("/backup/summary", async (req, res) => {
  try {
    res.json({
      ok: true,
      summary: await getTenantDataSummary(),
    });
  } catch (err) {
    console.error("database backup summary failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Database backup summary failed",
    });
  }
});

router.get("/backup/json", async (req, res) => {
  const filename = `denmark-legacy-json-backup-${isoStamp()}.json`;

  try {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked");
    await streamBackup(res);
  } catch (err) {
    console.error("legacy database backup failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Legacy database backup failed" });
      return;
    }

    res.destroy(err);
  }
});

router.get("/imports", async (req, res) => {
  try {
    await ensureDatabaseImportJobsTable();
    const { rows } = await db.query(
      `
        SELECT *
        FROM public.database_import_jobs
        ORDER BY created_at DESC
        LIMIT 20
      `
    );

    res.json({ ok: true, jobs: rows.map(mapImportJob) });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || "Failed to load database import jobs",
    });
  }
});

router.get("/imports/:id", async (req, res) => {
  try {
    await ensureDatabaseImportJobsTable();
    const { rows } = await db.query(
      `
        SELECT *
        FROM public.database_import_jobs
        WHERE id = $1
      `,
      [req.params.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: "Import job not found" });
    }

    return res.json({ ok: true, job: mapImportJob(rows[0]) });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Failed to load database import job",
    });
  }
});

router.delete("/imports/:id", async (req, res) => {
  try {
    await ensureDatabaseImportJobsTable();
    const job = await getImportJob(req.params.id);

    if (!job) {
      return res.status(404).json({ error: "Import job not found" });
    }

    const status = String(job.status || "").trim().toLowerCase();
    if (["downloading", "validating", "restoring"].includes(status)) {
      return res.status(409).json({
        error: `Import job is ${status}; wait for it to finish before removing it`,
      });
    }

    let removedFile = false;
    if (job.localPath) {
      const localPath = getSafeImportPath(job.localPath);
      await fs.promises
        .unlink(localPath)
        .then(() => {
          removedFile = true;
        })
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
    }

    await db.query(`DELETE FROM public.database_import_jobs WHERE id = $1`, [
      req.params.id,
    ]);

    await logSystemActivity({
      category: "database",
      eventType: "database_import_removed",
      severity: "notice",
      subjectType: "database_import_job",
      subjectId: String(req.params.id),
      subjectLabel: job.remoteFileName || job.remoteFileId || String(req.params.id),
      source: "database.import",
      details: {
        removedFile,
        localPath: job.localPath || null,
      },
    }).catch(() => null);

    return res.json({ ok: true, removedFile });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Failed to remove database import",
    });
  }
});

router.post("/imports/from-url", async (req, res) => {
  try {
    await ensureDatabaseImportJobsTable();
    const normalized = normalizeCloudBackupUrl(req.body?.url);
    const { rows } = await db.query(
      `
        INSERT INTO public.database_import_jobs
          (provider, source_url, remote_file_id, status)
        VALUES
          ($1, $2, $3, 'queued')
        RETURNING *
      `,
      [normalized.provider, normalized.sourceUrl, normalized.remoteFileId]
    );
    const job = mapImportJob(rows[0]);

    await logSystemActivity({
      category: "database",
      eventType: "database_import_queued",
      severity: "warning",
      subjectType: "database_import_job",
      subjectId: String(job.id),
      subjectLabel: normalized.remoteFileId,
      source: "database.import",
      details: {
        provider: normalized.provider,
        remoteFileId: normalized.remoteFileId,
      },
    }).catch(() => null);

    setImmediate(() => {
      downloadCloudBackupJob(job.id, normalized).catch((error) => {
        console.error("database cloud import failed:", error);
      });
    });

    return res.status(202).json({ ok: true, job });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Failed to queue cloud database import",
    });
  }
});

router.post("/imports/:id/validate", async (req, res) => {
  try {
    const job = await validateImportJob(req.params.id);
    return res.json({ ok: true, job });
  } catch (err) {
    const job = await getImportJob(req.params.id).catch(() => null);
    return res.status(err.status || 500).json({
      error: err.message || "Failed to validate database import",
      job,
    });
  }
});

router.post("/imports/:id/restore", async (req, res) => {
  try {
    if (req.body?.confirm !== "RESTORE") {
      return res.status(400).json({ error: "Type RESTORE to confirm restore" });
    }

    const job = await getImportJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Import job not found" });
    }
    const status = String(job.status || "").trim().toLowerCase();
    if (!["downloaded", "validated"].includes(status)) {
      return res.status(400).json({
        error: `Import must be downloaded or validated before restore. Current status: ${
          job.status || "unknown"
        }`,
      });
    }

    if (status !== "validated") {
      await validateImportJob(req.params.id);
    }

    setImmediate(() => {
      runRestoreJob(req.params.id).catch((error) => {
        console.error("database restore job failed:", error);
      });
    });

    return res.status(202).json({ ok: true, job: await getImportJob(req.params.id) });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || "Failed to start database restore",
    });
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
