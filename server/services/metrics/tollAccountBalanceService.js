const pool = require("../../db");

const SETTINGS_KEY = "metrics.toll_account_balance";

async function getTollAccountBalance(client = pool) {
  const { rows } = await client.query(
    "SELECT value FROM app_settings WHERE key=$1 LIMIT 1",
    [SETTINGS_KEY]
  );
  const value = rows[0]?.value || null;
  const anchorBalance = value == null ? null : Number(value.anchorBalance);
  const reconciledAt = value?.reconciledAt || null;

  if (!Number.isFinite(anchorBalance) || !reconciledAt) {
    return {
      configured: false,
      anchorBalance: null,
      reconciledAt: null,
      fundingAdded: 0,
      tollsDeducted: 0,
      currentBalance: null,
    };
  }

  const [fundingResult, tollResult] = await Promise.all([
    client.query(`SELECT COALESCE(SUM(COALESCE(price,0)+COALESCE(tax,0)),0)::numeric AS total
      FROM expenses
      WHERE created_at > $1::timestamptz
        AND (LOWER(COALESCE(category,''))='tolls' OR LOWER(COALESCE(vendor,'')) LIKE '%hctra%')`, [reconciledAt]),
    client.query(`SELECT COALESCE(SUM(amount),0)::numeric AS total
      FROM toll_charges
      WHERE created_at > $1::timestamptz`, [reconciledAt]),
  ]);
  const fundingAdded = Number(fundingResult.rows[0]?.total || 0);
  const tollsDeducted = Number(tollResult.rows[0]?.total || 0);

  return {
    configured: true,
    anchorBalance,
    reconciledAt,
    fundingAdded,
    tollsDeducted,
    currentBalance: anchorBalance + fundingAdded - tollsDeducted,
  };
}

async function reconcileTollAccountBalance(amount, client = pool) {
  const anchorBalance = Number(amount);
  if (!Number.isFinite(anchorBalance) || anchorBalance < 0) {
    const error = new Error("Toll account balance must be a non-negative number");
    error.status = 400;
    throw error;
  }
  const value = {
    anchorBalance: Math.round(anchorBalance * 100) / 100,
    reconciledAt: new Date().toISOString(),
  };
  await client.query(`INSERT INTO app_settings(key,value,updated_at)
    VALUES($1,$2::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [
    SETTINGS_KEY,
    JSON.stringify(value),
  ]);
  return getTollAccountBalance(client);
}

module.exports = { getTollAccountBalance, reconcileTollAccountBalance };
