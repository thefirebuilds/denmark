const test = require('node:test');
const assert = require('node:assert/strict');

test('maintenance history collapses duplicate notes and preserves distinct services and measurements', async () => {
  const { getUniqueMaintenanceHistory } = await import('../../src/utils/maintenanceHistory.js');
  const entry = { id: 1, performedAt: '2026-10-25T12:00:00Z', odometerMiles: 135000,
    notes: 'Oil changed', result: 'performed', data: { filter: true, oil: '5w30' } };
  const entries = [entry,
    { ...entry, id: 2, notes: '  OIL   changed ', data: { oil: '5w30', filter: true } },
    { ...entry, id: 3, performedAt: '2026-10-29T12:00:00Z' },
    { ...entry, id: 4, odometerMiles: 135100 },
    { ...entry, id: 5, data: { filter: false, oil: '5w30' } },
    { id: 6, performed_at: entry.performedAt, odometer_miles: 135000,
      notes: entry.notes, result: entry.result, data: entry.data },
  ];
  const unique = getUniqueMaintenanceHistory(entries);
  assert.equal(unique.length, 4);
  assert.equal(unique[0].id, 3);
  assert.equal(entries.length, 6);
  assert.equal(getUniqueMaintenanceHistory([]).length, 0);
});
