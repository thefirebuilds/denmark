const express = require("express");
const { recordPlaidWebhook } = require("../services/plaid/plaidWebhook");
const router = express.Router();

router.post("/", (req, res) => {
  res.status(200).json({ received: true });
  void recordPlaidWebhook(req.body || {}).catch((error) => {
    console.error("[plaid] failed to record webhook delivery:", error);
  });
});

module.exports = router;
