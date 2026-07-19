const pool = require("../../db");
const { loadAuthPublicUrlSettings } = require("../authPublicUrlSettings");

const STATUS_KEY = "integrations.plaid.webhook_status";
const WEBHOOK_PATH = "/api/webhooks/plaid";

async function getPlaidWebhookUrl() {
  const settings = await loadAuthPublicUrlSettings();
  const base = String(settings.publicBaseUrl || "").replace(/\/+$/, "");
  return base ? `${base}${WEBHOOK_PATH}` : "";
}

function safeDelivery(body = {}) {
  return {
    receivedAt: new Date().toISOString(),
    webhookType: body.webhook_type || null,
    webhookCode: body.webhook_code || null,
    itemId: body.item_id || null,
    errorCode: body.error?.error_code || null,
    newTransactions: Number.isFinite(Number(body.new_transactions)) ? Number(body.new_transactions) : null,
  };
}

async function recordPlaidWebhook(body) {
  const delivery = safeDelivery(body);
  await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`, [STATUS_KEY, JSON.stringify(delivery)]);
  console.log(`[plaid] webhook received | type=${delivery.webhookType || "unknown"} code=${delivery.webhookCode || "unknown"} item=${delivery.itemId || "none"}`);
  return delivery;
}

async function getPlaidWebhookStatus() {
  const [{ rows }, webhookUrl] = await Promise.all([
    pool.query("SELECT value FROM app_settings WHERE key=$1 LIMIT 1", [STATUS_KEY]),
    getPlaidWebhookUrl(),
  ]);
  return { webhookUrl, configured: Boolean(webhookUrl), lastDelivery: rows[0]?.value || null };
}

module.exports = { WEBHOOK_PATH, getPlaidWebhookUrl, recordPlaidWebhook, getPlaidWebhookStatus };
