const pool = require("../../db");
const { EventEmitter } = require("events");

const MESSAGE_ID = "system:banking-reconciliation";
const noticeEvents = new EventEmitter();

function onBankingReconciliationNoticeChanged(listener) {
  noticeEvents.on("changed", listener);
  return () => noticeEvents.off("changed", listener);
}

async function refreshBankingReconciliationNotice({ reopen = false } = {}) {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count
    FROM banking_transactions
    WHERE review_status='pending' AND ignored=FALSE`);
  const pending = Number(rows[0]?.count || 0);

  if (pending === 0) {
    const deleted = await pool.query("DELETE FROM messages WHERE message_id=$1", [MESSAGE_ID]);
    if (deleted.rowCount > 0) noticeEvents.emit("changed", { pending: 0, removed: true });
    return 0;
  }

  const subject = pending === 1
    ? "1 transaction is pending reconciliation"
    : `${pending} transactions are pending reconciliation`;
  const result = await pool.query(`INSERT INTO messages
      (message_id,subject,status,mailbox,from_header,message_timestamp,text_body,normalized_text_body,message_type)
    VALUES($1,$2,'unread','system','Denmark automation',NOW(),$2,$2,'banking_reconciliation_required')
    ON CONFLICT(message_id) DO UPDATE SET
      subject=EXCLUDED.subject,
      text_body=EXCLUDED.text_body,
      normalized_text_body=EXCLUDED.normalized_text_body,
      message_timestamp=CASE WHEN $3::boolean THEN NOW() ELSE messages.message_timestamp END,
      status=CASE WHEN $3::boolean THEN 'unread' ELSE messages.status END
    WHERE messages.subject IS DISTINCT FROM EXCLUDED.subject
       OR messages.text_body IS DISTINCT FROM EXCLUDED.text_body
       OR ($3::boolean AND messages.status IS DISTINCT FROM 'unread')`,
    [MESSAGE_ID, subject, reopen]);
  if (result.rowCount > 0) noticeEvents.emit("changed", { pending, removed: false });
  return pending;
}

module.exports = {
  refreshBankingReconciliationNotice,
  onBankingReconciliationNoticeChanged,
};
