const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const diagnostics = require('../services/infra/diagnostics');
const { requestContext } = require('../services/infra/requestContext');

const staticEndpoints = new Set([
  '', '/summary', '/vehicles', '/trends', '/off-trip-audit', '/off-trip-audit/review',
  '/tolls/detail', '/tolls/account-balance', '/parking', '/parking/home-transfers',
  '/business/current', '/business/settings', '/business/vehicle-profiles', '/business/snapshots', '/business/analysis-payload',
].map(suffix => `/api/metrics${suffix}`));
function safeMetricsEndpoint(pathname) {
  const path = pathname.replace(/\/$/, '');
  if (staticEndpoints.has(path)) return path;
  if (/^\/api\/metrics\/vehicles\/[^/]+\/financial-detail$/.test(path)) return '/api/metrics/vehicles/:vehicleId/financial-detail';
  const business = /^\/api\/metrics\/business\/(vehicle-profiles|maintenance-labor-missing)\/[^/]+$/.exec(path);
  if (business) return `/api/metrics/business/${business[1]}/:vehicleId`;
  if (/^\/api\/metrics\/business\/maintenance-labor\/[^/]+\/[^/]+$/.test(path)) return '/api/metrics/business/maintenance-labor/:kind/:id';
  if (/^\/api\/metrics\/tolls\/charges\/[^/]+\/assign-trip$/.test(path)) return '/api/metrics/tolls/charges/:tollChargeId/assign-trip';
  return '/api/metrics/:other';
}

// Record before session/auth/database gates so their failures and waiting count.
function createMetricsRequestDiagnostics({ infra = diagnostics, now = () => performance.now() } = {}) {
  return (req, res, next) => {
    const pathname = (req.originalUrl || req.url || '').split('?')[0];
    if (!/^\/api\/metrics(?:\/|$)/.test(pathname)) return next();
    const started = now();
    const correlationId = randomUUID();
    req.correlationId = correlationId;
    res.setHeader('X-Request-ID', correlationId);
    let recorded = false;
    // Whitelist route shapes; never log raw URLs, querystrings or supplied IDs.
    const endpoint = safeMetricsEndpoint(pathname);
    const method = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    function record(aborted) {
      if (recorded) return;
      recorded = true;
      const durationMs = Math.max(0, now() - started);
      const slow = durationMs >= infra.cfg.slowMs;
      if (slow) infra.triggerDatabase('slow_metrics_request');
      infra.emit(slow || aborted || res.statusCode >= 500 ? 'warn' : 'info', 'metrics request', {
        correlation_id: correlationId, method, endpoint, duration_ms: Math.round(durationMs), status: aborted ? null : res.statusCode,
        outcome: aborted ? 'aborted' : res.statusCode >= 400 ? 'failure' : res.statusCode === 202 ? 'pending' : 'success', slow,
        ...(slow || aborted || res.statusCode >= 500 ? { diagnostics: infra.context() } : {}),
      });
    }
    res.once('finish', () => record(false));
    res.once('close', () => record(!res.writableFinished));
    requestContext.run({ correlationId }, next);
  };
}
module.exports = { createMetricsRequestDiagnostics, safeMetricsEndpoint };
