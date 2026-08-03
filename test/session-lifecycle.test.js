import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VaaniObserver } from '../src/index.js';
import { newObserver, readEvents, readManifest, tempDir, PCM } from './helpers.js';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('generates a session id and directory when none is supplied', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  assert.match(session.id, /^[0-9a-f-]{36}$/);
  assert.equal(session.directory, join(vaani.options.spoolDirectory, session.id));
  assert.equal(session.agentId, null);
  assert.deepEqual(session.metadata, {});
  assert.ok(!Number.isNaN(Date.parse(session.startedAt)));
  await session.end();
});

test('creates the spool directory eagerly, before any data is recorded', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  await session.ready;
  assert.equal(await exists(session.directory), true);
  await session.end();
});

test('writes a complete manifest for a finalized session', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession({ sessionId: 'call-1', agentId: 'support', metadata: { env: 'test', region: 'in' } });
  const result = await session.end({ outcome: 'completed' });
  assert.deepEqual(Object.keys(result), ['sessionId', 'directory', 'manifest']);
  const manifest = await readManifest(result.directory);
  assert.equal(manifest.schema_version, '1.0');
  assert.deepEqual(manifest.sdk, { name: '@vaanieal/observer', language: 'nodejs', version: '0.1.0' });
  assert.equal(manifest.session_id, 'call-1');
  assert.equal(manifest.agent_id, 'support');
  assert.deepEqual(manifest.metadata, { env: 'test', region: 'in' });
  assert.equal(manifest.outcome, 'completed');
  assert.ok(manifest.duration_ms >= 0);
  assert.deepEqual(manifest.audio, {});
});

test('defaults the outcome to unknown when end() gets no input', async () => {
  const vaani = await newObserver();
  const { directory } = await vaani.startSession().end();
  assert.equal((await readManifest(directory)).outcome, 'unknown');
});

test('reports instrumentation state through capture_status', async () => {
  const enabled = await newObserver({ instrumentations: { fetch: false, websocket: true } });
  const disabled = await newObserver({ instrumentations: { fetch: false, websocket: false } });
  const first = await enabled.startSession().end();
  const second = await disabled.startSession().end();
  assert.equal(first.manifest.capture_status.websocket_instrumentation, 'active');
  assert.equal(first.manifest.capture_status.http_instrumentation, 'disabled');
  assert.equal(second.manifest.capture_status.websocket_instrumentation, 'disabled');
  assert.deepEqual(
    { ...first.manifest.capture_status },
    {
      events_complete: true,
      caller_audio_complete: true,
      agent_audio_complete: true,
      http_instrumentation: 'disabled',
      websocket_instrumentation: 'active',
      dropped_event_count: 0,
      dropped_audio_chunk_count: 0,
    },
  );
});

test('publishes the manifest atomically and leaves no temporary file behind', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1]), PCM);
  const { directory } = await session.end();
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, ['caller.audio', 'events.jsonl', 'manifest.json']);
});

test('is idempotent: a second end() resolves to the first finalized package', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const first = await session.end({ outcome: 'completed' });
  const second = await session.end({ outcome: 'failed' });
  assert.equal(second, first);
  assert.equal((await readManifest(first.directory)).outcome, 'completed');
});

test('resolves session.finished with the same package that end() returns', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const result = await session.end();
  assert.equal(await session.finished, result);
});

test('drops every kind of record written after the session ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  const { directory } = await session.end();
  operation.end({ status: 'ok' });
  session.recordWebSocketEvent({ phase: 'close' });
  session.recordInboundAudio(Buffer.from([1]), PCM);
  await settle();
  assert.deepEqual(await readEvents(directory), []);
});

test('flush waits for every in-flight session and then resolves immediately', async () => {
  const vaani = await newObserver();
  const first = vaani.startSession();
  const second = vaani.startSession();
  let flushed = false;
  const flushing = vaani.flush().then(() => { flushed = true; });
  await settle();
  assert.equal(flushed, false);
  await first.end();
  await second.end();
  await flushing;
  assert.equal(flushed, true);
  await vaani.flush();
});

test('flush resolves when no session was ever started', async () => {
  const vaani = await newObserver();
  await vaani.flush();
});

test('degrades capture_status instead of throwing when a write fails in default mode', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  await session.ready;
  // Make the audio track path unwritable so the queued append fails.
  await mkdir(join(session.directory, 'caller.audio'));
  session.recordInboundAudio(Buffer.from([1]), PCM);
  const { directory } = await session.end();
  const manifest = await readManifest(directory);
  assert.equal(manifest.capture_status.events_complete, false);
  assert.ok(manifest.capture_status.dropped_event_count >= 1);
});

test('propagates write failures from end() in strict mode', async () => {
  const vaani = await newObserver({ strict: true });
  const session = vaani.startSession();
  await session.ready;
  await mkdir(join(session.directory, 'caller.audio'));
  session.recordInboundAudio(Buffer.from([1]), PCM);
  await assert.rejects(session.end(), (error) => error instanceof Error);
  await assert.rejects(session.finished);
  assert.equal(await exists(join(session.directory, 'manifest.json')), false);
});

test('fails the session when its spool directory cannot be created', async () => {
  const root = await tempDir();
  const blocker = join(root, 'blocker');
  await writeFile(blocker, 'not a directory');
  const vaani = new VaaniObserver({ spoolDirectory: blocker, instrumentations: { fetch: false } });
  const session = vaani.startSession();
  session.ready.catch(() => {});
  session.recordInboundAudio(Buffer.from([1]), PCM);
  await assert.rejects(session.end(), (error) => ['ENOTDIR', 'EEXIST'].includes(error.code));
  await settle();
  assert.equal(session.captureStatus.events_complete, false);
});

test('keeps concurrent sessions isolated on disk', async () => {
  const vaani = await newObserver();
  const first = vaani.startSession({ sessionId: 'a' });
  const second = vaani.startSession({ sessionId: 'b' });
  first.recordInboundAudio(Buffer.from([1]), PCM);
  second.recordInboundAudio(Buffer.from([2, 2]), PCM);
  const [one, two] = await Promise.all([first.end(), second.end()]);
  assert.notEqual(one.directory, two.directory);
  assert.equal((await readEvents(one.directory))[0].byte_length, 1);
  assert.equal((await readEvents(two.directory))[0].byte_length, 2);
});

test('preserves event ordering under interleaved writes', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  for (let index = 0; index < 25; index += 1) {
    session.recordInboundAudio(Buffer.alloc(index + 1), PCM);
  }
  const { directory } = await session.end();
  const events = await readEvents(directory);
  assert.equal(events.length, 25);
  assert.deepEqual(events.map((event) => event.byte_length), Array.from({ length: 25 }, (_, index) => index + 1));
});
