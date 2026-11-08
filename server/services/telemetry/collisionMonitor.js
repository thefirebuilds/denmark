const { normalizeEvents } = require('./tripIncidents');
const { createHash } = require('node:crypto');
const DAY = 24 * 3600000;

async function ensureCollisionMonitorSchema(db = require('../../db')) {
  await db.query(`CREATE TABLE IF NOT EXISTS vehicle_collision_poll_state (
    vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    dimo_token_id text NOT NULL, checked_through timestamptz NOT NULL,
    PRIMARY KEY(vehicle_id, dimo_token_id)
  );
  CREATE TABLE IF NOT EXISTS vehicle_collision_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vehicle_id integer NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    dimo_token_id text NOT NULL, event_key text NOT NULL, trip_event_key text NOT NULL,
    observed_at timestamptz NOT NULL, source text NOT NULL, raw_event jsonb NOT NULL,
    trip_id integer REFERENCES trips(id) ON DELETE SET NULL,
    body text NOT NULL, detected_at timestamptz NOT NULL DEFAULT NOW(),
    sms_status text NOT NULL DEFAULT 'pending', sms_attempted_at timestamptz,
    sms_next_attempt_at timestamptz, sms_provider_id text,
    UNIQUE(dimo_token_id, event_key)
  );
  CREATE INDEX IF NOT EXISTS idx_vehicle_collision_sms ON vehicle_collision_events(sms_status, sms_next_attempt_at, id);`);
}

function pollWindow(checkedThrough, now) {
  const end = new Date(now).getTime();
  const previous = checkedThrough ? new Date(checkedThrough).getTime() : end;
  const checkpoint = Number.isFinite(previous) && previous <= end ? previous : end;
  return { from: new Date(checkpoint - DAY).toISOString(), to: new Date(Math.min(end, checkpoint + DAY)).toISOString() };
}
function collisionBody(vehicle, event, trip) {
  const label = String(vehicle.nickname || `Vehicle ${vehicle.id}`).replace(/\s+/g, ' ').slice(0, 80);
  const at = new Date(event.at).toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
  return `Denmark collision alert: DIMO reported a collision for ${label} at ${at}. ${trip ? `Trip #${trip.reservation_id || trip.id}.` : 'No unique matching trip; review vehicle and reservation history.'} Check the vehicle and trip telemetry. This is a provider-reported event, not a verified accident or driver-fault finding.`;
}

