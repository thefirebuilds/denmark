async function findManagedTelemetryVehicle(client, vin) {
  const normalizedVin = String(vin || '').trim();
  if (!normalizedVin) return null;
  const { rows } = await client.query(`
    SELECT id, vin FROM vehicles
    WHERE UPPER(TRIM(vin)) = UPPER($1) AND is_active = true
    FOR UPDATE
  `, [normalizedVin]);
  return rows[0] || null;
}

module.exports = { findManagedTelemetryVehicle };
