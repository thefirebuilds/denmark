const pool = require("../../db");

const MESSAGE_ID = "system:banking-reconciliation";

async function refreshBankingReconciliationNotice({ reopen = false } = {}) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count
    FROM banking_transactions
    WHERE review_status='pending' AND ignored=FALSE`);
  const pending = Number(rows[0]?.count || 0);

  if (pending === 0) {
    await pool.query("UPDATE messages SET status='read' WHERE message_id=$1", [MESSAGE_ID]);
    return 0;
  }

  const subject = pending === 1
    ? "1 transaction is pending reconciliation"
    : `${pending} transactions are pending reconciliation`;
  await pool.query(`INSERT INTO messages
      (message_id,subject,status,mailbox,from_header,message_timestamp,text_body,normalized_text_body,message_type)
    VALUES($1,$2,'unread','system','Denmark automation',NOW(),$2,$2,'banking_reconciliation_required')
    ON CONFLICT(message_id) DO UPDATE SET
      subject=EXCLUDED.subject,
      text_body=EXCLUDED.text_body,
      normalized_text_body=EXCLUDED.normalized_text_body,
      message_timestamp=CASE WHEN $3::boolean THEN NOW() ELSE messages.message_timestamp END,
      status=CASE WHEN $3::boolean THEN 'unread' ELSE messages.status END`,
    [MESSAGE_ID, subject, reopen]);
  return pending;
}

module.exports = { refreshBankingReconciliationNotice };
