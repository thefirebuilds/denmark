import { useEffect, useState } from 'react';

export default function ReturnMessageDraft({ message, replyUrl, onDismiss }) {
  const [draft, setDraft] = useState(message.return_message_draft || '');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(message.return_message_draft || ''); setNotice(''); }, [message.id]);

  async function dismiss() {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/messages/return-message/${message.trip_id}/ack`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tripEnd: message.trip_end }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not dismiss reminder');
      onDismiss();
    } catch (error) { setNotice(error.message || 'Could not dismiss reminder'); }
    finally { setBusy(false); }
  }

  return <div className="message-booking-task" onClick={event => event.stopPropagation()}>
    <div className="message-booking-title">Guest return message</div>
    <p>Review and copy this draft, then send it in the guest conversation.</p>
    <label htmlFor={`return-draft-${message.trip_id}`}>Return instructions</label>
    <textarea id={`return-draft-${message.trip_id}`} rows={14} value={draft}
      style={{ width: '100%', boxSizing: 'border-box' }}
      onChange={event => setDraft(event.target.value)} />
    <div className="message-inline-actions">
      <button type="button" className="message-action" disabled={!draft.trim()} onClick={async () => {
        try { await navigator.clipboard.writeText(draft); setNotice('Copied. Paste into the guest conversation to send.'); }
        catch { setNotice('Select and copy the draft text above.'); }
      }}>Copy message</button>
      {replyUrl && <a className="message-action" href={replyUrl} target="_blank" rel="noreferrer">Open guest conversation</a>}
      <button type="button" className="message-action" disabled={busy} onClick={dismiss}>
        {busy ? 'Dismissing…' : 'Dismiss reminder'}
      </button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </div>;
}
