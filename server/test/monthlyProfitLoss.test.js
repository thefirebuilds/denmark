const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('toggle applies to totals and both comparison periods, including January rollover', async () => {
  const { buildMonthlyProfitLoss } = await import('../../shared/monthlyProfitLoss.mjs');
  const report = {
    points: [{ label: '2026-01-01', revenue: 1000, expenses: 1600, onboarding_expenses: 1200 }],
    comparison_points: [
      { label: '2025-01-01', revenue: 800, expenses: 700, onboarding_expenses: 200 },
      { label: '2025-12-01', revenue: 900, expenses: 900, onboarding_expenses: 500 },
    ],
  };
  const included = buildMonthlyProfitLoss(report, false);
  const excluded = buildMonthlyProfitLoss(report, true);
  assert.equal(included.summary.profit, -600);
  assert.equal(excluded.summary.profit, 600);
  assert.equal(excluded.summary.expenses, 400);
  assert.equal(excluded.summary.onboarding_expenses, 1200);
  assert.equal(excluded.points[0].month_change, 100);
  assert.equal(excluded.points[0].year_change, 300);
  assert.equal(included.points[0].year_change, -700);
  assert.equal(report.points[0].expenses, 1600);
});

test('missing comparison months stay unavailable; refunds reduce onboarding totals', async () => {
  const { buildMonthlyProfitLoss } = await import('../../shared/monthlyProfitLoss.mjs');
  const result = buildMonthlyProfitLoss({ points: [{ label: '2026-01-01', revenue: 100, expenses: -20, onboarding_expenses: -50 }] }, true);
  assert.equal(result.points[0].month_change, null);
  assert.equal(result.points[0].year_change, null);
  assert.equal(result.summary.expenses, 30);
  assert.equal(result.summary.profit, 70);
});

test('trend report retains 12 visible months, 24 comparison months, and isolates onboarding with tax', async () => {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), 1, 12).toISOString();
  const db = { query: async sql => ({ rows: sql.includes('FROM expenses') ? [
    { date, price: 1000, tax: 80, category: 'Vehicle Onboard' },
    { date, price: 100, tax: 8, category: 'maintenance' },
  ] : [] }), release() {} };
  const source = fs.readFileSync(path.join(__dirname, '../services/metrics/trendMetricsService.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} }, require: name => {
    if (name === '../../db') return { connect: async () => db };
    if (name === './occupancyTrend') return { getOccupancyTrend: async () => ({}) };
    return require('../services/metrics/metricHelpers');
  } });
  vm.runInContext(source, context);
  const report = (await context.module.exports.getTrendMetrics('90d')).monthly_profit_loss;
  assert.equal(report.points.length, 12);
  assert.equal(report.comparison_points.length, 24);
  assert.equal(report.points.at(-1).expenses, 1188);
  assert.equal(report.points.at(-1).onboarding_expenses, 1080);
  assert.equal(report.summary.expenses, 1188);
});
