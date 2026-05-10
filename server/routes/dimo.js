const express = require("express");
const {
  fetchDimoSharedVehicles,
} = require("../services/dimo/client");
const { getDimoStatusFeed } = require("../services/dimo/statusFeed");

const router = express.Router();

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

module.exports = router;
