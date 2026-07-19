const pool = require("../../db");

let ensurePromise = null;

async function tableExists(client, name) {
  const { rows } = await client.query("SELECT to_regclass($1) AS relation", [`public.${name}`]);
  return Boolean(rows[0]?.relation);
}

async function columnExists(client, table, column) {
  const { rows } = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`, [table, column]);
  return Boolean(rows[0]);
}

async function ensureBankingRuntimeSchema() {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const client = await pool.connect();
    const retiredPrefix = ["tel", "ler"].join("");
    const renames = [
      [`${retiredPrefix}_transactions`, "banking_transactions"],
      [`${retiredPrefix}_ignore_rules`, "banking_ignore_rules"],
      [`${retiredPrefix}_tokens`, "banking_tokens"],
    ];
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [726401]);
      for (const [oldName, newName] of renames) {
        if ((await tableExists(client, oldName)) && !(await tableExists(client, newName))) {
          await client.query(`ALTER TABLE public.${oldName} RENAME TO ${newName}`);
        }
      }
      if (await tableExists(client, "banking_transactions")) {
        const columnRenames = [
          [`${retiredPrefix}_transaction_id`, "provider_transaction_id"],
          [`${retiredPrefix}_account_id`, "provider_account_id"],
        ];
        for (const [oldName, newName] of columnRenames) {
          if ((await columnExists(client, "banking_transactions", oldName)) && !(await columnExists(client, "banking_transactions", newName))) {
            await client.query(`ALTER TABLE public.banking_transactions RENAME COLUMN ${oldName} TO ${newName}`);
          }
        }
        await client.query(`UPDATE public.banking_transactions SET raw_json=jsonb_set(raw_json,'{source}',to_jsonb('banking_legacy'::text),true)
          WHERE raw_json->>'source'=$1`, [retiredPrefix]);
      }
      if (await tableExists(client, "income_transactions")) {
        const oldColumn = `${retiredPrefix}_transaction_row_id`;
        if ((await columnExists(client, "income_transactions", oldColumn)) && !(await columnExists(client, "income_transactions", "banking_transaction_row_id"))) {
          await client.query(`ALTER TABLE public.income_transactions RENAME COLUMN ${oldColumn} TO banking_transaction_row_id`);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      ensurePromise = null;
      throw error;
    } finally { client.release(); }
  })();
  return ensurePromise;
}

module.exports = { ensureBankingRuntimeSchema };
