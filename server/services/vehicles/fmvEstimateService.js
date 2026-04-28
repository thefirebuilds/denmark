const crypto = require("crypto");
const pool = require("../../db");
const { getVehicleMaintenanceSummary } = require("../maintenance/getVehicleMaintenanceSummary");
const {
  attachMarketplaceCohortMeta,
  getMarketplaceCatalogModule,
  inferListingYearFromText,
} = require("../marketplace/marketplaceCohort");

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_FMV_MODEL || "gpt-4.1-mini";
const DEFAULT_MARKET_LABEL =
  process.env.OPENAI_FMV_MARKET_LABEL || "Austin, Texas, USA";
const MARKETPLACE_MIN_USEFUL_PRICE = 2500;
const MARKETPLACE_MAX_USEFUL_PRICE = 25000;
const MARKETPLACE_MAX_USEFUL_MILES = 180000;
const MARKETPLACE_MAX_SAMPLE_COMPS = 5;
const MARKETPLACE_MIN_STRICT_COMPS = 4;
const MARKETPLACE_MIN_BROAD_COMPS = 5;
const TURO_MAX_ELIGIBLE_MILES = 130000;
const TURO_MAX_ELIGIBLE_AGE_YEARS = 12;
const TURO_MILEAGE_SOFT_BUFFER = 10000;
const TURO_MILEAGE_GRACE_CAP = 155000;
const ROUTINE_SERVICE_RULE_CODES = new Set([
  "engine_air_filter",
  "cabin_air_filter",
  "tire_pressure_check",
  "fluid_leak_check",
  "oil_level_check",
  "oil_change",
  "cleaning",
  "post_trip_condition_review",
]);
function normalizeSelector(value) {
  return String(value || "").trim().toLowerCase();
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWholePhrase(text, phrase) {
  const normalizedText = String(text || "").toLowerCase();
  const normalizedPhrase = String(phrase || "").trim().toLowerCase();
  if (!normalizedText || !normalizedPhrase) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedPhrase)}([^a-z0-9]|$)`, "i");
  return pattern.test(normalizedText);
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function getMarketplaceCohortWeight(strategy, usableCount) {
  const count = Number(usableCount || 0);
  if (count <= 0) return 0;

  let baseWeight;
  if (count <= 2) baseWeight = 0.1;
  else if (count >= 40) baseWeight = 1;
  else baseWeight = 0.1 + ((count - 2) / 38) * 0.9;

  const strategyFactor =
    strategy === "exact_year_mileage_band"
      ? 1
      : strategy === "same_year_tighter_miles"
      ? 0.92
      : strategy === "near_year_near_miles"
      ? 0.82
      : 0.68;

  return roundTo(Math.max(0.05, Math.min(1, baseWeight * strategyFactor)), 2);
}

function isCloseYearMileageComparable(item) {
  const yearDelta = Number(item?.year_delta);
  const mileageDelta = Number(item?.mileage_delta);

  return (
    (Number.isFinite(yearDelta) ? yearDelta <= 0 : true) &&
    (Number.isFinite(mileageDelta) ? mileageDelta <= 10000 : true)
  );
}

function trimPriceOutliers(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { kept: [], dropped: [] };
  }

  if (items.length < 5) {
    return { kept: [...items], dropped: [] };
  }

  const prices = items.map((item) => item.price).filter(Number.isFinite);
  const rawMedian = median(prices);
  if (!Number.isFinite(rawMedian) || rawMedian <= 0) {
    return { kept: [...items], dropped: [] };
  }

  const lowFloor = rawMedian * 0.72;
  const highCeiling = rawMedian * 1.38;

  const protectedIds = new Set(
    items.filter(isCloseYearMileageComparable).map((item) => item.id)
  );

  const filtered = items.filter((item) => {
    if (protectedIds.has(item.id)) return true;
    return item.price >= lowFloor && item.price <= highCeiling;
  });

  if (filtered.length >= Math.max(3, Math.ceil(items.length * 0.6))) {
    return {
      kept: filtered,
      dropped: items.filter((item) => !filtered.includes(item)),
    };
  }

  const sorted = [...items].sort((a, b) => a.price - b.price);
  const trimCount = items.length >= 10 ? 2 : items.length >= 6 ? 1 : 0;
  if (trimCount <= 0 || sorted.length - trimCount * 2 < 3) {
    return { kept: [...items], dropped: [] };
  }

  const kept = sorted.slice(trimCount, sorted.length - trimCount);
  return {
    kept,
    dropped: sorted.filter((item) => !kept.includes(item)),
  };
}

function buildMarketplaceListingText(item) {
  return [item?.title, item?.raw_text_sample, item?.seller_description]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMarketplaceRouteText(item) {
  return String(item?.title || item?.raw_text_sample || "")
    .replace(/^\s*notifications?\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeListingFingerprintText(item) {
  return buildMarketplaceListingText(item)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function currentModelYear() {
  return new Date().getFullYear();
}

function isLikelyTuroEligibleVehicle(year, miles) {
  const vehicleYear = Number(year);
  const odometerMiles = Number(miles);

  if (!Number.isFinite(vehicleYear) || !Number.isFinite(odometerMiles)) return false;

  return (
    currentModelYear() - vehicleYear <= TURO_MAX_ELIGIBLE_AGE_YEARS &&
    odometerMiles < TURO_MAX_ELIGIBLE_MILES
  );
}

function getComparableMileageCapForSubject(year, miles) {
  if (!isLikelyTuroEligibleVehicle(year, miles)) return null;

  const odometerMiles = Number(miles);
  if (!Number.isFinite(odometerMiles)) return TURO_MAX_ELIGIBLE_MILES;

  if (odometerMiles < TURO_MAX_ELIGIBLE_MILES - TURO_MILEAGE_SOFT_BUFFER) {
    return TURO_MAX_ELIGIBLE_MILES;
  }

  return Math.min(
    TURO_MILEAGE_GRACE_CAP,
    Math.max(TURO_MAX_ELIGIBLE_MILES, odometerMiles + 25000)
  );
}

function dedupeMarketplaceListings(items) {
  const seen = new Set();

  return items.filter((item) => {
    const fingerprint = [
      item?.year ?? "",
      item?.price ?? "",
      item?.driven_miles ?? "",
      normalizeListingFingerprintText(item),
    ].join("|");

    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function isRoutineServiceRule(rule) {
  const ruleCode = String(rule?.ruleCode || "").trim().toLowerCase();
  const title = String(rule?.title || "").trim().toLowerCase();

  if (ROUTINE_SERVICE_RULE_CODES.has(ruleCode)) return true;

  return [
    "air filter",
    "tire pressure",
    "fluid / leak inspection",
    "fluid leak inspection",
    "oil level",
    "oil change",
    "cleaning",
    "condition review",
  ].some((snippet) => title.includes(snippet));
}

function looksLikeNonComparablePricingText(item) {
  const text = buildMarketplaceListingText(item).toLowerCase();
  if (!text) return false;

  return [
    /\bdown payment\b/,
    /\bdownpayment\b/,
    /\bsuggested down ?payment\b/,
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
    /\bsalvage\b/,
    /\bsalvaje\b/,
    /\brebuilt\b/,
    /\brebuild\b/,
    /\breconstructed\b/,
    /\btotal loss\b/,
    /\bblown turbo\b/,
    /\bbad turbo\b/,
    /\bneeds turbo\b/,
    /\bneeds engine\b/,
    /\bneeds transmission\b/,
    /\bmechanic special\b/,
    /\bparts car\b/,
    /\bnot running\b/,
    /\binop\b/,
    /\bdoesn'?t run\b/,
    /\bwon'?t start\b/,
    /\btow away\b/,
  ].some((pattern) => pattern.test(text));
}

function hasMarketplaceSoldMarker(item) {
  const samples = [item?.title, item?.raw_text_sample]
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
  const text = [item?.title, item?.raw_text_sample]
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

async function fetchMarketplaceListingAnchor(client, vehicle) {
  const make = String(vehicle?.make || "").trim();
  const model = String(vehicle?.model || "").trim();
  const year = Number(vehicle?.year);
  const odometerMiles = toNumberOrNull(
    vehicle?.current_odometer_miles ?? vehicle?.odometerMiles
  );

  if (!make || !model) return null;

  const catalog = await getMarketplaceCatalogModule().catch(() => null);
  const inferVehicleFromDescription = catalog?.inferVehicleFromDescription;

  const { rows } = await client.query(
    `
      SELECT
        id,
        url,
        title,
        raw_text_sample,
        seller_description,
        price_numeric,
        driven_miles,
        listed_location,
        last_seen_at,
        updated_at
      FROM marketplace_listings
      WHERE hidden = false
        AND ignored_at IS NULL
        AND price_numeric IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `
  );

  const comparableRows = (await attachMarketplaceCohortMeta(client, rows))
    .filter((item) => !looksLikeNonComparablePricingText(item))
    .filter((item) => !hasMarketplaceSoldMarker(item))
    .filter((item) => !hasMarketplaceUnavailableMarker(item))
    .map((item) => {
      const text = [buildMarketplaceRouteText(item), item?.seller_description]
        .filter(Boolean)
        .join(" ");
      const inferred =
        typeof inferVehicleFromDescription === "function"
          ? inferVehicleFromDescription(text)
          : null;
      const inferredMake = String(inferred?.make || "").trim().toLowerCase();
      const inferredModel = String(inferred?.model || "").trim().toLowerCase();
      const targetMake = make.toLowerCase();
      const targetModel = model.toLowerCase();

      if (inferredMake && inferredModel) {
        if (inferredMake !== targetMake || inferredModel !== targetModel) {
          return null;
        }
      } else if (!hasWholePhrase(text, make) || !hasWholePhrase(text, model)) {
        return null;
      }

      const listingYear = inferListingYearFromText(item);
      const listingMiles = toNumberOrNull(item?.driven_miles);
      const price = toNumberOrNull(item?.price_numeric);
      if (!Number.isFinite(price)) return null;
      if (!item?.cohort_meta?.baselinePrice || !item?.cohort_meta?.cohortSize) return null;

      return {
        ...item,
        year: listingYear,
        price,
        driven_miles: listingMiles,
        mileage_delta:
          odometerMiles != null && listingMiles != null
            ? Math.abs(listingMiles - odometerMiles)
            : Number.POSITIVE_INFINITY,
        year_delta:
          Number.isInteger(year) && Number.isInteger(listingYear)
            ? Math.abs(listingYear - year)
            : Number.POSITIVE_INFINITY,
      };
    })
    .filter(Boolean);

  if (!comparableRows.length) return null;

  const bestListing = [...comparableRows].sort((a, b) => {
    if (a.year_delta !== b.year_delta) return a.year_delta - b.year_delta;
    if (a.mileage_delta !== b.mileage_delta) return a.mileage_delta - b.mileage_delta;
    return Math.abs((a.price ?? 0) - (b.price ?? 0));
  })[0];

  if (!bestListing) return null;
  const anchorGroup = comparableRows
    .filter(
      (item) =>
        item?.cohort_meta?.cohortKey === bestListing?.cohort_meta?.cohortKey
    );
  if (!anchorGroup.length) return null;

  const stats = {
    cohortKey: bestListing.cohort_meta.cohortKey,
    cohortSize: Number(bestListing.cohort_meta.cohortSize),
    baselinePrice: Number(bestListing.cohort_meta.baselinePrice),
    averagePrice: Number(bestListing.cohort_meta.averagePrice),
  };

  const sampleRows = [...anchorGroup]
    .sort((a, b) => {
      const aDelta = Math.abs(a.price - stats.baselinePrice);
      const bDelta = Math.abs(b.price - stats.baselinePrice);
      if (aDelta !== bDelta) return aDelta - bDelta;
      if (a.year_delta !== b.year_delta) return a.year_delta - b.year_delta;
      return a.mileage_delta - b.mileage_delta;
    })
    .slice(0, MARKETPLACE_MAX_SAMPLE_COMPS)
    .map((item) => ({
      id: item.id,
      title: item.title || null,
      year: item.year,
      price: item.price,
      driven_miles: item.driven_miles,
      listed_location: item.listed_location || null,
      url: item.url || null,
    }));

  return {
    listing_id: bestListing.id,
    listing_price: bestListing.price,
    listing_url: bestListing.url || null,
    cohort_key: stats.cohortKey,
    cohort_count: stats.cohortSize,
    cohort_baseline_price: Math.round(stats.baselinePrice),
    cohort_average_price: Math.round(stats.averagePrice),
    sample_count: sampleRows.length,
    samples: sampleRows,
  };
}

async function fetchMarketplaceCohortSnapshot(client, vehicle) {
  const make = String(vehicle?.make || "").trim();
  const model = String(vehicle?.model || "").trim();
  const year = Number(vehicle?.year);
  const odometerMiles = toNumberOrNull(
    vehicle?.current_odometer_miles ?? vehicle?.odometerMiles
  );

  if (!make || !model) return null;

  const marketplaceListingAnchor = await fetchMarketplaceListingAnchor(client, vehicle);

  if (marketplaceListingAnchor) {
    const prices = marketplaceListingAnchor.samples
      .map((item) => Number(item.price))
      .filter(Number.isFinite);
    const sampleCount = Number(marketplaceListingAnchor.sample_count || marketplaceListingAnchor.cohort_count || 0);
    const cohortWeight = getMarketplaceCohortWeight("marketplace_anchor", sampleCount);

    return {
      available: true,
      strategy: "marketplace_listing_anchor",
      matched_count: sampleCount,
      comparable_pool_count: sampleCount,
      cohort_count: marketplaceListingAnchor.cohort_count,
      usable_cohort_count: sampleCount,
      dropped_outlier_count: 0,
      turo_eligible_subject: isLikelyTuroEligibleVehicle(year, odometerMiles),
      comparable_mileage_cap: getComparableMileageCapForSubject(year, odometerMiles),
      turo_mileage_filtered_count: sampleCount,
      price_low: prices.length ? Math.min(...prices) : marketplaceListingAnchor.cohort_baseline_price,
      price_median: marketplaceListingAnchor.cohort_baseline_price,
      price_average: marketplaceListingAnchor.cohort_average_price,
      price_high: prices.length ? Math.max(...prices) : marketplaceListingAnchor.cohort_baseline_price,
      weight_recommendation_pct: roundTo(Math.max(cohortWeight, 0.35) * 100, 0),
      weight_recommendation_ratio: Math.max(cohortWeight, 0.35),
      vehicle_year: Number.isInteger(year) ? year : null,
      vehicle_odometer_miles: odometerMiles,
      listing_anchor: marketplaceListingAnchor,
      samples: marketplaceListingAnchor.samples,
    };
  }

  const { rows } = await client.query(
    `
      SELECT
        id,
        title,
        price_numeric,
        driven_miles,
        listed_location,
        raw_text_sample,
        seller_description,
        last_seen_at
      FROM marketplace_listings
      WHERE hidden = false
        AND ignored_at IS NULL
        AND price_numeric IS NOT NULL
        AND price_numeric >= $1
        AND price_numeric <= $2
        AND (driven_miles IS NULL OR driven_miles < $3)
      ORDER BY last_seen_at DESC NULLS LAST, id DESC
      LIMIT 5000
    `,
    [
      MARKETPLACE_MIN_USEFUL_PRICE,
      MARKETPLACE_MAX_USEFUL_PRICE,
      MARKETPLACE_MAX_USEFUL_MILES,
    ]
  );

  const matching = dedupeMarketplaceListings(
    rows
    .filter((item) => !looksLikeNonComparablePricingText(item))
    .map((item) => {
      const text = buildMarketplaceListingText(item);
      if (!hasWholePhrase(text, make) || !hasWholePhrase(text, model)) return null;

      const listingYear = inferListingYearFromText(item);
      const listingMiles = toNumberOrNull(item?.driven_miles);
      const price = toNumberOrNull(item?.price_numeric);
      if (!Number.isFinite(price)) return null;

      const yearDelta =
        Number.isInteger(year) && Number.isInteger(listingYear)
          ? Math.abs(listingYear - year)
          : null;
      const mileageDelta =
        odometerMiles != null && listingMiles != null
          ? Math.abs(listingMiles - odometerMiles)
          : null;

      if (yearDelta != null && yearDelta > 3) return null;
      if (mileageDelta != null && mileageDelta > 50000) return null;

      const score =
        (yearDelta == null ? 2 : Math.max(0, 3 - yearDelta)) * 3 +
        (mileageDelta == null ? 1 : Math.max(0, 3 - mileageDelta / 20000));

      return {
        id: item.id,
        title: item.title || null,
        price,
        driven_miles: listingMiles,
        listed_location: item.listed_location || null,
        year: listingYear,
        year_delta: yearDelta,
        mileage_delta: mileageDelta,
        score,
      };
    })
    .filter(Boolean)
  );

  const turoEligibleSubject = isLikelyTuroEligibleVehicle(year, odometerMiles);
  const comparableMileageCap = getComparableMileageCapForSubject(
    year,
    odometerMiles
  );
  const turoMileageFiltered = turoEligibleSubject
    ? matching.filter(
        (item) =>
          item.driven_miles == null ||
          item.driven_miles <= (comparableMileageCap ?? TURO_MAX_ELIGIBLE_MILES)
      )
    : matching;

  const comparablePool =
    turoEligibleSubject && turoMileageFiltered.length >= 2
      ? turoMileageFiltered
      : matching;

  if (!comparablePool.length) {
    return {
      available: false,
      matched_count: 0,
      strategy: "none",
      samples: [],
    };
  }

  const exactYearAndMiles = comparablePool.filter(
    (item) =>
      (item.year_delta == null || item.year_delta <= 1) &&
      (item.mileage_delta == null || item.mileage_delta <= 15000)
  );
  const sameYearTighterMiles = comparablePool.filter(
    (item) =>
      (item.year_delta == null || item.year_delta <= 1) &&
      (item.mileage_delta == null || item.mileage_delta <= 30000)
  );
  const nearYearNearMiles = comparablePool.filter(
    (item) =>
      (item.year_delta == null || item.year_delta <= 2) &&
      (item.mileage_delta == null || item.mileage_delta <= 45000)
  );

  let strategy = "make_model";
  let initialCohort = comparablePool;

  if (exactYearAndMiles.length >= MARKETPLACE_MIN_STRICT_COMPS) {
    strategy = "exact_year_mileage_band";
    initialCohort = exactYearAndMiles;
  } else if (sameYearTighterMiles.length >= MARKETPLACE_MIN_BROAD_COMPS) {
    strategy = "same_year_tighter_miles";
    initialCohort = sameYearTighterMiles;
  } else if (nearYearNearMiles.length >= MARKETPLACE_MIN_BROAD_COMPS) {
    strategy = "near_year_near_miles";
    initialCohort = nearYearNearMiles;
  }

  const { kept: cohort, dropped: droppedOutliers } =
    trimPriceOutliers(initialCohort);

  const sortedByScore = [...cohort].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((a.mileage_delta ?? Number.POSITIVE_INFINITY) !== (b.mileage_delta ?? Number.POSITIVE_INFINITY)) {
      return (a.mileage_delta ?? Number.POSITIVE_INFINITY) - (b.mileage_delta ?? Number.POSITIVE_INFINITY);
    }
    return Math.abs(a.price - (cohort[0]?.price ?? a.price)) - Math.abs(b.price - (cohort[0]?.price ?? b.price));
  });

  const prices = cohort.map((item) => item.price).filter(Number.isFinite);
  const samplePrices = sortedByScore
    .slice(0, MARKETPLACE_MAX_SAMPLE_COMPS)
    .map((item) => ({
      id: item.id,
      title: item.title,
      year: item.year,
      price: item.price,
      driven_miles: item.driven_miles,
      listed_location: item.listed_location,
    }));
  const cohortWeight = getMarketplaceCohortWeight(strategy, cohort.length);

  return {
    available: true,
    strategy,
    matched_count: matching.length,
    comparable_pool_count: comparablePool.length,
    cohort_count: initialCohort.length,
    usable_cohort_count: cohort.length,
    dropped_outlier_count: droppedOutliers.length,
    turo_eligible_subject: turoEligibleSubject,
    comparable_mileage_cap: comparableMileageCap,
    turo_mileage_filtered_count:
      turoEligibleSubject ? turoMileageFiltered.length : comparablePool.length,
    price_low: Math.min(...prices),
    price_median: median(prices),
    price_average: mean(prices),
    price_high: Math.max(...prices),
    weight_recommendation_pct: roundTo(cohortWeight * 100, 0),
    weight_recommendation_ratio: cohortWeight,
    vehicle_year: Number.isInteger(year) ? year : null,
    vehicle_odometer_miles: odometerMiles,
    samples: samplePrices,
  };
}

function buildSnapshotHash(snapshot) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = [];

  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;

    for (const content of item.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

async function ensureVehicleFmvEstimatesTable(client = pool) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.vehicle_fmv_estimates (
      id bigserial PRIMARY KEY,
      vehicle_vin text NOT NULL,
      estimated_at timestamptz NOT NULL DEFAULT now(),
      estimate_source text NOT NULL DEFAULT 'openai',
      estimate_model text NOT NULL,
      market_label text,
      odometer_miles integer,
      snapshot_hash text,
      condition_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      estimate_low numeric(12,2),
      estimate_mid numeric(12,2),
      estimate_high numeric(12,2),
      confidence text,
      rationale text,
      major_risks jsonb NOT NULL DEFAULT '[]'::jsonb,
      raw_response jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_fmv_estimates_vehicle_vin_estimated_at
      ON public.vehicle_fmv_estimates (vehicle_vin, estimated_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vehicle_fmv_estimates_snapshot_hash
      ON public.vehicle_fmv_estimates (snapshot_hash)
  `);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vehicle_fmv_estimates_vehicle_vin_fkey'
      ) THEN
        ALTER TABLE public.vehicle_fmv_estimates
        ADD CONSTRAINT vehicle_fmv_estimates_vehicle_vin_fkey
        FOREIGN KEY (vehicle_vin) REFERENCES public.vehicles(vin) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
}

