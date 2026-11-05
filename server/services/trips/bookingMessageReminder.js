const ACK_KEY = 'messages.bookingMessageAcknowledgements';
function reminderKey(tripId, tripStart) {
  return `booking-message:${tripId}:${new Date(tripStart).toISOString()}`;
}
function buildBookingMessage(row) {
  const guest = String(row.guest_name || '').trim().split(/\s+/)[0] || 'there';
  const vehicle = row.vehicle_nickname || row.vehicle_name || 'the car';
  return { template: 'fletcher', text: `Hi ${guest},

Thanks for booking!

I will have ${vehicle} ready for you at the address you selected for your reservation:

135 Fletcher Bend
Buda, TX

There is a HCTRA toll tag on the windshield, I will bill you for any usage after your trip. Also there is a sunshade in the glove box, help yourself, just return it after your trip if you use it please.

Let me know if you have any questions or concerns, and have a safe trip!

If you think you may need to extend your trip let me know and I will snooze the car so it's available to you.
-Blake` };
}
function mapBookingMessageReminder(row) {
  const draft = buildBookingMessage(row);
  const id = reminderKey(row.trip_id, row.trip_start);
  return { id, messageId: id, type: 'booking_message_required', status: 'read',
    subject: `Send booking welcome for ${row.vehicle_nickname || row.vehicle_name || 'vehicle'}`,
    timestamp: row.trip_start, notification_created_at: new Date().toISOString(),
    trip_id: row.trip_id, reservation_id: row.reservation_id, guest_name: row.guest_name,
    vehicle_name: row.vehicle_name, vehicle_nickname: row.vehicle_nickname,
    trip_start: row.trip_start, trip_end: row.trip_end, trip_workflow_stage: row.workflow_stage,
    return_location: row.return_location || row.pickup_location || null,
    booking_message_draft: draft.text, booking_message_template: draft.template,
    reply_url: row.reply_url || null };
}

async function getBookingMessageReminders(db) {
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
    WHERE t.workflow_stage IN ('booked', 'confirmed', 'ready_for_handoff') AND t.deleted_at IS NULL
      AND COALESCE(t.status, '') NOT IN ('canceled', 'cancelled')
      AND COALESCE(t.closed_out, false) = false AND t.returned_at IS NULL
      AND t.trip_start > NOW() AND t.pickup_location ~* '(^|[^0-9])135[[:space:]]+fletcher[[:space:]]+(bend|bnd)([^a-z]|$)'
    ORDER BY t.trip_end, t.id`, [ACK_KEY]);
  return rows.filter(row => !row.acknowledgements?.[reminderKey(row.trip_id, row.trip_start)])
    .map(mapBookingMessageReminder);
}

async function acknowledgeBookingMessage(db, tripId, tripStart, actor) {
  if (!Number.isSafeInteger(tripId) || tripId <= 0 || !tripStart || !Number.isFinite(new Date(tripStart).getTime())) {
    throw Object.assign(new Error('Valid trip ID and scheduled pickup time required'), { statusCode: 400 });
  }
  const key = reminderKey(tripId, tripStart);
  const { rowCount } = await db.query(`INSERT INTO app_settings (key, value, updated_at)
    SELECT $1, jsonb_build_object($2::text, jsonb_build_object('acknowledgedAt', NOW(), 'acknowledgedBy', $3::text)), NOW()
    FROM trips t WHERE t.id = $4 AND t.trip_start = $5::timestamptz
    ON CONFLICT (key) DO UPDATE SET value = COALESCE(app_settings.value, '{}'::jsonb) || EXCLUDED.value, updated_at = NOW()`,
  [ACK_KEY, key, actor || 'dashboard', tripId, new Date(tripStart).toISOString()]);
  if (!rowCount) throw Object.assign(new Error('Trip pickup time changed. Refresh the queue.'), { statusCode: 409 });
}

module.exports = { buildBookingMessage, reminderKey, mapBookingMessageReminder, getBookingMessageReminders, acknowledgeBookingMessage };
