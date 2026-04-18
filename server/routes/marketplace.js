//server/routes/marketplace.js
// ------------------------------------------------------------
// Express routes for handling marketplace listing data ingestion and enrichment
// ------------------------------------------------------------

const express = require("express");
const pool = require("../db");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const clients = new Set();
const router = express.Router();
const DEFAULT_IGNORE_KEYWORDS = ["nissan leaf"];
const DEFAULT_MARKETPLACE_SCREENING_RULES = {
  minUsefulPrice: 2500,
  maxUsefulPrice: 25000,
  minComparablePrice: 6000,
  maxComparablePrice: 20000,
  maxUsefulMiles: 130000,
  minUsefulYear: 2014,
  excludedFuelTypes: ["electric", "hybrid"],
};
const DEFAULT_MARKETPLACE_INVALID_LISTING_TERMS = [
  "salvage",
  "salvaje",
  "rebuilt",
  "rebuild",
  "reconstructed",
  "total loss",
  "turbo",
  "recommended down payment",
  "down payment",
  "monthly payment",
  "monthly payments",
  "weekly payment",
  "weekly payments",
  "bi-weekly",
  "bi weekly",
  "per week",
  "per month",
  "finance available",
  "owner finance",
  "financing",
  "enganche",
  "credito",
  "crédito",
];
let ensureMarketplacePreferencesTablePromise = null;
let marketplaceCatalogModulePromise = null;
let marketplaceCatalogModuleMtimeMs = null;

