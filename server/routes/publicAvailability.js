const express = require("express");
const { getPublicAvailability } = require("../services/publicAvailability");

const router = express.Router();

router.get("/public/availability", async (req, res) => {
  try {
    const rows = await getPublicAvailability();

    res.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      vehicles: rows,
    });
  } catch (error) {
    console.error("Failed to build public availability:", error);
    res.status(500).json({
      ok: false,
      error: "Failed to build public availability",
    });
  }
});

module.exports = router;