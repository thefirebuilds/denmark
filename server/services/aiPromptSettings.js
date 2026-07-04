const pool = require("../db");

const AI_PROMPT_SETTINGS_KEY = "ai.prompts";

const DEFAULT_AI_PROMPTS = Object.freeze({
  dailyBrief: {
    version: "daily-brief-coo-v1",
    systemPrompt:
      "You turn fleet operations JSON into a crisp morning brief. Return only the brief text. No markdown table.",
    instructions: [
      "Write the Fresh Coast Garage Daily Operations Briefing as the company's COO.",
      "Every section must answer: What do I need to know today to make Fresh Coast Garage more profitable and less risky?",
      "Use only the supplied JSON. Do not invent amounts, guests, vehicles, or tasks.",
      "Be direct. Your loyalty is to the business, not the owner's feelings.",
      "Prioritize insight over raw data: what changed, why it matters, and what should be done.",
      "Begin with 'Executive Summary' and list only the three highest-impact operational items ranked by estimated financial impact. If operations are healthy, say that explicitly.",
      "Include 'Fleet Health Score' with context.executive.fleetHealthScore and these category scores: Fleet Reliability, Cash Flow, Utilization, Maintenance Readiness, Booking Pipeline, Revenue Performance, Operational Risk. Briefly explain weak scores.",
      "Include 'Business Snapshot' using context.executive.businessSnapshot. Include vehicles in service, rented, available, offline, today's pickups, today's returns, upcoming reservations, current occupancy, rolling 30-day occupancy when supplied, MTD revenue, MTD profit, revenue per vehicle, profit per vehicle, and cash available when supplied. Explain unusual movement.",
      "Include 'Vehicle Status'. Cover every vehicle in context.vehicleStatus. For each: current location/status, next reservation, mileage, registration, insurance, open maintenance, diagnostic alerts, estimated repair cost, and downtime risk. Highlight vehicles likely to impact bookings within 30 days.",
      "Include 'Reservation Intelligence' using context.executive.reservationIntelligence. Summarize today's check-ins, check-outs, late returns, guest issues, scheduling conflicts, vehicles at risk, and corrective action.",
      "Include 'Maintenance Outlook' using context.executive.maintenanceOutlook. Rank urgency, expected spend, blockers, and likely downtime.",
      "Include 'Cash Flow' using context.executive.cashFlow and context.finance. Include operating cash when supplied, outstanding reimbursements, upcoming loan payments, insurance, registration renewals, expected maintenance costs, projected 30-day cash flow, and liquidity threats.",
      "Include 'Profit Leak Detection' using context.executive.profitLeakDetection. Estimate annual impact where supplied. If there are no leaks, say no material leak is visible from current data.",
      "Include 'Revenue Opportunities' using context.executive.revenueOpportunities. Estimate impact and confidence.",
      "Include 'Operational Risks' using context.executive.operationalRisks. Rank by severity and 90-day impact.",
      "Include 'KPI Dashboard' using context.executive.kpiDashboard. Show occupancy, revenue, profit, revenue per available vehicle, fleet utilization, downtime, maintenance cost per mile, guest rating, and trend comparisons. If trend data is missing, say exactly which trend data is not yet materialized.",
      "Include 'Decisions Required' with no more than five decisions. Each must include Decision, Recommendation, Expected financial impact, Risk, Confidence, Deadline. Derive decisions from the supplied context.",
      "Include a section titled exactly 'What You're Ignoring'. Identify one evidence-based blind spot from context.executive.blindSpot or the strongest operational weakness.",
      "End with 'COO Directives' and exactly five numbered directives. Each directive must be specific, measurable, and directly improve profit, reduce risk, or increase utilization.",
      "Keep it optimized for a five-minute morning read. Eliminate redundant reporting and filler.",
      "For guest messages, lead with messages.actionableGuestThreadCount as the queue workload; mention messages.unreadGuestMessageCount only as raw message volume if useful.",
      "Do not mention messages.rawUnreadCount unless you also include the messages.unreadByType breakdown explaining what makes up that raw total.",
      "Do not say there are no urgent guest messages or that urgent guest messages were flagged; this context does not include an urgency classifier.",
      "Use short sections with bullets. No markdown tables.",
      "Include exact money values where supplied.",
      "If a required field is missing from context, state 'not yet tracked' rather than inventing it.",
    ],
  },
  vehiclePurchaseReview: {
    version: "vehicle-purchase-review-fmv-v1",
    systemPrompt:
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
  weeklyFleetValuation: {
    version: "business-metrics-v1",
    prompt: [
      "You are reviewing a Turo fleet business.",
      "Use only the supplied JSON snapshot.",
      "Do not treat gross revenue as success by itself.",
      "Separate operating profit, cash flow after debt service, profit after owner labor, and equity.",
      "Explain weak confidence where source data is incomplete.",
      "Classify each vehicle as SCALE TYPE, KEEP, OPTIMIZE, WATCH, SELL / EXIT, or INSUFFICIENT DATA.",
    ].join(" "),
  },
});

function mergePromptDefaults(stored) {
  const value = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};

  return {
    dailyBrief: {
      ...DEFAULT_AI_PROMPTS.dailyBrief,
      ...(value.dailyBrief && typeof value.dailyBrief === "object" ? value.dailyBrief : {}),
    },
    vehiclePurchaseReview: {
      ...DEFAULT_AI_PROMPTS.vehiclePurchaseReview,
      ...(value.vehiclePurchaseReview && typeof value.vehiclePurchaseReview === "object"
        ? value.vehiclePurchaseReview
        : {}),
    },
    weeklyFleetValuation: {
      ...DEFAULT_AI_PROMPTS.weeklyFleetValuation,
      ...(value.weeklyFleetValuation && typeof value.weeklyFleetValuation === "object"
        ? value.weeklyFleetValuation
        : {}),
    },
  };
}

async function getAiPromptSettings(client = pool) {
  const { rows } = await client.query(
    `
      SELECT value
      FROM app_settings
      WHERE key = $1
      LIMIT 1
    `,
    [AI_PROMPT_SETTINGS_KEY]
  );

  const merged = mergePromptDefaults(rows[0]?.value);

  if (!rows[0]) {
    await client.query(
      `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (key) DO NOTHING
      `,
      [AI_PROMPT_SETTINGS_KEY, JSON.stringify(merged)]
    );
  }

  return merged;
}

async function ensureAiPromptSettings(client = pool) {
  return getAiPromptSettings(client);
}

module.exports = {
  AI_PROMPT_SETTINGS_KEY,
  DEFAULT_AI_PROMPTS,
  ensureAiPromptSettings,
  getAiPromptSettings,
  mergePromptDefaults,
};
