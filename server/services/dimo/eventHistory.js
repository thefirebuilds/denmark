const { getDimoVehicleAuthHeader } = require('./auth');
const URL = 'https://telemetry-api.dimo.zone/query';
const QUERY = `query TripEvents($tokenId: Int!, $from: Time!, $to: Time!) {
  events(tokenId: $tokenId, from: $from, to: $to) { timestamp name source durationNs metadata }
}`;
const problem = (message, statusCode = 502) => Object.assign(new Error(message), { statusCode, safeIncidentError: true });

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(problem('DIMO event lookup timed out or was canceled. Retry the import.', 504));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function fetchDimoEvents(tokenId, { from, to, signal, fetchImpl = fetch, auth = getDimoVehicleAuthHeader } = {}) {
  const timeout = AbortSignal.timeout(20000);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let authHeader;
  try { authHeader = await abortable(auth(tokenId), bounded); }
  catch (error) {
    if (error.safeIncidentError) throw error;
    throw problem('DIMO vehicle authorization failed. Verify DIMO configuration and vehicle data/location sharing.');
  }
  const response = await fetchImpl(URL, { method: 'POST', signal: bounded,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ query: QUERY, variables: { tokenId: Number(tokenId), from, to } }) });
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel();
    throw problem('DIMO denied event-history access. Verify this vehicle shares non-location data and all-time location with Denmark.', 403);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw problem(`DIMO event history returned HTTP ${response.status}. Retry later; no empty result was recorded.`);
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw problem('DIMO event response exceeded the safe import size. No events from this window were saved.');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('DIMO returned an unreadable event response. No events from this window were saved.'); }
  if (result.errors?.length) {
    // Never forward provider error bodies, JWTs, or query details.
    const denied = /privilege|permission|unauthori[sz]ed|forbidden/i.test(JSON.stringify(result.errors));
    throw problem(denied ? 'DIMO event-history permission is missing. Verify non-location data and all-time location sharing.'
      : 'DIMO could not complete the event-history query. Events may be unavailable; this is not an empty result.', denied ? 403 : 502);
  }
  if (!Array.isArray(result.data?.events)) throw problem('DIMO event history was unavailable, not an empty result.');
  if (result.data.events.length > 2000) throw problem('DIMO returned too many events for one import window. No events from this window were saved.');
  return result.data.events;
}
module.exports = { fetchDimoEvents, QUERY };
