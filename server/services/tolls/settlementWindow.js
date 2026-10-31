const pool = require('../../db');

const QUIET_HOURS = 48;
let policyCache = null;
let policyCachedAt = 0;
// First-seen time measures when Denmark actually received the charge. Exclude
// old backfill imports from the learning sample, not from the trip's quiet hold.
const POLICY_SQL = `WITH samples AS (
  SELECT EXTRACT(EPOCH FROM (GREATEST(created_at, COALESCE(posted_at, created_at)) - trxn_at)) / 3600.0 AS hours
  FROM toll_charges WHERE source = 'hctra_eztag'
    AND created_at >= NOW() - INTERVAL '90 days'
    AND GREATEST(created_at, COALESCE(posted_at, created_at)) >= trxn_at
    AND GREATEST(created_at, COALESCE(posted_at, created_at)) <= trxn_at + INTERVAL '30 days'
), learned AS (
  SELECT COUNT(*)::int AS sample_count, percentile_cont(0.99) WITHIN GROUP (ORDER BY hours) AS p99_hours FROM samples
)
SELECT CASE WHEN sample_count >= 20 THEN GREATEST(100, CEIL(p99_hours + 24)::integer) ELSE 100 END AS delay_hours,
  sample_count, p99_hours,
  (SELECT MAX(finished_at) FROM toll_sync_runs WHERE source = 'hctra_eztag' AND status = 'success') AS last_success_at
FROM learned`;

function settlementState(trip, policy, lastArrival, now = new Date()) {
  const end = trip.trip_end ? new Date(trip.trip_end).getTime() : NaN;
  const arrival = lastArrival ? new Date(lastArrival).getTime() : NaN;
  const delayHours = Number(policy.delay_hours) || 100;
  const due = Number.isFinite(end) ? Math.max(end + delayHours * 3600000,
    Number.isFinite(arrival) ? arrival + QUIET_HOURS * 3600000 : 0) : NaN;
  const sync = policy.last_success_at ? new Date(policy.last_success_at).getTime() : NaN;
  const nowMs = new Date(now).getTime();
  const windowElapsed = Number.isFinite(due) && nowMs >= due;
  const syncCoversWindow = Number.isFinite(sync) && sync >= due && sync >= nowMs - 24 * 3600000;
  return {
    toll_collection_wait_hours: delayHours,
    toll_collection_due_at: Number.isFinite(due) ? new Date(due).toISOString() : null,
    toll_collection_ready: windowElapsed && syncCoversWindow,
    toll_collection_hold_reason: !Number.isFinite(due) ? 'Trip end date is missing'
      : !windowElapsed ? 'Waiting for HCTRA toll arrivals to settle'
      : !syncCoversWindow ? 'Waiting for a successful HCTRA sync after the collection window' : null,
    toll_collection_sample_count: Number(policy.sample_count || 0),
    toll_collection_quiet_hours: QUIET_HOURS,
    toll_last_arrival_at: lastArrival || null,
    toll_last_successful_sync_at: policy.last_success_at || null,
  };
}

async function attachTollSettlement(trips, client = pool) {
  if (!trips.length) return [];
  let policy = client === pool && Date.now() - policyCachedAt < 60000 ? policyCache : null;
  if (!policy) {
    policy = (await client.query(POLICY_SQL)).rows[0] || {};
    if (client === pool) { policyCache = policy; policyCachedAt = Date.now(); }
  }
  const ids = trips.map(trip => Number(trip.id)).filter(Number.isSafeInteger);
  const arrivals = await client.query(`SELECT matched_trip_id, MAX(created_at) AS last_arrival
    FROM toll_charges WHERE matched_trip_id = ANY($1::bigint[]) AND source = 'hctra_eztag'
    GROUP BY matched_trip_id`, [ids]);
  const byTrip = new Map(arrivals.rows.map(row => [Number(row.matched_trip_id), row.last_arrival]));
  return trips.map(trip => ({ ...trip, ...settlementState(trip, policy, byTrip.get(Number(trip.id))) }));
}

async function assertTollsSettled(trip, client = pool) {
  if (trip.status === 'canceled' || trip.workflow_stage === 'canceled' || trip.canceled_at) return;
  const [state] = await attachTollSettlement([trip], client);
  if (!state.toll_collection_ready) {
    throw Object.assign(new Error(`${state.toll_collection_hold_reason}. Billing/closeout is on hold${state.toll_collection_due_at ? ` until at least ${state.toll_collection_due_at}` : ''}.`), { statusCode: 409 });
  }
}

module.exports = { POLICY_SQL, QUIET_HOURS, settlementState, attachTollSettlement, assertTollsSettled };
