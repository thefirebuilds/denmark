import { useState } from 'react';
const base = `${import.meta.env.VITE_API_BASE_URL || ''}/api/messages`;
async function request(path, method = 'GET', body) {
  const response = await fetch(`${base}/${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function GuestReplyComposer({ messageKey, context }) {
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [category, setCategory] = useState('general');
  const [guidance, setGuidance] = useState('');
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function run(action) {
    setBusy(true); setNotice('');
    try { await action(); } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  const guestMessage = context.latestMessage || context.messages?.at(-1)?.text || context.subject || '';
  return <div className="message-guest-reply" onClick={event => event.stopPropagation()}>
    <button className="message-action" type="button" onClick={() => setOpen(!open)}>
      {open ? 'Hide reply editor' : 'Draft a reply'}
    </button>
    {open && <>
      <label>Message type <input value={category} maxLength={100}
        onChange={event => setCategory(event.target.value)} placeholder="Pickup, tolls, extension…" /></label>
      <label>Guidance for this reply
        <textarea rows={2} maxLength={2000} value={guidance} onChange={event => setGuidance(event.target.value)}
          placeholder="Details to include, exceptions, or the tone you want" style={{ width: '100%' }} />
      </label>
      <button type="button" className="message-action" disabled={busy} onClick={() => run(async () => {
        const data = await request('guest-reply-suggestion', 'POST', { ...context, category, guidance });
        setReply(data.suggestion);
      })}>{busy ? 'Working…' : reply ? 'Regenerate reply' : 'Suggest reply'}</button>
      <label>Reply — edit or write your own
        <textarea rows={6} maxLength={6000} value={reply} onChange={event => setReply(event.target.value)}
          style={{ width: '100%' }} />
      </label>
      <div className="message-guest-reply-actions">
        <button type="button" disabled={!reply.trim() || busy} onClick={() => run(async () => {
          await navigator.clipboard.writeText(reply); setNotice('Copied.');
        })}>Copy reply</button>
        <button type="button" disabled={!reply.trim() || !category.trim() || busy} onClick={() => run(async () => {
          await request('guest-reply-examples', 'POST', { messageKey: String(messageKey), category,
            guestMessage: guestMessage.slice(0, 4000), reply });
          if (profile) setProfile(await request('guest-reply-profile'));
          setNotice('Saved as an approved example for future suggestions. Not sent to the guest.');
        })}>Save approved reply</button>
      </div>
      <button type="button" className="message-action" disabled={busy} onClick={() => run(async () => {
        setProfile(profile ? null : await request('guest-reply-profile'));
      })}>{profile ? 'Hide response profile' : 'Response profile & saved replies'}</button>
      {profile && <section>
        <label>Guidance for all replies
          <textarea rows={5} maxLength={6000} value={profile.guidance}
            onChange={event => setProfile({ ...profile, guidance: event.target.value })}
            placeholder="Your voice, pickup instructions, business policies, and details guests should know"
            style={{ width: '100%' }} />
        </label>
        <button type="button" disabled={busy} onClick={() => run(async () => {
          await request('guest-reply-profile', 'PUT', { guidance: profile.guidance });
          setNotice('Response profile saved.');
        })}>Save response profile</button>
        <p>Recent approved replies. Saving does not call AI or send a guest message.</p>
        {profile.examples.map(example => <details key={example.id}>
          <summary>{example.category} — {example.guest_message.slice(0, 90)}</summary>
          <p style={{ whiteSpace: 'pre-wrap' }}>{example.reply}</p>
          <button type="button" disabled={busy} onClick={() => { setReply(example.reply); setCategory(example.category); }}>Use in editor</button>
          <button type="button" disabled={busy} onClick={() => run(async () => {
            await request(`guest-reply-examples/${example.id}`, 'DELETE');
            setProfile(await request('guest-reply-profile'));
            setNotice('Example removed from future suggestions.');
          })}>Remove example</button>
        </details>)}
      </section>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
