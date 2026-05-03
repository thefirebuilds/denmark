const express = require("express");
const {
  listTellerTransactions,
  listIgnoredVendorGroups,
  getIgnoredVendorGroupDetails,
  getTellerTransactionById,
  getTellerSummary,
} = require("../services/teller/tellerInboxService");
const {
  getTellerSuggestions,
  matchTellerTransaction,
  createExpenseFromTeller,
  dismissTellerTransaction,
  ignoreTellerTransaction,
  createTellerIgnoreRule,
  getCategorySuggestionsForTransaction,
  detectRefundSignal,
  getIncomeDraftForTeller,
  createIncomeFromTeller,
} = require("../services/teller/tellerMatchService");
const syncTellerTransactions = require("../services/teller/teller");
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
    res.status(400).json({ error: "Invalid Teller transaction id" });
    return null;
  }

  return id;
}

router.post("/ignore-rules", async (req, res) => {
  try {
    const result = await createTellerIgnoreRule(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create Teller ignore rule:", err);
    sendRouteError(res, err, "Failed to create Teller ignore rule");
  }
});

router.get("/pending", async (req, res) => {
  try {
    const result = await listTellerTransactions({
      ...req.query,
      review_status: "pending",
      ignored: false,
    });
    res.json(result);
  } catch (err) {
    console.error("Failed to list pending Teller transactions:", err);
    sendRouteError(res, err, "Failed to list pending Teller transactions");
  }
});

router.get("/summary", async (req, res) => {
  try {
    const result = await getTellerSummary();
    res.json(result);
  } catch (err) {
    console.error("Failed to load Teller summary:", err);
    sendRouteError(res, err, "Failed to load Teller summary");
  }
});

router.get("/connect/config", async (req, res) => {
  try {
    const applicationId = String(process.env.TELLER_APPLICATION_ID || "").trim();
    const environment = String(
      process.env.TELLER_CONNECT_ENVIRONMENT || "development"
    ).trim();

    res.json({
      configured: Boolean(applicationId),
      applicationId: applicationId || null,
      environment,
      products: ["transactions", "balance"],
      selectAccount: "multiple",
    });
  } catch (err) {
    console.error("Failed to load Teller Connect config:", err);
    sendRouteError(res, err, "Failed to load Teller Connect config");
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

router.get("/connections", async (req, res) => {
  try {
    const summary = await syncTellerTransactions.getTokenSummary();
    res.json({
      token_count: Number(summary.token_count || 0),
      latest_connected_at: summary.latest_connected_at || null,
    });
  } catch (err) {
    console.error("Failed to load Teller connections:", err);
    sendRouteError(res, err, "Failed to load Teller connections");
  }
});

router.post("/connections", async (req, res) => {
  try {
    const accessToken = req.body?.access_token || req.body?.accessToken;
    const result = await syncTellerTransactions.saveAccessToken(accessToken);
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    console.error("Failed to save Teller connection:", err);
    sendRouteError(res, err, "Failed to save Teller connection");
  }
});

router.post("/sync", async (req, res) => {
  const result = {
    processed: 0,
    accounts: 0,
    teller: null,
    mercury: null,
    errors: [],
  };

  try {
    try {
      result.teller = await syncTellerTransactions();
      result.processed += Number(result.teller?.processed || 0);
      result.accounts += Number(result.teller?.accounts || 0);
    } catch (err) {
      result.errors.push({
        source: "teller",
        error: err.message || "Failed to sync Teller transactions",
      });
    }

    try {
      result.mercury = await syncMercuryTransactions();
      result.processed += Number(result.mercury?.processed || 0);
    } catch (err) {
      if (err.status === 400) {
        result.mercury = { configured: false, processed: 0 };
      } else {
        result.errors.push({
          source: "mercury",
          error: err.message || "Failed to sync Mercury transactions",
        });
      }
    }

    if (result.errors.length && !result.processed) {
      return res.status(502).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to sync bank transactions:", err);
    sendRouteError(res, err, "Failed to sync bank transactions");
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
    const result = await listTellerTransactions(req.query || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to list Teller transactions:", err);
    sendRouteError(res, err, "Failed to list Teller transactions");
  }
});

router.get("/:id/suggestions", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await getTellerSuggestions(id);
    res.json({ data: result });
  } catch (err) {
    console.error("Failed to load Teller suggestions:", err);
    sendRouteError(res, err, "Failed to load Teller suggestions");
  }
});

router.get("/:id/expense-draft", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const tx = await getTellerTransactionById(id);
    if (!tx) {
      return res.status(404).json({ error: "Teller transaction not found" });
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

    const draft = await getIncomeDraftForTeller(txId);
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

    const result = await createIncomeFromTeller(txId, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create income from Teller transaction:", err);
    sendRouteError(res, err, "Failed to create income");
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await getTellerTransactionById(id);

    if (!result) {
      return res.status(404).json({ error: "Teller transaction not found" });
    }

    res.json(result);
  } catch (err) {
    console.error("Failed to fetch Teller transaction:", err);
    sendRouteError(res, err, "Failed to fetch Teller transaction");
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

    const result = await matchTellerTransaction(id, expenseId, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to match Teller transaction:", err);
    sendRouteError(res, err, "Failed to match Teller transaction");
  }
});

router.post("/:id/create-expense", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await createExpenseFromTeller(id, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    console.error("Failed to create expense from Teller transaction:", err);
    sendRouteError(res, err, "Failed to create expense from Teller transaction");
  }
});

router.post("/:id/dismiss", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await dismissTellerTransaction(id, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to dismiss Teller transaction:", err);
    sendRouteError(res, err, "Failed to dismiss Teller transaction");
  }
});

router.post("/:id/ignore", async (req, res) => {
  try {
    const id = getValidatedTransactionId(req, res);
    if (!id) return;

    const result = await ignoreTellerTransaction(id, req.body || {});
    res.json(result);
  } catch (err) {
    console.error("Failed to ignore Teller transaction:", err);
    sendRouteError(res, err, "Failed to ignore Teller transaction");
  }
});

module.exports = router;
