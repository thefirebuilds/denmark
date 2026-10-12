function resolveCheckInGeofence(trip, locations) {
  const hasGps = trip.latitude != null && trip.longitude != null;
  const rad = value => Number(value) * Math.PI / 180;
  if (hasGps) {
    const match = locations.find(location => {
      if (location.enabled === false || location.latitude == null || location.longitude == null) return false;
      const a = Math.sin(rad(location.latitude - trip.latitude) / 2) ** 2 +
        Math.cos(rad(trip.latitude)) * Math.cos(rad(location.latitude)) *
        Math.sin(rad(location.longitude - trip.longitude) / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= location.radiusMiles;
    });
    return match?.label || null;
  }
  // Only use an observed return name that matches a configured geofence.
  // A scheduled address is not evidence that the car is there.
  const detected = String(trip.return_detected_location || '').trim().toLowerCase();
  return locations.find(location => location.enabled !== false && detected &&
    [location.id, location.label].some(value => String(value || '').toLowerCase() === detected))?.label || null;
}

function mapCheckInNotice(trip, now = new Date(), locations = []) {
  // Recompute from the current official reservation end on every queue refresh.
  // An early return or stage change must never start this deadline sooner.
  const end = new Date(trip.trip_end);
  if (trip.workflow_stage !== 'check_in' || !trip.trip_end || !Number.isFinite(+end) || trip.closed_out || trip.status === 'canceled' || trip.deleted_at) return null;
  const deadline = new Date(+end + 24 * 60 * 60 * 1000);
  const overdue = +now >= +deadline;
  return {
    id: `check-in:${trip.id}`, messageId: `check-in:${trip.id}`,
    type: 'check_in_required', status: 'read',
    subject: overdue ? 'Trip check-in overdue' : 'Trip check-in required',
    trip_id: trip.id, reservation_id: trip.reservation_id,
    guest_name: trip.guest_name, vehicle_name: trip.vehicle_name,
    vehicle_nickname: trip.vehicle_nickname || null,
    check_in_geofence: resolveCheckInGeofence(trip, locations),
    check_in_location: trip.last_location_address || trip.return_detected_location || trip.return_location || trip.pickup_location || null,
    check_in_location_label: trip.last_location_address ? 'Last reported location'
      : trip.return_detected_location ? 'Detected return location' : 'Scheduled location',
    check_in_location_at: trip.last_location_address ? trip.last_location_at
      : trip.return_detected_location ? trip.returned_at : null,
    trip_end: trip.trip_end, trip_workflow_stage: trip.workflow_stage,
    check_in_deadline: deadline.toISOString(), check_in_overdue: overdue,
    timestamp: trip.stage_updated_at || trip.trip_end,
    notification_created_at: trip.stage_updated_at || trip.trip_end,
  };
}
module.exports = { mapCheckInNotice };
