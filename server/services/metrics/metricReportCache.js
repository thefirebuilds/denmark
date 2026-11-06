const pool = require('../../db');
const { createHash } = require('node:crypto');
const { getDateRange } = require('./metricHelpers');
const { tryRunMetricRefresh, limitMetricRead, isDbPoolUnderPressure } = require('./metricReadLimiter');

const HOUR_MS = 3600000;
const REPORT_HOURS = Object.freeze({ summary: 1, vehicles: 1, business: 1,
  trends: 4, parking: 4, homeTransfers: 4, offTripAudit: 4, vehicleFinancial: 4, quarterlyAnalysis: 4,
  businessSnapshot: 24 });
const LOCK_KEY = 1146245970;
let schemaPromise;

// Deployment/startup only. Report GETs never create tables or indexes.
function ensureMetricReportCacheSchema(db = pool) {
  if (!schemaPromise) schemaPromise = db.query(`
    CREATE TABLE IF NOT EXISTS public.metric_report_cache (
      cache_key text PRIMARY KEY,
      report_kind text NOT NULL,
      params jsonb NOT NULL,
      payload jsonb,
      calculated_at timestamptz,
      refresh_after timestamptz NOT NULL DEFAULT NOW(),
      requested_at timestamptz NOT NULL DEFAULT NOW(),
      last_attempt_at timestamptz,
      next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
      last_error_at timestamptz
    )`).then(() => db.query(`
      CREATE INDEX IF NOT EXISTS idx_metric_report_cache_due
      ON public.metric_report_cache (next_attempt_at, refresh_after)
    `)).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function describeReport(kind, input = {}) {
  if (!Object.hasOwn(REPORT_HOURS, kind)) throw Object.assign(new Error('Unknown metrics report'), { statusCode: 400 });
  const params = { range: getDateRange(String(input.range || '30d').slice(0, 80)).key };
  if (kind === 'vehicleFinancial') {
    const id = Number(input.vehicleId);
    if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('Invalid vehicle id'), { statusCode: 400 });
    params.vehicleId = id;
  }
  if (kind === 'homeTransfers') {
    for (const key of ['month', 'start', 'end']) {
      if (input[key] != null) params[key] = String(input[key]).slice(0, 32);
    }
  }
  const cacheKey = `v1:${kind}:${createHash('sha256').update(JSON.stringify(params)).digest('hex')}`;
  return { kind, params, cacheKey, intervalMs: REPORT_HOURS[kind] * HOUR_MS };
}

async function computeReport(kind, params) {
  switch (kind) {
    case 'summary': return require('./summaryService').getSummaryMetrics(params.range);
    case 'vehicles': return require('./vehicleMetricsService').getVehicleMetrics(params.range);
    case 'business': return require('./businessMetricsService').getBusinessMetrics(params.range);
    case 'trends': return require('./trendMetricsService').getTrendMetrics(params.range);
    case 'parking': return require('./parkingMetricsService').getParkingEconomics(params.range);
    case 'homeTransfers': return require('./parkingTransferService').getHomeParkingTransfers(params);
    case 'offTripAudit': return require('./vehicleMetricsService').getOffTripMileageAudit(params.range);
    case 'vehicleFinancial': return require('./vehicleMetricsService').getVehicleFinancialDetail(params.vehicleId, params.range);
    case 'quarterlyAnalysis': return require('./businessMetricsService').buildQuarterlyAnalysisPayload();
    case 'businessSnapshot': return require('./businessMetricsService').createBusinessMetricSnapshot('quarterly');
    default: throw new Error('Unknown saved report kind');
  }
}

