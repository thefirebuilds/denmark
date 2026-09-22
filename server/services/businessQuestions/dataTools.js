const { DateTime } = require('luxon');

const nullableId = { type: ['integer', 'null'], description: 'Vehicle database ID from list_fleet, or null for all vehicles.' };
const date = { type: 'string', description: 'Inclusive calendar date, YYYY-MM-DD, America/Chicago.' };
function tool(name, description, properties) {
  return { type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}
const definitions = [
  tool('list_fleet', 'Find managed vehicles by canonical name, stored nickname or aliases. Includes inactive vehicles for historical spending; use active vehicles for current operations.', {}),
  tool('search_expenses', 'Search recorded business expenses. Exact database totals include tax and refunds, across ALL matching rows, not just the page. Terms match category, vendor or notes (OR). Use tire and tyre for tire spending. A matched vendor invoice may also contain non-tire work; disclose this. No bank transactions or unrecorded expenses are included.', {
    start_date: date, end_date: date, vehicle_id: nullableId,
    terms: { type: 'array', items: { type: 'string' }, description: 'Zero to 8 keywords; empty means all expenses.' },
    offset: { type: 'integer', description: 'Pagination offset, starting at 0; page size 100.' },
  }),
  tool('vehicle_maintenance', 'Get current scheduled maintenance rule statuses and open tasks using the same rules as Fleet Management. Does not refresh telemetry or alter tasks.', {
    vehicle_id: { type: 'integer', description: 'Database vehicle ID from list_fleet.' },
  }),
  tool('trip_summary', 'Summarize trips starting in the date range, grouped by vehicle and status. Booked amounts are not cash collected or prorated revenue. No guest personal data is returned.', {
    start_date: date, end_date: date, vehicle_id: nullableId,
  }),
];

function validateArgs(name, args) {
  const definition = definitions.find((item) => item.name === name);
  if (!definition || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid data request');
  const keys = Object.keys(definition.parameters.properties);
  if (Object.keys(args).some((key) => !keys.includes(key)) || keys.some((key) => !(key in args))) throw new Error('Invalid data request fields');
  if ('vehicle_id' in args && !(args.vehicle_id === null && name !== 'vehicle_maintenance') &&
      !(Number.isSafeInteger(args.vehicle_id) && args.vehicle_id > 0)) throw new Error('Invalid vehicle ID');
  if ('start_date' in args) {
    for (const field of ['start_date', 'end_date']) {
      if (typeof args[field] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(args[field]) ||
          !DateTime.fromISO(args[field]).isValid) throw new Error('Invalid date range');
    }
    if (args.start_date > args.end_date) throw new Error('Start date must precede end date');
  }
  if (name === 'search_expenses') {
    if (!Array.isArray(args.terms) || args.terms.length > 8 || args.terms.some((term) =>
      typeof term !== 'string' || !term.trim() || term.length > 80)) throw new Error('Invalid expense search terms');
    if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 10000) throw new Error('Invalid page offset');
  }
}

function createDataTools({ pool, getMaintenanceSummary }) {
  return async function execute(name, args) {
    validateArgs(name, args);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      let data;
      if (name === 'list_fleet') {
        const result = await client.query(`SELECT v.id, v.nickname, v.turo_vehicle_name,
          v.year, v.make, v.model, v.is_active, v.in_service,
          COALESCE((SELECT jsonb_agg(va.alias) FROM vehicle_aliases va
            WHERE va.vehicle_id = v.id AND va.active = true), '[]'::jsonb) AS aliases
          FROM vehicles v ORDER BY v.is_active DESC, v.nickname, v.id LIMIT 501`);
        data = { vehicles: result.rows.slice(0, 500), truncated: result.rows.length > 500 };
      } else if (name === 'search_expenses') {
        const result = await client.query(`WITH matching AS (
          SELECT e.id, e.date, e.vendor, e.category, LEFT(e.notes, 1000) AS notes,
            e.vehicle_id, v.nickname AS vehicle, e.price, e.tax,
            (e.price + COALESCE(e.tax, 0)) AS total, e.expense_scope, e.is_capitalized
          FROM expenses e LEFT JOIN vehicles v ON v.id = e.vehicle_id
          WHERE e.date BETWEEN $1::date AND $2::date
            AND ($3::integer IS NULL OR e.vehicle_id = $3)
            AND (cardinality($4::text[]) = 0 OR EXISTS (
              SELECT 1 FROM unnest($4::text[]) term
              WHERE strpos(LOWER(CONCAT_WS(' ', e.vendor, e.category, e.notes)), LOWER(term)) > 0
            ))
        ), page AS (SELECT * FROM matching ORDER BY date DESC, id DESC LIMIT 100 OFFSET $5)
        SELECT (SELECT COUNT(*) FROM matching)::int AS matched_count,
          (SELECT COALESCE(SUM(total), 0) FROM matching)::text AS total_including_tax,
          COALESCE((SELECT jsonb_agg(page) FROM page), '[]'::jsonb) AS records`,
        [args.start_date, args.end_date, args.vehicle_id, args.terms.map((term) => term.trim()), args.offset]);
        data = { ...result.rows[0], currency: 'USD', filters: args, page_size: 100,
          basis: 'Recorded expense price plus tax; includes negative refunds. Matching invoices may include other services.' };
      } else if (name === 'vehicle_maintenance') {
        const found = await client.query('SELECT id, vin, nickname FROM vehicles WHERE id = $1 AND is_active = true', [args.vehicle_id]);
        if (!found.rows[0]) throw new Error('Active fleet vehicle not found');
        const vehicle = found.rows[0];
        const summary = await getMaintenanceSummary(client, vehicle.vin, { readOnly: true });
        // Explicit projection excludes lockbox PINs, provider IDs and raw telemetry.
        data = { vehicle: { id: vehicle.id, nickname: vehicle.nickname },
          current_odometer_miles: summary.currentOdometerMiles,
          rule_statuses: (summary.ruleStatuses || []).map((rule) => ({
            id: rule.ruleId, title: rule.title, status: rule.status,
            nextDueMiles: rule.nextDueMiles, nextDueDate: rule.nextDueDate,
            blocksRentalWhenOverdue: rule.blocksRentalWhenOverdue,
          })),
          tasks: (summary.tasks || []).map((task) => ({ id: task.id, title: task.title,
            priority: task.priority, status: task.status, blocks_rental: task.blocks_rental ?? task.blocksRental })),
          basis: 'Stored maintenance records and latest stored odometer. Missing history is unknown, not proof work was completed.' };
      } else if (name === 'trip_summary') {
        const result = await client.query(`SELECT v.id AS vehicle_id, v.nickname AS vehicle,
          t.status, COUNT(*)::int AS trip_count, COALESCE(SUM(t.amount), 0)::text AS booked_amount
          FROM trips t
          LEFT JOIN LATERAL (SELECT candidate.id, candidate.nickname FROM vehicles candidate
            WHERE candidate.turo_vehicle_id = t.turo_vehicle_id OR
              (t.turo_vehicle_id IS NULL AND (
                LOWER(TRIM(candidate.nickname)) = LOWER(TRIM(t.vehicle_name)) OR
                LOWER(TRIM(candidate.turo_vehicle_name)) = LOWER(TRIM(t.vehicle_name)) OR
                EXISTS (SELECT 1 FROM vehicle_aliases a WHERE a.vehicle_id = candidate.id AND a.active = true
                  AND LOWER(TRIM(a.alias)) = LOWER(TRIM(t.vehicle_name)))))
            ORDER BY candidate.id LIMIT 1) v ON true
          WHERE t.deleted_at IS NULL AND t.trip_start >= $1::date AND t.trip_start < $2::date + INTERVAL '1 day'
            AND ($3::integer IS NULL OR v.id = $3)
          GROUP BY v.id, v.nickname, t.status ORDER BY v.nickname, t.status LIMIT 501`,
        [args.start_date, args.end_date, args.vehicle_id]);
        data = { filters: args, groups: result.rows.slice(0, 500), truncated: result.rows.length > 500,
          basis: 'Trips starting in range, including cancellations as separate statuses; booked amounts, not collected revenue.' };
      }
      await client.query('COMMIT');
      return data;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
}

module.exports = { definitions, validateArgs, createDataTools };