async function getMarketplaceCatalogModule() {
  const catalogPath = path.resolve(__dirname, "../../src/utils/marketplaceCatalog.js");
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

function hasMarketplaceSoldMarker(item) {
  const samples = [
    item?.title,
    item?.raw_text_sample,
  ]
    .filter(Boolean)
    .map((value) => String(value).replace(/\s+/g, " ").trim());

  return samples.some((text) => {
    if (!text) return false;

    return (
      /^sold\b/i.test(text) ||
      /^sold\b[\s:|-]+\$?\d/i.test(text) ||
      /^sold\b[\s:|-]+(?:just listed|listed\b)/i.test(text)
    );
  });
}

function hasMarketplaceUnavailableMarker(item) {
  const text = [
    item?.title,
    item?.raw_text_sample,
  ]
    .filter(Boolean)
    .map((value) => String(value).replace(/\s+/g, " ").trim().toLowerCase())
    .join(" ");

  if (!text) return false;

  return (
    text.includes("this listing isn't available anymore") ||
    text.includes("this listing isnt available anymore") ||
    text.includes("it may have been sold or expired")
  );
}

function hasMarketplaceEnrichmentSignal(item) {
  if (!item) return false;
  if (item.enriched_at) return true;

  return Boolean(
    item.vin ||
    item.transmission ||
    item.exterior_color ||
    item.interior_color ||
    item.fuel_type ||
    item.owners != null ||
    item.paid_off != null ||
    item.nhtsa_rating_overall != null ||
    item.seller_name ||
    item.seller_description
  );
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

function normalizeDuplicateText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(just listed|listed|message|about this vehicle|seller'?s description)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function duplicateTokenSet(item) {
  const base = normalizeDuplicateText(
    [item?.title, item?.seller_description, item?.raw_text_sample].filter(Boolean).join(" ")
  );
  return new Set(
    base
      .split(" ")
      .filter((token) => token.length >= 4)
      .slice(0, 24)
  );
}

function tokenOverlapScore(a, b) {
  if (!a?.size || !b?.size) return 0;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / Math.max(a.size, b.size);
}

async function attachMarketplaceCohortMeta(rows) {
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

async function attachMarketplaceDuplicateMeta(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  const catalog = await getMarketplaceCatalogModule();
  const inferVehicleFromDescription = catalog?.inferVehicleFromDescription;
  const estimateTexasCityDistanceFromBuda = catalog?.estimateTexasCityDistanceFromBuda;
  if (
    typeof inferVehicleFromDescription !== "function" ||
    typeof estimateTexasCityDistanceFromBuda !== "function"
  ) {
    return rows;
  }

  const sourceResult = await pool.query(
    `
    SELECT
      id,
      title,
      raw_text_sample,
      seller_description,
      listed_location,
      driven_miles,
      price_numeric,
      vin,
      transmission,
      exterior_color,
      interior_color,
      fuel_type,
      owners,
      paid_off,
      nhtsa_rating_overall,
      seller_name,
      enriched_at
    FROM marketplace_listings
    WHERE hidden = FALSE
      AND (driven_miles IS NULL OR driven_miles < $1)
      AND COALESCE(
            (substring(COALESCE(title, raw_text_sample, '') from '(19[0-9]{2}|20[0-9]{2})'))::int,
            9999
          ) >= $2
    `,
    [
      DEFAULT_MARKETPLACE_SCREENING_RULES.maxUsefulMiles,
      DEFAULT_MARKETPLACE_SCREENING_RULES.minUsefulYear,
    ]
  );

  const prepared = sourceResult.rows
    .filter((item) => hasMarketplaceEnrichmentSignal(item))
    .filter((item) => !looksLikeNonComparablePricingText(item))
    .map((item) => {
      const inferred = inferVehicleFromDescription(marketplaceTextSource(item));
      const make = String(inferred?.make || "").trim().toLowerCase();
      const model = String(inferred?.model || "").trim().toLowerCase();
      const year = inferListingYearFromText(item);
      const price = Number(item?.price_numeric);
      const miles = Number(item?.driven_miles);
      const location = String(item?.listed_location || "").trim();
      const distance = estimateTexasCityDistanceFromBuda(location);
      const tokens = duplicateTokenSet(item);

      return {
        id: item.id,
        make,
        model,
        year,
        price: Number.isFinite(price) ? price : null,
        miles: Number.isFinite(miles) ? miles : null,
        location,
        distance: Number.isFinite(distance) ? distance : null,
        tokens,
      };
    })
    .filter((item) => item.make && Number.isInteger(item.year));

  const byKey = new Map();
  for (const item of prepared) {
    const key = `${item.year}::${item.make}::${item.model || "__unknown_model"}`;
    const bucket = byKey.get(key) || [];
    bucket.push(item);
    byKey.set(key, bucket);
  }

  const duplicateMetaById = new Map();

  for (const item of prepared) {
    const key = `${item.year}::${item.make}::${item.model || "__unknown_model"}`;
    const candidates = byKey.get(key) || [];
    let bestMatch = null;
    let bestScore = 0;

    for (const other of candidates) {
      if (other.id === item.id) continue;

      const milesDelta =
        item.miles != null && other.miles != null
          ? Math.abs(item.miles - other.miles)
          : null;

      if (milesDelta != null && milesDelta > 1500) continue;

      const exactPrice =
        item.price != null &&
        other.price != null &&
        Math.abs(item.price - other.price) <= 25;
      const priceClose =
        item.price != null &&
        other.price != null &&
        Math.abs(item.price - other.price) <= 500;
      const exactMiles =
        item.miles != null &&
        other.miles != null &&
        milesDelta <= 500;
      const milesClose =
        item.miles != null &&
        other.miles != null &&
        milesDelta <= 1500;
      const exactLocation = item.location && other.location && item.location.toLowerCase() === other.location.toLowerCase();
      const distanceClose =
        item.distance != null &&
        other.distance != null &&
        Math.abs(item.distance - other.distance) <= 5;
      const textScore = tokenOverlapScore(item.tokens, other.tokens);

      let score = 0;
      if (exactPrice) score += 3.5;
      if (priceClose) score += 2;
      if (exactMiles) score += 3.5;
      if (milesClose) score += 2;
      if (exactLocation) score += 2;
      else if (distanceClose) score += 1.5;
      if (textScore >= 0.55) score += 3;
      else if (textScore >= 0.35) score += 1.5;

      const exactFingerprint = exactPrice && exactMiles;
      if (exactFingerprint) score += 2;

      if (score >= 5 && score > bestScore) {
        bestScore = score;
        bestMatch = other;
      }
    }

    if (bestMatch) {
      const bestMilesDelta =
        item.miles != null && bestMatch.miles != null
          ? Math.abs(item.miles - bestMatch.miles)
          : null;
      const bestPriceDelta =
        item.price != null && bestMatch.price != null
          ? Math.abs(item.price - bestMatch.price)
          : null;
      const likelyMileageMatch = bestMilesDelta != null && bestMilesDelta <= 1000;
      const likelyPriceMatch = bestPriceDelta != null && bestPriceDelta <= 100;
      const duplicateLabel =
        likelyMileageMatch && (bestScore >= 8 || likelyPriceMatch)
          ? "likely"
          : "possible";

      duplicateMetaById.set(item.id, {
        duplicateLabel,
        matchedId: bestMatch.id,
        matchedPrice: bestMatch.price,
        matchedMiles: bestMatch.miles,
        matchedLocation: bestMatch.location || null,
        matchedMilesDelta: bestMilesDelta,
        matchedPriceDelta: bestPriceDelta,
        similarityScore: Math.round(bestScore * 10) / 10,
      });
    }
  }

  return rows.map((row) => ({
    ...row,
    duplicate_meta: duplicateMetaById.get(row.id) || null,
  }));
}

function broadcastMarketplaceUpdate(payload = {}) {
  const message = `data: ${JSON.stringify({
    type: "marketplace_update",
    ...payload,
    sent_at: new Date().toISOString(),
  })}\n\n`;

  for (const res of clients) {
    res.write(message);
  }
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toFloatOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeDecisionStatus(value) {
  const allowed = new Set(["new", "watch", "candidate", "contacted", "passed", "bought"]);
  const v = String(value || "").trim().toLowerCase();
  return allowed.has(v) ? v : "new";
}

function normalizeMarketplaceUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/marketplace\/item\/(\d+)\//);
    if (m) return `${url.origin}/marketplace/item/${m[1]}/`;
    return `${url.origin}${url.pathname}`;
  } catch {
    return u;
  }
}

function normalizeMarketplaceTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title) return null;

  const lowered = title.toLowerCase();
  const blockedExact = new Set([
    "facebook",
    "marketplace",
    "notifications",
    "notification",
  ]);

  if (blockedExact.has(lowered)) return null;
  if (lowered.startsWith("notifications ")) return null;
  if (title.length > 220) return null;

  return title;
}

