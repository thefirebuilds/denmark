const pool = require('../../db');
const { getVehicleMaintenanceSummary } = require('./getVehicleMaintenanceSummary');
const { getEnabledLocations } = require('../locations/locationSettings');

function insideLocation(row, location) {
  const values = [row.latitude, row.longitude, location.latitude, location.longitude];
  if (values.some(value => value == null || !Number.isFinite(Number(value)))) return false;
  const [lat, lon, homeLat, homeLon] = values.map(Number);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return false;
  const rad = value => value * Math.PI / 180;
  const a = Math.sin(rad(homeLat - lat) / 2) ** 2 +
    Math.cos(rad(lat)) * Math.cos(rad(homeLat)) * Math.sin(rad(homeLon - lon) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(Math.min(1, a))) <= location.radiusMiles;
}

function buildHomeMaintenanceNotices(rows, locations, now = Date.now()) {
  const home = locations.find(location =>
    /garlic[\s_-]*creek/i.test(`${location.id} ${location.label}`));
  if (!home) return [];
  return rows.filter(row => {
    const age = now - new Date(row.seen_at).getTime();
    return Number.isFinite(age) && age >= -300000 && age <= 24 * 60 * 60 * 1000 && insideLocation(row, home);
  }).map(row => ({
    id: `home-maintenance:${row.id}`,
    messageId: `home-maintenance:${row.id}`,
    type: 'home_maintenance',
    status: 'read',
    subject: 'Maintenance at Garlic Creek',
    vehicle_name: row.nickname || row.vin,
    vehicle_nickname: row.nickname,
    maintenance_vehicle_name: row.nickname || row.vin,
    maintenance_vehicle_vin: row.vin,
    vehicle_vin: row.vin,
    maintenance_tasks: row.tasks || [],
    maintenance_task_count: (row.tasks || []).length,
    timestamp: row.seen_at,
    created_at: row.seen_at,
  }));
}

async function getHomeMaintenanceNotices() {
  const locations = await getEnabledLocations();
  if (!locations.some(location => /garlic[\s_-]*creek/i.test(`${location.id} ${location.label}`))) return [];
  const { rows } = await pool.query(`
    SELECT v.id, v.nickname, v.vin, gps.latitude, gps.longitude, gps.seen_at,
      '[]'::jsonb AS tasks
    FROM vehicles v
    JOIN LATERAL (
      SELECT s.latitude, s.longitude,
        COALESCE(s.location_last_updated, s.vehicle_last_updated, s.captured_at) AS seen_at
      FROM vehicle_telemetry_snapshots s
      WHERE LOWER(s.vin) = LOWER(v.vin)
        AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
        AND COALESCE(s.vehicle_last_updated, s.captured_at) >= NOW() - INTERVAL '24 hours'
      ORDER BY COALESCE(s.vehicle_last_updated, s.captured_at) DESC NULLS LAST, s.id DESC
      LIMIT 1
    ) gps ON true
    WHERE COALESCE(v.is_active, true) = true AND NULLIF(TRIM(v.vin), '') IS NOT NULL
    ORDER BY v.nickname, v.id
  `);
  const notices = buildHomeMaintenanceNotices(rows, locations);
  const { buildQueueItemsFromSummary, buildInspectionHistoryMap } = await import('../../../shared/maintenanceQueue.mjs');
  // Only load summaries for cars actually at home, serially inside the existing
  // background cache refresh. Never refresh telemetry or mutate tasks here.
  for (const notice of notices) {
    const summary = await getVehicleMaintenanceSummary(pool, notice.vehicle_vin, { readOnly: true });
    const items = buildQueueItemsFromSummary(summary, buildInspectionHistoryMap(summary));
    notice.maintenance_tasks = items.map(item => ({
      id: item.id, title: item.title, priority: item.priority,
      status: item.task?.status || item.ruleStatus || 'open',
    }));
    notice.maintenance_task_count = notice.maintenance_tasks.length;
  }
  return notices;
}

module.exports = { getHomeMaintenanceNotices, buildHomeMaintenanceNotices };
