import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newObserver, readEvents, readManifest, readTrack, PCM } from './helpers.js';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function pcm(...samples) {
  const output = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => output.writeInt16LE(sample, index * 2));
  return output;
}

test('writes one timeline-aligned stereo recording with agent left and caller right', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(pcm(1000, 2000), { ...PCM, timestampMs: 0 });
  session.recordOutboundAudio(pcm(3000, 4000), { ...PCM, timestampMs: 0 });
  const { directory, manifest } = await session.end();
  const recording = await readTrack(directory, 'call');
  assert.deepEqual([...Array(4)].map((_, index) => recording.readInt16LE(index * 2)), [3000, 1000, 4000, 2000]);
  assert.deepEqual((await readdir(directory)).sort(), ['call.audio', 'events.jsonl', 'manifest.json']);
  assert.deepEqual(manifest.audio, {
    call: {
      file: 'call.audio',
      encoding: 'pcm_s16le',
      sample_rate_hz: 16000,
      channels: 2,
      channel_layout: { left: 'agent', right: 'caller' },
    },
  });
});

test('uses silence for a missing side', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(pcm(1234), { ...PCM, timestampMs: 0 });
  const { directory } = await session.end();
  const recording = await readTrack(directory, 'call');
  assert.deepEqual([recording.readInt16LE(0), recording.readInt16LE(2)], [0, 1234]);
});

test('resamples both sides to the higher source rate', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordInboundAudio(pcm(1000, 2000), { encoding: 'pcm_s16le', sampleRateHz: 8000, channels: 1, timestampMs: 0 });
  session.recordOutboundAudio(pcm(3000, 4000), { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1, timestampMs: 0 });
  const { directory, manifest } = await session.end();
  assert.equal(manifest.audio.call.sample_rate_hz, 24000);
  const recording = await readTrack(directory, 'call');
  const samples = [...Array(8)].map((_, index) => recording.readInt16LE(index * 2));
  assert.deepEqual(samples.filter((_, index) => index % 2 === 0), [3000, 4000, 0, 0]);
  assert.deepEqual(samples.filter((_, index) => index % 2 === 1), [1000, 1333, 1667, 2000]);
});

test('accepts a Uint8Array chunk as well as a Buffer', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio(new Uint8Array([7, 8]), { ...PCM, timestampMs: 0 }), true);
  const { directory } = await session.end();
  assert.deepEqual([...await readTrack(directory, 'call')].slice(2, 4), [7, 8]);
});

test('rejects invalid chunk and format inputs', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  for (const chunk of ['abc', 42, null, undefined, {}, [1, 2], new ArrayBuffer(2)]) {
    assert.throws(() => session.recordInboundAudio(chunk, PCM), TypeError);
  }
  assert.throws(() => session.recordInboundAudio(pcm(1), { encoding: 'opus', sampleRateHz: 48000, channels: 1 }), /pcm_s16le/);
  assert.throws(() => session.recordInboundAudio(pcm(1), { encoding: 'pcm_s16le', channels: 1 }), /sampleRateHz/);
  assert.throws(() => session.recordInboundAudio(pcm(1), { encoding: 'pcm_s16le', sampleRateHz: 16000 }), /channel/);
  await session.end();
});

test('emits source audio events and paces bursty outbound PCM', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const frame = Buffer.alloc(320);
  session.recordOutboundAudio(frame, { ...PCM, timestampMs: 50 });
  session.recordOutboundAudio(frame, { ...PCM, timestampMs: 51 });
  const { directory } = await session.end();
  const events = (await readEvents(directory)).filter((event) => event.track === 'agent');
  assert.deepEqual(events.map((event) => event.occurred_at_ms), [50, 60]);
  assert.deepEqual(events.map((event) => event.duration_ms), [10, 10]);
});

test('records outbound TTS ownership and the scheduled playout clock', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const frame = Buffer.alloc(320);
  const tts = session.startOperation({ type: 'tts', turnId: 'turn-2', eventId: 'tts-2' });
  assert.equal(tts.id, 'tts-2');
  session.recordOutboundAudio(frame, { ...PCM, timestampMs: 50, playoutAtMs: 200, turnId: 'turn-2', operationId: tts.id });
  tts.end();
  const { directory } = await session.end();
  const event = (await readEvents(directory)).find((item) => item.track === 'agent');
  assert.deepEqual(event, {
    kind: 'audio_chunk', track: 'agent', occurred_at_ms: 200, playout_at_ms: 200,
    turn_id: 'turn-2', operation_id: 'tts-2', byte_length: 320, duration_ms: 10,
  });
});

test('does not advance the caller clock by PCM duration', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const frame = Buffer.alloc(320);
  session.recordInboundAudio(frame, { ...PCM, timestampMs: 50 });
  session.recordInboundAudio(frame, { ...PCM, timestampMs: 51 });
  const { directory } = await session.end();
  const events = (await readEvents(directory)).filter((event) => event.track === 'caller');
  assert.deepEqual(events.map((event) => event.occurred_at_ms), [50, 51]);
});

test('locks the audio format per source', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordOutboundAudio(pcm(1), PCM);
  assert.throws(() => session.recordOutboundAudio(pcm(2, 3), { ...PCM, channels: 2 }), /agent audio format cannot change/);
  await session.end();
});

test('drops audio entirely when capture is disabled', async () => {
  const vaani = await newObserver({ capture: { audio: false } });
  const session = vaani.startSession();
  assert.equal(session.recordInboundAudio('not-bytes', {}), false);
  const { directory, manifest } = await session.end();
  assert.deepEqual(manifest.audio, {});
  assert.equal(await exists(join(directory, 'call.audio')), false);
  assert.deepEqual(await readEvents(directory), []);
});

test('stops accepting audio after the session ends', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const { directory } = await session.end();
  assert.equal(session.recordInboundAudio(pcm(1), PCM), false);
  assert.equal(await exists(join(directory, 'call.audio')), false);
  assert.deepEqual((await readManifest(directory)).audio, {});
});
