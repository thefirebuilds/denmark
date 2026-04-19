import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimateTexasCityDistanceFromBuda,
  inferTexasCityFromDescription,
  inferVehicleFromDescription,
  MARKETPLACE_INVALID_LISTING_TERMS,
  MARKETPLACE_SCREENING_RULES,
} from "../utils/marketplaceCatalog";

const FILTER_STATUS_OPTIONS = [
  "all",
  "uncontacted",
  "outlier",
  "unviewed",
  "new",
  "watch",
  "contacted",
  "candidate",
];
const DECISION_STATUS_OPTIONS = ["new", "watch", "contacted", "candidate"];
const SORT_TOGGLE_MAP = {
  year: ["yearDesc", "yearAsc"],
  price: ["priceAsc", "priceDesc"],
  make: ["makeAsc", "makeDesc"],
  model: ["modelAsc", "modelDesc"],
  distance: ["distanceAsc", "distanceDesc"],
  state: ["stateDesc", "stateAsc"],
  rating: ["ratingDesc", "ratingAsc"],
  views: ["viewsAsc", "viewsDesc"],
};

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
const DEFAULT_IGNORE_KEYWORDS = "nissan leaf";
const DEFAULT_FILTERS = {
  minPrice: "",
  maxPrice: "",
  minMiles: "",
  maxMiles: "",
};
const MARKETPLACE_FETCH_LIMIT = 1000;
const MARKETPLACE_VISIBLE_LIMIT = 100;
const RATING_TOOLTIP =
  "10-point rating based on peer-relative price, newer year, lower mileage, distance from Buda, and interior signal. Tan/beige/grey interiors get -1, black gets +0.5, leather gets +1. Listings flagged as suspect are heavily penalized.";
const ENRICH_URL_FLAG = "fcg_enrich=1";
const ENRICH_VISIBLE_EVENT = "fcg-marketplace-enrich-visible";
const ENRICH_STATUS_EVENT = "fcg-marketplace-enrich-status";
const ENRICH_READY_EVENT = "fcg-marketplace-extension-ready";
const ENRICH_READY_ATTR = "data-fcg-marketplace-extension-ready";

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseDateValue(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function formatMoney(value, fallback = "—") {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

function formatMiles(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${num.toLocaleString()} mi`;
}

function formatRating(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "â€”";
  return num.toFixed(1);
}

function readJsonOrThrow(res) {
  return res.text().then((text) => {
    const contentType = res.headers.get("content-type") || "";

    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${text.slice(0, 300)}`);
    }

    if (!contentType.includes("application/json")) {
      throw new Error(`Expected JSON but got ${contentType || "unknown"}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse JSON response: ${err.message}`);
    }
  });
}

