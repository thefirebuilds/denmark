const axios = require("axios");
const pool = require("../../db");
const { encrypt, decrypt } = require("../googleCalendar/tokenCrypto");
const { getPlaidSettings, TRANSACTION_INTERVAL_HOURS, BALANCE_INTERVAL_HOURS } = require("./plaidSettings");
const { BANKING_INGESTION_START_DATE, isWithinBankingIngestionWindow } = require("../banking/bankingIngestionPolicy");
const { getPlaidWebhookUrl, getPlaidWebhookStatus } = require("./plaidWebhook");

let schemaPromise;
async function ensureSchema() {
  if (!schemaPromise) schemaPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id bigserial PRIMARY KEY, item_id text UNIQUE NOT NULL, access_token_encrypted text NOT NULL,
      institution_id text, institution_name text, cursor text,
      transactions_last_attempt_at timestamptz, transactions_last_success_at timestamptz,
      balance_last_attempt_at timestamptz, balance_last_success_at timestamptz,
      last_error jsonb, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS plaid_accounts (
      account_id text PRIMARY KEY, item_id text NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
      name text, official_name text, mask text, type text, subtype text,
      current_balance numeric, available_balance numeric, credit_limit numeric, iso_currency_code text,
      balance_fetched_at timestamptz, updated_at timestamptz NOT NULL DEFAULT NOW()
    );`);
  return schemaPromise;
}

function apiError(error) {
  const data = error?.response?.data;
  const err = new Error(data?.error_message || data?.display_message || error.message || "Plaid request failed");
  err.status = error?.response?.status || 502;
  err.code = data?.error_code;
  err.details = data;
  return err;
}
async function call(path, body = {}) {
  const settings = await getPlaidSettings();
  if (!settings.clientId || !settings.secret) throw Object.assign(new Error("Save Plaid Client ID and secret first"), { status: 400 });
  try {
    const { data } = await axios.post(`https://${settings.environment}.plaid.com${path}`,
      { client_id: settings.clientId, secret: settings.secret, ...body }, { timeout: 45000 });
    return data;
  } catch (error) { throw apiError(error); }
}

async function createLinkToken(userId, itemId = null) {
  await ensureSchema();
  const body = { client_name: "Denmark", language: "en", country_codes: ["US"],
    user: { client_user_id: String(userId || "denmark-owner") } };
  if (itemId) {
    const { rows } = await pool.query("SELECT access_token_encrypted FROM plaid_items WHERE item_id=$1", [itemId]);
    if (!rows[0]) throw Object.assign(new Error("Plaid Item not found"), { status: 404 });
    body.access_token = decrypt(rows[0].access_token_encrypted);
  } else {
    body.products = ["transactions"];
    body.transactions = { days_requested: 30 };
    const webhook = await getPlaidWebhookUrl();
    if (webhook) body.webhook = webhook;
  }
  return call("/link/token/create", body);
}

async function savePublicToken(publicToken, metadata = {}) {
  await ensureSchema();
  const exchanged = await call("/item/public_token/exchange", { public_token: publicToken });
  const institution = metadata.institution || {};
  await pool.query(`INSERT INTO plaid_items (item_id,access_token_encrypted,institution_id,institution_name,updated_at)
    VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT(item_id) DO UPDATE SET access_token_encrypted=EXCLUDED.access_token_encrypted,
    institution_id=COALESCE(EXCLUDED.institution_id,plaid_items.institution_id), institution_name=COALESCE(EXCLUDED.institution_name,plaid_items.institution_name), updated_at=NOW()`,
    [exchanged.item_id, encrypt(exchanged.access_token), institution.institution_id || metadata.institution_id || null,
      institution.name || metadata.institution_name || null]);
  return { itemId: exchanged.item_id };
}

async function createSandboxItem() {
  const settings = await getPlaidSettings();
  if (settings.environment !== "sandbox") throw Object.assign(new Error("Sandbox test Items can only be created in Sandbox"), { status: 400 });
  const webhook = await getPlaidWebhookUrl();
  const token = await call("/sandbox/public_token/create", { institution_id: "ins_109508", initial_products: ["transactions"],
    options: { override_username: "user_transactions_dynamic", override_password: "pass_good", ...(webhook ? { webhook } : {}) } });
  return savePublicToken(token.public_token, { institution_id: "ins_109508", institution_name: "First Platypus Bank (Sandbox)" });
}

