const fs = require("fs");
const path = require("path");
const { transitionTripStage } = require("./transitionTripStage");

const RULES_PATH = path.resolve(__dirname, "../../config/tripAutomationRules.json");
const DEFAULT_RULES = { tripStageAutomations: [] };

function toNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestamp(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function distanceMiles(aLat, aLon, bLat, bLon) {
  const lat1 = toNumber(aLat);
  const lon1 = toNumber(aLon);
  const lat2 = toNumber(bLat);
  const lon2 = toNumber(bLon);

  if ([lat1, lon1, lat2, lon2].some((value) => value == null)) return null;

  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const rLat1 = lat1 * rad;
  const rLat2 = lat2 * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;

  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function loadRulesConfig() {
  try {
    const raw = fs.readFileSync(RULES_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[trip-automation] failed to load rules config ${RULES_PATH}: ${err.message || err}`
    );
    return DEFAULT_RULES;
  }
}

function getEnabledStageRules() {
  const rules = loadRulesConfig();
  return (rules.tripStageAutomations || []).filter((rule) => rule?.enabled !== false);
}

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function isAtConfiguredLocation(telemetry, condition) {
  const address = normalizeAddress(telemetry?.address);
  const requiredParts = Array.isArray(condition?.addressContains)
    ? condition.addressContains
    : [];
  const addressMatches =
    address &&
    requiredParts.length > 0 &&
    requiredParts.every((part) => address.includes(normalizeAddress(part)));

  if (addressMatches) {
    return {
      matched: true,
      reason: `address ${telemetry.address}`,
    };
  }

  const miles = distanceMiles(
    telemetry?.latitude,
    telemetry?.longitude,
    condition?.lat,
    condition?.lon
  );
  const radiusMiles = toNumber(condition?.radiusMiles) ?? 0.1;

  if (miles != null && miles <= radiusMiles) {
    return {
      matched: true,
      reason: `within ${miles.toFixed(2)} mi of ${condition?.label || "configured location"}`,
    };
  }

  return {
    matched: false,
    reason: miles == null ? "no location" : `location ${miles.toFixed(2)} mi away`,
  };
}

async function getVehicleForTelemetry(client, telemetry) {
  const vin = String(telemetry?.vin || "").trim();
  const tokenId = telemetry?.dimoTokenId == null ? null : String(telemetry.dimoTokenId);
  const bouncieId =
    telemetry?.bouncieVehicleId == null ? null : String(telemetry.bouncieVehicleId);

  const result = await client.query(
    `
      SELECT id, vin, nickname, turo_vehicle_id, bouncie_vehicle_id, dimo_token_id
      FROM vehicles
      WHERE ($1 <> '' AND LOWER(vin) = LOWER($1))
        OR ($2::text IS NOT NULL AND CAST(dimo_token_id AS text) = $2)
        OR ($3::text IS NOT NULL AND CAST(bouncie_vehicle_id AS text) = $3)
      ORDER BY
        CASE WHEN $1 <> '' AND LOWER(vin) = LOWER($1) THEN 0 ELSE 1 END
      LIMIT 1
    `,
    [vin, tokenId, bouncieId]
  );

  return result.rows[0] || null;
}

async function getPreviousRunningState(client, telemetry) {
  const vin = String(telemetry?.vin || "").trim();
  const tokenId = telemetry?.dimoTokenId == null ? null : String(telemetry.dimoTokenId);
  const serviceName = String(telemetry?.serviceName || "").trim();
  const eventTimestamp = toTimestamp(telemetry?.eventTimestamp);

  if (!vin && !tokenId) return null;

  const result = await client.query(
    `
      SELECT is_running, vehicle_last_updated, captured_at
      FROM vehicle_telemetry_snapshots
      WHERE (
          ($1 <> '' AND LOWER(vin) = LOWER($1))
          OR ($2::text IS NOT NULL AND CAST(dimo_token_id AS text) = $2)
        )
        AND ($3 = '' OR service_name = $3)
        AND is_running IS NOT NULL
        AND COALESCE(vehicle_last_updated, captured_at) < $4::timestamptz
      ORDER BY COALESCE(vehicle_last_updated, captured_at) DESC NULLS LAST, id DESC
      LIMIT 1
    `,
    [vin, tokenId, serviceName, eventTimestamp]
  );

  return result.rows[0] || null;
}

async function evaluateEngineTransitionCondition(client, telemetry, condition) {
  const previous = await getPreviousRunningState(client, telemetry);
  const expectedPrevious = condition?.from;
  const expectedCurrent = condition?.to;

  if (telemetry?.isRunning !== expectedCurrent) {
    return {
      matched: false,
      reason: `engine state is ${telemetry?.isRunning}`,
    };
  }

  if (previous?.is_running !== expectedPrevious) {
    return {
      matched: false,
      reason: previous
        ? `previous engine state was ${previous.is_running}`
        : "no previous engine state",
    };
  }

  return {
    matched: true,
    reason: `engine changed ${expectedPrevious} -> ${expectedCurrent}`,
  };
}

async function evaluateCondition(client, telemetry, condition) {
  switch (condition?.type) {
    case "engine_transition":
      return evaluateEngineTransitionCondition(client, telemetry, condition);
    case "location":
      return isAtConfiguredLocation(telemetry, condition);
    default:
      return {
        matched: false,
        reason: `unknown condition type ${condition?.type || "(missing)"}`,
      };
  }
}

async function evaluateRuleConditions(client, telemetry, rule) {
  const reasons = [];

  for (const condition of rule.conditions || []) {
    const result = await evaluateCondition(client, telemetry, condition);
    reasons.push(result.reason);

    if (!result.matched) {
      return {
        matched: false,
        reason: result.reason,
        reasons,
      };
    }
  }

  return {
    matched: true,
    reason: reasons.join("; "),
    reasons,
  };
}

function normalizeOffsetMinutes(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

async function findEligibleTripForRule(client, vehicle, eventTimestamp, rule) {
  if (!vehicle?.turo_vehicle_id) return null;

  const window = rule.tripTimeWindow || {};
  const windowField = window.field === "trip_start" ? "trip_start" : "trip_end";
  const startOffsetMinutes = normalizeOffsetMinutes(window.startOffsetMinutes, -120);
  const endOffsetMinutes = normalizeOffsetMinutes(window.endOffsetMinutes, 2160);

  const result = await client.query(
    `
      SELECT
        id,
        reservation_id,
        vehicle_name,
        guest_name,
        trip_start,
        trip_end,
        workflow_stage,
        starting_odometer,
        ending_odometer,
        closed_out,
        completed_at,
        canceled_at,
        turo_vehicle_id
      FROM trips
      WHERE CAST(turo_vehicle_id AS text) = $1
        AND workflow_stage = $2
        AND canceled_at IS NULL
        AND completed_at IS NULL
        AND COALESCE(closed_out, false) = false
        AND ${windowField} IS NOT NULL
        AND $3::timestamptz >= ${windowField} + ($4::text || ' minutes')::interval
        AND $3::timestamptz <= ${windowField} + ($5::text || ' minutes')::interval
      ORDER BY ${windowField} ASC
      LIMIT 2
    `,
    [
      String(vehicle.turo_vehicle_id),
      rule.fromStage,
      eventTimestamp,
      startOffsetMinutes,
      endOffsetMinutes,
    ]
  );

  if (result.rows.length !== 1) {
    if (result.rows.length > 1) {
      console.warn(
        `Skipping telemetry auto-turnaround for vehicle ${vehicle.nickname || vehicle.vin}: multiple eligible in_progress trips found`
      );
    }
    return null;
  }

  return result.rows[0];
}

async function maybeAutoAdvanceTurnaroundTripFromTelemetry(client, telemetry) {
  const vehicle = await getVehicleForTelemetry(client, telemetry);
  if (!vehicle?.turo_vehicle_id) return null;

  const rules = getEnabledStageRules().filter(
    (rule) => rule.fromStage === "in_progress" && rule.toStage === "turnaround"
  );
  const eventTimestamp = toTimestamp(telemetry?.eventTimestamp);

  for (const rule of rules) {
    const signal = await evaluateRuleConditions(client, telemetry, rule);
    if (!signal.matched) continue;

    const trip = await findEligibleTripForRule(client, vehicle, eventTimestamp, rule);
    if (!trip) continue;

    console.log(
      `Auto-advancing trip ${trip.id} (${trip.guest_name || "unknown guest"} / ${
        trip.vehicle_name || vehicle.nickname || vehicle.vin
      }) to ${rule.toStage} from ${telemetry.serviceName || "telemetry"} rule=${rule.id}: ${signal.reason}`
    );

    return transitionTripStage(trip.id, rule.toStage, {
      changedBy: `system:${telemetry.serviceName || rule.changedBySuffix || "telemetry"}`,
      reason: `auto-stage rule ${rule.id} from ${
        telemetry.serviceName || "telemetry"
      }: ${signal.reason}`,
      currentOdometer: telemetry?.odometer,
    });
  }

  return null;
}

module.exports = {
  maybeAutoAdvanceTurnaroundTripFromTelemetry,
  loadRulesConfig,
};