async function saveCollision(pool, vehicle, event) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const matches = await client.query(`SELECT id, reservation_id, trip_start, trip_end FROM trips
      WHERE turo_vehicle_id=$1 AND trip_start <= $2::timestamptz AND trip_end >= $2::timestamptz
        AND deleted_at IS NULL AND COALESCE(workflow_stage,'') <> 'canceled' AND COALESCE(status,'') NOT IN ('canceled','cancelled')
      ORDER BY id LIMIT 2`, [vehicle.turo_vehicle_id, event.at]);
    const trip = matches.rows.length === 1 ? matches.rows[0] : null;
    const body = collisionBody(vehicle, event, trip);
    // Event history has no event ID. Metadata/duration corrections must not
    // generate a second collision alert for the same source and instant.
    const alertKey = createHash('sha256').update(JSON.stringify([event.name, event.source, event.at])).digest('hex');
    const inserted = await client.query(`INSERT INTO vehicle_collision_events
      (vehicle_id,dimo_token_id,event_key,observed_at,source,raw_event,trip_id,body,trip_event_key)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
      ON CONFLICT (dimo_token_id,event_key) DO NOTHING RETURNING *`,
    [vehicle.id, String(vehicle.dimo_token_id), alertKey, event.at, event.source, JSON.stringify(event.raw), trip?.id || null, body, event.key]);
    const collision = inserted.rows[0] || (await client.query(`SELECT * FROM vehicle_collision_events WHERE dimo_token_id=$1 AND event_key=$2`,
      [String(vehicle.dimo_token_id), alertKey])).rows[0];
    // Tracker reassignment must never attach an old collision to another car.
    const matchingTrip = collision.vehicle_id === vehicle.id && (!collision.trip_id || collision.trip_id === trip?.id) ? trip : null;
    if (matchingTrip) {
      await client.query(`UPDATE vehicle_collision_events SET trip_id=$2, body=$3 WHERE id=$1 AND trip_id IS NULL`, [collision.id, matchingTrip.id, body]);
      await client.query(`INSERT INTO trip_telemetry_events
        (trip_id,dimo_token_id,event_key,event_name,observed_at,source,raw_event)
        VALUES ($1,$2,$3,'safety.collision',$4,$5,$6::jsonb)
        ON CONFLICT (trip_id,dimo_token_id,event_key) DO NOTHING`,
      [matchingTrip.id, String(vehicle.dimo_token_id), collision.trip_event_key, event.at, event.source, JSON.stringify(collision.raw_event)]);
    }
    await client.query(`INSERT INTO messages
      (message_id,subject,status,mailbox,from_header,message_timestamp,text_body,normalized_text_body,
        guest_message,vehicle_name,reservation_id,message_type,trip_id,trip_start,trip_end)
      VALUES ($1,$2,'unread','system','Denmark automation',NOW(),$3,$3,$3,$4,$5,'collision_detected',$6,$7,$8)
      ON CONFLICT (message_id) DO NOTHING`,
    [`system:collision:${collision.id}`, `Collision detected: ${vehicle.nickname || 'Vehicle'}`, collision.body,
      vehicle.nickname || null, matchingTrip?.reservation_id || null, collision.trip_id || matchingTrip?.id || null,
      matchingTrip?.trip_start || null, matchingTrip?.trip_end || null]);
    if (matchingTrip) await client.query(`UPDATE messages SET trip_id=$2,reservation_id=$3,trip_start=$4,trip_end=$5
      WHERE message_id=$1 AND trip_id IS NULL`, [`system:collision:${collision.id}`, matchingTrip.id, matchingTrip.reservation_id, matchingTrip.trip_start, matchingTrip.trip_end]);
    await client.query('COMMIT');
    return inserted.rows.length > 0;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function deliverCollisionSms(pool, sendSms, signal) {
  // An interrupted or ambiguous send is never automatically resent: Twilio
  // may already have accepted it. Keep the queue warning visible for review.
  await pool.query(`UPDATE vehicle_collision_events SET sms_status='uncertain'
    WHERE sms_status='sending' AND sms_attempted_at < NOW() - INTERVAL '10 minutes'`);
  const candidates = await pool.query(`SELECT id FROM vehicle_collision_events
    WHERE sms_status IN ('pending','failed','skipped') AND (sms_next_attempt_at IS NULL OR sms_next_attempt_at <= NOW())
    ORDER BY id LIMIT 10`);
  let sent = 0;
  for (const candidate of candidates.rows) {
    if (signal?.aborted) break;
    const claim = await pool.query(`UPDATE vehicle_collision_events SET sms_status='sending',sms_attempted_at=NOW()
      WHERE id=$1 AND sms_status IN ('pending','failed','skipped')
        AND (sms_next_attempt_at IS NULL OR sms_next_attempt_at <= NOW()) RETURNING *`, [candidate.id]);
    const row = claim.rows[0]; if (!row) continue;
    let status, providerId = null;
    try {
      const delivery = await sendSms(row.body, { timeoutMs: 15000, signal });
      status = delivery.ok ? 'sent' : delivery.skipped ? 'skipped' : 'uncertain';
      providerId = delivery.sid || null;
    } catch (error) {
      status = Number.isInteger(error.statusCode) ? 'failed' : 'uncertain';
    }
    await pool.query(`UPDATE vehicle_collision_events SET sms_status=$2,sms_provider_id=$3,
      sms_next_attempt_at=NOW() + INTERVAL '15 minutes' WHERE id=$1`, [row.id, status, providerId]);
    if (status === 'sent') {
      sent++;
      await pool.query(`INSERT INTO fleet_alert_deliveries
        (alert_key,alert_type,severity,body,provider_message_id,status,details)
        VALUES ($1,'collision_detected','critical',$2,$3,'sent',$4::jsonb) ON CONFLICT (alert_key) DO NOTHING`,
      [`collision:${row.id}`, row.body, providerId, JSON.stringify({ collisionId: row.id, tripId: row.trip_id })]);
    }
  }
  await pool.query(`UPDATE messages m SET text_body=c.body || E'\nSMS delivery: ' || c.sms_status,
    normalized_text_body=c.body || E'\nSMS delivery: ' || c.sms_status,
    guest_message=c.body || E'\nSMS delivery: ' || c.sms_status
    FROM vehicle_collision_events c WHERE m.message_id='system:collision:' || c.id::text
      AND m.guest_message IS DISTINCT FROM c.body || E'\nSMS delivery: ' || c.sms_status`);
  return sent;
}