async function claimGate(kind, hours, environment) {
  if (environment === "sandbox") return { allowed: true, sandbox: true };
  const key = `integrations.plaid.${kind}_gate`;
  const result = await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES($1,jsonb_build_object('claimedAt',NOW()),NOW())
    ON CONFLICT(key) DO UPDATE SET value=jsonb_build_object('claimedAt',NOW()),updated_at=NOW()
    WHERE app_settings.updated_at <= NOW() - ($2 * interval '1 hour') RETURNING updated_at`, [key, hours]);
  if (result.rowCount) return { allowed: true };
  const prior = await pool.query("SELECT updated_at FROM app_settings WHERE key=$1", [key]);
  return { allowed: false, nextAllowedAt: new Date(new Date(prior.rows[0].updated_at).getTime() + hours*3600000).toISOString() };
}

function normalizedAmount(tx) { const amount = Number(tx.amount); return Number.isFinite(amount) ? -amount : 0; }
function findIgnoreReason(description,rules){const text=String(description||"").trim().toLowerCase();for(const rule of rules){const value=String(rule.match_value||"").trim().toLowerCase();if((rule.match_type==="exact"&&text===value)||(rule.match_type==="contains"&&text.includes(value)))return rule.reason||"Ignored by rule";}return null;}
async function upsertTransaction(tx, account, institutionName, ignoreRules=[]) {
  const transactionDate=tx.authorized_date || tx.date;
  if(!isWithinBankingIngestionWindow(transactionDate))return {inserted:false,beforeCutoff:true};
  const description=tx.merchant_name || tx.name || "Plaid transaction";
  const ignoreReason=findIgnoreReason(description,ignoreRules);
  const raw = { ...tx, source: "plaid", institution: institutionName || null,
    account: account ? { id: account.account_id, name: account.name, official_name: account.official_name, mask: account.mask, type: account.type, subtype: account.subtype } : null };
  const result = await pool.query(`INSERT INTO banking_transactions
    (provider_transaction_id,provider_account_id,transaction_date,description,amount,transaction_type,status,counterparty_name,category,raw_json,ignored,ignore_reason,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,NOW()) ON CONFLICT(provider_transaction_id) DO UPDATE SET
    provider_account_id=EXCLUDED.provider_account_id,transaction_date=EXCLUDED.transaction_date,description=EXCLUDED.description,
    amount=EXCLUDED.amount,transaction_type=EXCLUDED.transaction_type,status=EXCLUDED.status,counterparty_name=EXCLUDED.counterparty_name,
    category=EXCLUDED.category,raw_json=EXCLUDED.raw_json,ignored=EXCLUDED.ignored,ignore_reason=EXCLUDED.ignore_reason,updated_at=NOW() RETURNING (xmax=0) AS inserted`,
    [`plaid:${tx.transaction_id}`, `plaid:${tx.account_id}`, tx.authorized_date || tx.date,
      description, normalizedAmount(tx),tx.payment_channel||null, tx.pending ? "pending" : "posted",tx.merchant_name||null,
      tx.personal_finance_category?.primary||null,JSON.stringify(raw),Boolean(ignoreReason),ignoreReason]);
  return {inserted:result.rows[0]?.inserted === true,beforeCutoff:false};
}

async function syncTransactions({ reason = "manual" } = {}) {
  await ensureSchema();
  const settings = await getPlaidSettings();
  const { rows: items } = await pool.query("SELECT * FROM plaid_items ORDER BY id");
  if (!items.length) return { skipped: true, reason: "no_items", items: 0, fetched: 0, inserted: 0 };
  const gate = await claimGate("transactions", TRANSACTION_INTERVAL_HOURS, settings.environment);
  if (!gate.allowed) return { skipped: true, reason: "production_rate_guard", nextAllowedAt: gate.nextAllowedAt, fetched: 0, inserted: 0 };
  let fetched=0, inserted=0, modified=0, removed=0, skippedBeforeCutoff=0;
  const ignoreRules=(await pool.query("SELECT match_type,match_value,reason FROM banking_ignore_rules WHERE is_active=TRUE")).rows;
  for (const item of items) {
    await pool.query("UPDATE plaid_items SET transactions_last_attempt_at=NOW(),updated_at=NOW() WHERE item_id=$1", [item.item_id]);
    try {
      const token = decrypt(item.access_token_encrypted); const startingCursor=item.cursor || null;
      let cursor=startingCursor, hasMore=true, pages=[], mutationRetries=0;
      while(hasMore) { try { const data=await call("/transactions/sync", { access_token: token, cursor, count: 500,
          options: { include_original_description: true, personal_finance_category_version: "v2" } });
          pages.push(data); cursor=data.next_cursor; hasMore=Boolean(data.has_more);
        } catch(error) { if(error.code==="TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"&&mutationRetries<2){mutationRetries++;cursor=startingCursor;hasMore=true;pages=[];continue;}throw error; } }
      const accountsData=await call("/accounts/get", { access_token: token });
      const accountMap=new Map((accountsData.accounts||[]).map(a=>[a.account_id,a]));
      for(const page of pages) { for(const tx of [...(page.added||[]),...(page.modified||[])]) {
          const saved=await upsertTransaction(tx,accountMap.get(tx.account_id),item.institution_name,ignoreRules); fetched++; if(saved.inserted)inserted++;if(saved.beforeCutoff)skippedBeforeCutoff++;
        } modified += (page.modified||[]).length;
        for(const tx of page.removed||[]) { const result=await pool.query("DELETE FROM banking_transactions WHERE provider_transaction_id=$1 AND review_status='pending'", [`plaid:${tx.transaction_id}`]); removed+=result.rowCount; }
      }
      await pool.query("UPDATE plaid_items SET cursor=$2,transactions_last_success_at=NOW(),last_error=NULL,updated_at=NOW() WHERE item_id=$1", [item.item_id,cursor]);
    } catch(error) {
      await pool.query("UPDATE plaid_items SET last_error=$2::jsonb,updated_at=NOW() WHERE item_id=$1", [item.item_id,JSON.stringify({at:new Date().toISOString(),code:error.code||null,message:error.message})]);
      await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES('integrations.plaid.sync_status',$1::jsonb,NOW())
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[JSON.stringify({status:"error",lastCheckedAt:new Date().toISOString(),errors:[{itemId:item.item_id,institution:item.institution_name,code:error.code||null,message:error.message,reconnectRequired:error.code==="ITEM_LOGIN_REQUIRED"}]})]);
      throw error;
    }
  }
  const result={ skipped:false, sandbox:settings.environment==="sandbox", items:items.length,fetched,inserted,modified,removed,skippedBeforeCutoff,ingestionStartDate:BANKING_INGESTION_START_DATE };
  await pool.query(`INSERT INTO app_settings(key,value,updated_at) VALUES('integrations.plaid.sync_status',$1::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[JSON.stringify({status:"ok",lastCheckedAt:new Date().toISOString(),...result})]);
  console.log(`[plaid] transactions done | reason=${reason} items=${items.length} fetched=${fetched} inserted=${inserted} skippedBeforeCutoff=${skippedBeforeCutoff} ingestionStart=${BANKING_INGESTION_START_DATE}`);
  return result;
}

