const express = require("express");
const { recordPlaidWebhook } = require("../services/plaid/plaidWebhook");
const router = express.Router();
let transactionSyncInProgress = false;
let transactionSyncQueued = false;

function shouldSyncTransactions(body = {}) {
  if (body.webhook_type !== "TRANSACTIONS") return false;
  return ["HISTORICAL_UPDATE", "SYNC_UPDATES_AVAILABLE"].includes(body.webhook_code);
}

async function syncTransactionsAfterWebhook(body) {
  if (!shouldSyncTransactions(body)) return;
  if (transactionSyncInProgress) {
    transactionSyncQueued = true;
    return;
  }
  transactionSyncInProgress = true;
  try {
    do {
      transactionSyncQueued = false;
      const { syncTransactions } = require("../services/plaid/plaid");
      const result = await syncTransactions({
        reason: `webhook_${String(body.webhook_code || "transactions").toLowerCase()}`,
        allowInitialImport: true,
      });
      console.log(`[plaid] webhook sync complete | code=${body.webhook_code} fetched=${result.fetched || 0} inserted=${result.inserted || 0} skipped=${result.skipped === true}`);
    } while (transactionSyncQueued);
  } catch (error) {
    console.error("[plaid] webhook transaction sync failed:", error);
  } finally {
    transactionSyncInProgress = false;
  }
}

router.post("/", (req, res) => {
  res.status(200).json({ received: true });
  const body = req.body || {};
  void recordPlaidWebhook(body)
    .then(() => syncTransactionsAfterWebhook(body))
    .catch((error) => console.error("[plaid] failed to process webhook delivery:", error));
});

module.exports = router;
