const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('returning to the panel does not replay the startup snapshot after clearing a message', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/components/MessagesPanel.jsx'), 'utf8');
  // Support the repository's Windows line endings too.
  const normalized = source.replace(/\r\n/g, '\n');
  const effectStart = normalized.indexOf('  useEffect(() => {\n    audioRef.current');
  const effectEnd = normalized.indexOf('  }, [selectedTrip?.id, selectedTrip?.closed_out, messageMode]);', effectStart);
  const effect = normalized.slice(effectStart, effectEnd) + '  }, []);';
  let rendered;
  let cachedQueue = null;
  const loads = [];
  const state = {
    initialMessages: [{ id: 7, type: 'guest_message', status: 'unread' }],
    initialLoadComplete: true, messageMode: 'live', selectedTrip: null,
    consumedInitialLiveMessagesRef: { current: false },
    audioRef: {}, messagesRef: {}, queueChimeWatermarkRef: {}, messageRequestRef: {}, highlightTimeoutRef: {},
    seenIdsRef: { current: new Set() }, knownQueueItemIdsRef: { current: new Set() },
    completedSyntheticTaskIdsRef: { current: new Set() },
    useEffect: callback => callback(), Audio: function () {},
    readLiveMessageQueueCache: () => cachedQueue,
    wasRecentlyResolved: () => false, isCompletableSyntheticTask: () => false,
    setMessages: items => { rendered = items; },
    loadMessages: initial => loads.push(initial), loadMessageStats: () => {},
    setInterval: () => 1, clearInterval: () => {},
    setLoading: () => {}, setLastMessagesCheckedAt: () => {}, setNewMessageIds: () => {},
  };
  const context = vm.createContext(state);
  vm.runInContext('const consumedStartupMessageSnapshots = new WeakSet();', context);
  vm.runInContext(effect, context);
  assert.equal(rendered[0].id, 7);

  // Clear the message and navigate away. Simulate a new component instance,
  // with suppression already expired and no queue cache remaining.
  state.consumedInitialLiveMessagesRef.current = false;
  vm.runInContext(effect, context);
  assert.equal(rendered.length, 0);
  assert.deepEqual(loads, [true]);

  // A fresh reply in the current cache is still restored on a later visit.
  cachedQueue = { createdAt: Date.now(), items: [{ id: 8, type: 'guest_message', status: 'unread' }] };
  state.consumedInitialLiveMessagesRef.current = false;
  vm.runInContext(effect, context);
  assert.equal(rendered[0].id, 8);
  assert.deepEqual(loads, [true, false]);
});