async function findVehicleCoreBySelector(client, selector) {
  const normalized = normalizeSelector(selector);

  const { rows } = await client.query(
    `
      SELECT
        v.id,
        v.vin,
        v.nickname,
        v.year,
        v.make,
        v.model,
        v.standard_engine,
        v.turo_vehicle_id,
        v.turo_vehicle_name,
        v.current_odometer_miles,
        v.is_active,
        v.in_service
      FROM vehicles v
      WHERE lower(trim(v.vin)) = $1
         OR lower(trim(v.nickname)) = $1
         OR lower(trim(COALESCE(v.license_plate, ''))) = $1
      LIMIT 1
    `,
    [normalized]
  );

  return rows[0] || null;
}

async function listActiveVehicleSelectors(client) {
  const { rows } = await client.query(`
    SELECT vin
    FROM vehicles
    WHERE is_active = true
      AND in_service = true
    ORDER BY nickname NULLS LAST, make NULLS LAST, model NULLS LAST, vin ASC
  `);

  return rows.map((row) => row.vin).filter(Boolean);
}

async function buildConditionSnapshot(client, summary) {
  const overdueRules = [];
  const dueSoonRules = [];
  const failedInspectionRules = [];
  const routineServiceDue = [];
  const defectFlags = [];

  for (const rule of summary.ruleStatuses || []) {
    const title = rule?.title || rule?.ruleCode || "Unknown rule";
    const routine = isRoutineServiceRule(rule);

    if (rule?.status === "overdue") {
      overdueRules.push(title);
      if (routine) routineServiceDue.push(title);
      else defectFlags.push(title);
    }

    if (rule?.status === "due_soon") {
      dueSoonRules.push(title);
      if (routine) routineServiceDue.push(title);
    }

    if (rule?.lastEvent?.result === "fail") {
      failedInspectionRules.push(title);
      defectFlags.push(title);
    }
  }

  const marketplaceCohort = await fetchMarketplaceCohortSnapshot(
    client,
    {
      ...(summary.vehicle || {}),
      current_odometer_miles: summary.currentOdometerMiles ?? null,
      odometerMiles: summary.currentOdometerMiles ?? null,
    }
  );

  return {
    vehicle: {
      vin: summary.vehicle?.vin || null,
      nickname: summary.vehicle?.nickname || null,
      year: summary.vehicle?.year || null,
      make: summary.vehicle?.make || null,
      model: summary.vehicle?.model || null,
      standardEngine: summary.vehicle?.standard_engine || null,
      turoVehicleName: summary.vehicle?.turoVehicleName || null,
    },
    marketLabel: DEFAULT_MARKET_LABEL,
    odometerMiles: summary.currentOdometerMiles ?? null,
    openTaskCounts: summary.openTaskCounts || {
      urgent: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    maintenanceFlags: {
      needsReview: Boolean(summary.needsReview),
      blocksRental: Boolean(summary.blocksRental),
      overdueRules,
      dueSoonRules,
      routineServiceDue: [...new Set(routineServiceDue)],
      defectFlags: [...new Set(defectFlags)],
      failedInspectionRules,
      topOpenTasks: (summary.tasks || [])
        .slice(0, 8)
        .map((task) => ({
          title: task.title || task.task_type || "Open maintenance item",
          priority: task.priority || null,
          status: task.status || null,
        })),
    },
    conditionNotes: (summary.guestVisibleConditionNotes || [])
      .slice(0, 12)
      .filter((note) => {
        const text = String(
          note?.description || note?.title || ""
        ).toLowerCase();
        return !text.includes("lockbox code:");
      })
      .map((note) => ({
        title: note.title,
        area: note.area,
        severity: note.severity,
        description: note.description,
      })),
    marketplaceCohort,
  };
}

async function requestOpenAIFmvEstimate(snapshot, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.statusCode = 500;
    throw err;
  }

  const model = options.model || DEFAULT_OPENAI_MODEL;
  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You estimate a rough private-party fair market value in USD for a used vehicle. " +
              "Use the provided vehicle condition snapshot and marketplace cohort context when available. " +
              "Weight close marketplace comps meaningfully, but adjust for condition, mileage, and missing data. " +
              "If marketplaceCohort.strategy is marketplace_listing_anchor and listing_anchor is present, treat listing_anchor.cohort_baseline_price as the primary market anchor. " +
              "Do not discard a strong listing anchor just because a few cheaper comps exist nearby. " +
              "If marketplaceCohort includes weight_recommendation_pct / weight_recommendation_ratio, follow that guidance. " +
              "A 2-car cohort should be treated as a weak signal and a sanity check, not a primary anchor. " +
              "A large cohort around 40 good comps can anchor the estimate much more strongly. " +
              "If usable_cohort_count is under 3, do not anchor the estimate to the observed median; treat the cohort as a weak floor/sanity check only. " +
              "If the subject vehicle is still Turo-eligible but many comps are not, avoid letting non-eligible high-mileage comps drag the estimate down too aggressively. " +
              "Do not treat routine maintenance due items like air filters, tire pressure checks, oil service, or basic fluid inspections as major FMV defects by themselves. " +
              "Give meaningful negative weight only to actual failed inspections, explicit defect flags, severe condition notes, or evidence of major mechanical/body issues. " +
              "When cohort weight is low, rely more on vehicle condition, broader market intuition, and avoid overreacting to suspiciously cheap comps. " +
              "Be conservative, acknowledge uncertainty, and widen the range when condition data is sparse. " +
              "Output only JSON matching the schema.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(snapshot),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "vehicle_fmv_estimate",
        strict: true,
        schema: {
          type: "object",
          properties: {
            estimate_low: { type: "number" },
            estimate_mid: { type: "number" },
            estimate_high: { type: "number" },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
            rationale: { type: "string" },
            major_risks: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "estimate_low",
            "estimate_mid",
            "estimate_high",
            "confidence",
            "rationale",
            "major_risks",
          ],
          additionalProperties: false,
        },
      },
    },
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    const err = new Error(
      `OpenAI FMV request failed: HTTP ${response.status}`
    );
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  const text = extractResponseText(raw);
  if (!text) {
    const err = new Error("OpenAI FMV request returned no text output");
    err.statusCode = 502;
    err.details = raw;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const parseErr = new Error("OpenAI FMV response was not valid JSON");
    parseErr.statusCode = 502;
    parseErr.details = { text, raw };
    throw parseErr;
  }

  return {
    model,
    parsed,
    raw,
  };
}

