import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { newObserver, readEvents, readManifest, readTrack, PCM } from './helpers.js';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

test('writes caller and agent audio to independent append-only tracks', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1, 2]), PCM);
  session.recordInboundAudio(Buffer.from([3]), PCM);
  session.recordOutboundAudio(Buffer.from([9]), PCM);
  const { directory } = await session.end();
  assert.deepEqual([...await readTrack(directory, 'caller')], [1, 2, 3]);
  assert.deepEqual([...await readTrack(directory, 'agent')], [9]);
});

test('accepts a Uint8Array chunk as well as a Buffer', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio(new Uint8Array([7, 8]), PCM), true);
  const { directory } = await session.end();
  assert.deepEqual([...await readTrack(directory, 'caller')], [7, 8]);
});

test('rejects chunk types that are not byte containers', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  for (const chunk of ['abc', 42, null, undefined, {}, [1, 2], new ArrayBuffer(2)]) {
    assert.throws(() => session.recordInboundAudio(chunk, PCM), TypeError);
  }
  await session.end();
});

test('records a zero length chunk without creating a format conflict', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  assert.equal(session.recordOutboundAudio(Buffer.alloc(0), PCM), true);
  const { directory, manifest } = await session.end();
  assert.equal((await readTrack(directory, 'agent')).byteLength, 0);
  const events = await readEvents(directory);
  assert.equal(events.at(-1).byte_length, 0);
  assert.equal(manifest.audio.agent.encoding, 'pcm_s16le');
});

test('emits an audio_chunk event carrying the supplied timestamp and byte length', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1, 2, 3]), { ...PCM, timestampMs: 1234 });
  const { directory } = await session.end();
  const [event] = await readEvents(directory);
  assert.equal(event.kind, 'audio_chunk');
  assert.equal(event.track, 'caller');
  assert.equal(event.occurred_at_ms, 1234);
  assert.equal(event.byte_length, 3);
});

test('keeps outbound PCM on a real-time playback clock when TTS chunks arrive in a burst', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const frame = Buffer.alloc(320); // 10 ms of 16 kHz, mono, s16le PCM
  session.recordOutboundAudio(frame, { ...PCM, timestampMs: 50 });
  session.recordOutboundAudio(frame, { ...PCM, timestampMs: 51 });
  const { directory } = await session.end();
  const events = (await readEvents(directory)).filter((event) => event.track === 'agent');
  assert.deepEqual(events.map((event) => event.occurred_at_ms), [50, 60]);
  assert.deepEqual(events.map((event) => event.duration_ms), [10, 10]);
});

test('falls back to the session clock when no timestamp is supplied', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1]), PCM);
  const { directory } = await session.end();
  const [event] = await readEvents(directory);
  assert.equal(Number.isInteger(event.occurred_at_ms), true);
  assert.ok(event.occurred_at_ms >= 0);
});

test('locks the audio format per track and reports which track conflicted', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordOutboundAudio(Buffer.from([1]), PCM);
  assert.throws(() => session.recordOutboundAudio(Buffer.from([2]), { ...PCM, channels: 2 }), /agent audio format cannot change/);
  assert.throws(() => session.recordOutboundAudio(Buffer.from([2]), { ...PCM, encoding: 'opus' }), /agent audio format cannot change/);
  await session.end();
});

test('allows the two tracks to use different formats', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1]), { encoding: 'pcm_s16le', sampleRateHz: 8000, channels: 1 });
  session.recordOutboundAudio(Buffer.from([2]), { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 2 });
  const { manifest } = await session.end();
  assert.deepEqual(manifest.audio, {
    caller: { file: 'caller.audio', encoding: 'pcm_s16le', sample_rate_hz: 8000, channels: 1 },
    agent: { file: 'agent.audio', encoding: 'pcm_s16le', sample_rate_hz: 24000, channels: 2 },
  });
});

test('treats an omitted format as a format of undefined fields and keeps it stable', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio(Buffer.from([1])), true);
  assert.equal(session.recordInboundAudio(Buffer.from([2])), true);
  assert.throws(() => session.recordInboundAudio(Buffer.from([3]), PCM), /cannot change/);
  const { directory, manifest } = await session.end();
  assert.deepEqual(manifest.audio.caller, { file: 'caller.audio', encoding: undefined, sample_rate_hz: undefined, channels: undefined });
  // Undefined format fields are dropped by JSON serialization in the persisted manifest.
  assert.deepEqual((await readManifest(directory)).audio.caller, { file: 'caller.audio' });
});

test('ignores unrelated format fields such as timestampMs when comparing formats', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1]), { ...PCM, timestampMs: 0 });
  assert.doesNotThrow(() => session.recordInboundAudio(Buffer.from([2]), { ...PCM, timestampMs: 500 }));
  await session.end();
});

test('drops audio entirely when audio capture is disabled', async () => {
  const vaani = await newObserver({ capture: { audio: false } });
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio(Buffer.from([1]), PCM), false);
  assert.equal(session.recordOutboundAudio(Buffer.from([1]), PCM), false);
  const { directory, manifest } = await session.end();
  assert.deepEqual(manifest.audio, {});
  assert.equal(await exists(join(directory, 'caller.audio')), false);
  assert.deepEqual(await readEvents(directory), []);
});

test('skips validation when capture is disabled, so a bad chunk cannot throw', async () => {
  const vaani = await newObserver({ capture: { audio: false } });
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio('not-bytes', PCM), false);
  await session.end();
});

test('stops accepting audio after the session ends without creating files', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const { directory } = await session.end();
  assert.equal(session.recordInboundAudio(Buffer.from([1]), PCM), false);
  assert.equal(session.recordOutboundAudio(Buffer.from([1]), PCM), false);
  assert.equal(await exists(join(directory, 'caller.audio')), false);
  assert.deepEqual((await readManifest(directory)).audio, {});
});
