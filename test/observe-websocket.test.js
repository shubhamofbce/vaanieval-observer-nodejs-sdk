import test from 'node:test';
import assert from 'node:assert/strict';
import { newObserver, readEvents, FakeSocket } from './helpers.js';

const RULES = [
  { id: 'stt', type: 'stt', url: 'wss://stt.example.com/stream' },
  { id: 'tts', type: 'tts', url: 'wss://tts.example.com/speak' },
];

async function setup(options = {}) {
  const vaani = await newObserver({ endpoints: RULES, ...options });
  const session = vaani.startSession();
  return { vaani, session, socket: new FakeSocket() };
}

const operationOf = (events) => events.find((event) => ['stt', 'llm', 'tts'].includes(event.type));

test('requires an explicit session or an active run context', async () => {
  const { vaani, session, socket } = await setup();
  assert.throws(() => vaani.observeWebSocket(socket, { url: 'wss://stt.example.com/stream' }), /needs a session/);
  session.run(() => {
    assert.doesNotThrow(() => vaani.observeWebSocket(socket, { url: 'wss://stt.example.com/stream' }));
  });
  await session.end();
});

test('returns an inert handle and records nothing for an unclassified URL', async () => {
  const { session, vaani, socket } = await setup();
  const originalSend = socket.send;
  const handle = vaani.observeWebSocket(socket, { session, url: 'wss://unknown.example.com/stream' });
  assert.equal(typeof handle.detach, 'function');
  assert.doesNotThrow(() => handle.detach());
  assert.equal(socket.send, originalSend);
  socket.emit('open');
  socket.emit('close', 1000);
  const { directory } = await session.end();
  assert.equal(operationOf(await readEvents(directory)), undefined);
});

test('resolves the endpoint by id, bypassing URL classification', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, endpointId: 'tts', url: 'wss://unknown.example.com/x' });
  socket.emit('close', 1000);
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.equal(operation.type, 'tts');
  assert.equal(operation.endpoint_id, 'tts');
  assert.equal(operation.transport, 'websocket');
});

test('records nothing when the supplied endpoint id is unknown', async () => {
  const { session, vaani, socket } = await setup();
  const handle = vaani.observeWebSocket(socket, { session, endpointId: 'nope', url: 'wss://stt.example.com/stream' });
  socket.emit('close', 1000);
  handle.detach();
  const { directory } = await session.end();
  assert.equal(operationOf(await readEvents(directory)), undefined);
});

test('captures the full lifecycle with byte accounting in both directions', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream?lang=en' });
  socket.emit('open');
  socket.send(Buffer.from([1, 2, 3]));
  socket.send('hello');
  socket.emit('message', Buffer.from([1, 2]), true);
  socket.emit('message', 'partial-text', false);
  socket.emit('close', 1000);

  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.equal(operation.status, 'ok');
  assert.equal(operation.endpoint_id, 'stt');
  assert.deepEqual(operation.response, { close_code: 1000, sent_bytes: 8, received_bytes: 14 });
  assert.equal(operation.milestones.connected.occurred_at_ms >= 0, true);
  // Repeated frames accumulate: the latest payload plus first/last timing and a count.
  assert.deepEqual(
    { ...operation.milestones.sent_frame, occurred_at_ms: undefined, last_at_ms: undefined },
    { occurred_at_ms: undefined, last_at_ms: undefined, count: 2, direction: 'outbound', kind: 'text', byte_count: 5, total_byte_count: 8 },
  );
  assert.deepEqual(
    { ...operation.milestones.received_frame, occurred_at_ms: undefined, last_at_ms: undefined },
    { occurred_at_ms: undefined, last_at_ms: undefined, count: 2, direction: 'inbound', kind: 'text', byte_count: 12, total_byte_count: 14 },
  );
});

test('classifies binary and text frames by payload type', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.send(new Uint8Array([1]));
  socket.emit('message', Buffer.from([1, 2]), true);
  socket.emit('close', 1000);
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.equal(operation.milestones.sent_frame.kind, 'binary');
  assert.equal(operation.milestones.received_frame.kind, 'binary');
});

