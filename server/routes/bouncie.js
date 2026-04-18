const express = require("express");
const { getBouncieStatusFeed } = require("../services/bouncie/statusFeed");

const router = express.Router();

router.get("/status", async (req, res) => {
  try {
    const feed = await getBouncieStatusFeed();
    res.json(feed);
  } catch (err) {
    console.error("Bouncie status error:", err.message || err);
    res.status(500).json({ error: "Failed to fetch Bouncie status" });
  }
});

module.exports = router;