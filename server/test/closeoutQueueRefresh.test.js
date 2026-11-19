const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('open closeouts survive fast/full refreshes and display limits, then clear on close', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/MessagesPanel.jsx'), 'utf8');
  const start = source.indexOf('  async function loadMessages(');
  const end = source.indexOf('  useEffect(', start);
  let response = [];
  let rendered = [];
  let diagnosticsStatus;
  const state = {
    messageMode: 'live', selectedTrip: null, focusedCloseoutTask: null,
    messageRequestRef: { current: null }, messagesRef: { current: [] },
    lastFullQueueRefreshAtRef: { current: Date.now() }, forceMessageQueueRefreshRef: { current: false },
    completedSyntheticTaskIdsRef: { current: new Set() }, seenIdsRef: { current: new Set() },
    knownQueueItemIdsRef: { current: new Set() }, queueChimeWatermarkRef: { current: Date.now() },
    highlightTimeoutRef: { current: null }, audioRef: { current: null },
    fetch: async () => ({ ok: true, headers: { get: () => null }, json: async () => response }),
    performance: { now: () => 0 }, window: { localStorage: { getItem: () => null } }, console,
    isCloseoutTask: m => m.type === 'closeout_required',
    isFullQueueOnlyItem: m => m.type === 'maintenance_brief',
    isCompletableSyntheticTask: () => false, wasRecentlyResolved: () => false,
    getNotificationCreatedAtMs: () => 0,
    setMessages: items => { rendered = items; },
    setDiagnosticsStatus: value => { diagnosticsStatus = value; },
  };
  for (const name of ['setLoading', 'setQueueStatus', 'setError', 'setLastMessagesCheckedAt',
    'setNewMessageIds', 'writeLiveMessageQueueCache']) state[name] = () => {};
  const context = vm.createContext(state);
  vm.runInContext(source.slice(start, end), context);
  const notice = { id: 'closeout:1', trip_id: 1, type: 'closeout_required' };
  response = [...Array.from({ length: 12 }, (_, id) => ({ id, type: 'guest_message' })), notice];
  await context.loadMessages(false);
  assert.ok(rendered.some(m => m.id === notice.id));
  state.lastFullQueueRefreshAtRef.current = 0;
  await context.loadMessages(false);
  assert.ok(rendered.some(m => m.id === notice.id));
  response = [];
  await context.loadMessages(false);
  assert.equal(rendered.some(m => m.id === notice.id), false);
  assert.equal(state.messageRequestRef.current, null);

  const returnReminder = { id: 'return-message:7:due', trip_id: 7, type: 'return_message_required', status: 'read' };
  response = [...Array.from({ length: 12 }, (_, id) => ({ id, type: 'guest_message' })), returnReminder];
  await context.loadMessages(false);
  assert.ok(rendered.some(m => m.id === returnReminder.id));
  response = [];
  await context.loadMessages(false);
  assert.equal(rendered.some(m => m.id === returnReminder.id), false);

  // Urgent OBD2 notices arrive on fast polls even when more than ten other
  // items precede them, and a subsequent clear from the server removes them.
  const diagnostic = { id: 'diagnostic:7', type: 'vehicle_diagnostic_alert', status: 'read' };
  response = {
    items: [...Array.from({ length: 12 }, (_, id) => ({ id, type: 'guest_message' })), diagnostic],
    diagnostics: { checkedAt: '2026-10-31T12:00:00Z', refreshing: true, stale: true },
  };
  state.lastFullQueueRefreshAtRef.current = Date.now();
  await context.loadMessages(false);
  assert.ok(rendered.some(m => m.id === diagnostic.id));
  assert.equal(diagnosticsStatus, response.diagnostics);
  response = [];
  await context.loadMessages(false);
  assert.equal(rendered.some(m => m.id === diagnostic.id), false);

  // A trip's historical read messages must stay cleared even without a
  // temporary recently-resolved entry; a fresh unread reply still appears.
  context.messageMode = 'trip';
  context.selectedTrip = { id: 1 };
  response = [
    { id: 201, type: 'guest_message', status: 'read' },
    { id: 202, message_type: 'guest_message', status: 'read' },
    { id: 'thread:1', type: 'guest_message_thread', status: 'read' },
    { id: 203, type: 'guest_message', status: 'unread' },
    { id: 204, type: 'trip_booked', status: 'read' },
  ];
  await context.loadMessages(false);
  assert.deepEqual(Array.from(rendered, m => m.id), [203, 204]);
  await context.loadMessages(false);
  assert.deepEqual(Array.from(rendered, m => m.id), [203, 204]);

  // An action must bypass both the minute throttle and an older in-flight poll.
  context.messageMode = 'live';
  context.selectedTrip = null;
  state.lastFullQueueRefreshAtRef.current = Date.now();
  state.forceMessageQueueRefreshRef.current = true;
  let finishOldPoll;
  const endpoints = [];
  context.fetch = async endpoint => {
    endpoints.push(endpoint);
    if (endpoints.length === 1) return new Promise(resolve => { finishOldPoll = resolve; });
    return { ok: true, json: async () => [{ id: 'inspection:1', type: 'inspection_export_required' }] };
  };
  const oldPoll = context.loadMessages(false);
  await context.loadMessages(false, { forceFull: true });
  assert.match(endpoints[0], /fast=1/);
  assert.doesNotMatch(endpoints[1], /fast=1/);
  finishOldPoll({ ok: true, json: async () => [{ id: 'handoff:1', type: 'handoff_ready_required' }] });
  await oldPoll;
  assert.deepEqual(Array.from(rendered, m => m.id), ['inspection:1']);
});

test('handoff success clears the task before refresh; stage failures retain it and show errors', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/MessagesPanel.jsx'), 'utf8');
  const start = source.indexOf('async function handleAdvanceToReadyForHandoff(');
  const end = source.indexOf('async function handleExportPrepSheet(', start);
  const task = { id: 'handoff:7', trip_id: 7 };
  for (const succeeds of [true, false]) {
    let rendered = [task];
    let error = '';
    let busy;
    let refreshed = false;
    const remembered = [];
    const state = {
      API_BASE: '', messagesRef: { current: [task] },
      setMessages: update => { rendered = update(rendered); },
      setNewMessageIds: update => update([task.id]),
      setError: value => { error = value; },
      setReadyingHandoffMessageId: value => { busy = value; },
      rememberResolvedMessages: ids => remembered.push(...ids),
      invalidateLiveQueueCache() {}, notifyMessageStatsUpdated() {},
      fetch: async () => ({ ok: succeeds, status: 409, json: async () => ({ error: 'Prep incomplete' }) }),
      loadMessages: async (initial, options) => {
        assert.equal(rendered.length, 0);
        assert.equal(state.messagesRef.current.length, 0);
        assert.equal(options.forceFull, true);
        refreshed = true;
      },
    };
    const context = vm.createContext(state);
    vm.runInContext(source.slice(start, end), context);
    await context.handleAdvanceToReadyForHandoff(task);
    assert.equal(refreshed, succeeds);
    assert.equal(rendered.length, succeeds ? 0 : 1);
    assert.equal(error, succeeds ? '' : 'Prep incomplete');
    assert.deepEqual(remembered, succeeds ? [task.id] : []);
    assert.equal(busy, null);
  }
});
