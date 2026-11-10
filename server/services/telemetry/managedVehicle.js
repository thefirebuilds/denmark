const { NON_OWNED_NAMES } = require('../vehicles/nonOwnedVehicles');
async function findManagedTelemetryVehicle(client, vin) {
  const normalizedVin = String(vin || '').trim();
  if (!normalizedVin) return null;
  const { rows } = await client.query(`
    SELECT id, vin FROM vehicles
    WHERE UPPER(TRIM(vin)) = UPPER($1) AND is_active = true
      AND NOT (COALESCE(LOWER(TRIM(nickname)), '') = ANY($2::text[]))
      AND NOT (COALESCE(LOWER(TRIM(turo_vehicle_name)), '') = ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM vehicle_aliases a WHERE a.vehicle_id=vehicles.id AND a.active=true AND LOWER(TRIM(a.alias))=ANY($2::text[]))
    FOR UPDATE
  `, [normalizedVin, NON_OWNED_NAMES]);
  return rows[0] || null;
}

module.exports = { findManagedTelemetryVehicle };
