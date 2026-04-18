// ------------------------------------------------------------
// /server/routes/expenses.js
// API routes for expense CRUD and reporting/filtering.
// Endpoints:
//   GET / - List expenses
//   GET /summary - Get expense summary
//   GET /suggestions - Get distinct vendor/category suggestions
//   GET /capital-basis - Get onboarding/capital-basis breakdown by vehicle/category
//   GET /:id - Get expense by ID
//   POST / - Create expense
//   PUT /:id - Update expense
//   DELETE /:id - Delete expense
// ------------------------------------------------------------

const express = require("express");
const {
  listExpenses,
  getExpenseById,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
  getExpenseSuggestions,
  getCapitalBasisBreakdown,
} = require("../services/expenses/expenseService");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const result = await listExpenses(req.query);
    res.json(result);
  } catch (err) {
    console.error("Failed to list expenses:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to list expenses",
    });
  }
});

router.get("/summary", async (req, res) => {
  try {
    const result = await getExpenseSummary(req.query);
    res.json(result);
  } catch (err) {
    console.error("Failed to summarize expenses:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to summarize expenses",
    });
  }
});

router.get("/suggestions", async (req, res) => {
  try {
    const result = await getExpenseSuggestions();
    res.json(result);
  } catch (err) {
    console.error("Failed to load expense suggestions:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to load expense suggestions",
    });
  }
});

/**
 * Capital basis breakdown
 *
 * Query params:
 *   vehicle_id=123                 optional single vehicle filter
 *   category=Vehicle Onboard       optional category filter, defaults to Vehicle Onboard
 *   include_line_items=true        optional, include raw expense rows in response
 *   include_purchase_price=true    optional, include vehicle acquisition_cost if available
 *
 * Example:
 *   /api/expenses/capital-basis
 *   /api/expenses/capital-basis?vehicle_id=6
 *   /api/expenses/capital-basis?include_line_items=true
 *   /api/expenses/capital-basis?category=Vehicle%20Onboard
 */
router.get("/capital-basis", async (req, res) => {
  try {
    const result = await getCapitalBasisBreakdown(req.query);
    res.json(result);
  } catch (err) {
    console.error("Failed to load capital basis breakdown:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to load capital basis breakdown",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const numericId = Number(req.params.id);

    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ error: "Invalid expense id" });
    }

    const expense = await getExpenseById(numericId);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json(expense);
  } catch (err) {
    console.error("Failed to fetch expense:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to fetch expense",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const expense = await createExpense(req.body || {});
    res.status(201).json(expense);
  } catch (err) {
    console.error("Failed to create expense:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to create expense",
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const numericId = Number(req.params.id);

    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ error: "Invalid expense id" });
    }

    const expense = await updateExpense(numericId, req.body || {});
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json(expense);
  } catch (err) {
    console.error("Failed to update expense:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to update expense",
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const numericId = Number(req.params.id);

    if (!Number.isInteger(numericId) || numericId <= 0) {
      return res.status(400).json({ error: "Invalid expense id" });
    }

    const expense = await deleteExpense(numericId);
    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json({ ok: true, deleted: expense });
  } catch (err) {
    console.error("Failed to delete expense:", err);
    res.status(err.status || 500).json({
      error: err.message || "Failed to delete expense",
    });
  }
});

module.exports = router;