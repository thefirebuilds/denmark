const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const pool = require("../db");
const APPLY = process.argv.includes("--apply");
const DELETE_CREATED_EXPENSES = process.argv.includes("--delete-created-expenses");
const KEEP_MASK = "4483";
const TEST_INSTITUTION_ID = "ins_109508";
const CANDIDATE_SQL = "raw_json->>'source' = 'plaid'";

async function preview(client) {
  const { rows: groups } = await client.query(`SELECT
      COALESCE(raw_json->>'institution','(unknown)') AS institution,
      COALESCE(raw_json->'account'->>'mask','(missing)') AS mask,
      provider_account_id,
      COUNT(*)::int AS transactions,
      COUNT(*) FILTER (WHERE matched_expense_id IS NOT NULL)::int AS linked_expenses,
      COUNT(*) FILTER (WHERE match_method='created_from_banking' AND matched_expense_id IS NOT NULL)::int AS created_expenses,
      MIN(transaction_date) AS first_date,
      MAX(transaction_date) AS last_date
    FROM banking_transactions WHERE ${CANDIDATE_SQL}
    GROUP BY 1,2,3 ORDER BY 1,2,3`);
  const { rows: totals } = await client.query(`SELECT COUNT(*)::int AS transactions,
      COUNT(DISTINCT matched_expense_id) FILTER (WHERE matched_expense_id IS NOT NULL)::int AS linked_expenses,
      COUNT(DISTINCT matched_expense_id) FILTER (WHERE match_method='created_from_banking' AND matched_expense_id IS NOT NULL)::int AS created_expenses
    FROM banking_transactions WHERE ${CANDIDATE_SQL}`);
  const { rows: items } = await client.query(`SELECT item_id,institution_id,institution_name,created_at
    FROM plaid_items WHERE institution_id=$1 ORDER BY created_at`, [TEST_INSTITUTION_ID]);
  return { criteria: { source: "plaid", dates: "all", accountMasks: "all" }, totals: totals[0], groups, testItems: items };
}

async function main() {
  const client = await pool.connect();
  try {
    const report = await preview(client);
    console.log(JSON.stringify(report, null, 2));
    if (!APPLY) {
      console.log("\nDRY RUN ONLY. Review every group above. To apply: npm run cleanup:plaid-test-data -- --apply");
      return;
    }
    if (Number(report.totals.created_expenses || 0) > 0 && !DELETE_CREATED_EXPENSES) {
      throw new Error(`Refusing cleanup: ${report.totals.created_expenses} expenses were created from candidate transactions. Re-run with --apply --delete-created-expenses only after reviewing the preview.`);
    }
    await client.query("BEGIN");
    let deletedExpenses = 0;
    if (DELETE_CREATED_EXPENSES) {
      const result = await client.query(`DELETE FROM expenses WHERE id IN (
        SELECT matched_expense_id FROM banking_transactions
        WHERE ${CANDIDATE_SQL} AND match_method='created_from_banking' AND matched_expense_id IS NOT NULL
      )`);
      deletedExpenses = result.rowCount;
    }
    const deletedTransactions = await client.query(`DELETE FROM banking_transactions WHERE ${CANDIDATE_SQL}`);
    const deletedAccounts = await client.query(`DELETE FROM plaid_accounts WHERE COALESCE(mask,'') <> $1`, [KEEP_MASK]);
    const deletedItems = await client.query(`DELETE FROM plaid_items WHERE institution_id=$1`, [TEST_INSTITUTION_ID]);
    const remaining = await client.query(`SELECT COUNT(*)::int AS count FROM banking_transactions WHERE ${CANDIDATE_SQL}`);
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, deletedTransactions: deletedTransactions.rowCount,
      deletedExpenses, deletedCachedAccounts: deletedAccounts.rowCount, deletedTestItems: deletedItems.rowCount,
      remainingPlaidTransactions: remaining.rows[0]?.count || 0 }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    console.error(`[cleanup:plaid-test-data] ${error.message || error}`);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}

void main();
