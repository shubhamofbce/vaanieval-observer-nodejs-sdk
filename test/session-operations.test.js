import test from 'node:test';
import assert from 'node:assert/strict';
import { newObserver, readEvents } from './helpers.js';

const operations = (events) => events.filter((event) => ['stt', 'llm', 'tts', 'tool'].includes(event.type));

test('fills operation defaults for a minimally specified operation', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession({ sessionId: 'call-1' });
  session.startOperation({ type: 'llm' }).end();
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.session_id, 'call-1');
  assert.equal(event.turn_id, null);
  assert.equal(event.endpoint_id, null);
  assert.equal(event.provider, null);
  assert.equal(event.model, null);
  assert.equal(event.transport, 'manual');
  assert.equal(event.status, 'ok');
  assert.deepEqual(event.request, {});
  assert.deepEqual(event.response, {});
  assert.deepEqual(event.milestones, {});
  assert.equal(event.error, null);
  assert.match(event.event_id, /^[0-9a-f-]{36}$/);
});

test('carries provider, model, transport and request metadata through to the event', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session
    .startOperation({ type: 'tts', endpointId: 'tts-main', provider: 'acme', model: 'voice-1', transport: 'websocket', request: { voice: 'ana' } })
    .end({ status: 'ok', response: { audio_bytes: 42 } });
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.endpoint_id, 'tts-main');
  assert.equal(event.provider, 'acme');
  assert.equal(event.model, 'voice-1');
  assert.equal(event.transport, 'websocket');
  assert.deepEqual(event.request, { voice: 'ana' });
  assert.deepEqual(event.response, { audio_bytes: 42 });
});

test('accepts tool operations and rejects unsupported types', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const tool = session.startOperation({ type: 'tool', request: { name: 'search', input: { city: 'Pune' } } });
  tool.end({ response: { result: 'ok' } });
  for (const type of ['http', 'LLM', undefined, null, '']) {
    assert.throws(() => session.startOperation({ type }), TypeError);
  }
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.type, 'tool');
});

test('never writes an event for an operation that was never ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'stt' });
  operation.event('partial');
  const { directory } = await session.end();
  assert.deepEqual(operations(await readEvents(directory)), []);
});

test('records milestones with a timestamp and merges caller supplied data', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  operation.event('first_token');
  operation.event('chunk', { index: 1, text_available: true });
  operation.end();
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.ok(Number.isInteger(event.milestones.first_token.occurred_at_ms));
  assert.equal(event.milestones.chunk.index, 1);
  assert.equal(event.milestones.chunk.text_available, true);
});

test('lets a milestone payload override the recorded timestamp', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  operation.event('first_token', { occurred_at_ms: 7 });
  operation.end();
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.milestones.first_token.occurred_at_ms, 7);
});

test('keeps only the latest value when a milestone name repeats', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  operation.event('chunk', { index: 1 });
  operation.event('chunk', { index: 2 });
  operation.end();
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.milestones.chunk.index, 2);
});

test('ignores milestones recorded after the operation ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  operation.end();
  operation.event('too_late');
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.deepEqual(event.milestones, {});
});

test('ignores a second end() so an operation is written exactly once', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'llm' });
  operation.end({ status: 'ok' });
  operation.end({ status: 'error', error: { name: 'Error', message: 'late' } });
  const { directory } = await session.end();
  const written = operations(await readEvents(directory));
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'ok');
  assert.equal(written[0].error, null);
});

test('records a non-negative duration derived from the session clock', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const operation = session.startOperation({ type: 'stt' });
  await new Promise((resolve) => setTimeout(resolve, 12));
  operation.end();
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.ok(event.started_at_ms >= 0);
  assert.equal(event.duration_ms, event.ended_at_ms - event.started_at_ms);
  assert.ok(event.duration_ms >= 10, `expected >= 10ms, got ${event.duration_ms}`);
});

