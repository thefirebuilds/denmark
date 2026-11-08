import { useEffect, useRef, useState } from 'react';
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const time = value => new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
const categoryLabels = {
  'behavior.harshBraking': 'Harsh braking',
  'behavior.extremeBraking': 'Extreme braking',
  'behavior.harshAcceleration': 'Harsh acceleration',
  'behavior.harshCornering': 'Harsh cornering',
  'safety.collision': 'Collision detected',
  'security.engineBlock': 'Engine blocked',
  'security.engineUnblock': 'Engine unblocked',
};

function EventCategory({ category, base, version }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(null);
  const [cursors, setCursors] = useState([null]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ event_name: category.event_name });
    if (cursors.at(-1)) params.set('before', cursors.at(-1));
    fetch(`${base}?${params}`, { signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw Error(data.error || 'Could not load event category'); return data; })
      .then(data => { if (!controller.signal.aborted) setPage(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, base, category.event_name, cursors, version]);
  return <details className="trip-incident-category" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary><span>{categoryLabels[category.event_name] || category.event_name}</span><span className="trip-incident-category-count">{category.count.toLocaleString()} {category.count === 1 ? 'event' : 'events'}</span></summary>
    {open && <div className="trip-incident-category-body">
      {loading && <p role="status">Loading category events...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && page && <>
        {page.data.map(event => <details key={event.id}>
          <summary>{time(event.observed_at)}</summary>
          <p className="trip-telemetry-hint">{event.event_name}. Source: {event.source}. Imported {time(event.imported_at)}.</p>
          <pre>{JSON.stringify(event.raw_event, null, 2)}</pre>
        </details>)}
        {!page.data.length && <p>No events on this page.</p>}
        <div className="trip-telemetry-actions">
          <button type="button" className="message-action" disabled={cursors.length === 1} onClick={() => setCursors(c => c.slice(0, -1))}>Previous events</button>
          <span>Page {cursors.length} | {page.data.length} shown of {category.count}</span>
          <button type="button" className="message-action" disabled={!page.has_more} onClick={() => setCursors(c => [...c, page.next_cursor])}>Next events</button>
        </div>
      </>}
    </div>}
  </details>;
}

export default function TripIncidentReview({ tripId }) {
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [version, setVersion] = useState(0);
  const [nextFrom, setNextFrom] = useState(null);
  const request = useRef(null);
  const base = `${API_BASE}/api/trips/${encodeURIComponent(tripId)}/telemetry-review/incidents`;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(base, { signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw Error(data.error || 'Could not load imported incidents'); return data; })
      .then(data => { if (!controller.signal.aborted) setPage(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, version]);

  async function importEvents() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); setProgress('Requesting DIMO event history...');
    let from = nextFrom, windows = 0, received = 0, inserted = 0;
    try {
      while (!controller.signal.aborted) {
        const res = await fetch(`${base}/import`, { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
        const data = await res.json();
        if (controller.signal.aborted) break;
        if (!res.ok) throw Error(data.error || 'DIMO incident import failed');
        windows++; received += data.received; inserted += data.inserted;
        from = data.next_from; setNextFrom(from);
        setProgress(`Checked ${windows} window(s), ${received} provider events returned, ${inserted} new records saved. Through ${time(data.to)}.`);
        setVersion(v => v + 1);
        if (data.complete) break;
        if (!from) throw Error('Import did not supply a continuation time. Review import history before retrying.');
      }
    } catch (err) {
      if (!controller.signal.aborted) { setError(err.message); setVersion(v => v + 1); }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      request.current = null;
    }
  }

  return <section className="trip-telemetry-incidents">
    <h4>DIMO incident and driving events</h4>
    <p className="trip-telemetry-hint">Import provider-reported events for this trip's scheduled window, up to now. Availability depends on the device, DIMO retention and sharing permissions. Events are not independently verified accidents or proof of driver fault. Import requires trip write permission.</p>
    <div className="trip-telemetry-actions">
      <button type="button" className="message-action" disabled={busy || page?.can_import === false} onClick={importEvents}>{busy ? 'Importing DIMO events...' : nextFrom ? 'Resume DIMO incident import' : 'Import DIMO incidents'}</button>
      {busy && <button type="button" className="message-action" onClick={() => { request.current?.abort(); setBusy(false); setProgress('Import stopped. Completed windows remain saved; retry safely without duplicates.'); }}>Stop import</button>}
    </div>
    {progress && <p role="status" className="trip-telemetry-hint">{progress}</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">Loading imported events...</p>}
    {page && <>
      {!page.categories?.length && <p className="trip-telemetry-hint">No imported events. Check the import history below; this does not establish that no incident occurred.</p>}
      {page.categories?.map(category => <EventCategory key={category.event_name} category={category} base={base} version={version} />)}
      <details><summary>Recent import history ({page.imports.length})</summary>
        {!page.imports.length && <p>No DIMO event import has been requested for this trip.</p>}
        {page.imports.map(run => <p key={run.id} className="trip-telemetry-hint">{time(run.window_from)} to {time(run.window_to)}: {run.status}{run.status === 'complete' ? `; ${run.received_count} returned, ${run.inserted_count} new` : ''}{run.error_message ? `; ${run.error_message}` : ''}. Requested {time(run.requested_at)}.</p>)}
      </details>
    </>}
  </section>;
}
