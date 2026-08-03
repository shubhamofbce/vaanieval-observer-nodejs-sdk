import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { VaaniObserver } from '../src/index.js';

function observer(options = {}) {
  return new VaaniObserver({ instrumentations: { fetch: false }, ...options });
}

test('applies documented defaults when constructed with no options', () => {
  const vaani = observer();
  assert.equal(vaani.options.endpoint, undefined);
  assert.equal(vaani.options.apiKey, undefined);
  assert.equal(vaani.options.spoolDirectory, join(process.cwd(), '.vaani-spool'));
  assert.deepEqual(vaani.options.capture, { audio: true, httpBodies: false, websocketTextFrames: false, payloadMaxBytes: 16 * 1024 });
  assert.deepEqual(vaani.options.endpoints, []);
  assert.deepEqual(vaani.options.upload, { retries: 3 });
  assert.equal(vaani.options.strict, false);
  assert.deepEqual(vaani.endpointRules, []);
});

test('merges partial capture and instrumentation options instead of replacing them', () => {
  const vaani = observer({ capture: { audio: false }, instrumentations: { fetch: false, websocket: false } });
  assert.deepEqual(vaani.options.capture, { audio: false, httpBodies: false, websocketTextFrames: false, payloadMaxBytes: 16 * 1024 });
  assert.deepEqual(vaani.options.instrumentations, { fetch: false, websocket: false });
});

test('websocket instrumentation stays enabled when only fetch is disabled', () => {
  assert.equal(observer().options.instrumentations.websocket, true);
});

test('merges partial upload options with the default retry count', () => {
  assert.deepEqual(observer({ upload: { retries: 0 } }).options.upload, { retries: 0 });
  assert.deepEqual(observer({ upload: { timeoutMs: 10 } }).options.upload, { retries: 3, timeoutMs: 10 });
});

test('treats a nullish endpoints option as an empty rule set', () => {
  assert.deepEqual(observer({ endpoints: null }).endpointRules, []);
  assert.deepEqual(observer({ endpoints: undefined }).endpointRules, []);
});

test('normalizes endpoint rules with a parsed URL and a default path match', () => {
  const vaani = observer({ endpoints: [{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }] });
  const [rule] = vaani.endpointRules;
  assert.equal(rule.id, 'llm');
  assert.equal(rule.match, 'path');
  assert.ok(rule.url instanceof URL);
  assert.equal(rule.url.href, 'https://api.example.com/v1');
});

test('preserves an explicit match strategy and extra rule fields', () => {
  const [rule] = observer({
    endpoints: [{ id: 'tts', type: 'tts', url: 'https://tts.example.com/', match: 'origin', provider: 'acme' }],
  }).endpointRules;
  assert.equal(rule.match, 'origin');
  assert.equal(rule.provider, 'acme');
});

test('rejects endpoint rules that are missing required fields', () => {
  assert.throws(() => observer({ endpoints: [{ type: 'llm', url: 'https://a.example.com' }] }), TypeError);
  assert.throws(() => observer({ endpoints: [{ id: 'a', url: 'https://a.example.com' }] }), TypeError);
  assert.throws(() => observer({ endpoints: [{ id: 'a', type: 'llm' }] }), TypeError);
  assert.throws(() => observer({ endpoints: [null] }), TypeError);
  assert.throws(() => observer({ endpoints: [{ id: '', type: 'llm', url: 'https://a.example.com' }] }), TypeError);
});

test('rejects endpoint types outside stt, llm and tts', () => {
  for (const type of ['http', 'STT', 'vad', '', 1]) {
    assert.throws(() => observer({ endpoints: [{ id: 'a', type, url: 'https://a.example.com' }] }), TypeError);
  }
});

test('accepts each supported endpoint type', () => {
  const vaani = observer({
    endpoints: [
      { id: 'a', type: 'stt', url: 'https://a.example.com' },
      { id: 'b', type: 'llm', url: 'https://b.example.com' },
      { id: 'c', type: 'tts', url: 'https://c.example.com' },
    ],
  });
  assert.deepEqual(vaani.endpointRules.map((rule) => rule.type), ['stt', 'llm', 'tts']);
});

test('rejects duplicate endpoint ids', () => {
  assert.throws(
    () => observer({
      endpoints: [
        { id: 'same', type: 'llm', url: 'https://a.example.com' },
        { id: 'same', type: 'tts', url: 'https://b.example.com' },
      ],
    }),
    /Duplicate endpoint id: same/,
  );
});

test('rejects an endpoint URL that cannot be parsed', () => {
  assert.throws(() => observer({ endpoints: [{ id: 'a', type: 'llm', url: 'not-a-url' }] }), TypeError);
});

test('does not mutate the caller supplied endpoint objects', () => {
  const input = { id: 'a', type: 'llm', url: 'https://a.example.com/v1' };
  observer({ endpoints: [input] });
  assert.equal(input.url, 'https://a.example.com/v1');
  assert.equal(input.match, undefined);
});
