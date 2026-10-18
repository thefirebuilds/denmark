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
});