async function saveVehicleFmvEstimate(client, vehicleVin, snapshot, estimate) {
  const snapshotHash = buildSnapshotHash(snapshot);
  const estimateLow = toNumberOrNull(estimate?.estimate_low);
  const estimateMid = toNumberOrNull(estimate?.estimate_mid);
  const estimateHigh = toNumberOrNull(estimate?.estimate_high);
  const odometerMiles = toNumberOrNull(snapshot?.odometerMiles);

  const { rows } = await client.query(
    `
      INSERT INTO vehicle_fmv_estimates (
        vehicle_vin,
        estimate_source,
        estimate_model,
        market_label,
        odometer_miles,
        snapshot_hash,
        condition_snapshot,
        estimate_low,
        estimate_mid,
        estimate_high,
        confidence,
        rationale,
        major_risks,
        raw_response
      )
      VALUES (
        $1, 'openai', $2, $3, $4, $5, $6::jsonb,
        $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb
      )
      RETURNING *
    `,
    [
      vehicleVin,
      estimate.model,
      snapshot.marketLabel || DEFAULT_MARKET_LABEL,
      odometerMiles,
      snapshotHash,
      JSON.stringify(snapshot),
      estimateLow,
      estimateMid,
      estimateHigh,
      estimate?.confidence || "low",
      estimate?.rationale || null,
      JSON.stringify(Array.isArray(estimate?.major_risks) ? estimate.major_risks : []),
      JSON.stringify(estimate.raw || {}),
    ]
  );

  return rows[0] || null;
}

function normalizeEstimateRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    vehicle_vin: row.vehicle_vin,
    estimated_at: row.estimated_at,
    estimate_source: row.estimate_source,
    estimate_model: row.estimate_model,
    market_label: row.market_label,
    odometer_miles: row.odometer_miles,
    estimate_low: toNumberOrNull(row.estimate_low),
    estimate_mid: toNumberOrNull(row.estimate_mid),
    estimate_high: toNumberOrNull(row.estimate_high),
    confidence: row.confidence || null,
    rationale: row.rationale || null,
    major_risks: Array.isArray(row.major_risks) ? row.major_risks : [],
    condition_snapshot: row.condition_snapshot || {},
  };
}

async function generateVehicleFmvEstimate(selector, options = {}) {
  const client = await pool.connect();

  try {
    const vehicle = await findVehicleCoreBySelector(client, selector);
    if (!vehicle) {
      const err = new Error(`Vehicle not found for selector ${selector}`);
      err.statusCode = 404;
      throw err;
    }

    const summary = await getVehicleMaintenanceSummary(client, vehicle.vin);
    const snapshot = await buildConditionSnapshot(client, {
      ...summary,
      vehicle: {
        ...summary.vehicle,
        standard_engine: vehicle.standard_engine || null,
        turoVehicleName: vehicle.turo_vehicle_name || null,
      },
    });

    const openaiResult = await requestOpenAIFmvEstimate(snapshot, options);
    const saved = await saveVehicleFmvEstimate(client, vehicle.vin, snapshot, {
      ...openaiResult.parsed,
      model: openaiResult.model,
      raw: openaiResult.raw,
    });

    return normalizeEstimateRow(saved);
  } finally {
    client.release();
  }
}