test('delegates to the original send and preserves its return value and payload', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  assert.equal(socket.send('ping'), 'sent');
  assert.deepEqual(socket.sent, ['ping']);
  socket.emit('close', 1000);
  await session.end();
});

test('counts a frame with no measurable length as zero bytes', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.send(undefined);
  socket.emit('message', undefined, false);
  socket.emit('close', 1000);
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.deepEqual(operation.response, { close_code: 1000, sent_bytes: 0, received_bytes: 0 });
});

test('ends the operation as an error when the socket errors', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.emit('error', new TypeError('handshake failed'));
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.equal(operation.status, 'error');
  assert.deepEqual(operation.error, { name: 'TypeError', message: 'handshake failed' });
});

test('keeps the first terminal result when close follows error', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.emit('error', new Error('reset'));
  socket.emit('close', 1006);
  const { directory } = await session.end();
  const written = (await readEvents(directory)).filter((event) => event.type === 'stt');
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'error');
});

test('normalizes a non-Error rejection value', async () => {
  const { session, vaani, socket } = await setup();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.emit('error', 'plain string failure');
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.deepEqual(operation.error, { name: 'Error', message: 'plain string failure' });
});

test('detach unwraps send and marks the operation cancelled', async () => {
  const { session, vaani, socket } = await setup();
  const handle = vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  const wrapped = socket.send;
  handle.detach();
  assert.notEqual(socket.send, wrapped);
  assert.equal(socket.send('after-detach'), 'sent');
  assert.deepEqual(socket.sent, ['after-detach']);
  const { directory } = await session.end();
  const operation = operationOf(await readEvents(directory));
  assert.equal(operation.status, 'cancelled');
  assert.equal(operation.milestones.sent_frame, undefined);
});

test('detach after close does not overwrite the recorded close result', async () => {
  const { session, vaani, socket } = await setup();
  const handle = vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  socket.emit('close', 1000);
  handle.detach();
  const { directory } = await session.end();
  const written = (await readEvents(directory)).filter((event) => event.type === 'stt');
  assert.equal(written.length, 1);
  assert.equal(written[0].status, 'ok');
});

test('detach twice is safe', async () => {
  const { session, vaani, socket } = await setup();
  const handle = vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  handle.detach();
  assert.doesNotThrow(() => handle.detach());
  const { directory } = await session.end();
  assert.equal((await readEvents(directory)).filter((event) => event.type === 'stt').length, 1);
});

test('tolerates a socket without on() or send()', async () => {
  const { session, vaani } = await setup();
  const bare = {};
  const handle = vaani.observeWebSocket(bare, { session, url: 'wss://stt.example.com/stream' });
  assert.equal(bare.send, undefined);
  assert.doesNotThrow(() => handle.detach());
  const { directory } = await session.end();
  assert.equal(operationOf(await readEvents(directory)).status, 'cancelled');
});

test('binds every socket handler to the session context', async () => {
  const { session, vaani, socket } = await setup();
  const registered = [];
  const originalBind = session.bind.bind(session);
  session.bind = (handler) => { registered.push(handler); return originalBind(handler); };
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  assert.equal(registered.length, 4);
  assert.deepEqual(socket.eventNames().sort(), ['close', 'error', 'message', 'open']);
  socket.emit('close', 1000);
  await session.end();
});

test('observes two sockets on one session independently', async () => {
  const { session, vaani, socket } = await setup();
  const second = new FakeSocket();
  vaani.observeWebSocket(socket, { session, url: 'wss://stt.example.com/stream' });
  vaani.observeWebSocket(second, { session, url: 'wss://tts.example.com/speak' });
  socket.send('abc');
  second.emit('message', Buffer.alloc(4), true);
  socket.emit('close', 1000);
  second.emit('close', 1001);
  const { directory } = await session.end();
  const events = await readEvents(directory);
  const stt = events.find((event) => event.type === 'stt');
  const tts = events.find((event) => event.type === 'tts');
  assert.equal(stt.response.sent_bytes, 3);
  assert.equal(stt.response.received_bytes, 0);
  assert.equal(tts.response.received_bytes, 4);
  assert.equal(tts.response.close_code, 1001);
});