function createCollisionMonitor({ pool, fetchEvents = (...args) => require('../dimo/eventHistory').fetchDimoEvents(...args),
  sendSms = (...args) => require('../alerts/twilioSms').sendSms(...args), now = () => new Date(), logger = console }) {
  let running = false;
  return async function pollCollisions({ signal } = {}) {
    if (running || signal?.aborted) return { skipped: true };
    running = true;
    const result = { vehicles: 0, failed: 0, detected: 0, sms_sent: 0 };
    try {
      const fleet = await pool.query(`SELECT v.id,v.nickname,v.dimo_token_id,v.turo_vehicle_id,p.checked_through
        FROM vehicles v LEFT JOIN vehicle_collision_poll_state p ON p.vehicle_id=v.id AND p.dimo_token_id=v.dimo_token_id::text
        WHERE v.is_active=true AND v.dimo_token_id IS NOT NULL ORDER BY v.id`);
      const at = now();
      for (const vehicle of fleet.rows) {
        if (signal?.aborted) break;
        try {
          const token = Number(vehicle.dimo_token_id);
          if (!Number.isSafeInteger(token) || token <= 0 || fleet.rows.filter(v => String(v.dimo_token_id) === String(vehicle.dimo_token_id)).length !== 1) throw Error('Ambiguous DIMO identity');
          const window = pollWindow(vehicle.checked_through, at);
          const events = normalizeEvents(await fetchEvents(token, { ...window, signal, collisionOnly: true }), window.from, window.to);
          if (events.some(e => e.name !== 'safety.collision')) throw Error('Unexpected event category');
          for (const event of events) {
            if (signal?.aborted) break;
            if (await saveCollision(pool, vehicle, event)) result.detected++;
          }
          if (signal?.aborted) break;
          await pool.query(`INSERT INTO vehicle_collision_poll_state(vehicle_id,dimo_token_id,checked_through)
            VALUES ($1,$2,$3) ON CONFLICT (vehicle_id,dimo_token_id) DO UPDATE
              SET checked_through=GREATEST(vehicle_collision_poll_state.checked_through,EXCLUDED.checked_through)`,
          [vehicle.id, String(vehicle.dimo_token_id), window.to]);
          result.vehicles++;
        } catch {
          result.failed++;
          logger.warn('[collisions] vehicle check failed', { vehicle_id: vehicle.id, reason: 'DIMO events unavailable, identity invalid, or persistence failed; checkpoint retained' });
        }
      }
      if (!signal?.aborted) result.sms_sent = await deliverCollisionSms(pool, sendSms, signal);
      logger.log('[collisions] check complete', result);
      return result;
    } finally { running = false; }
  };
}
module.exports = { ensureCollisionMonitorSchema, pollWindow, collisionBody, saveCollision, deliverCollisionSms, createCollisionMonitor };
