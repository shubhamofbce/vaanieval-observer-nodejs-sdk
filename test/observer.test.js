import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaaniObserver } from '../src/index.js';

async function observer() {
  return new VaaniObserver({ spoolDirectory: await mkdtemp(join(tmpdir(), 'vaani-test-')), instrumentations: { fetch: false } });
}
async function packageFor(session) { const result = await session.end({ outcome: 'completed' }); return result; }

test('finalizes a portable manifest and independent audio tracks', async () => {
  const vaani = await observer();
  const session = vaani.startSession({ sessionId: 'call-1', agentId: 'agent-a', metadata: { env: 'test' } });
  session.recordInboundAudio(Buffer.from([1, 2]), { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1, timestampMs: 0 });
  session.recordOutboundAudio(Buffer.from([3]), { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1, timestampMs: 5 });
  const result = await packageFor(session);
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json')));
  assert.equal(manifest.session_id, 'call-1');
  assert.equal(manifest.audio.caller.sample_rate_hz, 16000);
  assert.deepEqual([...await readFile(join(result.directory, 'agent.audio'))], [3]);
});

test('writes append-only operation events with a turn correlation id', async () => {
  const vaani = await observer(); const session = vaani.startSession(); const turn = session.startTurn({ turnId: 'turn-1' });
  const operation = turn.startOperation({ type: 'stt', endpointId: 'stt', transport: 'manual' });
  operation.event('partial', { text_available: false }); operation.end({ status: 'ok' }); turn.end();
  const result = await packageFor(session);
  const events = (await readFile(join(result.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const event = events.find((item) => item.type === 'stt');
  assert.equal(event.turn_id, 'turn-1'); assert.equal(event.milestones.partial.text_available, false); assert.equal(event.status, 'ok');
});

test('rejects a changed audio format within one track', async () => {
  const vaani = await observer(); const session = vaani.startSession();
  session.recordInboundAudio(Buffer.from([1]), { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 });
  assert.throws(() => session.recordInboundAudio(Buffer.from([2]), { encoding: 'pcm_s16le', sampleRateHz: 8000, channels: 1 }), /cannot change/);
  await packageFor(session);
});

test('classifies configured URLs while ignoring query values', async () => {
  const vaani = new VaaniObserver({ spoolDirectory: await mkdtemp(join(tmpdir(), 'vaani-test-')), endpoints: [{ id: 'primary-llm', type: 'llm', url: 'https://api.example.com/v1/chat' }], instrumentations: { fetch: false } });
  assert.deepEqual(vaani.classifyUrl('https://api.example.com/v1/chat?token=secret'), { id: 'primary-llm', type: 'llm', url: new URL('https://api.example.com/v1/chat'), match: 'path' });
});

test('requires a scoped endpoint where URL rules are ambiguous', async () => {
  const vaani = new VaaniObserver({ spoolDirectory: await mkdtemp(join(tmpdir(), 'vaani-test-')), endpoints: [{ id: 'a', type: 'llm', url: 'https://api.example.com/v1' }, { id: 'b', type: 'tts', url: 'https://api.example.com/v1' }], instrumentations: { fetch: false } });
  assert.throws(() => vaani.classifyUrl('https://api.example.com/v1/chat'), /Ambiguous/);
  const session = vaani.startSession();
  assert.doesNotThrow(() => session.withEndpoint('b', () => {}));
  await packageFor(session);
});

test('stops accepting late audio once a session has ended', async () => {
  const vaani = await observer(); const session = vaani.startSession(); await packageFor(session);
  assert.equal(session.recordOutboundAudio(Buffer.from([1]), { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 }), false);
});