async function generateFleetFmvEstimates(options = {}) {
  const selectors = await listActiveVehicleSelectors(pool);
  const results = [];

  for (const selector of selectors) {
    try {
      const estimate = await generateVehicleFmvEstimate(selector, options);
      results.push({ ok: true, selector, estimate });
    } catch (error) {
      results.push({
        ok: false,
        selector,
        error: error.message || "Failed to estimate FMV",
      });
    }
  }

  return results;
}

async function getLatestVehicleFmvEstimates(client = pool) {
  const { rows } = await client.query(`
    WITH ranked AS (
      SELECT
        e.*,
        ROW_NUMBER() OVER (
          PARTITION BY e.vehicle_vin
          ORDER BY e.estimated_at DESC, e.id DESC
        ) AS estimate_rank
      FROM vehicle_fmv_estimates e
    )
    SELECT
      cur.*,
      prev.estimate_mid AS previous_estimate_mid,
      prev.estimated_at AS previous_estimated_at,
      v.nickname,
      v.year,
      v.make,
      v.model
    FROM ranked cur
    JOIN vehicles v
      ON v.vin = cur.vehicle_vin
    LEFT JOIN ranked prev
      ON prev.vehicle_vin = cur.vehicle_vin
     AND prev.estimate_rank = 2
    WHERE v.is_active = true
      AND cur.estimate_rank = 1
    ORDER BY cur.vehicle_vin ASC
  `);

  return rows.map((row) => ({
    ...normalizeEstimateRow(row),
    previous_estimate_mid: toNumberOrNull(row.previous_estimate_mid),
    previous_estimated_at: row.previous_estimated_at || null,
    estimate_change:
      toNumberOrNull(row.estimate_mid) != null &&
      toNumberOrNull(row.previous_estimate_mid) != null
        ? toNumberOrNull(row.estimate_mid) - toNumberOrNull(row.previous_estimate_mid)
        : null,
    vehicle: {
      vin: row.vehicle_vin,
      nickname: row.nickname || null,
      year: row.year || null,
      make: row.make || null,
      model: row.model || null,
    },
  }));
}

