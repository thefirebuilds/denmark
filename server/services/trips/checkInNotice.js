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
    trip_end: trip.trip_end, trip_workflow_stage: trip.workflow_stage,
    check_in_deadline: deadline.toISOString(), check_in_overdue: overdue,
    timestamp: trip.stage_updated_at || trip.trip_end,
    notification_created_at: trip.stage_updated_at || trip.trip_end,
  };
}
module.exports = { mapCheckInNotice };
