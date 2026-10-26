import { useEffect, useState } from 'react';

function dateTime(value) {
  return new Date(value).toLocaleString('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

export default function TripReturnAudit({ tripId, open }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !tripId) return;
    const controller = new AbortController();
    setEntries([]); setLoading(true); setError('');
    fetch(`${import.meta.env.VITE_API_BASE_URL || ''}/api/trip-summaries/${tripId}/return-audit`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Could not load return audit log');
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid return audit response');
        if (!controller.signal.aborted) setEntries(data);
      }).catch(caught => { if (!controller.signal.aborted) setError(caught.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tripId, open]);
  if (!tripId) return null;
  return <section className="trip-summary-drawer-section">
    <div className="trip-summary-drawer-section-title">Return audit log</div>
    {loading ? <p>Loading return history…</p> : error ? <p role="alert">{error}</p> : entries.length === 0
      ? <p>No recorded return observation. The scheduled trip end is not a recorded arrival.</p>
      : entries.map(entry => <article key={entry.id}>
        <strong>{entry.source.startsWith('telemetry:') ? 'Return location arrival detected' : 'Vehicle return recorded'}</strong>
        <p><time dateTime={entry.occurred_at}>{dateTime(entry.occurred_at)}</time>
          {entry.location ? ` · ${entry.location}` : ' · Location not recorded'}</p>
        <p>Source: {entry.source === 'turo_notification' ? 'Turo return notification' : entry.source}.
          {entry.distance_miles != null ? ` ${Number(entry.distance_miles).toFixed(2)} mi from the return location.` : ''}
          {entry.late_minutes != null ? Number(entry.late_minutes) > 0 ? ` ${entry.late_minutes} min late.` : ' On time.' : ''}</p>
        <small>Logged {dateTime(entry.recorded_at)}{entry.is_backfilled ? ' · Preserved from an existing return record' : ''}</small>
      </article>)}
  </section>;
}
