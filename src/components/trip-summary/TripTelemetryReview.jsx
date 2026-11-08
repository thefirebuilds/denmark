import { Fragment, useEffect, useState } from 'react';
import BusinessQuestions from '../BusinessQuestions';
import TripIncidentReview from './TripIncidentReview';
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const initialFilters = { kind: 'snapshots', provider: '', from: '', to: '', minSpeed: '', signal: '' };
const number = (value, unit = '') => value == null || !Number.isFinite(Number(value)) ? '--' : `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit}`;
function timestamp(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short', hour12: false }) : 'Unknown';
}
async function read(path, signal) {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Telemetry request failed (${res.status})`);
  return data;
}
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function TripTelemetryReview({ tripId }) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState(initialFilters);
  const [summary, setSummary] = useState(null);
  const [page, setPage] = useState(null);
  const [cursors, setCursors] = useState([null]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [snapshotId, setSnapshotId] = useState(null);
  const base = `/api/trips/${encodeURIComponent(tripId)}/telemetry-review`;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    read(`${base}/summary`, controller.signal).then(data => { if (!controller.signal.aborted) setSummary(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [open, base]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setSnapshotId(null); setDetail(null);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ kind: filters.kind, limit: '50' });
      for (const key of ['provider', 'signal', 'minSpeed']) if (filters[key] !== '') params.set(key, filters[key]);
      for (const key of ['from', 'to']) if (filters[key]) {
        const date = new Date(filters[key]);
        if (!Number.isFinite(date.getTime())) { setError('Enter a valid date/time.'); setLoading(false); return; }
        params.set(key, date.toISOString());
      }
      const cursor = cursors[cursors.length - 1];
      if (cursor) params.set('before', cursor);
      read(`${base}?${params}`, controller.signal).then(data => { if (!controller.signal.aborted) setPage(data); })
        .catch(err => { if (!controller.signal.aborted) setError(err.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, base, filters, cursors]);
  useEffect(() => {
    if (!open || !snapshotId) return;
    const controller = new AbortController();
    setDetail(null); setDetailLoading(true); setDetailError('');
    read(`${base}/snapshots/${encodeURIComponent(snapshotId)}`, controller.signal)
      .then(data => { if (!controller.signal.aborted) setDetail(data); })
      .catch(err => { if (!controller.signal.aborted) setDetailError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [open, snapshotId, base]);
  function change(key, value) { setFilters(current => ({ ...current, [key]: value })); setCursors([null]); }
  return <section className="trip-telemetry-review">
    <div className="trip-telemetry-heading"><div><h3>Telemetry review</h3><p>Recorded vehicle samples and provider fields for this trip.</p></div>
      <button type="button" className="message-action" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide telemetry' : 'Review telemetry'}</button>
    </div>
    {open && <>
      <div className="trip-telemetry-notice">
        <strong>Impact and aggressive-driving coverage is limited.</strong> Active DIMO vehicles are checked for collision events every 15 minutes. Import other DIMO event history below when needed. Missing flags or events do not establish that no incident occurred. Sparse samples cannot reconstruct a collision, hard braking, or continuous speed.
      </div>
      <p className="trip-telemetry-hint"><a className="message-action" href={`${API_BASE}${base}/export`} download={`trip-${tripId}-all-telemetry.json`}>Export all telemetry (JSON)</a> All stored snapshots, signal values, imported DIMO events and retained raw payloads for this trip, regardless of page or filters.</p>
      <TripIncidentReview key={tripId} tripId={tripId} />
      <details className="trip-telemetry-ai">
        <summary>Ask AI to review possible incident or driving behavior</summary>
        <BusinessQuestions key={`${tripId}-${snapshotId || 'trip'}`} embedded initialQuestion={`Review the stored telemetry JSON for internal trip ID ${tripId}${snapshotId ? `, focusing on snapshot ID ${snapshotId}` : ''}. Does anything indicate a possible accident or inappropriate driving behavior, such as impact/collision flags, hard braking, rapid acceleration, or high speed? Use the trip telemetry tools to inspect the available records and raw payloads. Cite specific fields and observation times in America/Chicago. Separate recorded facts from possible interpretations; do not infer an accident or aggressive driving from sparse samples. Check for stale or outside-trip readings and explain missing data and partial coverage. Missing flags do not prove no incident occurred, and high speed alone does not establish a posted speed-limit violation.`} />
      </details>
      {summary && <>
        <dl className="trip-telemetry-stats">
          <div><dt>Stored snapshots</dt><dd>{number(summary.snapshots)}</dd></div>
          <div><dt>Max sampled speed in trip window</dt><dd>{number(summary.max_sampled_speed_mph, ' mph')}</dd></div>
          <div><dt>Samples at least 80 mph in trip window</dt><dd>{number(summary.samples_at_or_above_80)}</dd></div>
          <div><dt>Recorded trip peak</dt><dd>{number(summary.trip?.max_speed_mph, ' mph')}</dd></div>
        </dl>
        <p className="trip-telemetry-hint">Received: {timestamp(summary.first_received_at)} to {timestamp(summary.last_received_at)}. Providers: {summary.providers.join(', ') || 'None recorded'}. Speed totals include only readings timestamped within the scheduled trip window. Counts are observations, not separate speeding events.</p>
        <p className="trip-telemetry-hint">{summary.association} No posted speed-limit data is available. Date filters use your browser's local time; displayed timestamps use America/Chicago. JSON exports retain UTC offsets.</p>
      </>}
      <div className="trip-telemetry-filters" onKeyDown={event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault(); }}>
        <label>Records<select aria-label="Records" value={filters.kind} onChange={e => { setFilters({ ...initialFilters, kind: e.target.value }); setCursors([null]); }}><option value="snapshots">All snapshots</option><option value="signals">All signal values</option></select></label>
        <label>Provider<select aria-label="Provider" value={filters.provider} onChange={e => change('provider', e.target.value)}><option value="">All providers</option><option value="bouncie">Bouncie</option><option value="dimo">DIMO</option></select></label>
        <label>Observed from<input type="datetime-local" value={filters.from} onChange={e => change('from', e.target.value)} /></label>
        <label>Observed through<input type="datetime-local" value={filters.to} onChange={e => change('to', e.target.value)} /></label>
        {filters.kind === 'snapshots' ? <label>Minimum speed (mph)<input type="number" min="0" max="400" step="any" value={filters.minSpeed} onChange={e => change('minSpeed', e.target.value)} placeholder="e.g. 80" /></label>
          : <label>Signal name<input value={filters.signal} onChange={e => change('signal', e.target.value)} placeholder="speed, rpm, impact..." /></label>}
        <button type="button" className="message-action" onClick={() => { setFilters(initialFilters); setCursors([null]); }}>Reset</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">Loading stored telemetry...</p> : !error && <>
        <p className="trip-telemetry-hint">Newest received records first. {page?.units} Observation times can repeat across polls; inspect timestamps before drawing conclusions.</p>
        <div className="trip-telemetry-scroll" tabIndex={0} role="region" aria-label="Trip telemetry records">
          <table><thead><tr><th>Observed / received (Central)</th><th>Provider</th><th>{filters.kind === 'signals' ? 'Signal / stored value' : 'Speed / RPM'}</th><th>Details</th></tr></thead>
            <tbody>{page?.data.map(row => <Fragment key={row.id}><tr>
              <td><time>{timestamp(filters.kind === 'snapshots' ? row.speed_observed_at || row.observed_at : row.observed_at)}</time><small>Received {timestamp(row.received_at)}</small>{row.observation_time_source?.includes('fallback') && <small>Observation time uses a fallback, not a confirmed signal timestamp.</small>}{row.reading_within_trip === false && <strong className="trip-telemetry-warning">Reading outside reservation window</strong>}</td>
              <td>{row.service_name}<small>Record #{row.id}</small></td>
              <td>{filters.kind === 'snapshots' ? <>{number(row.speed_mph, ' mph')}<small>{number(row.engine_rpm, ' RPM')}{row.latitude != null ? ` | ${row.latitude}, ${row.longitude}` : ''}</small></>
                : <><strong>{row.signal_name}</strong><pre>{JSON.stringify(row.value_json ?? row.value_numeric ?? row.value_text ?? row.value_boolean)}</pre></>}</td>
              <td><button type="button" className="message-action" onClick={() => setSnapshotId(snapshotId === (row.snapshot_id || row.id) ? null : row.snapshot_id || row.id)}>Inspect snapshot #{row.snapshot_id || row.id}</button></td>
            </tr></Fragment>)}</tbody>
          </table>
          {!page?.data.length && <p>No matching records. This does not establish that no incident occurred.</p>}
        </div>
        <div className="trip-telemetry-actions">
          <button type="button" className="message-action" disabled={cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}>Previous page</button>
          <span>Page {cursors.length} | {page?.data.length || 0} records</span>
          <button type="button" className="message-action" disabled={!page?.has_more} onClick={() => setCursors(current => [...current, page.next_cursor])}>Next page</button>
          <button type="button" className="message-action" disabled={!page?.data.length} onClick={() => download({ summary, filters, page }, `trip-${tripId}-${filters.kind}-page-${cursors.length}.json`)}>Export this page (JSON)</button>
        </div>
      </>}
      {snapshotId && <div className="trip-telemetry-detail">
        <h4>Snapshot #{snapshotId}</h4>
        {detailLoading && <p role="status">Loading retained data...</p>}{detailError && <p role="alert">{detailError}</p>}
        {detail && <>
          <p className="trip-telemetry-hint">{detail.matching_fields_note}</p>
          {detail.matching_fields.length ? <ul>{detail.matching_fields.map(field => <li key={field.field}><strong>{field.field}</strong>: <code>{JSON.stringify(field.value)}</code></li>)}</ul> : <p>No impact/aggressive-driving field names found in this retained payload. This is not evidence of no incident.</p>}
          <details><summary>All stored normalized snapshot fields</summary><p>{detail.snapshot_timestamps_note}</p><pre>{JSON.stringify(detail.snapshot, null, 2)}</pre></details>
          <details><summary>Retained provider payload</summary>{detail.raw_available ? <pre>{JSON.stringify(detail.raw_payload, null, 2)}</pre> : <p>{detail.raw_unavailable_reason}</p>}</details>
          <button type="button" className="message-action" onClick={() => download(detail, `trip-${tripId}-snapshot-${snapshotId}.json`)}>Export snapshot (JSON)</button>
        </>}
      </div>}
    </>}
  </section>;
}
