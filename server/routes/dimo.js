const express = require("express");
const {
  fetchDimoSignalsLatest,
  fetchDimoSharedVehicles,
  getDimoFleetFromDb,
  mergeDimoFleet,
} = require("../services/dimo/client");
const { getDimoStatusFeed } = require("../services/dimo/statusFeed");

const router = express.Router();
const DIAGNOSTIC_SIGNAL_MAX_AGE_MS = 15 * 60 * 1000;

function signalValue(signal) {
  if (signal == null) return null;
  if (typeof signal === "object" && Object.prototype.hasOwnProperty.call(signal, "value")) {
    return signal.value;
  }
  return signal;
}

function signalTimestamp(signal) {
  if (signal == null || typeof signal !== "object") return null;
  return signal.timestamp || null;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseDtcList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isFreshDiagnosticTimestamp(value) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Date.now() - timestamp;
  return ageMs >= -5 * 60 * 1000 && ageMs <= DIAGNOSTIC_SIGNAL_MAX_AGE_MS;
}

router.get("/status", async (req, res) => {
  try {
    const feed = await getDimoStatusFeed();
    res.json(feed);
  } catch (err) {
    console.error("DIMO status error:", err.message || err);
    res.status(500).json({ error: "Failed to fetch DIMO status" });
  }
});

router.get("/config", async (req, res) => {
  const clientId = String(process.env.DIMO_CLIENT_ID || "").trim();
  const shareTarget = String(
    process.env.DIMO_SHARE_TARGET ||
      process.env.DIMO_DEVELOPER_ENS ||
      process.env.DIMO_ENS ||
      clientId
  ).trim();

  res.json({
    configured: Boolean(clientId),
    shareTarget: shareTarget || null,
    shareTargetKind: /^0x[a-f0-9]{40}$/i.test(shareTarget)
      ? "wallet_address"
      : shareTarget
      ? "ens_or_name"
      : null,
    envKey: shareTarget && shareTarget !== clientId ? "DIMO_SHARE_TARGET" : "DIMO_CLIENT_ID",
  });
});

router.get("/vehicles", async (req, res) => {
  try {
    const vehicles = await fetchDimoSharedVehicles();
    res.json(vehicles);
  } catch (err) {
    console.error("DIMO vehicles error:", err.message || err);
    res.status(500).json({ error: "Failed to fetch DIMO shared vehicles" });
  }
});

router.get("/vehicles/:tokenId/latest-diagnostics", async (req, res) => {
  try {
    const tokenId = Number(req.params.tokenId);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return res.status(400).json({ error: "Invalid DIMO tokenId" });
    }

    const raw = await fetchDimoSignalsLatest(tokenId);
    const signals = raw?.data?.signalsLatest || {};
    const dtcCount = toNumber(signalValue(signals.obdStatusDTCCount));
    const dtcList =
      dtcCount === 0 ? [] : parseDtcList(signalValue(signals.obdDTCList));
    const diagnosticTimestamp =
      signalTimestamp(signals.obdStatusDTCCount) ||
      signalTimestamp(signals.obdDTCList) ||
      signalTimestamp(signals.obdDistanceWithMIL) ||
      null;

    res.json({
      tokenId,
      source: "dimo_latest_signals",
      fetchedAt: new Date().toISOString(),
      meta: {
        fetchedSignals: raw?.meta?.fetchedSignals || [],
        skippedSignals: raw?.meta?.skippedSignals || [],
        blockedSignals: raw?.meta?.blockedSignals || [],
        missingPrivileges: raw?.meta?.missingPrivileges || [],
        degraded: Boolean(raw?.meta?.degraded),
        degradedReason: raw?.meta?.degradedReason || null,
      },
      mil: {
        mil_on: dtcCount == null ? null : dtcCount > 0,
        dtc_count: dtcCount,
        qualified_dtc_list: dtcList,
        distance_with_mil: toNumber(signalValue(signals.obdDistanceWithMIL)),
        last_updated: diagnosticTimestamp,
        stale: !isFreshDiagnosticTimestamp(diagnosticTimestamp),
        freshness_max_age_minutes: DIAGNOSTIC_SIGNAL_MAX_AGE_MS / 60000,
        first_reported_at: null,
        source: "dimo_latest_signals",
      },
    });
  } catch (err) {
    console.error("DIMO latest diagnostics error:", err.message || err);
    res.status(500).json({
      error: "Failed to fetch DIMO latest diagnostics",
      detail: err.message || String(err),
    });
  }
});

router.get("/debug/fleet", async (req, res) => {
  try {
    const localFleet = await getDimoFleetFromDb();
    let sharedVehicles = { totalCount: 0, nodes: [] };
    let sharedError = null;

    try {
      sharedVehicles = await fetchDimoSharedVehicles();
    } catch (err) {
      sharedError = err?.message || String(err);
    }

    const fleet = sharedError ? [] : mergeDimoFleet(sharedVehicles, localFleet);

    res.json({
      generated_at: new Date().toISOString(),
      sharedError,
      sharedReturned: sharedVehicles?.nodes?.map((vehicle) => ({
        tokenId: vehicle.tokenId,
        tokenDID: vehicle.tokenDID,
        owner: vehicle.owner,
        definition: vehicle.definition,
      })) || [],
      configuredLocal: localFleet?.map((vehicle) => ({
        tokenId: vehicle.tokenId,
        nickname: vehicle.nickname,
        vin: vehicle.vin,
        active: vehicle.active,
        in_service: vehicle.in_service,
      })) || [],
      pollableFleet: fleet?.map((vehicle) => ({
        tokenId: vehicle.tokenId,
        nickname: vehicle.nickname,
        vin: vehicle.vin,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        external_vehicle_key: vehicle.external_vehicle_key,
      })) || [],
    });
  } catch (err) {
    console.error("DIMO debug fleet error:", err.message || err);
    res.status(500).json({ error: "Failed to load DIMO debug fleet" });
  }
});

module.exports = router;
