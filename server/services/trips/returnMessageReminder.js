const ACK_KEY = 'messages.returnMessageAcknowledgements';
const LEAD_HOURS = 12;

function reminderKey(tripId, tripEnd) {
  return `return-message:${tripId}:${new Date(tripEnd).toISOString()}`;
}

function buildReturnMessage(row) {
  const guest = String(row.guest_name || '').trim().split(/\s+/)[0] || 'there';
  const vehicle = row.vehicle_nickname || row.vehicle_name || 'the car';
  const location = String(row.return_location || row.pickup_location || '').trim();
  const airport = /parking spot west|\bairport\b|\baus\b|1600\s+(?:e\.?|east)\s+(?:hwy|highway)\s*71/i.test(location);
  const home = /fletcher\s+(?:bend|bnd)\b|garlic creek|^home$/i.test(location);
  if (airport) return { template: 'airport', text: `Hello Again ${guest},

I hope ${vehicle} served you well on your trip! When you return to The Parking Spot West please follow the signs for car share parking, you can return the car to any spot within that area (sort of off to your right as you come in).

1600 E Hwy 71,
Austin, TX 78742

Please lock the keys in the car and I will use my spare to pick it up. Make sure you remove all your belongings beforehand!

If you have any feedback or concerns for me I'd love to hear them, and I do appreciate your review on the app! We look forward to seeing you again.

Thanks,
Blake - Fresh Coast Garage` };
  if (home) return { template: 'home', text: `Hi ${guest},

When you bring back ${vehicle} you can park on the street near my house (across the street is fine) and lock the key in the car. I'll use my spare.

If you wish to extend, please request an extension in the app.

Have a great week!

Thanks,
Blake` };
  return { template: 'other', text: `Hi ${guest},

I hope ${vehicle} served you well on your trip! As your trip wraps up,${location ? ` please return the car to ${location}.` : ' please follow the return location and instructions in your booking.'} Make sure you remove all your belongings beforehand!

If you have any feedback or concerns for me I'd love to hear them, and I do appreciate your review on the app!

Thanks,
Blake - Fresh Coast Garage` };
}

function mapReturnMessageReminder(row) {
  const draft = buildReturnMessage(row);
  const id = reminderKey(row.trip_id, row.trip_end);
  return { id, messageId: id, type: 'return_message_required', status: 'read',
    subject: `Send return instructions for ${row.vehicle_nickname || row.vehicle_name || 'vehicle'}`,
    timestamp: row.trip_end, notification_created_at: new Date(new Date(row.trip_end).getTime() - LEAD_HOURS * 3600000).toISOString(),
    trip_id: row.trip_id, reservation_id: row.reservation_id, guest_name: row.guest_name,
    vehicle_name: row.vehicle_name, vehicle_nickname: row.vehicle_nickname,
    trip_start: row.trip_start, trip_end: row.trip_end, trip_workflow_stage: row.workflow_stage,
    return_location: row.return_location || row.pickup_location || null,
    return_message_draft: draft.text, return_message_template: draft.template,
    reply_url: row.reply_url || null };
}

async function getReturnMessageReminders(db) {
  const { rows } = await db.query(`SELECT t.id AS trip_id, t.reservation_id, t.guest_name, t.vehicle_name,
      v.nickname AS vehicle_nickname, t.trip_start, t.trip_end, t.workflow_stage,
      t.return_location, t.pickup_location,
      (SELECT m.reply_url FROM messages m WHERE m.reply_url IS NOT NULL
        AND (m.trip_id = t.id OR m.reservation_id = t.reservation_id)
        ORDER BY m.message_timestamp DESC NULLS LAST, m.id DESC LIMIT 1) AS reply_url,
      COALESCE(ack.value, '{}'::jsonb) AS acknowledgements
    FROM trips t
    LEFT JOIN LATERAL (SELECT v.nickname FROM vehicles v
      WHERE (t.turo_vehicle_id IS NOT NULL AND v.turo_vehicle_id = t.turo_vehicle_id)
        OR (t.turo_vehicle_id IS NULL AND LOWER(TRIM(v.nickname)) = LOWER(TRIM(t.vehicle_name)))
      ORDER BY v.id LIMIT 1) v ON true
    LEFT JOIN app_settings ack ON ack.key = $1
    WHERE t.workflow_stage = 'in_progress' AND t.deleted_at IS NULL
      AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
      AND COALESCE(t.closed_out, false) = false AND t.returned_at IS NULL
      AND t.trip_start <= NOW() AND t.trip_end <= NOW() + ($2 * INTERVAL '1 hour')
    ORDER BY t.trip_end, t.id`, [ACK_KEY, LEAD_HOURS]);
  return rows.filter(row => !row.acknowledgements?.[reminderKey(row.trip_id, row.trip_end)])
    .map(mapReturnMessageReminder);
}

async function acknowledgeReturnMessage(db, tripId, tripEnd, actor) {
  if (!Number.isSafeInteger(tripId) || tripId <= 0 || !tripEnd || !Number.isFinite(new Date(tripEnd).getTime())) {
    throw Object.assign(new Error('Valid trip ID and scheduled return time required'), { statusCode: 400 });
  }
  const key = reminderKey(tripId, tripEnd);
  const { rowCount } = await db.query(`INSERT INTO app_settings (key, value, updated_at)
    SELECT $1, jsonb_build_object($2::text, jsonb_build_object('acknowledgedAt', NOW(), 'acknowledgedBy', $3::text)), NOW()
    FROM trips t WHERE t.id = $4 AND t.trip_end = $5::timestamptz
    ON CONFLICT (key) DO UPDATE SET value = COALESCE(app_settings.value, '{}'::jsonb) || EXCLUDED.value, updated_at = NOW()`,
  [ACK_KEY, key, actor || 'dashboard', tripId, new Date(tripEnd).toISOString()]);
  if (!rowCount) throw Object.assign(new Error('Trip return time changed. Refresh the queue.'), { statusCode: 409 });
}

module.exports = { buildReturnMessage, reminderKey, mapReturnMessageReminder, getReturnMessageReminders, acknowledgeReturnMessage };
