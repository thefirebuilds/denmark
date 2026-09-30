const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../routes/messages.js'), 'utf8');
const start = source.indexOf('function mapLateTollNoticeRow(');
const end = source.indexOf('function getLocalDateKey(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

test('dismissed toll batches keep their identity until another toll arrives', () => {
  const row = { trip_id: 17, latest_recorded_at: '2026-09-28T15:14:00Z',
    late_toll_count: 3, late_toll_total: '4.01' };
  const notice = context.mapLateTollNoticeRow(row);
  assert.equal(notice.id, context.mapLateTollNoticeRow({ ...row }).id);
  assert.equal(notice.id, notice.messageId);
  assert.equal(notice.trip_id, 17);
  assert.notEqual(notice.id, context.mapLateTollNoticeRow({ ...row,
    latest_recorded_at: '2026-09-29T15:14:00Z', late_toll_count: 4 }).id);
});

test('late toll notice is only for closed trips with new charges above the billed total', () => {
  const sql = source.slice(source.indexOf('const lateTollSql ='), source.indexOf('const overlapSql ='));
  assert.match(sql, /AND t.closed_out = true/);
  assert.match(sql, /AND t.deleted_at IS NULL/);
  assert.match(sql, /tc.created_at > COALESCE\(t.closed_out_at, t.trip_end\)/);
  assert.match(sql, /HAVING COALESCE\(SUM\(tc.amount\), 0\) > COALESCE\(t.toll_charged_total, 0\)/);
  assert.doesNotMatch(sql, /'billed'|INTERVAL '1 hour'/);
  assert.match(sql, /t.toll_review_status, ''\) <> 'waived'/);
  assert.match(source, /db.query\(lateTollSql\)/);
});
