const pool = require('../../db');

// Both metrics routers share this budget. A queued HTTP request holds no DB
// connection; messages, trip updates and telemetry can use the pool first.
function createMetricReadLimiter({
  db = pool,
  maxConcurrent = Number(process.env.METRICS_MAX_CONCURRENT || 1),
  queueMax = Number(process.env.METRICS_QUEUE_MAX || 4),
  queueTimeoutMs = Number(process.env.METRICS_QUEUE_TIMEOUT_MS || 8000),
} = {}) {
  maxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
  queueMax = Number.isFinite(queueMax) ? Math.max(0, Math.floor(queueMax)) : 4;
  queueTimeoutMs = Number.isFinite(queueTimeoutMs) ? Math.max(1, queueTimeoutMs) : 8000;
  let active = 0;
  const queue = [];

  function isDbPoolUnderPressure() {
    if (typeof db.getPoolStats !== 'function') return false;
    const stats = db.getPoolStats();
    return stats.waiting > 0 || (stats.max > 0 &&
      stats.checked_out >= Math.max(1, stats.max - 2));
  }

  function acquire() {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    if (queue.length >= queueMax) return Promise.reject(new Error('metrics queue full'));
    return new Promise((resolve, reject) => {
      const item = { resolve, timer: null };
      item.timer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        reject(new Error('metrics queue timeout'));
      }, queueTimeoutMs);
      queue.push(item);
    });
  }

  function release() {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      // Transfer the reserved slot directly; don't open a gap for new arrivals.
      next.resolve();
    } else {
      active--;
    }
  }

  function busy(res) {
    res.setHeader?.('Retry-After', '10');
    return res.status(503).json({
      error: 'Metrics temporarily deferred while database is busy',
      retry_after_seconds: 10,
    });
  }

  function limitMetricRead(handler) {
    return async (req, res, next) => {
      if (isDbPoolUnderPressure()) return busy(res);
      try { await acquire(); }
      catch { return busy(res); }
      try {
        if (req.aborted || res.destroyed) return;
        if (isDbPoolUnderPressure()) return busy(res);
        return await handler(req, res, next);
      } finally { release(); }
    };
  }
  async function tryRunMetricRefresh(work) {
    if (active > 0 || queue.length > 0 || isDbPoolUnderPressure()) return { deferred: true };
    active++;
    try { return await work(); }
    finally { release(); }
  }
  return { limitMetricRead, isDbPoolUnderPressure, tryRunMetricRefresh };
}

module.exports = { ...createMetricReadLimiter(), createMetricReadLimiter };
