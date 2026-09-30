const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, globals) {
  const context = vm.createContext({ module: { exports: {} }, ...globals });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services', file), 'utf8'), context);
  return context.module.exports;
}

test('approved replies are persisted with bound values and updated for the same message', async () => {
  const queries = [];
  const memory = load('guestReplyMemory.js', { require: () => ({ query: async (sql, values) => {
    queries.push({ sql, values }); return { rows: [{ id: 1 }] };
  } }) });
  await memory.saveExample({ messageKey: 'message:1', category: 'pickup', guestMessage: 'Where?', reply: 'Use the agreed pickup address.' });
  const query = queries.find(item => item.sql.includes('INSERT INTO guest_reply_examples'));
  assert.match(query.sql, /ON CONFLICT \(message_key\) DO UPDATE/);
  assert.equal(query.values[3], 'Use the agreed pickup address.');
  await assert.rejects(memory.saveExample({ messageKey: 'x', category: 'pickup', guestMessage: 'Where?', reply: '' }));
  await memory.deleteExample(1);
  assert.match(queries.at(-1).sql, /DELETE FROM guest_reply_examples WHERE id = \$1/);
});

test('reply generation includes owner profile, current guidance, thread and relevant approved examples', async () => {
  let calls = 0;
  const service = load('guestReplySuggestionService.js', {
    process: { env: { OPENAI_API_KEY: 'test' } }, AbortSignal,
    require: () => ({ getReplyContext: async () => ({ guidance: 'Friendly and specific; explain parking clearly.',
      examples: [{ category: 'pickup', guest_message: 'Where do I park?', reply: 'Use the marked visitor spaces.' }] }) }),
    fetch: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.store, false);
      assert.match(body.input[0].content[0].text, /Friendly and specific/);
      assert.match(body.input[0].content[0].text, /untrusted context/);
      const prompt = JSON.parse(body.input[1].content[0].text);
      assert.equal(prompt.guidanceForThisReply, 'Mention the blue sign.');
      assert.equal(prompt.approvedExamples[0].approvedReply, 'Use the marked visitor spaces.');
      assert.equal(prompt.latestGuestMessage, 'Where do I park?');
      return { ok: true, json: async () => ({ output_text: 'Look for the blue sign by the visitor spaces.' }) };
    },
  });
  const result = await service.suggestGuestReply({ latestMessage: 'Where do I park?', guidance: 'Mention the blue sign.', category: 'pickup' });
  assert.equal(calls, 1);
  assert.match(result.suggestion, /blue sign/);
});
