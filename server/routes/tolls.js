const express = require("express");
const syncTolls = require("../services/tolls/syncTolls");

const router = express.Router();

router.post("/sync", async (req, res) => {
  try {
    const result = await syncTolls();
    res.json(result);
  } catch (err) {
    console.error("Manual toll sync failed:", err.message || err);
    res.status(500).json({
      error: "Toll sync failed",
      details: err.message || String(err),
    });
  }
});

module.exports = router;