function parsePriceNumeric(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseDrivenMiles(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;

  const s = String(value).trim();
  if (!s) return null;

  const bareNumber = Number(s.replace(/[,\s]/g, ""));
  if (Number.isFinite(bareNumber) && /^\d[\d,\s]*$/.test(s)) {
    return Math.round(bareNumber);
  }

  const m = s.match(/(\d+(?:[,\s]\d{3})*|\d+)(?:\s*)(k)?\s*miles?/i);
  if (!m) return null;

  const n = Number(m[1].replace(/[,\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return m[2] ? Math.round(n * 1000) : Math.round(n);
}

function normalizeIgnoreKeywordsInput(value) {
  const values = Array.isArray(value) ? value : String(value || "").split("\n");
  const deduped = new Set();

  for (const entry of values) {
    const normalized = String(entry || "").trim().toLowerCase();
    if (normalized) deduped.add(normalized);
  }

  return Array.from(deduped);
}

function formatIgnoreKeywordsPreference(keywords) {
  const normalized = normalizeIgnoreKeywordsInput(keywords);
  const fallback = normalized.length ? normalized : DEFAULT_IGNORE_KEYWORDS;

  return {
    keywords: fallback,
    text: fallback.join("\n"),
  };
}

function normalizeFilterValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const numeric = Number(text.replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) && numeric >= 0 ? String(Math.round(numeric)) : "";
}

function formatMarketplaceFiltersPreference(value) {
  const raw = value && typeof value === "object" ? value : {};

  return {
    minPrice: normalizeFilterValue(raw.minPrice),
    maxPrice: normalizeFilterValue(raw.maxPrice),
    minMiles: normalizeFilterValue(raw.minMiles),
    maxMiles: normalizeFilterValue(raw.maxMiles),
  };
}

async function loadMarketplacePreference(preferenceKey) {
  await ensureMarketplacePreferencesTable();

  const { rows } = await pool.query(
    `
    SELECT preference_value
    FROM marketplace_preferences
    WHERE preference_key = $1
    LIMIT 1
    `,
    [preferenceKey]
  );

  return rows[0]?.preference_value ?? null;
}

async function saveMarketplacePreference(preferenceKey, preferenceValue) {
  await ensureMarketplacePreferencesTable();

  await pool.query(
    `
    INSERT INTO marketplace_preferences (
      preference_key,
      preference_value,
      created_at,
      updated_at
    )
    VALUES ($1, $2::jsonb, NOW(), NOW())
    ON CONFLICT (preference_key)
    DO UPDATE SET
      preference_value = EXCLUDED.preference_value,
      updated_at = NOW()
    `,
    [preferenceKey, JSON.stringify(preferenceValue)]
  );
}

async function ensureMarketplacePreferencesTable() {
  if (!ensureMarketplacePreferencesTablePromise) {
    ensureMarketplacePreferencesTablePromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS marketplace_preferences (
          preference_key TEXT PRIMARY KEY,
          preference_value JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      .catch((err) => {
        ensureMarketplacePreferencesTablePromise = null;
        throw err;
      });
  }

  await ensureMarketplacePreferencesTablePromise;
}

router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  res.write(
    `data: ${JSON.stringify({
      type: "marketplace_update",
      bootstrap: true,
      sent_at: new Date().toISOString(),
    })}\n\n`
  );

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

router.get("/listings", async (req, res) => {
  try {
    const catalog = await getMarketplaceCatalogModule();
    const includeHidden = String(req.query.includeHidden || "false") === "true";
    const unviewedOnly = String(req.query.unviewed || "false") === "true";
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    const search = req.query.search ? String(req.query.search).trim() : null;
    const freshOnly = String(req.query.freshOnly || "false") === "true";
    const minPrice = req.query.minPrice != null ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice != null ? Number(req.query.maxPrice) : null;
    const minMiles = req.query.minMiles != null ? Number(req.query.minMiles) : null;
    const maxMiles = req.query.maxMiles != null ? Number(req.query.maxMiles) : null;
    const minYear = req.query.minYear != null ? Number(req.query.minYear) : null;
    const ignoreKeywords = Array.isArray(req.query.ignore)
      ? req.query.ignore.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
      : req.query.ignore
        ? [String(req.query.ignore).trim().toLowerCase()].filter(Boolean)
        : [];
    const hasExplicitMinPrice = Number.isFinite(minPrice);
    const hasExplicitMaxPrice = Number.isFinite(maxPrice);
    const useExplicitPriceRange = hasExplicitMinPrice || hasExplicitMaxPrice;
    const effectiveMinPrice = useExplicitPriceRange
      ? (hasExplicitMinPrice ? minPrice : 0)
      : DEFAULT_MARKETPLACE_SCREENING_RULES.minUsefulPrice;
    const effectiveMaxPrice = useExplicitPriceRange
      ? (hasExplicitMaxPrice ? maxPrice : null)
      : DEFAULT_MARKETPLACE_SCREENING_RULES.maxUsefulPrice;
    const effectiveMaxMiles = Number.isFinite(maxMiles)
      ? maxMiles
      : DEFAULT_MARKETPLACE_SCREENING_RULES.maxUsefulMiles;
    const effectiveMinMiles = Number.isFinite(minMiles) ? minMiles : null;
    const effectiveMinYear = Number.isFinite(minYear)
      ? minYear
      : DEFAULT_MARKETPLACE_SCREENING_RULES.minUsefulYear;
    const invalidListingTerms = Array.isArray(catalog?.MARKETPLACE_INVALID_LISTING_TERMS)
      ? catalog.MARKETPLACE_INVALID_LISTING_TERMS
      : DEFAULT_MARKETPLACE_INVALID_LISTING_TERMS;
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);

    const where = [];
    const params = [];
    let i = 1;

    if (!includeHidden) {
      where.push(`hidden = FALSE`);
    }

    if (status === "uncontacted") {
      where.push(`COALESCE(decision_status, 'new') NOT IN ('candidate', 'contacted')`);
    } else if (status && status !== "all") {
      where.push(`COALESCE(decision_status, 'new') = $${i++}`);
      params.push(status);
    }

    if (freshOnly) {
      where.push(`COALESCE(last_seen_at, created_at) > COALESCE(reviewed_at, TIMESTAMP 'epoch')`);
      where.push(`COALESCE(decision_status, 'new') NOT IN ('candidate', 'contacted')`);
      where.push(`COALESCE(open_count, 0) = 0`);
    }

    if (unviewedOnly) {
      where.push(`COALESCE(open_count, 0) = 0`);
    }

    if (Number.isFinite(effectiveMinPrice)) {
      where.push(`(price_numeric IS NULL OR price_numeric >= $${i++})`);
      params.push(effectiveMinPrice);
    }

    if (Number.isFinite(effectiveMaxPrice)) {
      where.push(`(price_numeric IS NULL OR price_numeric <= $${i++})`);
      params.push(effectiveMaxPrice);
    }

    if (Number.isFinite(effectiveMinMiles)) {
      where.push(`(driven_miles IS NULL OR driven_miles >= $${i++})`);
      params.push(effectiveMinMiles);
    }

    if (Number.isFinite(effectiveMaxMiles)) {
      where.push(`(driven_miles IS NULL OR driven_miles < $${i++})`);
      params.push(effectiveMaxMiles);
    }

    if (Number.isFinite(effectiveMinYear)) {
      where.push(`(
        COALESCE(
          (substring(COALESCE(title, raw_text_sample, '') from '(19[0-9]{2}|20[0-9]{2})'))::int,
          9999
        ) >= $${i++}
      )`);
      params.push(effectiveMinYear);
    }

    if (!includeHidden && DEFAULT_MARKETPLACE_SCREENING_RULES.excludedFuelTypes.length > 0) {
      where.push(`(
        fuel_type IS NULL
        OR LOWER(TRIM(fuel_type)) <> ALL($${i++}::text[])
      )`);
      params.push(
        DEFAULT_MARKETPLACE_SCREENING_RULES.excludedFuelTypes.map((value) =>
          String(value || "").trim().toLowerCase()
        )
      );
    }

    if (!includeHidden && invalidListingTerms.length > 0) {
      where.push(`NOT EXISTS (
        SELECT 1
        FROM unnest($${i++}::text[]) AS invalid(term)
        WHERE LOWER(CONCAT_WS(' ', title, raw_text_sample, seller_description)) LIKE '%' || invalid.term || '%'
      )`);
      params.push(invalidListingTerms);
    }

    if (!includeHidden && ignoreKeywords.length > 0) {
      where.push(`NOT EXISTS (
        SELECT 1
        FROM unnest($${i++}::text[]) AS ignored(keyword)
        WHERE LOWER(COALESCE(title, raw_text_sample, '')) LIKE '%' || ignored.keyword || '%'
      )`);
      params.push(ignoreKeywords);
    }

    if (search) {
      where.push(`
        (
          title ILIKE $${i}
          OR seller_name ILIKE $${i}
          OR vin ILIKE $${i}
          OR listed_location ILIKE $${i}
          OR raw_text_sample ILIKE $${i}
        )
      `);
      params.push(`%${search}%`);
      i += 1;
    }

    const countSql = `
      SELECT COUNT(*)::int AS total_count
      FROM marketplace_listings
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    `;

    params.push(limit);

    const sql = `
      SELECT
        id,
        url,
        title,
        price_text,
        price_numeric,
        listed_ago,
        listed_location,
        vin,
        driven_miles,
        raw_text_sample,
        transmission,
        exterior_color,
        interior_color,
        fuel_type,
        owners,
        paid_off,
        nhtsa_rating_overall,
        seller_name,
        seller_joined_year,
        seller_description,
        keywords,
        hidden,
        ignored_at,
        open_count,
        last_opened_at,
        enriched_at,
        first_seen_at,
        last_seen_at,
        scraped_at,
        decision_status,
        decision_score,
        decision_notes,
        decision_tags,
        acquisition_priority,
        reviewed_at,
        reviewed_by
      FROM marketplace_listings
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        hidden ASC,
        COALESCE(acquisition_priority, 999) ASC,
        last_seen_at DESC,
        created_at DESC
      LIMIT $${i}
    `;

    const [{ rows }, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query(countSql, params.slice(0, params.length - 1)),
    ]);

    const listingsWithCohortMeta = await attachMarketplaceCohortMeta(rows);
    const listingsWithMeta = await attachMarketplaceDuplicateMeta(listingsWithCohortMeta);

    return res.json({
      ok: true,
      listings: listingsWithMeta,
      totalCount: countResult.rows[0]?.total_count ?? listingsWithMeta.length,
      limit,
    });
  } catch (err) {
    console.error("[marketplace.listings] failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "listings failed" });
  }
});

router.get("/preferences/ignore-keywords", async (req, res) => {
  try {
    const stored = (await loadMarketplacePreference("ignore_keywords"))?.keywords;
    const preference = formatIgnoreKeywordsPreference(stored);

    return res.json({ ok: true, ...preference });
  } catch (err) {
    console.error("[marketplace.getIgnoreKeywords] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "ignore keywords load failed",
    });
  }
});

router.put("/preferences/ignore-keywords", async (req, res) => {
  try {
    const body = req.body || {};
    const preference = formatIgnoreKeywordsPreference(
      body.keywords !== undefined ? body.keywords : body.text
    );

    await saveMarketplacePreference("ignore_keywords", {
      keywords: preference.keywords,
    });

    broadcastMarketplaceUpdate({
      source: "ignoreKeywordsPreference",
    });

    return res.json({ ok: true, ...preference });
  } catch (err) {
    console.error("[marketplace.putIgnoreKeywords] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "ignore keywords save failed",
    });
  }
});

router.get("/preferences/filters", async (req, res) => {
  try {
    const stored = await loadMarketplacePreference("filters");
    const preference = formatMarketplaceFiltersPreference(stored);

    return res.json({ ok: true, ...preference });
  } catch (err) {
    console.error("[marketplace.getFiltersPreference] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "filters load failed",
    });
  }
});

