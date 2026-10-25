export function getBookingContext(message) {
  const stage = String(message?.trip_workflow_stage || message?.trip_status || '').toLowerCase();
  const status = String(message?.trip_status || '').toLowerCase();
  const pickedUp = ['in_progress', 'check_in', 'awaiting_expenses', 'complete', 'completed'].includes(stage) ||
    ['in_progress', 'completed', 'complete', 'returned'].includes(status) ||
    (message?.trip_id != null && Number(message.active_trip_id) === Number(message.trip_id));
  const canceled = ['canceled', 'cancelled'].includes(stage) || ['canceled', 'cancelled'].includes(status);
  const showPickupCountdown = !pickedUp && !canceled;
  const initial = message?.initial_booking_amount ??
    ((message?.type || message?.message_type) === 'trip_booked' ? message.amount : null);
  const initialAmount = initial == null || String(initial).trim() === '' ? null : Number(initial);
  return {
    title: showPickupCountdown ? 'Upcoming booking context' : 'Booking context',
    showPickupCountdown,
    initialAmount: Number.isFinite(initialAmount) ? initialAmount : null,
    pickupLocation: String(message?.pickup_location || '').trim() || null,
  };
}
