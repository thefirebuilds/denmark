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