const express = require("express");
const {
  listBankingTransactions,
  listIgnoredVendorGroups,
  getIgnoredVendorGroupDetails,
  getBankingTransactionById,
  getBankingSummary,
} = require("../services/banking/bankingInboxService");
const {
  getBankingSuggestions,
  matchBankingTransaction,
  createExpenseFromBanking,
  dismissBankingTransaction,
  ignoreBankingTransaction,
  createBankingIgnoreRule,
  getCategorySuggestionsForTransaction,
  detectRefundSignal,
  getIncomeDraftForBanking,
  createIncomeFromBanking,
} = require("../services/banking/bankingMatchService");
const syncMercuryTransactions = require("../services/mercury/mercury");

const router = express.Router();

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toDateOnly(value) {
  if (!value) return null;

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
}

function sendRouteError(res, err, fallbackMessage) {
  res.status(err.status || 500).json({
    error: err.message || fallbackMessage,
  });
}

function getValidatedTransactionId(req, res) {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    res.status(400).json({ error: "Invalid Banking transaction id" });
    return null;
  }

  return id;
}

router.post("/ignore-rules", async (req, res) => {
  try {
    const result = await createBankingIgnoreRule(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create Banking ignore rule:", err);
    sendRouteError(res, err, "Failed to create Banking ignore rule");
  }
});

router.get("/pending", async (req, res) => {
  try {
    const result = await listBankingTransactions({
      ...req.query,
      review_status: "pending",
      ignored: false,
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to list pending Banking transactions:", err);
    sendRouteError(res, err, "Failed to list pending Banking transactions");
  }
});

router.get("/summary", async (req, res) => {
  try {
    const result = await getBankingSummary();
    res.json(result);
  } catch (err) {
    console.error("Failed to load Banking summary:", err);
    sendRouteError(res, err, "Failed to load Banking summary");
  }
});

router.get("/mercury/config", async (req, res) => {
  try {
    res.json(syncMercuryTransactions.getConfigSummary());
  } catch (err) {
    console.error("Failed to load Mercury config:", err);
    sendRouteError(res, err, "Failed to load Mercury config");
  }
});

router.get("/mercury/balance", async (req, res) => {
  try {
    const result = await syncMercuryTransactions.getBalanceSummary();
    res.json(result);
  } catch (err) {
    console.error("Failed to load Mercury balance:", err);
    sendRouteError(res, err, "Failed to load Mercury balance");
  }
});

router.post("/mercury/sync", async (req, res) => {
  try {
    const result = await syncMercuryTransactions();
    res.json(result);
  } catch (err) {
    console.error("Failed to sync Mercury transactions:", err);
    sendRouteError(res, err, "Failed to sync Mercury transactions");
  }
});

router.get("/ignored-groups", async (req, res) => {
  try {
    const result = await listIgnoredVendorGroups(req.query || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to list ignored vendor groups:", err);
    sendRouteError(res, err, "Failed to list ignored vendor groups");
  }
});

router.get("/ignored-groups/:vendorKey", async (req, res) => {
  try {
    const vendorKey = decodeURIComponent(req.params.vendorKey || "").trim();

    if (!vendorKey) {
      return res.status(400).json({ error: "Invalid vendor key" });
    }

    const result = await getIgnoredVendorGroupDetails(vendorKey, req.query || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to load ignored vendor group details:", err);
    sendRouteError(res, err, "Failed to load ignored vendor group details");
  }
});

router.get("/", async (req, res) => {
  try {
    const result = await listBankingTransactions(req.query || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to list Banking transactions:", err);
    sendRouteError(res, err, "Failed to list Banking transactions");
  }
});

router.get("/:id/suggestions", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await getBankingSuggestions(id);
    res.json({ data: result });
  } catch (err) {
    console.error("Failed to load Banking suggestions:", err);
    sendRouteError(res, err, "Failed to load Banking suggestions");
  }
});

router.get("/:id/expense-draft", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const tx = await getBankingTransactionById(id);
    if (!tx) {
      return res.status(404).json({ error: "Banking transaction not found" });
    }

    const amount = Math.abs(Number(tx.amount || 0));
    const refundSignal = detectRefundSignal(
      tx.counterparty_name,
      tx.description
    );
    const categoryOptions = await getCategorySuggestionsForTransaction(tx);

    const draft = {
      vehicle_id: null,
      vendor: tx.counterparty_name || tx.description || null,
      price: refundSignal.detected ? -amount : amount,
      tax: 0,
      is_capitalized: false,
      category: categoryOptions[0]?.category || null,
      notes: tx.description || null,
      date: toDateOnly(tx.transaction_date),
      expense_scope: "shared",
      trip_id: null,
      category_options: categoryOptions,
      category_confidence: categoryOptions[0]?.confidence || 0,
      refund_signal_detected: refundSignal.detected,
      refund_signal_reason: refundSignal.reason || null,
    };

    res.json(draft);
  } catch (err) {
    console.error("Failed to build expense draft:", err);
    sendRouteError(res, err, "Failed to build expense draft");
  }
});

router.get("/:id/income-draft", async (req, res) => {
  try {
    const txId = getValidatedTransactionId(req, res);
    if (!txId) return;

    const draft = await getIncomeDraftForBanking(txId);
    res.json(draft);
  } catch (err) {
    console.error("Failed to build income draft:", err);
    sendRouteError(res, err, "Failed to build income draft");
  }
});

router.post("/:id/create-income", async (req, res) => {
  try {
    const txId = getValidatedTransactionId(req, res);
    if (!txId) return;

    const result = await createIncomeFromBanking(txId, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create income from Banking transaction:", err);
    sendRouteError(res, err, "Failed to create income");
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await getBankingTransactionById(id);

    if (!result) {
      return res.status(404).json({ error: "Banking transaction not found" });
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch Banking transaction:", err);
    sendRouteError(res, err, "Failed to fetch Banking transaction");
  }
});

router.post("/:id/match", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const expenseId = parsePositiveInt(req.body?.expense_id);
    if (!expenseId) {
      return res.status(400).json({ error: "Invalid expense id" });
    }

    const result = await matchBankingTransaction(id, expenseId, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to match Banking transaction:", err);
    sendRouteError(res, err, "Failed to match Banking transaction");
  }
});

router.post("/:id/create-expense", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await createExpenseFromBanking(id, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create expense from Banking transaction:", err);
    sendRouteError(res, err, "Failed to create expense from Banking transaction");
  }
});

router.post("/:id/dismiss", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await dismissBankingTransaction(id, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to dismiss Banking transaction:", err);
    sendRouteError(res, err, "Failed to dismiss Banking transaction");
  }
});

router.post("/:id/ignore", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await ignoreBankingTransaction(id, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to ignore Banking transaction:", err);
    sendRouteError(res, err, "Failed to ignore Banking transaction");
  }
});

module.exports = router;
