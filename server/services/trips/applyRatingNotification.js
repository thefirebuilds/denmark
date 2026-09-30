function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchesRatingTrip(event, trip) {
  const guest = normalizeName(event.guestName);
  const fullGuest = normalizeName(trip.guest_name);
  const vehicle = normalizeName(event.vehicleName).replace(/\s+\d{4}$/, '');
  if (!guest || !vehicle || !(fullGuest === guest || fullGuest.startsWith(`${guest} `))) return false;
  const names = [trip.vehicle_name, trip.nickname, trip.turo_vehicle_name,
    [trip.make, trip.model].filter(Boolean).join(' '), ...(trip.aliases || [])];
  return names.some((name) => normalizeName(name).replace(/\s+\d{4}$/, '') === vehicle);
}

async function applyRatingNotification(client, event, notificationId) {
  if (event.classification !== 'trip_rated' || !notificationId) return null;
  const eventAt = event.postedAt || new Date().toISOString();
  if (!Number.isFinite(new Date(eventAt).getTime())) return null;
  if (!event.reservationId && (!event.guestName || !event.vehicleName)) return null;
  const { rows } = await client.query(`
    SELECT t.id, t.guest_name, t.vehicle_name, v.nickname, v.turo_vehicle_name, v.make, v.model,
      COALESCE((SELECT array_agg(a.alias) FROM vehicle_aliases a
        WHERE a.vehicle_id = v.id AND a.active = true), ARRAY[]::text[]) AS aliases
    FROM trips t
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM vehicles candidate
      WHERE candidate.turo_vehicle_id = t.turo_vehicle_id
        OR (t.turo_vehicle_id IS NULL AND (
          LOWER(TRIM(candidate.nickname)) = LOWER(TRIM(t.vehicle_name)) OR
          LOWER(TRIM(candidate.turo_vehicle_name)) = LOWER(TRIM(t.vehicle_name)) OR
          EXISTS (SELECT 1 FROM vehicle_aliases a WHERE a.vehicle_id = candidate.id AND a.active = true
            AND LOWER(TRIM(a.alias)) = LOWER(TRIM(t.vehicle_name)))))
      ORDER BY candidate.id LIMIT 1
    ) v ON true
    WHERE t.deleted_at IS NULL AND t.canceled_at IS NULL
      AND LOWER(COALESCE(t.status, '')) NOT IN ('canceled', 'cancelled')
      AND LOWER(COALESCE(t.workflow_stage, '')) NOT IN ('canceled', 'cancelled')
      AND (($1::bigint IS NOT NULL AND t.reservation_id = $1)
        OR ($1::bigint IS NULL AND COALESCE(t.returned_at, t.trip_end)
          BETWEEN $2::timestamptz - INTERVAL '30 days' AND $2::timestamptz))
  `, [event.reservationId || null, eventAt]);
  const candidates = event.reservationId ? rows : rows.filter((trip) => matchesRatingTrip(event, trip));
  if (candidates.length !== 1) return null;
  const trip = candidates[0];
  // Apply the flag and resolve the bridge warning atomically; preserve the first
  // rating timestamp and every operational/financial field on duplicate delivery.
  const updated = await client.query(`WITH rated AS (
    UPDATE trips SET guest_rating_received = true,
      guest_rating_received_at = COALESCE(guest_rating_received_at, $2::timestamptz),
      updated_at = CASE WHEN guest_rating_received IS DISTINCT FROM true OR guest_rating_received_at IS NULL
        THEN NOW() ELSE updated_at END
    WHERE id = $1 AND deleted_at IS NULL AND canceled_at IS NULL
      AND LOWER(COALESCE(status, '')) NOT IN ('canceled', 'cancelled')
      AND LOWER(COALESCE(workflow_stage, '')) NOT IN ('canceled', 'cancelled')
    RETURNING id
  )
  UPDATE notification_events SET acknowledged_at = COALESCE(acknowledged_at, NOW()),
    acknowledged_by = COALESCE(acknowledged_by, 'trip-rating-auto-sync'),
    acknowledged_reason = COALESCE(acknowledged_reason, 'Guest rating recorded from Turo app notification')
  WHERE id = $3 AND EXISTS (SELECT 1 FROM rated)
  RETURNING id`, [trip.id, eventAt, notificationId]);
  return updated.rows.length ? { tripId: trip.id } : null;
}

module.exports = { applyRatingNotification, matchesRatingTrip };
