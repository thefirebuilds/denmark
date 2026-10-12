function mapCheckInNotice(trip, now = new Date()) {
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
