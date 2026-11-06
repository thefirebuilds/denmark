const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../node_modules/typescript');
const APP_EVENTS = { authRequired: 'auth-required', backendUnavailable: 'backend-unavailable' };
function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8')
    .replace('import.meta.env.VITE_API_BASE_URL', '""');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, require: name => dependencies[name], Error, TypeError, URL, Request, ...globals });
  vm.runInContext(code, context);
  return context.module.exports;
}
function environment() {
  const events = [];
  const window = { location: { origin: 'https://denmark.test' }, dispatchEvent: event => events.push(event.type), addEventListener() {}, removeEventListener() {} };
  const CustomEvent = class { constructor(type) { this.type = type; } };
  const api = load('lib/apiClient.ts', { '../app/appEvents': { APP_EVENTS } }, { window, CustomEvent });
  return { api, window, CustomEvent, events };
}

test('request-local 503 responses do not take the entire app back to startup', () => {
  const { api, events } = environment();
  api.emitApiFetchEvents(new Response('', { status: 503, headers: { 'X-Denmark-Error-Scope': 'request' } }));
  assert.deepEqual(events, []);
  assert.equal(api.isBackendUnavailableError(Object.assign(new Error('Failed to load message stats: 503'), { requestLocal: true })), false);
  api.emitApiFetchEvents(new Response('', { status: 503 }));
  api.emitApiFetchEvents(new Response('', { status: 502 }));
  api.emitApiFetchEvents(new Response('', { status: 401 }));
  assert.deepEqual(events, ['backend-unavailable', 'backend-unavailable', 'auth-required']);
});

test('cancelled API requests do not signal an outage; real fetch failures still do', async () => {
  const { api, window, CustomEvent, events } = environment();
  const controller = new AbortController(); controller.abort();
  let failure = new DOMException('cancelled', 'AbortError');
  window.fetch = async () => { throw failure; };
  const effects = [];
  const hooks = load('hooks/useBackendAvailability.ts', {
    react: { useEffect: effect => effects.push(effect) }, '../lib/apiClient': api, '../app/appEvents': { APP_EVENTS },
  }, { window, CustomEvent });
  hooks.useBackendAvailability(() => {});
  const cleanup = effects[0]();
  await assert.rejects(window.fetch('/api/metrics/summary', { signal: controller.signal }));
  assert.deepEqual(events, []);
  await assert.rejects(window.fetch(new Request('https://denmark.test/api/metrics/summary', { signal: controller.signal })));
  assert.deepEqual(events, []);
  failure = new TypeError('Failed to fetch');
  await assert.rejects(window.fetch('/api/metrics/summary'));
  assert.deepEqual(events, ['backend-unavailable']);
  cleanup();
});