function marketplaceTextSource(item) {
  return String(item?.title || item?.raw_text_sample || "")
    .replace(/^\s*notifications?\b/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function marketplaceLocationSource(item) {
  return [item?.listed_location, item?.title, item?.raw_text_sample]
    .filter(Boolean)
    .map((value) =>
      String(value)
        .replace(/^\s*notifications?\b/i, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join(" ");
}

function inferYear(item) {
  const match = marketplaceTextSource(item).match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function inferMake(item) {
  const inferred = inferVehicleFromDescription(marketplaceTextSource(item));
  if (inferred.make) return inferred.make;
  const parts = marketplaceTextSource(item).split(/\s+/);
  if (parts.length >= 2 && /^\d{4}$/.test(parts[0])) return parts[1];
  return "";
}

function inferModel(item) {
  const inferred = inferVehicleFromDescription(marketplaceTextSource(item));
  if (inferred.model) return inferred.model;
  const parts = marketplaceTextSource(item).split(/\s+/);
  if (parts.length >= 3 && /^\d{4}$/.test(parts[0])) {
    return parts.slice(2, 4).join(" ");
  }
  return "";
}

function compactDescription(item) {
  const raw = marketplaceTextSource(item);
  if (!raw) return "Untitled listing";
  if (raw.length <= 90) return raw;
  return `${raw.slice(0, 90)}…`;
}

function detailTitle(item) {
  const raw = String(item?.title || "").trim();
  if (!raw) return "Untitled listing";

  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  const candidate = (firstLine || raw)
    .split(/\s+\$\d|\s+Message\b|\s+About this vehicle\b|\s+Driven\b/i)[0]
    .trim();

  return candidate || "Untitled listing";
}

function cleanMarketplaceLocation(value) {
  const raw = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return "";

  const inferredCity = inferTexasCityFromDescription(raw);
  if (inferredCity) return inferredCity;

  const cityState = raw.match(/\b([A-Za-z .'-]+,\s*[A-Z]{2})\b/);
  if (cityState) return cityState[1].replace(/\s+/g, " ").trim();

  const stripped = raw
    .split(
      /\s+(?:Message|About this vehicle|Driven\b|Automatic transmission|Location is approximate|Seller information|Seller details|Send seller a message)\b/i
    )[0]
    .trim();

  return stripped;
}

function inferLocation(item) {
  const cleaned = cleanMarketplaceLocation(item?.listed_location);
  if (cleaned) return cleaned;
  return inferTexasCityFromDescription(marketplaceLocationSource(item));
}

function hasInvalidListingText(item) {
  const text = [item?.title, item?.raw_text_sample, item?.seller_description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return false;

  return MARKETPLACE_INVALID_LISTING_TERMS.some((term) => text.includes(term));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreBand(value, best, worst, maxPoints) {
  if (!Number.isFinite(value)) return 0;
  if (value <= best) return maxPoints;
  if (value >= worst) return 0;
  const ratio = (worst - value) / (worst - best);
  return clamp(ratio * maxPoints, 0, maxPoints);
}

function scoreBandAscending(value, worst, best, maxPoints) {
  if (!Number.isFinite(value)) return 0;
  if (value >= best) return maxPoints;
  if (value <= worst) return 0;
  const ratio = (value - worst) / (best - worst);
  return clamp(ratio * maxPoints, 0, maxPoints);
}

function estimateDistanceFromBuda(location) {
  const cleaned = cleanMarketplaceLocation(location);
  return estimateTexasCityDistanceFromBuda(cleaned);
}

function formatDistanceFromBuda(location) {
  const distance = estimateDistanceFromBuda(location);
  if (!Number.isFinite(distance)) return "—";
  return `${Math.round(distance)} mi`;
}

function stringSortValue(value) {
  return String(value || "").trim().toLowerCase();
}

function inferInteriorMeta(item) {
  const knownInteriorColors = [
    "black",
    "light grey",
    "light gray",
    "dark grey",
    "dark gray",
    "grey",
    "gray",
    "tan",
    "beige",
    "brown",
    "red",
    "blue",
    "white",
    "cream",
    "charcoal",
    "silver",
  ];
  const normalizeInteriorPhrase = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\b(?:interior|color|seats?|seat)\b/g, " ")
      .replace(/[^a-z\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const findKnownInteriorColor = (value) => {
    const normalizedValue = normalizeInteriorPhrase(value);
    return (
      knownInteriorColors
        .sort((a, b) => b.length - a.length)
        .find((color) => {
          const normalizedColor = normalizeInteriorPhrase(color);
          return new RegExp(`\\b${normalizedColor.replace(/\s+/g, "\\s+")}\\b`).test(
            normalizedValue
          );
        }) || ""
    );
  };
  const noteInteriorMatch = String(item?.decision_notes || "").match(
    /\binterior(?:\s+color)?\s*:\s*([^,.;\n\r]+)/i
  );
  const notedInterior = noteInteriorMatch
    ? normalizeInteriorPhrase(noteInteriorMatch[1]).split(/\s+/).slice(0, 3).join(" ")
    : "";
  const explicitInteriorRaw = String(item?.interior_color || "").trim();
  const explicitInterior = findKnownInteriorColor(explicitInteriorRaw);
  const text = [
    item?.interior_color,
    item?.decision_notes,
    item?.title,
    item?.raw_text_sample,
    item?.seller_description,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = text.toLowerCase();

  const interiorMatch = normalized.match(
    /\binterior(?:\s+color)?\s*:\s*(black|grey|gray|tan|beige|brown|red|blue|white|cream|charcoal|silver)\b/i
  );
  const inferredInterior = interiorMatch ? interiorMatch[1].trim() : "";
  const color = notedInterior || explicitInterior || inferredInterior;
  const hasLeather = /\bleather\b/.test(normalized);
  const colorLower = color.toLowerCase();

  let ratingAdjustment = 0;
  if (/\b(?:tan|beige|grey|gray)\b/.test(colorLower)) ratingAdjustment -= 1;
  if (colorLower === "black") ratingAdjustment += 0.5;
  if (hasLeather) ratingAdjustment += 1;

  const labelParts = [];
  if (color) labelParts.push(color.replace(/\b\w/g, (char) => char.toUpperCase()));
  if (hasLeather) labelParts.push("Leather");

  return {
    color,
    hasLeather,
    ratingAdjustment,
    label: labelParts.length ? labelParts.join(" / ") : "",
  };
}

function computeMarketplaceRating(item) {
  const year = toNumberOrNull(inferYear(item));
  const miles = toNumberOrNull(item?.driven_miles);
  const distance = estimateDistanceFromBuda(inferLocation(item) || item?.listed_location);
  const cohortMeta = item?.cohort_meta || null;
  const cohortRatio = toNumberOrNull(cohortMeta?.priceRatio);
  const cohortLabel = cohortMeta?.outlierLabel || null;
  const interiorMeta = inferInteriorMeta(item);

  let priceScore = 1.5;
  if (Number.isFinite(cohortRatio)) {
    priceScore = scoreBand(cohortRatio, 0.72, 1.18, 3.5);
  }

  const currentYear = new Date().getFullYear();
  const yearScore = scoreBandAscending(
    year,
    MARKETPLACE_SCREENING_RULES.minUsefulYear,
    currentYear,
    2
  );
  const milesScore = scoreBand(miles, 50000, 130000, 2.5);
  const distanceScore = scoreBand(distance, 10, 75, 2);

  let total = priceScore + yearScore + milesScore + distanceScore + interiorMeta.ratingAdjustment;
  if (cohortLabel === "suspect") {
    total = Math.min(total, 1.2);
  }

  return Math.round(clamp(total, 0, 10) * 10) / 10;
}

function marketplaceRatingValue(item) {
  const rating = computeMarketplaceRating(item);
  return Number.isFinite(rating) ? rating : -1;
}

function effectiveMarketplaceScore(item, draft = null) {
  const draftScore = toNumberOrNull(draft?.decision_score);
  if (draftScore !== null) return draftScore;

  const savedScore = toNumberOrNull(item?.decision_score);
  if (savedScore !== null) return savedScore;

  return computeMarketplaceRating(item);
}

function formatMarketplaceScore(value, fallback = "—") {
  const score = toNumberOrNull(value);
  if (score === null) return fallback;
  return score.toFixed(1);
}

function cohortPriceTooltip(item) {
  const meta = item?.cohort_meta || null;
  const baseline = toNumberOrNull(meta?.baselinePrice ?? meta?.averagePrice);
  if (baseline === null) return item?.price_text || "";

  const ratio = toNumberOrNull(meta?.priceRatio);
  const percentDelta = Number.isFinite(ratio)
    ? `${ratio >= 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%`
    : null;

  return [percentDelta ? `(${percentDelta})` : null, formatMoney(baseline)]
    .filter(Boolean)
    .join(" ");
}

function cohortPriceTone(item) {
  const ratio = toNumberOrNull(item?.cohort_meta?.priceRatio);
  if (ratio === null) return "";
  if (ratio <= 0.9) return "cohort-below-strong";
  if (ratio <= 0.95) return "cohort-below";
  if (ratio > 1.05) return "cohort-high";
  return "";
}

function formatCohortDetail(item) {
  const meta = item?.cohort_meta || null;
  const baseline = toNumberOrNull(meta?.baselinePrice ?? meta?.averagePrice);
  if (baseline === null) return "—";

  const ratio = toNumberOrNull(meta?.priceRatio);
  const percentDelta = Number.isFinite(ratio)
    ? `${ratio >= 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%`
    : null;
  const comps = Number.isFinite(Number(meta?.cohortSize))
    ? `${Number(meta.cohortSize).toLocaleString()} comps`
    : null;
  const suffix = [percentDelta, comps].filter(Boolean).join(", ");

  return `${formatMoney(baseline)}${suffix ? ` (${suffix})` : ""}`;
}

function stateSortValue(item) {
  const created = parseDateValue(item.first_seen_at || item.created_at);
  const ageMs = created ? Date.now() - created : Number.POSITIVE_INFINITY;
  return isFresh(item) ? -1 : ageMs;
}

function viewCountValue(item) {
  return toNumberOrNull(item?.open_count) ?? 0;
}

function shouldHideForMileage(item) {
  const miles = toNumberOrNull(item?.driven_miles);
  return Number.isFinite(miles) && miles >= MARKETPLACE_SCREENING_RULES.maxUsefulMiles;
}

function shouldHideForYear(item) {
  const year = toNumberOrNull(inferYear(item));
  return Number.isFinite(year) && year < MARKETPLACE_SCREENING_RULES.minUsefulYear;
}

function shouldHideForFuelType(item) {
  const fuelType = String(item?.fuel_type || "")
    .trim()
    .toLowerCase();

  if (!fuelType) return false;

  return MARKETPLACE_SCREENING_RULES.excludedFuelTypes.some(
    (blockedFuelType) => fuelType === String(blockedFuelType || "").trim().toLowerCase()
  );
}

function isFresh(item) {
  const status = String(item?.decision_status || "new").toLowerCase();
  if (status === "candidate" || status === "contacted") return false;
  if (viewCountValue(item) > 0) return false;

  const reviewed = parseDateValue(item.reviewed_at);
  const lastSeen = parseDateValue(item.last_seen_at || item.created_at);
  if (!lastSeen) return false;
  if (!reviewed) return true;
  return lastSeen > reviewed;
}

function formatListingAge(item) {
  const created = parseDateValue(item.first_seen_at || item.created_at);
  if (!created) return null;
  const ageMs = Date.now() - created;
  const ageDays = Math.max(1, Math.floor(ageMs / 86400000) + 1);
  if (ageDays <= 1) return null;
  if (ageDays >= 7) return `${Math.floor(ageDays / 7)}w`;
  return `${ageDays}d`;
}

function hasMarketplaceEnrichment(item) {
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

function buildEnrichUrl(url) {
  if (!url) return "#";
  const normalized = String(url);
  return normalized.includes("#")
    ? `${normalized}&${ENRICH_URL_FLAG}`
    : `${normalized}#${ENRICH_URL_FLAG}`;
}

function statusTone(status) {
  switch (status) {
    case "candidate":
    case "bought":
      return "good";
    case "watch":
    case "contacted":
      return "warn";
    case "passed":
      return "bad";
    default:
      return "neutral";
  }
}

function normalizeIgnoreKeywords(value) {
  return String(value || "")
    .split("\n")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePriceFilterInput(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function buildIgnoreHaystack(item) {
  return compactDescription(item).replace(/â€¦$/, "").toLowerCase();
}

function buildSearchHaystack(item) {
  return [
    item.title,
    item.listed_location,
    item.vin,
    item.seller_name,
    item.seller_description,
    item.decision_notes,
    inferMake(item),
    inferModel(item),
    inferYear(item),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function clearDuplicateReferences(listings, ignoredId) {
  const ignoredKey = String(ignoredId);
  return listings.map((listing) =>
    String(listing?.id || "") === ignoredKey ||
    String(listing?.duplicate_meta?.matchedId || "") === ignoredKey
      ? { ...listing, duplicate_meta: null }
      : listing
  );
}

function marketplaceGroupLabel(item) {
  const make = inferMake(item);
  const model = inferModel(item);
  if (make && model) return `${make} ${model}`;
  if (make) return make;
  return "Unknown";
}

function marketplaceMarqueLabel(item) {
  return inferMake(item) || "Unknown";
}

function marketplaceModelLabel(item) {
  return inferModel(item) || "Unknown model";
}

export default function MarketplacePanel() {
  const [listings, setListings] = useState([]);
  const [totalListingsCount, setTotalListingsCount] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [search, setSearch] = useState("");
  const [priceMin, setPriceMin] = useState(DEFAULT_FILTERS.minPrice);
  const [priceMax, setPriceMax] = useState(DEFAULT_FILTERS.maxPrice);
  const [milesMin, setMilesMin] = useState(DEFAULT_FILTERS.minMiles);
  const [milesMax, setMilesMax] = useState(DEFAULT_FILTERS.maxMiles);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [freshOnly, setFreshOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [ignoringVisible, setIgnoringVisible] = useState(false);
  const [error, setError] = useState("");
  const [streamState, setStreamState] = useState("connecting");
  const [draftsById, setDraftsById] = useState({});
  const [showIgnoreKeywordEditor, setShowIgnoreKeywordEditor] = useState(false);
  const [ignoreKeywordsText, setIgnoreKeywordsText] = useState(DEFAULT_IGNORE_KEYWORDS);
  const [ignoreKeywordsReady, setIgnoreKeywordsReady] = useState(false);
  const [extensionReady, setExtensionReady] = useState(false);
  const [enrichVisibleStatus, setEnrichVisibleStatus] = useState(null);
  const [viewMode, setViewMode] = useState("flat");
  const [groupedSortBy, setGroupedSortBy] = useState({});
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const eventSourceRef = useRef(null);
  const ignoreKeywordsHydratedRef = useRef(false);
  const ignoreKeywordsTextRef = useRef(DEFAULT_IGNORE_KEYWORDS);
  const ignoreKeywordsSaveSeqRef = useRef(0);
  const filtersReadyRef = useRef(false);
  const filtersHydratedRef = useRef(false);
  const filtersRef = useRef(DEFAULT_FILTERS);
  const filtersSaveSeqRef = useRef(0);
  const includeHiddenRef = useRef(includeHidden);

  async function persistIgnoreKeywords(text) {
    const requestSeq = ++ignoreKeywordsSaveSeqRef.current;

    try {
      const res = await fetch(`${API_BASE}/api/marketplace/preferences/ignore-keywords`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ text }),
      });

      const data = await readJsonOrThrow(res);
      const nextText = data?.text || DEFAULT_IGNORE_KEYWORDS;
      if (ignoreKeywordsSaveSeqRef.current === requestSeq) {
        ignoreKeywordsTextRef.current = nextText;
      }
    } catch (err) {
      console.error("Marketplace ignore keyword save failed:", err);
      setError((prev) => prev || err.message || "Failed to save ignore keywords");
    }
  }

  async function persistFilters(nextFilters) {
    const requestSeq = ++filtersSaveSeqRef.current;

    try {
      const res = await fetch(`${API_BASE}/api/marketplace/preferences/filters`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(nextFilters),
      });

      const data = await readJsonOrThrow(res);
      if (filtersSaveSeqRef.current === requestSeq) {
        filtersRef.current = {
          minPrice: data?.minPrice ?? "",
          maxPrice: data?.maxPrice ?? "",
          minMiles: data?.minMiles ?? "",
          maxMiles: data?.maxMiles ?? "",
        };
      }
    } catch (err) {
      console.error("Marketplace filter save failed:", err);
      setError((prev) => prev || err.message || "Failed to save marketplace filters");
    }
  }

  useEffect(() => {
    ignoreKeywordsTextRef.current = ignoreKeywordsText;
  }, [ignoreKeywordsText]);

  useEffect(() => {
    filtersRef.current = {
      minPrice: priceMin,
      maxPrice: priceMax,
      minMiles: milesMin,
      maxMiles: milesMax,
    };
  }, [priceMin, priceMax, milesMin, milesMax]);

  useEffect(() => {
    let cancelled = false;

    async function loadPreferences() {
      try {
        const [ignoreRes, filtersRes] = await Promise.all([
          fetch(`${API_BASE}/api/marketplace/preferences/ignore-keywords`, {
            headers: { Accept: "application/json" },
          }),
          fetch(`${API_BASE}/api/marketplace/preferences/filters`, {
            headers: { Accept: "application/json" },
          }),
        ]);
        const [ignoreData, filtersData] = await Promise.all([
          readJsonOrThrow(ignoreRes),
          readJsonOrThrow(filtersRes),
        ]);
        if (!cancelled) {
          setIgnoreKeywordsText(ignoreData?.text || DEFAULT_IGNORE_KEYWORDS);
          setPriceMin(filtersData?.minPrice ?? DEFAULT_FILTERS.minPrice);
          setPriceMax(filtersData?.maxPrice ?? DEFAULT_FILTERS.maxPrice);
          setMilesMin(filtersData?.minMiles ?? DEFAULT_FILTERS.minMiles);
          setMilesMax(filtersData?.maxMiles ?? DEFAULT_FILTERS.maxMiles);
        }
      } catch (err) {
        console.error("Marketplace preferences load failed:", err);
        if (!cancelled) {
          setError((prev) => prev || err.message || "Failed to load marketplace preferences");
        }
      } finally {
        if (!cancelled) {
          setIgnoreKeywordsReady(true);
          filtersReadyRef.current = true;
        }
      }
    }

    loadPreferences();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ignoreKeywordsReady) return undefined;
    if (!ignoreKeywordsHydratedRef.current) {
      ignoreKeywordsHydratedRef.current = true;
      return undefined;
    }

    const timeoutId = window.setTimeout(async () => {
      await persistIgnoreKeywords(ignoreKeywordsTextRef.current);
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [ignoreKeywordsReady, ignoreKeywordsText]);

  useEffect(() => {
    if (!filtersReadyRef.current) return undefined;
    if (!filtersHydratedRef.current) {
      filtersHydratedRef.current = true;
      return undefined;
    }

    const timeoutId = window.setTimeout(async () => {
      await persistFilters(filtersRef.current);
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [priceMin, priceMax, milesMin, milesMax]);

  useEffect(() => {
    return () => {
      if (ignoreKeywordsHydratedRef.current) {
        void persistIgnoreKeywords(ignoreKeywordsTextRef.current);
      }
      if (filtersHydratedRef.current) {
        void persistFilters(filtersRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      typeof document !== "undefined" &&
      document.documentElement.getAttribute(ENRICH_READY_ATTR) === "1"
    ) {
      setExtensionReady(true);
    }

    function handleReady() {
      setExtensionReady(true);
    }

    function handleStatus(event) {
      setEnrichVisibleStatus(event.detail || null);
    }

    window.addEventListener(ENRICH_READY_EVENT, handleReady);
    window.addEventListener(ENRICH_STATUS_EVENT, handleStatus);

    return () => {
      window.removeEventListener(ENRICH_READY_EVENT, handleReady);
      window.removeEventListener(ENRICH_STATUS_EVENT, handleStatus);
    };
  }, []);

  const ignoreKeywords = useMemo(
    () => normalizeIgnoreKeywords(ignoreKeywordsText),
    [ignoreKeywordsText]
  );

  const minPriceFilter = useMemo(() => toNumberOrNull(priceMin), [priceMin]);
  const maxPriceFilter = useMemo(() => toNumberOrNull(priceMax), [priceMax]);
  const minMilesFilter = useMemo(() => toNumberOrNull(milesMin), [milesMin]);
  const maxMilesFilter = useMemo(() => toNumberOrNull(milesMax), [milesMax]);

async function loadListings({ preserveSelection = true } = {}) {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        status: statusFilter === "outlier" || statusFilter === "unviewed" ? "all" : statusFilter,
        includeHidden: includeHidden ? "true" : "false",
        freshOnly: freshOnly ? "true" : "false",
        limit: String(MARKETPLACE_FETCH_LIMIT),
        maxMiles: String(MARKETPLACE_SCREENING_RULES.maxUsefulMiles),
        minYear: String(MARKETPLACE_SCREENING_RULES.minUsefulYear),
      });

      if (statusFilter === "unviewed") params.set("unviewed", "true");

      if (search.trim()) params.set("search", search.trim());
      if (minPriceFilter !== null) params.set("minPrice", String(minPriceFilter));
      if (maxPriceFilter !== null) params.set("maxPrice", String(maxPriceFilter));
      if (minMilesFilter !== null) params.set("minMiles", String(minMilesFilter));
      if (maxMilesFilter !== null) params.set("maxMiles", String(maxMilesFilter));
      if (!includeHidden && ignoreKeywords.length > 0) {
        ignoreKeywords.forEach((keyword) => params.append("ignore", keyword));
      }

      const res = await fetch(`${API_BASE}/api/marketplace/listings?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });

      const data = await readJsonOrThrow(res);
      const nextListings = data?.listings || [];

      setListings(nextListings);
      setTotalListingsCount(
        Number.isFinite(Number(data?.totalCount)) ? Number(data.totalCount) : nextListings.length
      );

      setSelectedId((prev) => {
        if (preserveSelection && prev && nextListings.some((item) => item.id === prev)) {
          return prev;
        }
        return nextListings[0]?.id || null;
      });
    } catch (err) {
      console.error("Marketplace load failed:", err);
      setError(err.message || "Failed to load marketplace listings");
      setListings([]);
      setTotalListingsCount(0);
      setSelectedId(null);
    } finally {
      setLoading(false);
    }
  }

  const loadListingsRef = useRef(loadListings);

  useEffect(() => {
    loadListingsRef.current = loadListings;
  });

  useEffect(() => {
    includeHiddenRef.current = includeHidden;
  }, [includeHidden]);

  useEffect(() => {
    loadListings();

    return undefined;
  }, [
    statusFilter,
    includeHidden,
    freshOnly,
    search,
    minPriceFilter,
    maxPriceFilter,
    minMilesFilter,
    maxMilesFilter,
    ignoreKeywords,
  ]);

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/marketplace/stream`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setStreamState("live");
    };

    es.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data || "{}");
        if (payload?.bootstrap) return;
        if (payload?.type === "marketplace_update") {
          if (payload.source === "ignore" && payload.id) {
            setListings((prev) =>
              includeHiddenRef.current
                ? clearDuplicateReferences(
                    prev.map((item) =>
                      String(item.id) === String(payload.id)
                      ? {
                          ...item,
                          hidden: true,
                          ignored_at: payload.ignored_at || item.ignored_at || new Date().toISOString(),
                        }
                      : item
                    ),
                    payload.id
                  )
                : clearDuplicateReferences(
                    prev.filter((item) => String(item.id) !== String(payload.id)),
                    payload.id
                  )
            );
            return;
          }

          if (payload.source === "ignoreByUrl" && payload.url) {
            setListings((prev) =>
              includeHiddenRef.current
                ? prev.map((item) =>
                    item.url === payload.url
                      ? {
                          ...item,
                          hidden: true,
                          ignored_at: payload.ignored_at || item.ignored_at || new Date().toISOString(),
                        }
                      : item
                  )
                : prev.filter((item) => item.url !== payload.url)
            );
            return;
          }

          if (payload.source === "opened") return;
          if (payload.source === "patch") return;

          await loadListingsRef.current?.({ preserveSelection: true });
        }
      } catch (err) {
        console.error("Marketplace stream parse failed:", err);
      }
    };

    es.onerror = () => {
      setStreamState("disconnected");
    };

    return () => {
      es.close();
    };
  }, []);

  const filteredListings = useMemo(() => {
    const needle = search.trim().toLowerCase();

    const next = listings.filter((item) => {
      if (!includeHidden && item.hidden) return false;
      if (shouldHideForMileage(item)) return false;
      if (shouldHideForYear(item)) return false;
      if (shouldHideForFuelType(item)) return false;
      if (hasInvalidListingText(item)) return false;

      const status = item.decision_status || "new";
      const fresh = isFresh(item);
      const ignoreHaystack = buildIgnoreHaystack(item);
      const haystack = buildSearchHaystack(item);
      const outlierLabel = item?.cohort_meta?.outlierLabel || null;

      if (statusFilter === "outlier") {
        if (!outlierLabel) return false;
      } else if (statusFilter === "unviewed") {
        if (viewCountValue(item) > 0) return false;
      } else if (statusFilter === "uncontacted") {
        if (status === "contacted" || status === "candidate") return false;
      } else if (statusFilter !== "all" && status !== statusFilter) {
        return false;
      }
      if (freshOnly && !fresh && item.id !== selectedId) return false;

      const numericPrice = toNumberOrNull(item.price_numeric);
      if (minPriceFilter !== null && (numericPrice === null || numericPrice < minPriceFilter)) {
        return false;
      }
      if (maxPriceFilter !== null && (numericPrice === null || numericPrice > maxPriceFilter)) {
        return false;
      }

      const numericMiles = toNumberOrNull(item.driven_miles);
      if (minMilesFilter !== null && (numericMiles === null || numericMiles < minMilesFilter)) {
        return false;
      }
      if (maxMilesFilter !== null && (numericMiles === null || numericMiles > maxMilesFilter)) {
        return false;
      }

      if (!includeHidden && ignoreKeywords.length > 0) {
        const hit = ignoreKeywords.some((keyword) => ignoreHaystack.includes(keyword));
        if (hit) return false;
      }

      if (needle && !haystack.includes(needle)) return false;

      return true;
    });

    next.sort((a, b) => {
      if (sortBy === "priceAsc") {
        return (toNumberOrNull(a.price_numeric) ?? 999999999) - (toNumberOrNull(b.price_numeric) ?? 999999999);
      }

      if (sortBy === "priceDesc") {
        return (toNumberOrNull(b.price_numeric) ?? -1) - (toNumberOrNull(a.price_numeric) ?? -1);
      }

      if (sortBy === "ratingDesc") {
        return marketplaceRatingValue(b) - marketplaceRatingValue(a);
      }

      if (sortBy === "ratingAsc") {
        return marketplaceRatingValue(a) - marketplaceRatingValue(b);
      }

      if (sortBy === "viewsAsc") {
        return viewCountValue(a) - viewCountValue(b);
      }

      if (sortBy === "viewsDesc") {
        return viewCountValue(b) - viewCountValue(a);
      }

      if (sortBy === "yearAsc") {
        return (toNumberOrNull(inferYear(a)) ?? 0) - (toNumberOrNull(inferYear(b)) ?? 0);
      }

      if (sortBy === "yearDesc") {
        return (toNumberOrNull(inferYear(b)) ?? 0) - (toNumberOrNull(inferYear(a)) ?? 0);
      }

      if (sortBy === "makeAsc") {
        return stringSortValue(inferMake(a)).localeCompare(stringSortValue(inferMake(b)));
      }

      if (sortBy === "makeDesc") {
        return stringSortValue(inferMake(b)).localeCompare(stringSortValue(inferMake(a)));
      }

      if (sortBy === "modelAsc") {
        return stringSortValue(inferModel(a)).localeCompare(stringSortValue(inferModel(b)));
      }

      if (sortBy === "modelDesc") {
        return stringSortValue(inferModel(b)).localeCompare(stringSortValue(inferModel(a)));
      }

      if (sortBy === "distanceAsc") {
        return (estimateDistanceFromBuda(inferLocation(a) || a.listed_location) ?? 999999999)
          - (estimateDistanceFromBuda(inferLocation(b) || b.listed_location) ?? 999999999);
      }

      if (sortBy === "distanceDesc") {
        return (estimateDistanceFromBuda(inferLocation(b) || b.listed_location) ?? -1)
          - (estimateDistanceFromBuda(inferLocation(a) || a.listed_location) ?? -1);
      }

      if (sortBy === "stateDesc") {
        return stateSortValue(a) - stateSortValue(b);
      }

      if (sortBy === "stateAsc") {
        return stateSortValue(b) - stateSortValue(a);
      }

      if (sortBy === "oldest") {
        return parseDateValue(a.first_seen_at || a.created_at) - parseDateValue(b.first_seen_at || b.created_at);
      }

      return parseDateValue(b.last_seen_at || b.created_at) - parseDateValue(a.last_seen_at || a.created_at);
    });

    return next;
  }, [
    listings,
    includeHidden,
    statusFilter,
    sortBy,
    search,
    freshOnly,
    ignoreKeywords,
    minPriceFilter,
    maxPriceFilter,
    minMilesFilter,
    maxMilesFilter,
    selectedId,
  ]);

  const visibleListings = useMemo(
    () => filteredListings.slice(0, MARKETPLACE_VISIBLE_LIMIT),
    [filteredListings]
  );
  const displayListings = viewMode === "grouped" ? filteredListings : visibleListings;
  const groupedVisibleListings = useMemo(() => {
    const marques = [];
    const byMarque = new Map();

    displayListings.forEach((item) => {
      const marqueLabel = marketplaceMarqueLabel(item);
      const modelLabel = marketplaceModelLabel(item);
      const modelKey = `${marqueLabel}::${modelLabel}`;

      if (!byMarque.has(marqueLabel)) {
        const marque = {
          label: marqueLabel,
          key: `make::${marqueLabel}`,
          items: [],
          modelGroups: [],
          byModel: new Map(),
        };
        byMarque.set(marqueLabel, marque);
        marques.push(marque);
      }

      const marque = byMarque.get(marqueLabel);
      marque.items.push(item);

      if (!marque.byModel.has(modelKey)) {
        const group = {
          label: modelLabel,
          key: modelKey,
          items: [],
        };
        marque.byModel.set(modelKey, group);
        marque.modelGroups.push(group);
      }

      marque.byModel.get(modelKey).items.push(item);
    });

    return marques.map((marque) => {
      const { byModel, ...rest } = marque;
      return rest;
    });
  }, [displayListings]);
  const visibleUnenrichedCount = useMemo(
    () => displayListings.filter((item) => item?.url && !hasMarketplaceEnrichment(item)).length,
    [displayListings]
  );

  useEffect(() => {
    if (!displayListings.length) {
      setSelectedId(null);
      return;
    }

    if (!selectedId || !displayListings.some((item) => item.id === selectedId)) {
      setSelectedId(displayListings[0].id);
    }
  }, [displayListings, selectedId]);

  const selected = useMemo(
    () => displayListings.find((item) => item.id === selectedId) || null,
    [displayListings, selectedId]
  );

  function toggleSort(column) {
    const pair = SORT_TOGGLE_MAP[column];
    if (!pair) return;
    setSortBy((prev) => (prev === pair[0] ? pair[1] : pair[0]));
  }

  function sortIndicator(column) {
    const pair = SORT_TOGGLE_MAP[column];
    if (!pair) return "";
    if (sortBy === pair[0]) return " ▲";
    if (sortBy === pair[1]) return " ▼";
    return "";
  }

  function getDraft(item) {
    if (!item) return null;

    const baseDraft = {
      decision_status: item.decision_status || "new",
      decision_score: item.decision_score ?? "",
      decision_notes: item.decision_notes || "",
      vin: item.vin || "",
      driven_miles: item.driven_miles ?? "",
      decision_tags: Array.isArray(item.decision_tags) ? item.decision_tags.join(", ") : "",
    };

    return {
      ...baseDraft,
      ...(draftsById[item.id] || {}),
    };
  }

  function updateDraft(itemId, patch) {
    setDraftsById((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        ...patch,
      },
    }));
  }

  async function saveListing(item) {
    if (!item) return;
    const draft = getDraft(item);
    if (!draft) return;
    const touchedDraft = draftsById[item.id] || {};
    const hasTouchedField = (field) =>
      Object.prototype.hasOwnProperty.call(touchedDraft, field);

    setSavingId(item.id);
    setError("");

    try {
      const payload = {};

      if (hasTouchedField("decision_status")) {
        payload.decision_status = draft.decision_status;
      }

      if (hasTouchedField("decision_score")) {
        payload.decision_score =
          draft.decision_score === "" ? null : Number(draft.decision_score);
      }

      if (hasTouchedField("decision_notes")) {
        payload.decision_notes = draft.decision_notes || null;
      }

      if (hasTouchedField("vin")) {
        payload.vin = draft.vin || null;
      }

      if (hasTouchedField("driven_miles")) {
        payload.driven_miles =
          draft.driven_miles === "" ? null : Number(draft.driven_miles);
      }

      if (hasTouchedField("decision_tags")) {
        payload.decision_tags = String(draft.decision_tags || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
      }

      if (!Object.keys(payload).length) {
        return;
      }

      const res = await fetch(`${API_BASE}/api/marketplace/listings/${item.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await readJsonOrThrow(res);
      if (data?.ok) {
        setDraftsById((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        if (data.listing) {
          setListings((prev) =>
            prev.map((listing) =>
              listing.id === item.id
                ? {
                    ...listing,
                    ...data.listing,
                  }
                : listing
            )
          );
        }
      }
    } catch (err) {
      console.error("Marketplace save failed:", err);
      setError(err.message || "Failed to save listing");
    } finally {
      setSavingId(null);
    }
  }

  async function ignoreListing(item) {
    if (!item) return;

    setSavingId(item.id);
    setError("");

    try {
      const res = await fetch(`${API_BASE}/api/marketplace/listings/${item.id}/ignore`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });

      const data = await readJsonOrThrow(res);
      if (data?.ok) {
        setDraftsById((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
        const ignoredAt = data?.ignored_at || new Date().toISOString();
        setListings((prev) =>
          includeHidden
            ? clearDuplicateReferences(
                prev.map((listing) =>
                  String(listing.id) === String(item.id)
                    ? {
                        ...listing,
                        hidden: true,
                        ignored_at: ignoredAt,
                      }
                    : listing
                ),
                item.id
              )
            : clearDuplicateReferences(
                prev.filter((listing) => String(listing.id) !== String(item.id)),
                item.id
              )
        );
      }
    } catch (err) {
      console.error("Marketplace ignore failed:", err);
      setError(err.message || "Failed to ignore listing");
    } finally {
      setSavingId(null);
    }
  }

  async function ignoreAllVisibleListings() {
    const ids = displayListings
      .map((item) => item?.id)
      .filter((id) => Number.isFinite(Number(id)));

    if (!ids.length) return;

    setIgnoringVisible(true);
    setError("");

    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await fetch(`${API_BASE}/api/marketplace/listings/${id}/ignore`, {
            method: "POST",
            headers: { Accept: "application/json" },
          });
          return readJsonOrThrow(res);
        })
      );

      if (results.some((result) => !result?.ok)) {
        throw new Error("One or more visible listings could not be ignored");
      }

      setDraftsById((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          delete next[id];
        });
        return next;
      });

      await loadListings({ preserveSelection: false });
    } catch (err) {
      console.error("Marketplace ignore visible failed:", err);
      setError(err.message || "Failed to ignore visible listings");
    } finally {
      setIgnoringVisible(false);
    }
  }

  function enrichVisibleListings() {
    const urls = displayListings
      .filter((item) => item?.url && !hasMarketplaceEnrichment(item))
      .map((item) => item.url);

    if (!extensionReady) {
      setEnrichVisibleStatus({
        running: false,
        total: 0,
        completed: 0,
        failed: 0,
        error: "Reload the Chrome extension and refresh this page to enable batch enrich.",
      });
      return;
    }

    window.dispatchEvent(
      new CustomEvent(ENRICH_VISIBLE_EVENT, {
        detail: { urls },
      })
    );
  }

  function enrichGroupListings(items) {
    const urls = items
      .filter((item) => item?.url && !hasMarketplaceEnrichment(item))
      .map((item) => item.url);

    if (!extensionReady) {
      setEnrichVisibleStatus({
        running: false,
        total: 0,
        completed: 0,
        failed: 0,
        error: "Reload the Chrome extension and refresh this page to enable batch enrich.",
      });
      return;
    }

    window.dispatchEvent(
      new CustomEvent(ENRICH_VISIBLE_EVENT, {
        detail: { urls },
      })
    );
  }

  async function recordListingOpen(id) {
    if (!id) return;

    setListings((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              open_count: viewCountValue(item) + 1,
              last_opened_at: new Date().toISOString(),
            }
          : item
      )
    );

    try {
      const res = await fetch(`${API_BASE}/api/marketplace/listings/${id}/opened`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });

      const data = await readJsonOrThrow(res);
      const nextOpenCount = toNumberOrNull(data?.open_count);
      const nextLastOpenedAt = data?.last_opened_at || null;

      setListings((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                open_count: nextOpenCount ?? item.open_count,
                last_opened_at: nextLastOpenedAt ?? item.last_opened_at,
              }
            : item
        )
      );
    } catch (err) {
      console.error("Marketplace open count record failed:", err);
    }
  }

  function openListing(item) {
    if (!item?.url) return;

    window.open(item.url, "_blank", "noopener,noreferrer");
    void recordListingOpen(item.id);
  }

  function sortGroupedItems(items, sortKey = "ratingDesc") {
    const next = [...items];

    next.sort((a, b) => {
      if (sortKey === "distanceAsc") {
        return (estimateDistanceFromBuda(inferLocation(a) || a.listed_location) ?? 999999999)
          - (estimateDistanceFromBuda(inferLocation(b) || b.listed_location) ?? 999999999);
      }

      if (sortKey === "priceAsc") {
        return (toNumberOrNull(a.price_numeric) ?? 999999999) - (toNumberOrNull(b.price_numeric) ?? 999999999);
      }

      if (sortKey === "mileageAsc") {
        return (toNumberOrNull(a.driven_miles) ?? 999999999) - (toNumberOrNull(b.driven_miles) ?? 999999999);
      }

      return marketplaceRatingValue(b) - marketplaceRatingValue(a);
    });

    return next;
  }

  function modelGroupBestValue(modelGroup, sortKey) {
    const values = modelGroup.items.map((item) => {
      if (sortKey === "distanceAsc") {
        return estimateDistanceFromBuda(inferLocation(item) || item.listed_location);
      }

      if (sortKey === "priceAsc") {
        return toNumberOrNull(item.price_numeric);
      }

      if (sortKey === "mileageAsc") {
        return toNumberOrNull(item.driven_miles);
      }

      if (sortKey === "ratingDesc") {
        return marketplaceRatingValue(item);
      }

      return null;
    }).filter(Number.isFinite);

    if (!values.length) return null;
    return sortKey === "ratingDesc"
      ? Math.max(...values)
      : Math.min(...values);
  }

  function sortModelGroups(modelGroups, sortKey = "modelAsc") {
    const next = [...modelGroups];

    next.sort((a, b) => {
      if (sortKey === "modelAsc") {
        return stringSortValue(a.label).localeCompare(stringSortValue(b.label));
      }

      const aValue = modelGroupBestValue(a, sortKey);
      const bValue = modelGroupBestValue(b, sortKey);

      if (sortKey === "ratingDesc") {
        return (bValue ?? -1) - (aValue ?? -1)
          || stringSortValue(a.label).localeCompare(stringSortValue(b.label));
      }

      return (aValue ?? 999999999) - (bValue ?? 999999999)
        || stringSortValue(a.label).localeCompare(stringSortValue(b.label));
    });

    return next;
  }

  function toggleGroup(label) {
    setCollapsedGroups((prev) => ({
      ...prev,
      [label]: !prev[label],
    }));
  }

  function groupSortValue(label) {
    return groupedSortBy[label] || "modelAsc";
  }

  function updateGroupSort(label, value) {
    setGroupedSortBy((prev) => ({
      ...prev,
      [label]: value,
    }));
  }

  function clearMarketplaceFilters() {
    setStatusFilter("all");
    setSearch("");
    setPriceMin(DEFAULT_FILTERS.minPrice);
    setPriceMax(DEFAULT_FILTERS.maxPrice);
    setMilesMin(DEFAULT_FILTERS.minMiles);
    setMilesMax(DEFAULT_FILTERS.maxMiles);
    setFreshOnly(false);
  }

  function renderListingRow(item) {
    const year = inferYear(item);
    const make = inferMake(item);
    const model = inferModel(item);
    const location = inferLocation(item) || item.listed_location;
    const distanceLabel = formatDistanceFromBuda(location);
    const rating = computeMarketplaceRating(item);
    const fresh = isFresh(item);
    const ageLabel = formatListingAge(item);
    const tone = statusTone(item.decision_status || "new");
    const isSelected = item.id === selectedId;
    const enriched = hasMarketplaceEnrichment(item);
    const cohortMeta = item.cohort_meta;
    const outlierLabel = cohortMeta?.outlierLabel || null;
    const duplicateMeta = item.duplicate_meta || null;
    const duplicateLabel = duplicateMeta?.duplicateLabel || null;
    const priceTone = cohortPriceTone(item);
    const highlightTitle = cohortMeta
      ? outlierLabel === "suspect"
        ? `${make} ${model} is priced far below the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps). This one may be bogus or otherwise not comparable.`
        : outlierLabel === "outlier"
          ? `${make} ${model} is priced about ${formatMoney(cohortMeta.delta)} below the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps).`
          : outlierLabel === "alert"
            ? `${make} ${model} is priced more than 20% above the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps).`
            : `${make} ${model} cohort baseline is ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} across ${cohortMeta.cohortSize} comps.`
      : "";
    const duplicateTitle = duplicateMeta
      ? `Possible duplicate of listing ${duplicateMeta.matchedId}${duplicateMeta.matchedPrice ? ` at ${formatMoney(duplicateMeta.matchedPrice)}` : ""}${duplicateMeta.matchedLocation ? ` in ${duplicateMeta.matchedLocation}` : ""}.`
      : "";

    return (
      <div
        key={item.id}
        className={`marketplace-table-row ${isSelected ? "selected" : ""} ${fresh ? "fresh" : ""} ${!enriched ? "unenriched" : ""} ${priceTone} ${outlierLabel ? outlierLabel : ""} ${duplicateLabel ? `duplicate-${duplicateLabel}` : ""}`}
        onClick={() => setSelectedId(item.id)}
        role="button"
        tabIndex={0}
        title={duplicateTitle || highlightTitle || undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setSelectedId(item.id);
          }
        }}
      >
        <span className="mono">{year || "—"}</span>
        <span className="mono" title={cohortPriceTooltip(item)}>
          {formatMoney(item.price_numeric, item.price_text || "—")}
        </span>
        <span>{make || "—"}</span>
        <span>{model || "—"}</span>
        <span className="truncate" title={item.title || ""}>
          {compactDescription(item)}
        </span>
        <span className="truncate" title={location || ""}>
          {distanceLabel}
        </span>
        <span>
          <div className="marketplace-state-stack">
            {fresh && !ageLabel ? (
              <div className="marketplace-pill marketplace-pill--fresh">NEW</div>
            ) : null}
            {item.decision_status && item.decision_status !== "new" ? (
              <div className={`marketplace-pill marketplace-pill--${tone}`}>
                {item.decision_status}
              </div>
            ) : null}
            {ageLabel ? (
              <div className="marketplace-pill marketplace-pill--neutral">
                {ageLabel}
              </div>
            ) : null}
            {outlierLabel ? (
              <div
                className={`marketplace-pill marketplace-pill--${outlierLabel}`}
                title={highlightTitle}
              >
                {outlierLabel === "suspect" ? "SUSPECT" : outlierLabel === "alert" ? "HIGH" : "OUTLIER"}
              </div>
            ) : null}
            {duplicateLabel ? (
              <div
                className={`marketplace-pill marketplace-pill--duplicate-${duplicateLabel}`}
                title={duplicateTitle}
              >
                {duplicateLabel === "likely" ? "LIKELY DUP" : "POSSIBLE DUP"}
              </div>
            ) : null}
          </div>
        </span>
        <span className="mono" title={RATING_TOOLTIP}>{formatRating(rating)}</span>
        <span className="mono">{viewCountValue(item)}</span>
        <span className="marketplace-row-actions">
          <button
            type="button"
            className="marketplace-row-quick-action"
            onClick={(e) => {
              e.stopPropagation();
              openListing(item);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="marketplace-row-quick-action marketplace-row-quick-action--danger"
            onClick={(e) => {
              e.stopPropagation();
              ignoreListing(item);
            }}
            disabled={savingId === item.id}
          >
            Ignore
          </button>
        </span>
      </div>
    );
  }

  const selectedDraft = getDraft(selected);
  const selectedEffectiveScore = selected
    ? effectiveMarketplaceScore(selected, selectedDraft)
    : null;

  return (
    <section className="marketplace-panel marketplace-workbench">
      <div className="marketplace-topbar">
        <div className="marketplace-topbar-left">
          <div className="marketplace-filter-row">
            <select
              className="marketplace-input marketplace-input--compact marketplace-filter-control"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {FILTER_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {status === "all"
                    ? "All statuses"
                    : status === "uncontacted"
                      ? "Needs contact"
                      : status === "unviewed"
                        ? "Not yet viewed"
                        : status}
                </option>
              ))}
            </select>

            <input
              className="marketplace-input marketplace-input--compact marketplace-filter-control marketplace-price-filter"
              inputMode="numeric"
              placeholder="Min $"
              value={priceMin}
              onChange={(e) => setPriceMin(normalizePriceFilterInput(e.target.value))}
            />

            <input
              className="marketplace-input marketplace-input--compact marketplace-filter-control marketplace-price-filter"
              inputMode="numeric"
              placeholder="Max $"
              value={priceMax}
              onChange={(e) => setPriceMax(normalizePriceFilterInput(e.target.value))}
            />

            <input
              className="marketplace-input marketplace-input--compact marketplace-filter-control marketplace-mileage-filter"
              inputMode="numeric"
              placeholder="Min mi"
              value={milesMin}
              onChange={(e) => setMilesMin(normalizePriceFilterInput(e.target.value))}
            />

            <input
              className="marketplace-input marketplace-input--compact marketplace-filter-control marketplace-mileage-filter"
              inputMode="numeric"
              placeholder="Max mi"
              value={milesMax}
              onChange={(e) => setMilesMax(normalizePriceFilterInput(e.target.value))}
            />
          </div>

          <div className="marketplace-filter-row marketplace-filter-row--secondary">
            <input
              className="marketplace-input marketplace-search-input"
              placeholder="Search year, make, model, VIN, seller, notes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="marketplace-view-toggle">
              <button
                type="button"
                className={`marketplace-action ${viewMode === "flat" ? "active" : ""}`}
                onClick={() => setViewMode("flat")}
              >
                Flat
              </button>
              <button
                type="button"
                className={`marketplace-action ${viewMode === "grouped" ? "active" : ""}`}
                onClick={() => setViewMode("grouped")}
              >
                Grouped
              </button>
            </div>
            <button
              type="button"
              className="marketplace-action"
              onClick={clearMarketplaceFilters}
              title="Clear status, search, price bounds, and fresh-only filters."
            >
              Clear filters
            </button>
          </div>
        </div>

        <div className="marketplace-topbar-right">
          <label className="marketplace-checkbox">
            <input
              type="checkbox"
              checked={freshOnly}
              onChange={(e) => {
                const checked = e.target.checked;
                setFreshOnly(checked);
                if (checked) setSortBy("ratingDesc");
              }}
            />
            Fresh only
          </label>

          <label className="marketplace-checkbox">
            <input
              type="checkbox"
              checked={statusFilter === "uncontacted"}
              onChange={(e) => setStatusFilter(e.target.checked ? "uncontacted" : "all")}
            />
            Needs contact
          </label>

          <label className="marketplace-checkbox">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(e) => setIncludeHidden(e.target.checked)}
            />
            Show ignored
          </label>

          <div className={`marketplace-stream marketplace-stream--${streamState}`}>
            {streamState === "live" ? "Live" : streamState === "connecting" ? "Connecting" : "Disconnected"}
          </div>

          <div className="marketplace-results-count">
            {displayListings.length} / {filteredListings.length} shown
            {totalListingsCount > listings.length ? ` loaded of ${totalListingsCount}` : ""}
          </div>

          <button
            type="button"
            className="marketplace-action"
            onClick={() => loadListings({ preserveSelection: true })}
          >
            Refresh
          </button>

          <div className="marketplace-batch-box">
            <div className="marketplace-batch-label">Batch tools</div>
            <div className="marketplace-batch-actions">
              <button
                type="button"
                className="marketplace-action"
                onClick={enrichVisibleListings}
                disabled={Boolean(enrichVisibleStatus?.running)}
                title={
                  extensionReady
                    ? "Open and enrich all currently visible listings one at a time in your logged-in Facebook browser session."
                    : "Chrome extension bridge not detected yet. Reload the extension and refresh this page."
                }
              >
                {enrichVisibleStatus?.running
                  ? "Enriching visible..."
                  : extensionReady
                    ? `Enrich visible (${visibleUnenrichedCount})`
                    : `Enrich visible (${visibleUnenrichedCount}, setup)`}
              </button>

              <button
                type="button"
                className="marketplace-action"
                onClick={ignoreAllVisibleListings}
                disabled={ignoringVisible || displayListings.length === 0}
                title="Hide all currently visible listings in one step."
              >
                {ignoringVisible ? "Ignoring visible..." : "Ignore all visible"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {enrichVisibleStatus ? (
        <div className="marketplace-enrich-status">
          {enrichVisibleStatus.running
            ? `Batch enrich: ${enrichVisibleStatus.completed}/${enrichVisibleStatus.total} complete`
            : enrichVisibleStatus.error
              ? `Batch enrich: ${enrichVisibleStatus.error}`
              : enrichVisibleStatus.total
                ? `Batch enrich finished: ${enrichVisibleStatus.completed}/${enrichVisibleStatus.total} complete`
                : null}
        </div>
      ) : null}

      <div className="marketplace-ignore-toggle-row">
        <button
          type="button"
          className="marketplace-action"
          onClick={() => setShowIgnoreKeywordEditor((prev) => !prev)}
        >
          {showIgnoreKeywordEditor ? "Hide keywords" : "Ignore keywords"}
        </button>
      </div>

      {showIgnoreKeywordEditor ? (
        <div className="marketplace-ignore-panel">
          <div className="marketplace-section-title">Ignore keywords</div>
          <label className="marketplace-field">
            <span>One phrase per line</span>
            <textarea
              className="marketplace-input marketplace-input--textarea marketplace-ignore-textarea"
              value={ignoreKeywordsText}
              onChange={(e) => setIgnoreKeywordsText(e.target.value)}
              placeholder={`nissan leaf\nsalvage\nrebuilt title\nparts only`}
            />
          </label>
          <div className="marketplace-ignore-help">
            Listings still ingest normally. Anything matching these phrases is hidden in this panel and now saves to the backend.
          </div>
        </div>
      ) : null}

      {error ? <div className="marketplace-empty">{error}</div> : null}

      <div className="marketplace-body">
        <div className="marketplace-list-pane">
          <div className="marketplace-table-head">
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("year")}>
              Year{sortIndicator("year")}
            </button>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("price")}>
              Price{sortIndicator("price")}
            </button>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("make")}>
              Make{sortIndicator("make")}
            </button>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("model")}>
              Model{sortIndicator("model")}
            </button>
            <span>Description</span>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("distance")}>
              Distance{sortIndicator("distance")}
            </button>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("state")}>
              State{sortIndicator("state")}
            </button>
            <button
              type="button"
              className="marketplace-sort-head"
              onClick={() => toggleSort("rating")}
              title={RATING_TOOLTIP}
            >
              Rating{sortIndicator("rating")}
            </button>
            <button type="button" className="marketplace-sort-head" onClick={() => toggleSort("views")}>
              Views{sortIndicator("views")}
            </button>
            <span>Action</span>
          </div>

          <div className="marketplace-table-body">
            {loading ? (
              <div className="marketplace-empty">Loading listings…</div>
            ) : displayListings.length === 0 ? (
              <div className="marketplace-empty">No listings match the current filters.</div>
            ) : viewMode === "grouped" ? (
              <div className="marketplace-group-list">
                {groupedVisibleListings.map((group) => {
                  const isCollapsed = Boolean(collapsedGroups[group.key]);
                  const groupUnenriched = group.items.filter((item) => !hasMarketplaceEnrichment(item)).length;
                  const groupOutliers = group.items.filter((item) => item?.cohort_meta?.outlierLabel).length;
                  const groupDuplicates = group.items.filter((item) => item?.duplicate_meta?.duplicateLabel).length;
                  const typicalGroupPrice = group.items
                    .map((item) => toNumberOrNull(item?.cohort_meta?.baselinePrice ?? item?.cohort_meta?.averagePrice))
                    .filter(Number.isFinite)
                    .sort((a, b) => a - b)[0];

                  return (
                    <div key={group.key} className="marketplace-group">
                      <button
                        type="button"
                        className="marketplace-group-header"
                        onClick={() => toggleGroup(group.key)}
                        >
                          <span className="marketplace-group-title">
                            {isCollapsed ? "▶" : "▼"} {group.label}
                          </span>
                        <span className="marketplace-group-meta">
                          {group.items.length} · typical {formatMoney(typicalGroupPrice, "—")} · {groupUnenriched} unenriched · {groupOutliers} flagged · {groupDuplicates} dupes
                        </span>
                      </button>
                      <div className="marketplace-group-actions">
                        <select
                          className="marketplace-input marketplace-input--compact marketplace-filter-control marketplace-group-sort"
                          value={groupSortValue(group.key)}
                          onChange={(e) => updateGroupSort(group.key, e.target.value)}
                          title="Sort model groups inside this marque."
                        >
                          <option value="modelAsc">Model</option>
                          <option value="ratingDesc">Rating</option>
                          <option value="priceAsc">Price</option>
                          <option value="mileageAsc">Mileage</option>
                          <option value="distanceAsc">Distance</option>
                        </select>
                        <button
                          type="button"
                          className="marketplace-action marketplace-action--small"
                          onClick={() => enrichGroupListings(group.items)}
                          disabled={Boolean(enrichVisibleStatus?.running) || groupUnenriched === 0}
                          title="Enrich all currently visible listings in this marque."
                        >
                          Enrich marque ({groupUnenriched})
                        </button>
                      </div>
                      {!isCollapsed ? (
                        <div className="marketplace-group-rows">
                          {sortModelGroups(group.modelGroups, groupSortValue(group.key)).map((modelGroup) => {
                            const modelSortKey = modelGroup.key || `${group.label}::${modelGroup.label}`;
                            const modelUnenriched = modelGroup.items.filter((item) => !hasMarketplaceEnrichment(item)).length;
                            const modelOutliers = modelGroup.items.filter((item) => item?.cohort_meta?.outlierLabel).length;
                            const modelDuplicates = modelGroup.items.filter((item) => item?.duplicate_meta?.duplicateLabel).length;
                            const typicalModelPrice = modelGroup.items
                              .map((item) => toNumberOrNull(item?.cohort_meta?.baselinePrice ?? item?.cohort_meta?.averagePrice))
                              .filter(Number.isFinite)
                              .sort((a, b) => a - b)[0];

                            return (
                              <div key={modelSortKey} className="marketplace-model-group">
                                <div className="marketplace-model-group-header">
                                  <div>
                                    <span className="marketplace-model-group-title">{modelGroup.label}</span>
                                    <span className="marketplace-group-meta">
                                      {modelGroup.items.length} · typical {formatMoney(typicalModelPrice, "—")} · {modelUnenriched} unenriched · {modelOutliers} flagged · {modelDuplicates} dupes
                                    </span>
                                  </div>
                                </div>
                                {sortGroupedItems(modelGroup.items, "ratingDesc").map((item) => renderListingRow(item))}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              visibleListings.map((item) => {
                const year = inferYear(item);
                const make = inferMake(item);
                const model = inferModel(item);
                const location = inferLocation(item) || item.listed_location;
                const distanceLabel = formatDistanceFromBuda(location);
                const rating = computeMarketplaceRating(item);
                const fresh = isFresh(item);
                const ageLabel = formatListingAge(item);
                const tone = statusTone(item.decision_status || "new");
                const isSelected = item.id === selectedId;
                const enriched = hasMarketplaceEnrichment(item);
                const cohortMeta = item.cohort_meta;
                const outlierLabel = cohortMeta?.outlierLabel || null;
                const duplicateMeta = item.duplicate_meta || null;
                const duplicateLabel = duplicateMeta?.duplicateLabel || null;
                const priceTone = cohortPriceTone(item);
                const highlightTitle = cohortMeta
                  ? outlierLabel === "suspect"
                    ? `${make} ${model} is priced far below the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps). This one may be bogus or otherwise not comparable.`
                    : outlierLabel === "outlier"
                      ? `${make} ${model} is priced about ${formatMoney(cohortMeta.delta)} below the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps).`
                      : outlierLabel === "alert"
                        ? `${make} ${model} is priced more than 20% above the ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} cohort baseline (${cohortMeta.cohortSize} comps).`
                      : `${make} ${model} cohort baseline is ${formatMoney(cohortMeta.baselinePrice ?? cohortMeta.averagePrice)} across ${cohortMeta.cohortSize} comps.`
                  : "";
                const duplicateTitle = duplicateMeta
                  ? `Possible duplicate of listing ${duplicateMeta.matchedId}${duplicateMeta.matchedPrice ? ` at ${formatMoney(duplicateMeta.matchedPrice)}` : ""}${duplicateMeta.matchedLocation ? ` in ${duplicateMeta.matchedLocation}` : ""}.`
                  : "";

                return (
                  <div
                    key={item.id}
                    className={`marketplace-table-row ${isSelected ? "selected" : ""} ${fresh ? "fresh" : ""} ${!enriched ? "unenriched" : ""} ${priceTone} ${outlierLabel ? outlierLabel : ""} ${duplicateLabel ? `duplicate-${duplicateLabel}` : ""}`}
                    onClick={() => setSelectedId(item.id)}
                    role="button"
                    tabIndex={0}
                    title={duplicateTitle || highlightTitle || undefined}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(item.id);
                      }
                    }}
                  >
                    <span className="mono">{year || "—"}</span>
                    <span className="mono" title={cohortPriceTooltip(item)}>
                      {formatMoney(item.price_numeric, item.price_text || "—")}
                    </span>
                    <span>{make || "—"}</span>
                    <span>{model || "—"}</span>
                    <span className="truncate" title={item.title || ""}>
                      {compactDescription(item)}
                    </span>
                    <span className="truncate" title={location || ""}>
                      {distanceLabel}
                    </span>
                    <span>
                      <div className="marketplace-state-stack">
                        {fresh && !ageLabel ? (
                          <div className="marketplace-pill marketplace-pill--fresh">NEW</div>
                        ) : null}
                        {item.decision_status && item.decision_status !== "new" ? (
                          <div className={`marketplace-pill marketplace-pill--${tone}`}>
                            {item.decision_status}
                          </div>
                        ) : null}
                        {ageLabel ? (
                          <div className="marketplace-pill marketplace-pill--neutral">
                            {ageLabel}
                          </div>
                        ) : null}
                        {outlierLabel ? (
                          <div
                            className={`marketplace-pill marketplace-pill--${outlierLabel}`}
                            title={highlightTitle}
                          >
                            {outlierLabel === "suspect" ? "SUSPECT" : outlierLabel === "alert" ? "HIGH" : "OUTLIER"}
                          </div>
                        ) : null}
                        {duplicateLabel ? (
                          <div
                            className={`marketplace-pill marketplace-pill--duplicate-${duplicateLabel}`}
                            title={duplicateTitle}
                          >
                            {duplicateLabel === "likely" ? "LIKELY DUP" : "POSSIBLE DUP"}
                          </div>
                        ) : null}
                      </div>
                    </span>
                    <span className="mono" title={RATING_TOOLTIP}>{formatRating(rating)}</span>
                    <span className="mono">{viewCountValue(item)}</span>
                    <span className="marketplace-row-actions">
                      <button
                        type="button"
                        className="marketplace-row-quick-action"
                        onClick={(e) => {
                          e.stopPropagation();
                          openListing(item);
                        }}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        className="marketplace-row-quick-action marketplace-row-quick-action--danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          ignoreListing(item);
                        }}
                        disabled={savingId === item.id}
                      >
                        Ignore
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <aside className="marketplace-detail-pane">
          {!selected ? (
            <div className="marketplace-empty">Select a listing to inspect it.</div>
          ) : (
            <>
              <div className="marketplace-detail-card">
                <div className="marketplace-detail-header">
                  <div>
                    <h3 className="marketplace-detail-title">{detailTitle(selected)}</h3>
                    <div className="marketplace-detail-subtitle">
                      {formatMoney(selected.price_numeric, selected.price_text || "—")} •{" "}
                      {formatMiles(selected.driven_miles)} •{" "}
                      {cleanMarketplaceLocation(selected.listed_location) || "Unknown location"}
                    </div>
                  </div>

                  <div className="marketplace-detail-actions">
                    {!hasMarketplaceEnrichment(selected) ? (
                      <a
                        className="marketplace-link-btn"
                        href={buildEnrichUrl(selected.url)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open this listing in your normal logged-in Facebook tab and auto-run the extension enrich action."
                      >
                        Enrich
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className="marketplace-link-btn"
                      onClick={() => openListing(selected)}
                    >
                      Open listing
                    </button>
                    <button
                      type="button"
                      className="marketplace-link-btn marketplace-link-btn--danger"
                      onClick={() => ignoreListing(selected)}
                      disabled={savingId === selected.id}
                    >
                      {savingId === selected.id ? "Ignoring..." : "Ignore"}
                    </button>
                  </div>
                </div>

                <div className="marketplace-keyvals">
                  <div><span>Year</span><strong>{inferYear(selected) || "—"}</strong></div>
                  <div><span>Make</span><strong>{inferMake(selected) || "—"}</strong></div>
                  <div><span>Model</span><strong>{inferModel(selected) || "—"}</strong></div>
                  <div><span>VIN</span><strong>{selectedDraft?.vin || selected.vin || "—"}</strong></div>
                  <div><span>Miles</span><strong>{formatMiles(selectedDraft?.driven_miles ?? selected.driven_miles)}</strong></div>
                  <div><span>Transmission</span><strong>{selected.transmission || "—"}</strong></div>
                  <div><span>Fuel</span><strong>{selected.fuel_type || "—"}</strong></div>
                  <div><span>Interior</span><strong>{inferInteriorMeta(selected).label || "—"}</strong></div>
                  <div><span>Seller</span><strong>{selected.seller_name || "—"}</strong></div>
                  <div><span>Views</span><strong>{viewCountValue(selected)}</strong></div>
                  <div><span>Score</span><strong>{formatMarketplaceScore(selectedEffectiveScore)}</strong></div>
                  <div><span>Cohort</span><strong>{formatCohortDetail(selected)}</strong></div>
                  <div><span>Last opened</span><strong>{selected.last_opened_at ? new Date(selected.last_opened_at).toLocaleString() : "—"}</strong></div>
                  <div><span>Last seen</span><strong>{selected.last_seen_at ? new Date(selected.last_seen_at).toLocaleString() : "—"}</strong></div>
                </div>
              </div>

              <div className="marketplace-detail-card">
                <div className="marketplace-section-title">Analyst controls</div>

                <div className="marketplace-edit-grid">
                  <label className="marketplace-field">
                    <span>Status</span>
                    <select
                      className="marketplace-input marketplace-filter-control"
                      value={selectedDraft?.decision_status || "new"}
                      onChange={(e) =>
                        updateDraft(selected.id, { decision_status: e.target.value })
                      }
                    >
                      {DECISION_STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="marketplace-field">
                    <span>VIN</span>
                    <input
                      className="marketplace-input"
                      value={selectedDraft?.vin ?? ""}
                      onChange={(e) =>
                        updateDraft(selected.id, { vin: e.target.value.toUpperCase().replace(/\s+/g, "") })
                      }
                      placeholder="17-character VIN"
                    />
                  </label>

                  <label className="marketplace-field">
                    <span>Miles</span>
                    <input
                      className="marketplace-input"
                      type="number"
                      min="0"
                      step="1"
                      value={selectedDraft?.driven_miles ?? ""}
                      onChange={(e) =>
                        updateDraft(selected.id, { driven_miles: e.target.value })
                      }
                      placeholder="Odometer miles"
                    />
                  </label>

                  <label className="marketplace-field">
                    <span>Score</span>
                    <input
                      className="marketplace-input"
                      type="number"
                      step="0.1"
                      value={selectedDraft?.decision_score ?? ""}
                      onChange={(e) =>
                        updateDraft(selected.id, { decision_score: e.target.value })
                      }
                      placeholder={formatMarketplaceScore(computeMarketplaceRating(selected), "")}
                    />
                  </label>

                </div>

                <label className="marketplace-field">
                  <span>Tags</span>
                  <input
                    className="marketplace-input"
                    value={selectedDraft?.decision_tags ?? ""}
                    onChange={(e) =>
                      updateDraft(selected.id, { decision_tags: e.target.value })
                    }
                    placeholder="clean-title, low-miles, fleet-fit"
                  />
                </label>

                <label className="marketplace-field">
                  <span>Notes</span>
                  <textarea
                    className="marketplace-input marketplace-input--textarea"
                    value={selectedDraft?.decision_notes ?? ""}
                    onChange={(e) =>
                      updateDraft(selected.id, { decision_notes: e.target.value })
                    }
                    placeholder="What do you like, hate, suspect, or want to verify?"
                  />
                </label>

                <div className="marketplace-actions">
                  <button
                    type="button"
                    className="marketplace-action"
                    onClick={() => updateDraft(selected.id, { decision_status: "candidate" })}
                    disabled={savingId === selected.id}
                  >
                    Candidate
                  </button>

                  <button
                    type="button"
                    className="marketplace-action marketplace-action--danger"
                    onClick={() => ignoreListing(selected)}
                    disabled={savingId === selected.id}
                  >
                    {savingId === selected.id ? "Ignoring..." : "Ignore"}
                  </button>

                  <button
                    type="button"
                    className="marketplace-action marketplace-action--primary"
                    onClick={() => saveListing(selected)}
                    disabled={savingId === selected.id}
                  >
                    {savingId === selected.id ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              {!!selected.raw_text_sample ? (
                <div className="marketplace-detail-card">
                  <div className="marketplace-section-title">Raw listing text</div>
                  <div className="marketplace-raw-text">{selected.raw_text_sample}</div>
                </div>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
