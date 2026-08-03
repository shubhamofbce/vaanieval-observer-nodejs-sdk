import test from 'node:test';
import assert from 'node:assert/strict';
import { VaaniObserver } from '../src/index.js';

function observer(endpoints) {
  return new VaaniObserver({ endpoints, instrumentations: { fetch: false } });
}

test('returns undefined when no rule is configured', () => {
  assert.equal(observer([]).classifyUrl('https://api.example.com/v1/chat'), undefined);
});

test('matches a path prefix and ignores the query string', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }]);
  assert.equal(vaani.classifyUrl('https://api.example.com/v1/chat?token=secret').id, 'llm');
  assert.equal(vaani.classifyUrl('https://api.example.com/v1').id, 'llm');
});

test('does not match a sibling path outside the configured prefix', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1/chat' }]);
  assert.equal(vaani.classifyUrl('https://api.example.com/v2/chat'), undefined);
});

test('treats the prefix as a raw string prefix, not a path segment boundary', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }]);
  // Documents current behaviour: /v10 shares the /v1 string prefix and matches.
  assert.equal(vaani.classifyUrl('https://api.example.com/v10/chat').id, 'llm');
});

test('requires the protocol to match', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }]);
  assert.equal(vaani.classifyUrl('http://api.example.com/v1/chat'), undefined);
});

test('requires the host, including the port, to match', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com:8443/v1' }]);
  assert.equal(vaani.classifyUrl('https://api.example.com/v1/chat'), undefined);
  assert.equal(vaani.classifyUrl('https://other.example.com:8443/v1/chat'), undefined);
  assert.equal(vaani.classifyUrl('https://api.example.com:8443/v1/chat').id, 'llm');
});

test('treats the default port as equivalent to an omitted port', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com:443/v1' }]);
  assert.equal(vaani.classifyUrl('https://api.example.com/v1/chat').id, 'llm');
});

test('matches every path under an origin rule', () => {
  const vaani = observer([{ id: 'tts', type: 'tts', url: 'https://tts.example.com/ignored/path', match: 'origin' }]);
  assert.equal(vaani.classifyUrl('https://tts.example.com/').id, 'tts');
  assert.equal(vaani.classifyUrl('https://tts.example.com/anything/else?x=1').id, 'tts');
  assert.equal(vaani.classifyUrl('https://other.example.com/ignored/path'), undefined);
});

test('requires both path and query to match an exact rule', () => {
  const vaani = observer([{ id: 'stt', type: 'stt', url: 'https://stt.example.com/v1/listen?model=a', match: 'exact' }]);
  assert.equal(vaani.classifyUrl('https://stt.example.com/v1/listen?model=a').id, 'stt');
  assert.equal(vaani.classifyUrl('https://stt.example.com/v1/listen?model=b'), undefined);
  assert.equal(vaani.classifyUrl('https://stt.example.com/v1/listen'), undefined);
  assert.equal(vaani.classifyUrl('https://stt.example.com/v1/listen/extra?model=a'), undefined);
});

test('throws when two rules match the same URL', () => {
  const vaani = observer([
    { id: 'a', type: 'llm', url: 'https://api.example.com/v1' },
    { id: 'b', type: 'tts', url: 'https://api.example.com/v1' },
  ]);
  assert.throws(() => vaani.classifyUrl('https://api.example.com/v1/chat'), /Ambiguous/);
});

test('does not throw when overlapping rules disambiguate by path', () => {
  const vaani = observer([
    { id: 'chat', type: 'llm', url: 'https://api.example.com/v1/chat' },
    { id: 'speak', type: 'tts', url: 'https://api.example.com/v1/speak' },
  ]);
  assert.equal(vaani.classifyUrl('https://api.example.com/v1/chat/completions').id, 'chat');
  assert.equal(vaani.classifyUrl('https://api.example.com/v1/speak').id, 'speak');
});

test('classifies websocket URLs by protocol', () => {
  const vaani = observer([{ id: 'stt', type: 'stt', url: 'wss://stt.example.com/stream' }]);
  assert.equal(vaani.classifyUrl('wss://stt.example.com/stream?lang=en').id, 'stt');
  assert.equal(vaani.classifyUrl('https://stt.example.com/stream'), undefined);
});

test('accepts a URL instance as well as a string', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }]);
  assert.equal(vaani.classifyUrl(new URL('https://api.example.com/v1/chat')).id, 'llm');
});

test('throws on input that is not a valid absolute URL', () => {
  const vaani = observer([{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }]);
  assert.throws(() => vaani.classifyUrl('/v1/chat'), TypeError);
  assert.throws(() => vaani.classifyUrl(undefined), TypeError);
});
