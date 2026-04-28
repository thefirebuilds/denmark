const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DEFAULT_MARKETPLACE_SCREENING_RULES = {
  minComparablePrice: 6000,
  maxComparablePrice: 20000,
  maxUsefulMiles: 130000,
  minUsefulYear: 2014,
};

let marketplaceCatalogModulePromise = null;
let marketplaceCatalogModuleMtimeMs = null;

async function getMarketplaceCatalogModule() {
  const catalogPath = path.resolve(__dirname, "../../../src/utils/marketplaceCatalog.js");
  const stat = await fs.promises.stat(catalogPath);

  if (!marketplaceCatalogModulePromise || marketplaceCatalogModuleMtimeMs !== stat.mtimeMs) {
    const moduleUrl = pathToFileURL(catalogPath);
    moduleUrl.search = `?mtime=${stat.mtimeMs}`;
    marketplaceCatalogModulePromise = import(moduleUrl);
    marketplaceCatalogModuleMtimeMs = stat.mtimeMs;
  }

  return marketplaceCatalogModulePromise;
}

function marketplaceTextSource(item) {
  return String(item?.title || item?.raw_text_sample || "")
    .replace(/^\s*notifications?\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stdDev(values, avg) {
  if (values.length < 2 || !Number.isFinite(avg)) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function looksLikeNonComparablePricingText(item) {
  const text = [
    item?.title,
    item?.raw_text_sample,
    item?.seller_description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return false;

  const patterns = [
    /\bdown payment\b/,
    /\benganche\b/,
    /\bmonthly payments?\b/,
    /\bweekly payments?\b/,
    /\bbi[-\s]?weekly\b/,
    /\bper week\b/,
    /\bper month\b/,
    /\bfinancing\b/,
    /\bfinance available\b/,
    /\bowner finance\b/,
    /\bcredito\b/,
    /\bcredito\b/,
    /\bsalvage\b/,
    /\bsalvaje\b/,
    /\brebuilt\b/,
    /\brebuild\b/,
    /\breconstructed\b/,
    /\btotal loss\b/,
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function inferListingYearFromText(item) {
  const text = marketplaceTextSource(item);
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function yearBucket(year) {
  if (!Number.isInteger(year)) return "unknown";
  const start = year - (year % 2);
  return `${start}-${start + 1}`;
}

function mileageBucket(miles) {
  if (!Number.isFinite(miles)) return "unknown";
  const start = Math.floor(miles / 20000) * 20000;
  return `${start}-${start + 19999}`;
}

function minCohortSizeForKey(cohortKey) {
  if (String(cohortKey || "").startsWith("base::")) return 8;
  if (String(cohortKey || "").startsWith("year::")) return 4;
  return 3;
}

async function attachMarketplaceCohortMeta(pool, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const catalog = await getMarketplaceCatalogModule();
  const inferVehicleFromDescription = catalog?.inferVehicleFromDescription;
  if (typeof inferVehicleFromDescription !== "function") return rows;

  const cohortSourceResult = await pool.query(
    `
    SELECT
      id,
      title,
      raw_text_sample,
      seller_description,
      driven_miles,
      price_numeric
    FROM marketplace_listings
    WHERE price_numeric IS NOT NULL
      AND price_numeric >= $1
      AND price_numeric <= $2
      AND (driven_miles IS NULL OR driven_miles < $3)
      AND COALESCE(
            (substring(COALESCE(title, raw_text_sample, '') from '(19[0-9]{2}|20[0-9]{2})'))::int,
            9999
          ) >= $4
    `,
    [
      DEFAULT_MARKETPLACE_SCREENING_RULES.minComparablePrice,
      DEFAULT_MARKETPLACE_SCREENING_RULES.maxComparablePrice,
      DEFAULT_MARKETPLACE_SCREENING_RULES.maxUsefulMiles,
      DEFAULT_MARKETPLACE_SCREENING_RULES.minUsefulYear,
    ]
  );

  const cohorts = new Map();

  for (const item of cohortSourceResult.rows) {
    if (looksLikeNonComparablePricingText(item)) continue;

    const inferred = inferVehicleFromDescription(marketplaceTextSource(item));
    const make = String(inferred?.make || "").trim().toLowerCase();
    const model = String(inferred?.model || "").trim().toLowerCase();
    const price = Number(item?.price_numeric);
    if (!make || !model || !Number.isFinite(price)) continue;

    const year = inferListingYearFromText(item);
    const miles = Number(item?.driven_miles);
    const keys = [
      `strict::${make}::${model}::${yearBucket(year)}::${mileageBucket(miles)}`,
      `year::${make}::${model}::${yearBucket(year)}`,
      `base::${make}::${model}`,
    ];

    for (const cohortKey of keys) {
      const bucket = cohorts.get(cohortKey) || [];
      bucket.push({ id: item.id, price });
      cohorts.set(cohortKey, bucket);
    }
  }

  const cohortStatsByKey = new Map();

  for (const [cohortKey, bucket] of cohorts.entries()) {
    if (bucket.length < minCohortSizeForKey(cohortKey)) continue;

    const prices = bucket.map((entry) => entry.price);
    const baselinePrice = median(prices);
    const averagePrice = mean(prices);
    const deviation = stdDev(prices, averagePrice);
    if (!Number.isFinite(averagePrice) || averagePrice <= 0 || !Number.isFinite(baselinePrice) || baselinePrice <= 0) continue;

    cohortStatsByKey.set(cohortKey, {
      cohortKey,
      cohortSize: bucket.length,
      baselinePrice,
      averagePrice,
      deviation,
    });
  }

  const cohortMetaById = new Map();

  for (const item of rows) {
    if (looksLikeNonComparablePricingText(item)) continue;

    const inferred = inferVehicleFromDescription(marketplaceTextSource(item));
    const make = String(inferred?.make || "").trim().toLowerCase();
    const model = String(inferred?.model || "").trim().toLowerCase();
    const price = Number(item?.price_numeric);
    if (!make || !model || !Number.isFinite(price)) continue;

    const year = inferListingYearFromText(item);
    const miles = Number(item?.driven_miles);
    const candidateKeys = [
      `strict::${make}::${model}::${yearBucket(year)}::${mileageBucket(miles)}`,
      `year::${make}::${model}::${yearBucket(year)}`,
      `base::${make}::${model}`,
    ];

    const stats = candidateKeys.map((key) => cohortStatsByKey.get(key)).find(Boolean);
    if (!stats) continue;

    const delta = stats.baselinePrice - price;
    const ratio = price / stats.baselinePrice;
    const zScore = stats.deviation > 0 ? (stats.averagePrice - price) / stats.deviation : 0;
    const overpricedDelta = price - stats.baselinePrice;
    const overpricedRatio = price / stats.baselinePrice;
    const isSuspicious = delta >= 3000 && ratio <= 0.45 && zScore >= 2;
    const isOutlier = !isSuspicious && delta >= 1000 && ratio <= 0.82 && zScore >= 1.15;
    const isAlert = !isSuspicious && overpricedDelta >= 1000 && overpricedRatio >= 1.2;

    cohortMetaById.set(item.id, {
      cohortKey: stats.cohortKey,
      cohortSize: stats.cohortSize,
      baselinePrice: Math.round(stats.baselinePrice),
      averagePrice: Math.round(stats.averagePrice),
      delta: Math.round(delta),
      priceRatio: Math.round(ratio * 1000) / 1000,
      zScore: Math.round(zScore * 100) / 100,
      outlierLabel: isSuspicious ? "suspect" : isOutlier ? "outlier" : isAlert ? "alert" : null,
    });
  }

  return rows.map((row) => ({
    ...row,
    cohort_meta: cohortMetaById.get(row.id) || null,
  }));
}

module.exports = {
  DEFAULT_MARKETPLACE_SCREENING_RULES,
  attachMarketplaceCohortMeta,
  getMarketplaceCatalogModule,
  inferListingYearFromText,
  looksLikeNonComparablePricingText,
  marketplaceTextSource,
  mean,
  median,
  mileageBucket,
  minCohortSizeForKey,
  stdDev,
  yearBucket,
};
