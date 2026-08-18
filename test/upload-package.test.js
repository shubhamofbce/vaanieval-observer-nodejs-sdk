import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VaaniObserver } from '../src/index.js';
import { sha256 } from '../src/session.js';
import { newObserver, tempDir, stubFetch, jsonResponse, PCM } from './helpers.js';

const UPLOAD_URLS = {
  'events.jsonl': 'https://objects.example.com/events',
  'call.audio': 'https://objects.example.com/call',
};

function uploader(options = {}) {
  return new VaaniObserver({ endpoint: 'https://ingest.example.com', apiKey: 'test-key', instrumentations: { fetch: false }, ...options });
}

/** Produces a finalized package containing events.jsonl plus one stereo recording. */
async function fullPackage(sessionId = 'call-1') {
  const vaani = await newObserver();
  const session = vaani.startSession({ sessionId, agentId: 'support' });
  session.recordInboundAudio(Buffer.from([1, 0]), { ...PCM, timestampMs: 0 });
  session.recordOutboundAudio(Buffer.from([3, 0]), { ...PCM, timestampMs: 0 });
  session.startOperation({ type: 'llm' }).end();
  return session.end({ outcome: 'completed' });
}

/** Produces a finalized package with events.jsonl but no audio files at all. */
async function eventsOnlyPackage() {
  const vaani = await newObserver();
  const session = vaani.startSession({ sessionId: 'call-2' });
  session.startOperation({ type: 'stt' }).end();
  return session.end();
}

function defaultHandler(call, index) {
  if (index === 1) return jsonResponse({ session_id: 'call-1', upload_urls: UPLOAD_URLS }, 201);
  if (call.method === 'PUT') return new Response(null, { status: 204 });
  return jsonResponse({ session_id: 'call-1', status: 'ready', operation_count: 1 }, 202);
}

test('refuses to upload without an endpoint and api key', async () => {
  const finalized = await fullPackage();
  await assert.rejects(uploader({ endpoint: undefined }).uploadPackage(finalized), /endpoint and apiKey are required/);
  await assert.rejects(uploader({ apiKey: undefined }).uploadPackage(finalized), /endpoint and apiKey are required/);
  await assert.rejects(new VaaniObserver({ instrumentations: { fetch: false } }).uploadPackage(finalized), /endpoint and apiKey are required/);
});

test('performs create, per-object upload and complete in order', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  const result = await uploader().uploadPackage(finalized);
  assert.deepEqual(result, { session_id: 'call-1', status: 'ready', operation_count: 1 });
  assert.deepEqual(fetcher.calls.map((call) => `${call.method} ${call.url}`), [
    'POST https://ingest.example.com/v1/sessions',
    'PUT https://objects.example.com/events',
    'PUT https://objects.example.com/call',
    'POST https://ingest.example.com/v1/sessions/call-1/complete',
  ]);
});

test('sends the manifest, auth and idempotency headers on the control calls', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  const [create, , , complete] = fetcher.calls;
  assert.deepEqual(JSON.parse(create.body), finalized.manifest);
  for (const call of [create, complete]) {
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['idempotency-key'], 'call-1');
    assert.ok(call.headers.authorization.includes('test-key'), 'authorization header must carry the api key');
  }
  assert.equal(fetcher.calls[1].headers.authorization, undefined, 'object PUTs must not leak the api key');
});

test('reports the byte size and sha256 of every uploaded object', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  const { objects } = JSON.parse(fetcher.calls.at(-1).body);
  assert.deepEqual(Object.keys(objects), ['events.jsonl', 'call.audio']);
  for (const [name, info] of Object.entries(objects)) {
    const bytes = await readFile(join(finalized.directory, name));
    assert.equal(info.byte_size, bytes.byteLength);
    assert.equal(info.sha256, sha256(bytes));
  }
  assert.ok(objects['call.audio'].byte_size >= 4);
});

test('uploads the exact file bytes', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  const call = fetcher.calls.find((item) => item.url.endsWith('/call'));
  assert.deepEqual([...call.body.subarray(0, 4)], [3, 0, 1, 0]);
});

test('normalizes a trailing slash on the configured endpoint', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader({ endpoint: 'https://ingest.example.com/' }).uploadPackage(finalized);
  assert.equal(fetcher.calls[0].url, 'https://ingest.example.com/v1/sessions');
});

test('url-encodes the session id in the complete path', async (t) => {
  const finalized = await fullPackage('call 1+a');
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  assert.equal(fetcher.calls.at(-1).url, 'https://ingest.example.com/v1/sessions/call%201%2Ba/complete');
});

test('skips objects that were never written to disk', async (t) => {
  const finalized = await eventsOnlyPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  assert.deepEqual(fetcher.calls.map((call) => call.method), ['POST', 'PUT', 'POST']);
  assert.deepEqual(Object.keys(JSON.parse(fetcher.calls.at(-1).body).objects), ['events.jsonl']);
});