async function getVehicleFmvEstimateHistory(selector, client = pool) {
  const vehicle = await findVehicleCoreBySelector(client, selector);
  if (!vehicle) {
    const err = new Error(`Vehicle not found for selector ${selector}`);
    err.statusCode = 404;
    throw err;
  }

  const { rows } = await client.query(
    `
      SELECT *
      FROM vehicle_fmv_estimates
      WHERE vehicle_vin = $1
      ORDER BY estimated_at DESC, id DESC
    `,
    [vehicle.vin]
  );

  return {
    vehicle: {
      vin: vehicle.vin,
      nickname: vehicle.nickname || null,
      year: vehicle.year || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
    },
    estimates: rows.map(normalizeEstimateRow),
  };
}

async function getFleetFmvRefreshState(client = pool, maxAgeDays = 7) {
  const { rows } = await client.query(`
    WITH active_vehicles AS (
      SELECT vin
      FROM vehicles
      WHERE is_active = true
        AND in_service = true
    ),
    latest_estimates AS (
      SELECT
        e.vehicle_vin,
        MAX(e.estimated_at) AS latest_estimated_at
      FROM vehicle_fmv_estimates e
      GROUP BY e.vehicle_vin
    )
    SELECT
      COUNT(*)::int AS active_vehicle_count,
      COUNT(le.vehicle_vin)::int AS estimated_vehicle_count,
      MAX(le.latest_estimated_at) AS latest_estimated_at,
      MIN(le.latest_estimated_at) AS oldest_estimated_at
    FROM active_vehicles av
    LEFT JOIN latest_estimates le
      ON le.vehicle_vin = av.vin
  `);

  const activeVehicleCount = Number(rows[0]?.active_vehicle_count ?? 0);
  const estimatedVehicleCount = Number(rows[0]?.estimated_vehicle_count ?? 0);
  const latestEstimatedAt = rows[0]?.latest_estimated_at || null;
  const oldestEstimatedAt = rows[0]?.oldest_estimated_at || null;

  if (!latestEstimatedAt || estimatedVehicleCount <= 0) {
    return {
      has_estimates: false,
      active_vehicle_count: activeVehicleCount,
      estimated_vehicle_count: estimatedVehicleCount,
      latest_estimated_at: null,
      oldest_estimated_at: null,
      age_days: null,
      missing_vehicle_count: Math.max(0, activeVehicleCount - estimatedVehicleCount),
      stale: true,
    };
  }

  const oldestDate = new Date(oldestEstimatedAt || latestEstimatedAt);
  const ageDays = Number.isNaN(oldestDate.getTime())
    ? null
    : (Date.now() - oldestDate.getTime()) / 86400000;
  const missingVehicleCount = Math.max(0, activeVehicleCount - estimatedVehicleCount);

  return {
    has_estimates: true,
    active_vehicle_count: activeVehicleCount,
    estimated_vehicle_count: estimatedVehicleCount,
    latest_estimated_at: latestEstimatedAt,
    oldest_estimated_at: oldestEstimatedAt || latestEstimatedAt,
    age_days: ageDays == null ? null : Number(ageDays.toFixed(2)),
    missing_vehicle_count: missingVehicleCount,
    stale:
      missingVehicleCount > 0 || (ageDays == null ? true : ageDays >= maxAgeDays),
  };
}

async function refreshFleetFmvIfStale(options = {}) {
  const maxAgeDays = Number(options.maxAgeDays || 7);
  const state = await getFleetFmvRefreshState(pool, maxAgeDays);

  if (!state.stale) {
    return {
      ran: false,
      reason: "fresh",
      ...state,
      results: [],
    };
  }

  const results = await generateFleetFmvEstimates(options);
  return {
    ran: true,
    reason: state.has_estimates ? "stale" : "missing",
    ...state,
    results,
  };
}

module.exports = {
  ensureVehicleFmvEstimatesTable,
  generateVehicleFmvEstimate,
  generateFleetFmvEstimates,
  getLatestVehicleFmvEstimates,
  getVehicleFmvEstimateHistory,
  getFleetFmvRefreshState,
  refreshFleetFmvIfStale,
};