router.put("/preferences/filters", async (req, res) => {
  try {
    const preference = formatMarketplaceFiltersPreference(req.body || {});

    await saveMarketplacePreference("filters", preference);

    return res.json({ ok: true, ...preference });
  } catch (err) {
    console.error("[marketplace.putFiltersPreference] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "filters save failed",
    });
  }
});

router.patch("/listings/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: "invalid id" });
    }

    const body = req.body || {};

    const decisionStatus =
      body.decision_status === undefined
        ? undefined
        : normalizeDecisionStatus(body.decision_status);

    const decisionScore =
      body.decision_score === undefined
        ? undefined
        : toFloatOrNull(body.decision_score);

    const decisionNotes =
      body.decision_notes === undefined
        ? undefined
        : (body.decision_notes || null);

    const decisionTags =
      body.decision_tags === undefined
        ? undefined
        : JSON.stringify(Array.isArray(body.decision_tags) ? body.decision_tags : []);

    const acquisitionPriority =
      body.acquisition_priority === undefined
        ? undefined
        : toIntOrNull(body.acquisition_priority);

    const vin =
      body.vin === undefined
        ? undefined
        : (String(body.vin || "").trim().toUpperCase() || null);

    const drivenMiles =
      body.driven_miles === undefined
        ? undefined
        : parseDrivenMiles(body.driven_miles);

    const hidden =
      body.hidden === undefined
        ? undefined
        : Boolean(body.hidden);

    const fields = [];
    const params = [];
    let i = 1;
    let shouldMarkReviewed = false;

    if (decisionStatus !== undefined) {
      fields.push(`decision_status = $${i++}`);
      params.push(decisionStatus);
      shouldMarkReviewed = true;
    }

    if (decisionScore !== undefined) {
      fields.push(`decision_score = $${i++}`);
      params.push(decisionScore);
      shouldMarkReviewed = true;
    }

    if (decisionNotes !== undefined) {
      fields.push(`decision_notes = $${i++}`);
      params.push(decisionNotes);
      shouldMarkReviewed = true;
    }

    if (decisionTags !== undefined) {
      fields.push(`decision_tags = $${i++}::jsonb`);
      params.push(decisionTags);
      shouldMarkReviewed = true;
    }

    if (acquisitionPriority !== undefined) {
      fields.push(`acquisition_priority = $${i++}`);
      params.push(acquisitionPriority);
      shouldMarkReviewed = true;
    }

    if (vin !== undefined) {
      fields.push(`vin = $${i++}`);
      params.push(vin);
    }

    if (drivenMiles !== undefined) {
      fields.push(`driven_miles = $${i++}`);
      params.push(drivenMiles);
    }

    if (hidden !== undefined) {
      fields.push(`hidden = $${i++}`);
      params.push(hidden);
      fields.push(`ignored_at = ${hidden ? "NOW()" : "NULL"}`);
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, error: "no valid fields to update" });
    }

    if (shouldMarkReviewed) {
      fields.push(`reviewed_at = NOW()`);
    }

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const { rows } = await pool.query(
      `
      UPDATE marketplace_listings
      SET ${fields.join(", ")}
      WHERE id = $${i}
      RETURNING *
      `,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "listing not found" });
    }

    broadcastMarketplaceUpdate({
      source: "patch",
      id,
    });

    return res.json({ ok: true, listing: rows[0] });
  } catch (err) {
    console.error("[marketplace.patchListing] failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "update failed" });
  }
});