function createMetricReportCache({ db = pool, compute = computeReport, runRefresh = tryRunMetricRefresh,
  clock = () => Date.now() } = {}) {
  let running = false;
  const snapshots = new Map();
  const reads = new Map();

  async function getSavedReport(kind, input) {
    const report = describeReport(kind, input);
    const cached = snapshots.get(report.cacheKey);
    if (cached && cached.expiresAt > clock()) return cached.report;
    if (reads.has(report.cacheKey)) return reads.get(report.cacheKey);
    const read = readSavedReport(report);
    reads.set(report.cacheKey, read);
    try { return await read; }
    finally { reads.delete(report.cacheKey); }
  }

  async function readSavedReport(report) {
    // This only registers demand and returns the last successful snapshot.
    // No calculation, callback, or background worker is started by a GET.
    const { rows } = await db.query(`
      INSERT INTO public.metric_report_cache (cache_key, report_kind, params)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (cache_key) DO UPDATE SET requested_at = NOW()
      RETURNING payload, calculated_at, refresh_after, last_error_at
    `, [report.cacheKey, report.kind, JSON.stringify(report.params)]);
    const row = rows[0];
    const saved = { payload: row.payload, meta: {
      kind: report.kind, range: report.params.range,
      calculated_at: row.calculated_at,
      refresh_after: row.refresh_after,
      refresh_interval_hours: report.intervalMs / HOUR_MS,
      pending: row.payload == null,
      stale: row.payload == null || new Date(row.refresh_after).getTime() <= clock(),
      refresh_failed: Boolean(row.last_error_at),
    } };
    // Polling and multiple tabs share one lookup. Bound both lifetime and size.
    if (snapshots.size >= 100) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(report.cacheKey, { report: saved, expiresAt: clock() + 15000 });
    return saved;
  }

  async function refreshDueReport() {
    if (running) return { deferred: true };
    running = true;
    try {
      return await runRefresh(async () => {
        // Session lock prevents two app processes calculating different reports
        // simultaneously. This client coordinates only; it has no transaction
        // or table locks while the calculator uses its own database client.
        const coordinator = await db.connect();
        let locked = false;
        let releaseError;
        try {
          const lock = await coordinator.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
          locked = lock.rows[0]?.locked === true;
          if (!locked) return { deferred: true };
          const { rows } = await coordinator.query(`
            SELECT cache_key, report_kind, params FROM public.metric_report_cache
            WHERE requested_at >= NOW() - INTERVAL '7 days'
              AND next_attempt_at <= NOW()
              AND (payload IS NULL OR refresh_after <= NOW())
            ORDER BY (payload IS NULL) DESC, last_attempt_at ASC NULLS FIRST, requested_at ASC
            LIMIT 1
          `);
          const row = rows[0];
          if (!row) return { refreshed: false };
          await coordinator.query(`UPDATE public.metric_report_cache
            SET last_attempt_at = NOW(), next_attempt_at = NOW() + INTERVAL '15 minutes'
            WHERE cache_key = $1`, [row.cache_key]);
          const started = clock();
          try {
            const report = describeReport(row.report_kind, row.params);
            const payload = await compute(report.kind, report.params);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid metrics report result');
            await coordinator.query(`UPDATE public.metric_report_cache
              SET payload = $2::jsonb, calculated_at = NOW(),
                  refresh_after = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                  next_attempt_at = NOW(), last_error_at = NULL
              WHERE cache_key = $1`, [row.cache_key, JSON.stringify(payload), report.intervalMs]);
            snapshots.delete(row.cache_key);
            console.log(`[metrics-reports] refreshed kind=${report.kind} range=${report.params.range} durationMs=${clock() - started}`);
            return { refreshed: true };
          } catch (error) {
            await coordinator.query(`UPDATE public.metric_report_cache SET last_error_at = NOW(),
              next_attempt_at = NOW() + INTERVAL '15 minutes' WHERE cache_key = $1`, [row.cache_key]);
            snapshots.delete(row.cache_key);
            console.warn(`[metrics-reports] refresh failed kind=${row.report_kind}: ${error.message || error}`);
            return { refreshed: false, failed: true };
          }
        } catch (error) {
          releaseError = error;
          throw error;
        } finally {
          if (locked) {
            try { await coordinator.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
            catch (error) { releaseError = error; }
          }
          coordinator.release(releaseError);
        }
      });
    } finally { running = false; }
  }

  function savedMetricReport(kind, parameters = req => req.query || {}) {
    function send(res, report, deferred = false) {
      res.setHeader('Cache-Control', 'no-store');
      const meta = { ...report.meta,
        stale: report.meta.pending || new Date(report.meta.refresh_after).getTime() <= clock(),
        ...(deferred ? { read_deferred: true } : {}),
      };
      if (meta.pending) {
        res.setHeader('Retry-After', '30');
        return res.status(202).json({ pending: true, _report: meta,
          message: 'Preparing the first saved metrics report in the background. This page will check again shortly.' });
      }
      return res.json({ ...report.payload, _report: meta });
    }
    const read = async (req, res) => {
      try {
        const report = await getSavedReport(kind, parameters(req));
        return send(res, report);
      } catch (error) {
        console.warn(`[metrics-reports] read failed kind=${kind}: ${error.message || error}`);
        if (!error.statusCode) {
          const descriptor = describeReport(kind, parameters(req));
          const saved = snapshots.get(descriptor.cacheKey);
          if (saved?.report.payload != null) return send(res, saved.report, true);
        }
        res.setHeader('X-Denmark-Error-Scope', 'request');
        res.setHeader('Retry-After', '10');
        return res.status(error.statusCode || 503).json({ error: error.statusCode ? error.message : 'Saved metrics temporarily unavailable' });
      }
    };
    const limitedRead = limitMetricRead(read);
    return (req, res, next) => {
      // Memory-only responses do not consume admission slots or connections.
      // Under real pool pressure keep serving the last successful snapshot,
      // preserving its calculation time and marking the DB lookup as deferred.
      let cached;
      try { cached = snapshots.get(describeReport(kind, parameters(req)).cacheKey); }
      catch { return read(req, res); }
      if (cached?.report.payload != null) {
        if (cached.expiresAt > clock()) return send(res, cached.report);
        if (isDbPoolUnderPressure?.()) return send(res, cached.report, true);
      }
      return limitedRead(req, res, next);
    };
  }
  return { getSavedReport, refreshDueReport, savedMetricReport };
}

module.exports = { ...createMetricReportCache(), createMetricReportCache,
  ensureMetricReportCacheSchema, describeReport, REPORT_HOURS };