test('completes with no objects when the package directory is empty', async (t) => {
  const vaani = await newObserver();
  const finalized = await vaani.startSession().end();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);

  await uploader().uploadPackage(finalized);
  assert.deepEqual(fetcher.calls.map((call) => call.method), ['POST', 'POST']);
  assert.deepEqual(JSON.parse(fetcher.calls.at(-1).body).objects, {});
});

test('fails when session creation is rejected', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(() => jsonResponse({ detail: 'nope' }, 400));
  t.after(fetcher.restore);

  await assert.rejects(uploader().uploadPackage(finalized), /Session creation failed: HTTP 400/);
  assert.equal(fetcher.calls.length, 1);
});

test('fails when the backend omits an upload url for a file that exists', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch((call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: { 'events.jsonl': UPLOAD_URLS['events.jsonl'] } }, 201);
    return new Response(null, { status: 204 });
  });
  t.after(fetcher.restore);

  await assert.rejects(uploader().uploadPackage(finalized), /did not provide an upload URL for call.audio/);
});

test('fails when the create response carries no upload_urls at all', async (t) => {
  const finalized = await eventsOnlyPackage();
  const fetcher = stubFetch(() => jsonResponse({ session_id: 'call-2' }, 201));
  t.after(fetcher.restore);

  await assert.rejects(uploader().uploadPackage(finalized), /did not provide an upload URL for events.jsonl/);
});

test('fails and stops when an object upload is rejected', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch((call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: UPLOAD_URLS }, 201);
    return new Response(null, { status: 500 });
  });
  t.after(fetcher.restore);

  await assert.rejects(
    uploader({ upload: { retries: 0 } }).uploadPackage(finalized),
    /Upload failed for events.jsonl: HTTP 500/,
  );
  // One create plus one PUT: the second object must not be attempted once the
  // first has failed, or a half-uploaded package looks complete.
  assert.equal(fetcher.calls.length, 2);
});

test('retries a failed object upload rather than discarding the recording', async (t) => {
  const finalized = await fullPackage();
  let puts = 0;
  const fetcher = stubFetch((call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: UPLOAD_URLS }, 201);
    if (call.method !== 'PUT') return jsonResponse({ status: 'ready' });
    puts += 1;
    return new Response(null, { status: puts === 1 ? 503 : 204 });
  });
  t.after(fetcher.restore);

  // `upload.retries` was configured from the first release and never read, so
  // a single 503 threw away a call that a retry would have delivered.
  await uploader({ upload: { retries: 3 } }).uploadPackage(finalized);
  assert.equal(puts, 3, 'the rejected object is re-sent, then the second is sent');
});

test('does not retry a rejection that says the request itself is wrong', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch((call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: UPLOAD_URLS }, 201);
    return new Response(null, { status: 400 });
  });
  t.after(fetcher.restore);

  // Re-sending identical bytes cannot fix a digest mismatch; it only burns the
  // shutdown window that the remaining objects need.
  await assert.rejects(uploader().uploadPackage(finalized), /Upload failed for events.jsonl: HTTP 400/);
  assert.equal(fetcher.calls.length, 2);
});

test('bounds a peer that accepts the connection and then never responds', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(async (call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: UPLOAD_URLS }, 201);
    // Never settles unless the caller aborts it.
    return new Promise((resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(call.init.signal.reason));
    });
  });
  t.after(fetcher.restore);

  // With no timeout at all -- the previous behaviour -- this hung until the
  // process was killed, which on a shutdown hook means the call is lost.
  await assert.rejects(
    uploader({ upload: { retries: 0, timeoutMs: 120 } }).uploadPackage(finalized),
    (error) => error.name === 'TimeoutError',
  );
});

test('fails when completion is rejected', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch((call, index) => {
    if (index === 1) return jsonResponse({ upload_urls: UPLOAD_URLS }, 201);
    if (call.method === 'PUT') return new Response(null, { status: 204 });
    return jsonResponse({ detail: 'checksum' }, 400);
  });
  t.after(fetcher.restore);

  await assert.rejects(uploader().uploadPackage(finalized), /Session completion failed: HTTP 400/);
});

test('propagates transport errors from the network layer', async (t) => {
  const finalized = await fullPackage();
  const fetcher = stubFetch(() => { throw new TypeError('fetch failed'); });
  t.after(fetcher.restore);

  await assert.rejects(uploader().uploadPackage(finalized), /fetch failed/);
});

test('propagates unexpected filesystem errors instead of skipping the object', async (t) => {
  const finalized = await eventsOnlyPackage();
  const fetcher = stubFetch(defaultHandler);
  t.after(fetcher.restore);
  // A directory in place of the events file yields EISDIR rather than ENOENT.
  const broken = { ...finalized, directory: await tempDir() };
  await mkdir(join(broken.directory, 'events.jsonl'));

  await assert.rejects(uploader().uploadPackage(broken), (error) => error.code === 'EISDIR');
});

test('sha256 produces the canonical digest of the given bytes', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
