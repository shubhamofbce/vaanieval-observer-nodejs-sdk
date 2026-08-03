// The fetch instrumentation patches globalThis.fetch, so these tests live in
// their own file and always restore the original global.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VaaniObserver } from '../src/index.js';
import { readEvents, tempDir } from './helpers.js';

const ENDPOINTS = [
  { id: 'llm', type: 'llm', url: 'https://api.example.com/v1/chat' },
  { id: 'tts', type: 'tts', url: 'https://api.example.com/v1/speak' },
];

/**
 * Installs a recording base fetch, then constructs an observer that patches it.
 * Returns the observer plus a restore hook for the original global.
 */
async function instrumented(t, { responder, options = {} } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function baseFetch(input, init) {
    calls.push({ input, init, self: this });
    if (responder) return responder(input, init);
    return new Response('ok', { status: 200 });
  };
  const base = globalThis.fetch;
  const vaani = new VaaniObserver({ spoolDirectory: await tempDir(), endpoints: ENDPOINTS, ...options });
  t.after(() => { globalThis.fetch = original; });
  return { vaani, calls, base };
}

const operations = (events) => events.filter((event) => ['stt', 'llm', 'tts'].includes(event.type));

test('patches global fetch when the instrumentation is enabled', async (t) => {
  const { base } = await instrumented(t);
  assert.notEqual(globalThis.fetch, base);
  assert.equal(globalThis.fetch.name, 'observedFetch');
});

test('leaves global fetch untouched when the instrumentation is disabled', async (t) => {
  const { base } = await instrumented(t, { options: { instrumentations: { fetch: false } } });
  assert.equal(globalThis.fetch, base);
});

test('passes calls through untouched when there is no active session', async (t) => {
  const { calls } = await instrumented(t);
  const response = await fetch('https://api.example.com/v1/chat');
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test('records an operation for a classified call inside a session context', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => fetch('https://api.example.com/v1/chat/completions?key=secret'));
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.type, 'llm');
  assert.equal(event.endpoint_id, 'llm');
  assert.equal(event.transport, 'http');
  assert.equal(event.status, 'ok');
  assert.deepEqual(event.response, { status: 200 });
  assert.ok(event.duration_ms >= 0);
});

test('never records the request URL, headers or body', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => fetch('https://api.example.com/v1/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer super-secret' },
    body: JSON.stringify({ prompt: 'private text' }),
  }));
  const { directory } = await session.end();
  const raw = JSON.stringify(await readEvents(directory));
  assert.equal(raw.includes('super-secret'), false);
  assert.equal(raw.includes('private text'), false);
  assert.equal(raw.includes('api.example.com'), false);
});

test('captures bounded request and response bodies when explicitly enabled', async (t) => {
  const { vaani } = await instrumented(t, { options: { capture: { httpBodies: true, payloadMaxBytes: 12 } }, responder: () => new Response('response body that is longer', { status: 200 }) });
  const session = vaani.startSession();
  await session.run(() => fetch('https://api.example.com/v1/chat', { method: 'POST', body: 'request body that is longer' }));
  await new Promise((resolve) => setImmediate(resolve));
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.deepEqual(event.request.body, { _truncated: true, _original_bytes: 27, _preview: 'request body' });
  assert.deepEqual(event.response.body, { _truncated: true, _original_bytes: 28, _preview: 'response bod' });
});

test('marks a non-2xx response as an error while still returning it', async (t) => {
  const { vaani } = await instrumented(t, { responder: () => new Response('bad', { status: 503 }) });
  const session = vaani.startSession();
  const response = await session.run(() => fetch('https://api.example.com/v1/chat'));
  assert.equal(response.status, 503);
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.status, 'error');
  assert.deepEqual(event.response, { status: 503 });
});

test('records a transport failure and rethrows the original error', async (t) => {
  const { vaani } = await instrumented(t, { responder: () => { throw new TypeError('fetch failed'); } });
  const session = vaani.startSession();
  await assert.rejects(session.run(() => fetch('https://api.example.com/v1/chat')), /fetch failed/);
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.status, 'error');
  assert.deepEqual(event.error, { name: 'TypeError', message: 'fetch failed' });
  assert.equal(event.response.status, undefined);
});

test('ignores an unclassified URL inside a session context', async (t) => {
  const { vaani, calls } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => fetch('https://telemetry.example.com/collect'));
  const { directory } = await session.end();
  assert.equal(calls.length, 1);
  assert.deepEqual(operations(await readEvents(directory)), []);
});

test('lets a scoped endpoint id override URL classification', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.withEndpoint('tts', () => fetch('https://unmapped.example.com/anything'));
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.type, 'tts');
  assert.equal(event.endpoint_id, 'tts');
});

test('classifies a Request object by its url', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => fetch(new Request('https://api.example.com/v1/speak')));
  const { directory } = await session.end();
  assert.equal(operations(await readEvents(directory))[0].type, 'tts');
});

test('classifies a URL instance', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => fetch(new URL('https://api.example.com/v1/chat')));
  const { directory } = await session.end();
  assert.equal(operations(await readEvents(directory))[0].type, 'llm');
});

test('records one operation per concurrent call', async (t) => {
  const { vaani } = await instrumented(t);
  const session = vaani.startSession();
  await session.run(() => Promise.all([
    fetch('https://api.example.com/v1/chat'),
    fetch('https://api.example.com/v1/chat'),
    fetch('https://api.example.com/v1/speak'),
  ]));
  const { directory } = await session.end();
  const written = operations(await readEvents(directory));
  assert.equal(written.length, 3);
  assert.deepEqual(written.map((event) => event.type).sort(), ['llm', 'llm', 'tts']);
  assert.equal(new Set(written.map((event) => event.event_id)).size, 3);
});

test('does not record calls made after the session ended', async (t) => {
  const { vaani, calls } = await instrumented(t);
  const session = vaani.startSession();
  const { directory } = await session.end();
  await session.run(() => fetch('https://api.example.com/v1/chat'));
  assert.equal(calls.length, 1);
  assert.deepEqual(operations(await readEvents(directory)), []);
});

test('propagates an ambiguous rule error to the caller of fetch', async (t) => {
  const { vaani } = await instrumented(t, {
    options: {
      endpoints: [
        { id: 'a', type: 'llm', url: 'https://api.example.com/v1' },
        { id: 'b', type: 'tts', url: 'https://api.example.com/v1' },
      ],
    },
  });
  const session = vaani.startSession();
  await assert.rejects(session.run(() => fetch('https://api.example.com/v1/chat')), /Ambiguous/);
  await session.end();
});
