function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function getConfiguredReturnLocation(trip, locations = []) {
  const booked = normalize(trip?.return_location || trip?.returnLocation || trip?.pickup_location);
  const enabled = (Array.isArray(locations) ? locations : []).filter(location => {
    const lat = location?.latitude ?? location?.lat;
    const lon = location?.longitude ?? location?.lon ?? location?.lng;
    return location?.enabled !== false && lat != null && lon != null && lat !== '' && lon !== '' &&
      Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
  });
  const match = booked && enabled.find(location =>
    [location.label, location.name, location.address, location.id].map(normalize).filter(Boolean).some(candidate =>
      candidate === booked || (candidate.length >= 6 && booked.includes(candidate)) ||
      (booked.length >= 6 && candidate.includes(booked))));
  if (match) return match;
  if (/(?:^| )(?:airport|terminal|hotel|delivery|delivered|station|garage)(?: |$)/.test(booked)) return null;
  // Preserve the trip dialog's primary parking fallback for ordinary booked
  // street addresses whose configured geofence has only a friendly label.
  return enabled.find(location => /\b(?:garlic creek|home|buda|78610)\b/i.test(location.label || location.name || '')) ||
    enabled.find(location => String(location.kind || '').toLowerCase() === 'parking') || null;
}