async function refreshBalances() {
  await ensureSchema(); const settings=await getPlaidSettings();
  const {rows:items}=await pool.query("SELECT * FROM plaid_items ORDER BY id");
  if(!items.length)return {skipped:true,reason:"no_items",accounts:[],fetchedAt:null};
  const gate=await claimGate("balances", BALANCE_INTERVAL_HOURS, settings.environment);
  if (!gate.allowed) return { skipped:true,reason:"production_rate_guard",nextAllowedAt:gate.nextAllowedAt,...await getCachedBalances() };
  let accounts=0;
  for(const item of items){ await pool.query("UPDATE plaid_items SET balance_last_attempt_at=NOW() WHERE item_id=$1",[item.item_id]);
    const data=await call("/accounts/balance/get",{access_token:decrypt(item.access_token_encrypted)});
    for(const a of data.accounts||[]){accounts++; await pool.query(`INSERT INTO plaid_accounts
      (account_id,item_id,name,official_name,mask,type,subtype,current_balance,available_balance,credit_limit,iso_currency_code,balance_fetched_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW()) ON CONFLICT(account_id) DO UPDATE SET
      name=EXCLUDED.name,official_name=EXCLUDED.official_name,mask=EXCLUDED.mask,type=EXCLUDED.type,subtype=EXCLUDED.subtype,
      current_balance=EXCLUDED.current_balance,available_balance=EXCLUDED.available_balance,credit_limit=EXCLUDED.credit_limit,
      iso_currency_code=EXCLUDED.iso_currency_code,balance_fetched_at=NOW(),updated_at=NOW()`,[a.account_id,item.item_id,a.name,a.official_name,a.mask,a.type,a.subtype,a.balances?.current,a.balances?.available,a.balances?.limit,a.balances?.iso_currency_code]);}
    await pool.query("UPDATE plaid_items SET balance_last_success_at=NOW(),last_error=NULL,updated_at=NOW() WHERE item_id=$1",[item.item_id]); }
  return {skipped:false,accounts,...await getCachedBalances()};
}
async function getCachedBalances(){await ensureSchema();const {rows}=await pool.query("SELECT * FROM plaid_accounts ORDER BY name");return {accounts:rows,fetchedAt:rows.reduce((v,r)=>!v||r.balance_fetched_at>v?r.balance_fetched_at:v,null)};}
async function getCiti4483BalanceSummary(){
  const settings=await getPlaidSettings();
  await refreshBalances();
  const cached=await getCachedBalances();
  const a=cached.accounts.find(x=>x.mask==="4483"&&x.type==="credit");
  if(!a)return {configured:Boolean(settings.clientId&&settings.secret),found:false,currentBalance:null,availableBalance:null,debtBalance:null,lastFour:"4483",balanceSource:"plaid_weekly_anchor",fetchedAt:null};
  const deltaResult=await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric AS normalized_delta
    FROM banking_transactions WHERE provider_account_id=$1 AND created_at > $2`,[`plaid:${a.account_id}`,a.balance_fetched_at]);
  const normalizedDelta=Number(deltaResult.rows[0]?.normalized_delta||0);
  // Imported expenses are negative and payments/refunds are positive. Subtracting
  // that normalized activity advances Plaid's positive credit-card debt balance.
  const currentBalance=Number(a.current_balance)-normalizedDelta;
  const creditLimit=a.credit_limit==null?null:Number(a.credit_limit);
  const availableBalance=creditLimit==null
    ? (a.available_balance==null?null:Number(a.available_balance)+normalizedDelta)
    : Math.max(0,creditLimit-currentBalance);
  return {configured:Boolean(settings.clientId&&settings.secret),found:true,currentBalance,availableBalance,
    debtBalance:Math.max(0,currentBalance),lastFour:"4483",balanceSource:"plaid_weekly_anchor_plus_transactions",
    fetchedAt:a.balance_fetched_at||null,calculatedAt:new Date().toISOString(),transactionDelta:normalizedDelta};
}
async function getSummary(){await ensureSchema();const settings=await getPlaidSettings();const items=await pool.query(`SELECT item_id,institution_id,institution_name,created_at,transactions_last_attempt_at,transactions_last_success_at,balance_last_success_at,last_error FROM plaid_items ORDER BY created_at DESC`);const latest=await pool.query("SELECT MAX(transaction_date) latest FROM banking_transactions WHERE raw_json->>'source'='plaid'");return {environment:settings.environment,configured:Boolean(settings.clientId&&settings.secret),items:items.rows,latestTransaction:latest.rows[0]?.latest||null,transactionIntervalHours:TRANSACTION_INTERVAL_HOURS,balanceIntervalHours:BALANCE_INTERVAL_HOURS,ingestionStartDate:BANKING_INGESTION_START_DATE,webhook:await getPlaidWebhookStatus()};}
async function configureItemWebhook(itemId){await ensureSchema();const {rows}=await pool.query("SELECT access_token_encrypted FROM plaid_items WHERE item_id=$1",[itemId]);if(!rows[0])throw Object.assign(new Error("Plaid Item not found"),{status:404});const webhook=await getPlaidWebhookUrl();if(!webhook)throw Object.assign(new Error("Configure Denmark's public base URL in Settings first"),{status:400});return call("/item/webhook/update",{access_token:decrypt(rows[0].access_token_encrypted),webhook});}
async function fireSandboxWebhook(itemId){const settings=await getPlaidSettings();if(settings.environment!=="sandbox")throw Object.assign(new Error("Webhook test is available only in Sandbox"),{status:400});await configureItemWebhook(itemId);const {rows}=await pool.query("SELECT access_token_encrypted FROM plaid_items WHERE item_id=$1",[itemId]);return call("/sandbox/item/fire_webhook",{access_token:decrypt(rows[0].access_token_encrypted),webhook_type:"TRANSACTIONS",webhook_code:"SYNC_UPDATES_AVAILABLE"});}
async function removeItem(itemId){await ensureSchema();const {rows}=await pool.query("SELECT access_token_encrypted FROM plaid_items WHERE item_id=$1",[itemId]);if(!rows[0])throw Object.assign(new Error("Plaid Item not found"),{status:404});await call("/item/remove",{access_token:decrypt(rows[0].access_token_encrypted)});await pool.query("DELETE FROM plaid_items WHERE item_id=$1",[itemId]);return {removed:true,itemId};}

module.exports={createLinkToken,savePublicToken,createSandboxItem,syncTransactions,refreshBalances,getCachedBalances,getCiti4483BalanceSummary,getSummary,removeItem,configureItemWebhook,fireSandboxWebhook,ensureSchema};