router.post("/listings/:id/ignore", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: "invalid id" });
    }

    const { rows } = await pool.query(
      `
      UPDATE marketplace_listings
      SET hidden = TRUE,
          ignored_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, url, hidden, ignored_at
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "listing not found" });
    }

    broadcastMarketplaceUpdate({
      source: "ignore",
      id,
    });

    return res.json({ ok: true, listing: rows[0] });
  } catch (err) {
    console.error("[marketplace.ignoreById] failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "ignore failed" });
  }
});

router.get("/health", async (req, res) => {
  res.json({ ok: true, service: "marketplace-api" });
});

router.post("/listings/:id/opened", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: "invalid id" });
    }

    const { rows } = await pool.query(
      `
      UPDATE marketplace_listings
      SET
        open_count = COALESCE(open_count, 0) + 1,
        last_opened_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, open_count, last_opened_at
      `,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "listing not found" });
    }

    broadcastMarketplaceUpdate({
      source: "opened",
      id,
    });

    return res.json({ ok: true, ...rows[0] });
  } catch (err) {
    console.error("[marketplace.markOpened] failed:", err);
    return res.status(500).json({ ok: false, error: err.message || "mark opened failed" });
  }
});

router.post("/ingest", async (req, res) => {
  const client = await pool.connect();
  try {
    const payload = req.body || {};
    const results = Array.isArray(payload.results) ? payload.results : [];

    await client.query("BEGIN");

    let insertedOrUpdated = 0;

    for (const item of results) {
      const url = normalizeMarketplaceUrl(item?.url);
      if (!url) continue;

      const normalizedTitle = normalizeMarketplaceTitle(item?.title);

      await client.query(
        `
        INSERT INTO marketplace_listings (
          url,
          title,
          price_text,
          price_numeric,
          listed_location,
          driven_miles,
          raw_text_sample,
          scraped_at,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (url)
        DO UPDATE SET
          title = COALESCE(EXCLUDED.title, marketplace_listings.title),
          price_text = COALESCE(EXCLUDED.price_text, marketplace_listings.price_text),
          price_numeric = COALESCE(EXCLUDED.price_numeric, marketplace_listings.price_numeric),
          listed_location = COALESCE(EXCLUDED.listed_location, marketplace_listings.listed_location),
          driven_miles = COALESCE(EXCLUDED.driven_miles, marketplace_listings.driven_miles),
          raw_text_sample = COALESCE(EXCLUDED.raw_text_sample, marketplace_listings.raw_text_sample),
          last_seen_at = NOW(),
          updated_at = NOW()
        `,
        [
          url,
          normalizedTitle,
          item?.price || null,
          parsePriceNumeric(item?.price),
          item?.listed_location || null,
          parseDrivenMiles(item?.mileage),
          item?.text || null,
        ]
      );

      insertedOrUpdated += 1;
    }

    await client.query("COMMIT");

    if (insertedOrUpdated > 0) {
      broadcastMarketplaceUpdate({
        source: "ingest",
        upserted: insertedOrUpdated,
      });
    }

    return res.json({
      ok: true,
      count: results.length,
      upserted: insertedOrUpdated,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[marketplace.ingest] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "ingest failed",
    });
  } finally {
    client.release();
  }
});

router.post("/enrich", async (req, res) => {
  try {
    const body = req.body || {};
    const url = normalizeMarketplaceUrl(body.url);

    if (!url) {
      return res.status(400).json({ ok: false, error: "missing url" });
    }

    const about = body.about || {};
    const seller = body.seller || {};
    const soldByFacebook = hasMarketplaceSoldMarker({
      title: body.title,
      raw_text_sample: body.raw_text_sample,
    });
    const unavailableByFacebook = hasMarketplaceUnavailableMarker({
      title: body.title,
      raw_text_sample: body.raw_text_sample,
    });
    const autoIgnore = soldByFacebook || unavailableByFacebook;

    await pool.query(
      `
      INSERT INTO marketplace_listings (
        url,
        title,
        price_text,
        price_numeric,
        listed_ago,
        listed_location,
        vin,
        driven_miles,
        transmission,
        exterior_color,
        interior_color,
        fuel_type,
        owners,
        paid_off,
        nhtsa_rating_overall,
        seller_name,
        seller_joined_year,
        seller_description,
        raw_text_sample,
        keywords,
        hidden,
        ignored_at,
        enriched_at,
        scraped_at,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb,
        $21, CASE WHEN $21 THEN NOW() ELSE NULL END, NOW(), $22, NOW(), NOW(), NOW(), NOW()
      )
      ON CONFLICT (url)
      DO UPDATE SET
        title = COALESCE(EXCLUDED.title, marketplace_listings.title),
        price_text = COALESCE(EXCLUDED.price_text, marketplace_listings.price_text),
        price_numeric = COALESCE(EXCLUDED.price_numeric, marketplace_listings.price_numeric),
        listed_ago = COALESCE(EXCLUDED.listed_ago, marketplace_listings.listed_ago),
        listed_location = COALESCE(EXCLUDED.listed_location, marketplace_listings.listed_location),
        vin = COALESCE(EXCLUDED.vin, marketplace_listings.vin),
        driven_miles = COALESCE(EXCLUDED.driven_miles, marketplace_listings.driven_miles),
        transmission = COALESCE(EXCLUDED.transmission, marketplace_listings.transmission),
        exterior_color = COALESCE(EXCLUDED.exterior_color, marketplace_listings.exterior_color),
        interior_color = COALESCE(EXCLUDED.interior_color, marketplace_listings.interior_color),
        fuel_type = COALESCE(EXCLUDED.fuel_type, marketplace_listings.fuel_type),
        owners = COALESCE(EXCLUDED.owners, marketplace_listings.owners),
        paid_off = COALESCE(EXCLUDED.paid_off, marketplace_listings.paid_off),
        nhtsa_rating_overall = COALESCE(EXCLUDED.nhtsa_rating_overall, marketplace_listings.nhtsa_rating_overall),
        seller_name = COALESCE(EXCLUDED.seller_name, marketplace_listings.seller_name),
        seller_joined_year = COALESCE(EXCLUDED.seller_joined_year, marketplace_listings.seller_joined_year),
        seller_description = COALESCE(EXCLUDED.seller_description, marketplace_listings.seller_description),
        raw_text_sample = COALESCE(EXCLUDED.raw_text_sample, marketplace_listings.raw_text_sample),
        keywords = CASE
          WHEN EXCLUDED.keywords IS NOT NULL AND EXCLUDED.keywords <> '[]'::jsonb
          THEN EXCLUDED.keywords
          ELSE marketplace_listings.keywords
        END,
        enriched_at = COALESCE(EXCLUDED.enriched_at, marketplace_listings.enriched_at, NOW()),
        hidden = EXCLUDED.hidden,
        ignored_at = CASE WHEN EXCLUDED.hidden THEN NOW() ELSE NULL END,
        scraped_at = COALESCE(EXCLUDED.scraped_at, marketplace_listings.scraped_at),
        last_seen_at = NOW(),
        updated_at = NOW()
      `,
      [
        url,
        normalizeMarketplaceTitle(body.title),
        body.price || null,
        parsePriceNumeric(body.price),
        body.listed_ago || null,
        body.listed_location || null,
        body.vin || null,
        parseDrivenMiles(about.driven_miles),
        about.transmission || null,
        about.exterior_color || null,
        about.interior_color || null,
        about.fuel_type || null,
        about.owners ?? null,
        about.paid_off ?? null,
        about.nhtsa_rating_overall ?? null,
        seller.name || null,
        seller.joined_year ?? null,
        body.seller_description || null,
        body.raw_text_sample || null,
        JSON.stringify(Array.isArray(body.keywords) ? body.keywords : []),
        autoIgnore,
        body.scraped_at || new Date().toISOString(),
      ]
    );

    broadcastMarketplaceUpdate({
      source: "enrich",
      url,
      hidden: autoIgnore,
    });

    return res.json({ ok: true, url, hidden: autoIgnore });
  } catch (err) {
    console.error("[marketplace.enrich] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "enrich failed",
    });
  }
});

router.post("/listings/ignoreByUrl", async (req, res) => {
  try {
    const url = normalizeMarketplaceUrl(req.body?.url);
    if (!url) {
      return res.status(400).json({ ok: false, error: "missing url" });
    }

    const result = await pool.query(
      `
      UPDATE marketplace_listings
      SET hidden = TRUE,
          ignored_at = NOW(),
          updated_at = NOW()
      WHERE url = $1
      RETURNING id, url, hidden, ignored_at
      `,
      [url]
    );

    if (result.rowCount === 0) {
      await pool.query(
        `
        INSERT INTO marketplace_listings (
          url,
          hidden,
          ignored_at,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at
        )
        VALUES ($1, TRUE, NOW(), NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (url)
        DO UPDATE SET
          hidden = TRUE,
          ignored_at = NOW(),
          updated_at = NOW()
        `,
        [url]
      );
    }

    broadcastMarketplaceUpdate({
      source: "ignoreByUrl",
      url,
    });

    return res.json({ ok: true, url, hidden: true });
  } catch (err) {
    console.error("[marketplace.ignoreByUrl] failed:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "ignore failed",
    });
  }
});

module.exports = router;
