const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('reconciliation unread count stays visible but never plays the global mail chime', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/hooks/useMessageStats.ts'), 'utf8');
  const start = source.indexOf('  const loadMessageStats = useCallback(');
  const end = source.indexOf('}, [playMailChime, returnToStartup]);', start);
  const callback = source.slice(start, end).replace('const loadMessageStats = useCallback(', 'const loadMessageStats = ') + '};';
  let response = { unread: 0, chimeUnread: 0 };
  let chimes = 0;
  let displayed;
  const context = vm.createContext({ API_BASE: '', console,
    previousUnreadRef: { current: null }, lastChimeAtRef: { current: 0 },
    fetch: async () => ({ ok: true, text: async () => JSON.stringify(response) }),
    playMailChime: () => { chimes++; }, setMessageStats: value => { displayed = value; },
    setMessageStatsRefreshing() {}, setMessageStatsLoading() {}, isBackendUnavailableError: () => false,
  });
  vm.runInContext(callback, context);
  await vm.runInContext('loadMessageStats()', context);
  response = { unread: 1, chimeUnread: 0 };
  for (let i = 0; i < 4; i++) await vm.runInContext('loadMessageStats()', context);
  assert.equal(chimes, 0);
  assert.equal(displayed.unread, 1);
  response = { unread: 2, chimeUnread: 1 };
  await vm.runInContext('loadMessageStats()', context);
  assert.equal(chimes, 1);
  assert.equal(displayed.unread, 2);
  await vm.runInContext('loadMessageStats()', context);
  assert.equal(chimes, 1);
});

test('queue refresh keeps reconciliation visible and silent even if its row ID changes', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/MessagesPanel.jsx'), 'utf8');
  const start = source.indexOf('  async function loadMessages(');
  const end = source.indexOf('  useEffect(', start);
  let response = [];
  let rendered = [];
  let chimes = 0;
  const context = vm.createContext({
    messageMode: 'live', selectedTrip: null, focusedCloseoutTask: null,
    messageRequestRef: { current: null }, messagesRef: { current: [] },
    lastFullQueueRefreshAtRef: { current: Date.now() }, forceMessageQueueRefreshRef: { current: false },
    completedSyntheticTaskIdsRef: { current: new Set() }, seenIdsRef: { current: new Set() },
    knownQueueItemIdsRef: { current: new Set() }, queueChimeWatermarkRef: { current: Date.now() },
    highlightTimeoutRef: { current: null }, audioRef: { current: { play: async () => { chimes++; } } },
    fetch: async () => ({ ok: true, headers: { get: () => null }, json: async () => response }),
    performance: { now: () => 0 }, window: { localStorage: { getItem: () => null } }, console,
    isCloseoutTask: () => false, isFullQueueOnlyItem: () => false,
    isCompletableSyntheticTask: () => false, wasRecentlyResolved: () => false,
    getNotificationCreatedAtMs: () => Date.now(),
    setMessages: items => { rendered = items; },
    setLoading() {}, setQueueStatus() {}, setError() {}, setLastMessagesCheckedAt() {},
    setNewMessageIds() {}, writeLiveMessageQueueCache() {}, setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(source.slice(start, end), context);
  for (let id = 1; id <= 3; id++) {
    response = [{ id, type: 'banking_reconciliation_required', status: 'unread' }];
    await context.loadMessages(false);
    assert.equal(rendered.length, 1);
  }
  assert.equal(chimes, 0);
  response.push({ id: 10, type: 'guest_message', status: 'unread' });
  await context.loadMessages(false);
  assert.equal(chimes, 1);
});