test('preserves an error result verbatim', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.startOperation({ type: 'llm' }).end({ status: 'error', error: { name: 'TypeError', message: 'boom' } });
  const { directory } = await session.end();
  const [event] = operations(await readEvents(directory));
  assert.equal(event.status, 'error');
  assert.deepEqual(event.error, { name: 'TypeError', message: 'boom' });
});

test('returns an inert operation once the session has ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const { directory } = await session.end();
  const operation = session.startOperation({ type: 'not-a-valid-type' });
  assert.doesNotThrow(() => operation.event('x'));
  assert.doesNotThrow(() => operation.end({ status: 'ok' }));
  assert.deepEqual(operations(await readEvents(directory)), []);
});

test('correlates operations started through a turn', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const turn = session.startTurn({ turnId: 'turn-7' });
  turn.startOperation({ type: 'stt' }).end();
  turn.startOperation({ type: 'llm', turnId: 'ignored-override' }).end();
  turn.end();
  const { directory } = await session.end();
  const written = operations(await readEvents(directory));
  assert.deepEqual(written.map((event) => event.turn_id), ['turn-7', 'turn-7']);
});

test('generates a turn id when one is not supplied', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const first = session.startTurn();
  const second = session.startTurn();
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.id, second.id);
  await session.end();
});

test('marks a turn ended explicitly and again when the session ends', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const closed = session.startTurn();
  const open = session.startTurn();
  closed.end();
  assert.equal(closed.ended, true);
  assert.equal(open.ended, false);
  await session.end();
  assert.equal(open.ended, true);
});

test('still records operations started from a turn that has ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const turn = session.startTurn({ turnId: 'turn-1' });
  turn.end();
  turn.startOperation({ type: 'llm' }).end();
  const { directory } = await session.end();
  assert.equal(operations(await readEvents(directory))[0].turn_id, 'turn-1');
});

test('records neutral websocket lifecycle events', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession({ sessionId: 'call-9' });
  session.recordWebSocketEvent({ phase: 'open', endpoint_id: 'stt', byte_count: 10 });
  const { directory } = await session.end();
  const [event] = await readEvents(directory);
  assert.equal(event.kind, 'websocket');
  assert.equal(event.session_id, 'call-9');
  assert.equal(event.phase, 'open');
  assert.equal(event.byte_count, 10);
  assert.ok(Number.isInteger(event.occurred_at_ms));
});

test('lets a websocket event payload override the generated timestamp', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  session.recordWebSocketEvent({ phase: 'close', occurred_at_ms: 99 });
  const { directory } = await session.end();
  assert.equal((await readEvents(directory))[0].occurred_at_ms, 99);
});

test('drops websocket events recorded after the session ended', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const { directory } = await session.end();
  session.recordWebSocketEvent({ phase: 'close' });
  assert.deepEqual(await readEvents(directory), []);
});

test('binds handlers so nested calls observe the session context', async () => {
  const vaani = await newObserver();
  const session = vaani.startSession();
  const handler = session.bind((a, b) => {
    assert.equal(vaani.currentContext().session, session);
    return a + b;
  });
  assert.equal(handler(2, 3), 5);
  assert.equal(vaani.currentContext(), undefined);
  await session.end();
});

test('scopes an endpoint id onto the active context and validates it', async () => {
  const vaani = await newObserver({ endpoints: [{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }] });
  const session = vaani.startSession();
  assert.throws(() => session.withEndpoint('missing', () => {}), /Unknown endpoint: missing/);
  const result = session.withEndpoint('llm', () => {
    assert.equal(vaani.currentContext().endpointId, 'llm');
    return 'value';
  });
  assert.equal(result, 'value');
  await session.end();
});

test('session.run keeps an inherited endpoint id in scope', async () => {
  const vaani = await newObserver({ endpoints: [{ id: 'llm', type: 'llm', url: 'https://api.example.com/v1' }] });
  const session = vaani.startSession();
  session.withEndpoint('llm', () => {
    session.run(() => {
      assert.equal(vaani.currentContext().endpointId, 'llm');
      assert.equal(vaani.currentContext().session, session);
    });
  });
  await session.end();
});
