const pool = require('../../db');
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
      COALESCE(tasks.items, '[]'::jsonb) AS tasks
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
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', mt.id, 'title', mt.title,
        'status', mt.status, 'priority', mt.priority)
        ORDER BY CASE mt.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
          WHEN 'medium' THEN 2 ELSE 3 END, mt.created_at) AS items
      FROM maintenance_tasks mt
      WHERE UPPER(TRIM(mt.vehicle_vin)) = UPPER(TRIM(v.vin))
        AND mt.status IN ('open', 'scheduled', 'in_progress', 'deferred')
        AND NOT EXISTS (
          SELECT 1 FROM maintenance_events me JOIN maintenance_rules mr ON mr.id = me.rule_id
          WHERE me.vehicle_vin = mt.vehicle_vin
            AND me.result IN ('pass', 'performed', 'measured', 'not_applicable')
            AND COALESCE(me.performed_at, me.created_at) >= mt.created_at
            AND (me.rule_id = mt.rule_id OR
              (COALESCE(mt.trigger_context->>'ruleCode', '') <> ''
                AND mr.rule_code = mt.trigger_context->>'ruleCode'))
        )
    ) tasks ON true
    WHERE COALESCE(v.is_active, true) = true AND NULLIF(TRIM(v.vin), '') IS NOT NULL
    ORDER BY v.nickname, v.id
  `);
  return buildHomeMaintenanceNotices(rows, locations);
}

module.exports = { getHomeMaintenanceNotices, buildHomeMaintenanceNotices };
