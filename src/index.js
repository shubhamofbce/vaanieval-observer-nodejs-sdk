import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './session.js';
import { Session } from './session.js';

/** A provider-neutral, local-first observer for voice-agent calls. */
export class VaaniObserver {
  #sessions = new Set();
  #als = new AsyncLocalStorage();
  #fetchInstalled = false;

  constructor(options = {}) {
    this.options = {
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      spoolDirectory: options.spoolDirectory ?? join(process.cwd(), '.vaani-spool'),
      // Provider transcript content is application-defined and can include
      // sensitive speech. The SDK exposes the policy flag but integrations
      // must explicitly attach STT results to their per-turn operation.
      capture: { audio: true, httpBodies: false, websocketTextFrames: false, sttContent: false, payloadMaxBytes: 16 * 1024, ...options.capture },
      instrumentations: { fetch: true, websocket: true, ...options.instrumentations },
      endpoints: options.endpoints ?? [],
      upload: { retries: 3, ...options.upload },
      strict: options.strict ?? false,
    };
    this.endpointRules = validateEndpointRules(this.options.endpoints);
    if (this.options.instrumentations.fetch) this.#installFetchObserver();
  }

  startSession(input = {}) {
    const session = new Session(this, input);
    this.#sessions.add(session);
    session.finished.then(() => this.#sessions.delete(session), () => this.#sessions.delete(session));
    return session;
  }

  /** Wait for local session finalization. Does not force network upload. */
  async flush() { await Promise.all([...this.#sessions].map((session) => session.finished)); }

  run(session, callback) { const store = this.#als.getStore(); return this.#als.run({ session, endpointId: store?.endpointId, turnId: store?.turnId }, callback); }
  runWithEndpoint(session, endpointId, callback, turnId) { return this.#als.run({ session, endpointId, turnId: turnId ?? this.#als.getStore()?.turnId }, callback); }
  runWithTurn(session, turnId, callback) { return this.#als.run({ session, endpointId: this.#als.getStore()?.endpointId, turnId }, callback); }
  currentContext() { return this.#als.getStore(); }
  classifyUrl(url) { return classifyUrl(url, this.endpointRules); }

  /**
   * Attach neutral lifecycle/frame accounting to an existing EventEmitter-like
   * `ws` socket. Frame contents and authentication headers are never stored.
   */
  observeWebSocket(socket, { session = this.currentContext()?.session, url, endpointId } = {}) {
    if (!session) throw new Error('observeWebSocket needs a session or an active session.run() context.');
    const rule = endpointId ? this.endpointRules.find((item) => item.id === endpointId) : this.classifyUrl(url);
    if (!rule) return { detach() {} };
    const operation = session.startOperation({ type: rule.type, endpointId: rule.id, transport: 'websocket', scope: 'connection' });
    const on = (name, handler) => socket.on?.(name, session.bind(handler));
    let closed = false; let sent = 0; let received = 0;
    const finish = (result) => { if (!closed) { closed = true; operation.end(result); } };
    on('open', () => operation.event('connected'));
    on('message', (data, isBinary) => { received += data?.length ?? data?.byteLength ?? 0; operation.event('received_frame', { direction: 'inbound', kind: isBinary ? 'binary' : 'text', byte_count: data?.length ?? data?.byteLength ?? 0, total_byte_count: received }); });
    on('error', (error) => finish({ status: 'error', error: safeError(error) }));
    on('close', (code) => finish({ status: 'ok', response: { close_code: code, sent_bytes: sent, received_bytes: received } }));
    const originalSend = socket.send?.bind(socket);
    if (originalSend) socket.send = (data, ...args) => { const bytes = data?.length ?? data?.byteLength ?? 0; sent += bytes; operation.event('sent_frame', { direction: 'outbound', kind: Buffer.isBuffer(data) || data instanceof Uint8Array ? 'binary' : 'text', byte_count: bytes, total_byte_count: sent }); return originalSend(data, ...args); };
    return { detach: () => { if (originalSend) socket.send = originalSend; finish({ status: 'cancelled' }); } };
  }

  /** Upload a finalized local package using the planned direct-object protocol. */
  async uploadPackage(finalized) {
    if (!this.options.endpoint || !this.options.apiKey) throw new Error('endpoint and apiKey are required for uploadPackage().');
    const base = this.options.endpoint.replace(/\/$/, '');
    const headers = { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', 'idempotency-key': finalized.sessionId };
    const create = await fetch(`${base}/v1/sessions`, { method: 'POST', headers, body: JSON.stringify(finalized.manifest) });
    if (!create.ok) throw new Error(`Session creation failed: HTTP ${create.status}`);
    const { upload_urls: uploadUrls = {} } = await create.json();
    const objects = {};
    for (const file of ['events.jsonl', 'call.audio']) {
      const path = join(finalized.directory, file);
      let bytes; try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!uploadUrls[file]) throw new Error(`Backend did not provide an upload URL for ${file}.`);
      const response = await fetch(uploadUrls[file], { method: 'PUT', body: bytes });
      if (!response.ok) throw new Error(`Upload failed for ${file}: HTTP ${response.status}`);
      objects[file] = { byte_size: bytes.byteLength, sha256: sha256(bytes) };
    }
    const complete = await fetch(`${base}/v1/sessions/${encodeURIComponent(finalized.sessionId)}/complete`, { method: 'POST', headers, body: JSON.stringify({ objects }) });
    if (!complete.ok) throw new Error(`Session completion failed: HTTP ${complete.status}`);
    return complete.json();
  }

  #installFetchObserver() {
    if (this.#fetchInstalled || !globalThis.fetch) return;
    this.#fetchInstalled = true;
    const originalFetch = globalThis.fetch;
    const observer = this;
    globalThis.fetch = async function observedFetch(input, init) {
      const context = observer.currentContext();
      const session = context?.session;
      const rule = context?.endpointId ? observer.endpointRules.find((item) => item.id === context.endpointId) : session && observer.classifyUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (!session || !rule) return originalFetch.call(this, input, init);
      const operation = session.startOperation({ type: rule.type, endpointId: rule.id, transport: 'http', turnId: context?.turnId });
      try {
        const response = await originalFetch.call(this, input, init);
        const baseResponse = { status: response.status };
        if (!observer.options.capture.httpBodies) {
          operation.end({ status: response.ok ? 'ok' : 'error', response: baseResponse });
        } else {
          operation.event('request_body_captured');
          operation.setRequest({ body: boundedBody(requestBody(input, init), observer.options.capture.payloadMaxBytes) }, { bounded: true });
          const capture = captureResponseBody(response, observer.options.capture.payloadMaxBytes)
            .then((body) => operation.end({ status: response.ok ? 'ok' : 'error', response: { ...baseResponse, body }, payloadBounded: true }))
            .catch((error) => operation.end({ status: 'error', response: baseResponse, error: safeError(error) }));
          session.deferCapture(capture);
        }
        return response;
      } catch (error) {
        operation.end({ status: 'error', error: safeError(error) });
        throw error;
      }
    };
  }
}

function requestBody(input, init) {
  if (init && Object.hasOwn(init, 'body')) return init.body;
  return input instanceof Request ? input.body : undefined;
}

function boundedBody(body, limit) {
  if (body == null) return null;
  if (typeof body === 'string') return boundedText(body, limit);
  if (body instanceof URLSearchParams) return boundedText(body.toString(), limit);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return boundedText(Buffer.from(body).toString('utf8'), limit);
  return { _capture_skipped: 'Unsupported or streaming request body.' };
}

async function captureResponseBody(response, limit) {
  if (!response.body) return null;
  const reader = response.clone().body.getReader();
  const chunks = []; let total = 0; let captured = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (captured < limit) {
        const slice = value.subarray(0, Math.max(0, limit - captured));
        chunks.push(slice); captured += slice.byteLength;
      }
    }
  } finally { reader.releaseLock(); }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return total > captured ? { _truncated: true, _original_bytes: total, _preview: text } : text;
}

function boundedText(value, limit) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= limit) return value;
  const structured = boundedChatBody(value, limit);
  if (structured) return structured;
  return { _truncated: true, _original_bytes: bytes.byteLength, _preview: bytes.subarray(0, limit).toString('utf8') };
}

/**
 * Bounds a chat-completions body by dropping whole messages, not bytes.
 *
 * A byte prefix keeps the system prompt — which is identical on every call —
 * and discards the conversation, which is the only part that differs. On a real
 * agent the instructions alone can exceed the limit, so the stored preview ends
 * mid-sentence inside message zero, no message survives intact, and the capture
 * answers none of the questions it was taken to answer.
 *
 * Keeping the newest messages instead preserves the exchange that actually
 * produced this reply, records how many older ones were elided, and leaves the
 * preview as valid JSON so it can still be parsed and read.
 *
 * Returns null when the body is not a chat request, so the caller falls back to
 * the byte prefix.
 */
function boundedChatBody(text, limit) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages) || !parsed.messages.length) return null;

  const messages = parsed.messages;
  const envelope = { ...parsed, messages: [] };
  // Room for the elision marker and the separators between kept messages.
  let budget = limit - jsonBytes(envelope) - 96;
  // Tool schemas are boilerplate that repeats on every call of the session,
  // and a large one can crowd out the conversation entirely. The exchange is
  // worth more than the schemas, so trade them away rather than the messages.
  if (budget <= 256 && Array.isArray(parsed.tools) && parsed.tools.length) {
    envelope.tools = `[${parsed.tools.length} tool schema(s) omitted to keep the conversation]`;
    budget = limit - jsonBytes(envelope) - 96;
  }
  if (budget <= 0) return null;

  const kept = [];
  let elided = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const cost = jsonBytes(messages[index]) + 1;
    if (cost <= budget) {
      kept.unshift(messages[index]);
      budget -= cost;
      continue;
    }
    // The standing instructions are worth a summary even when they do not fit.
    if (index === 0 && kept.length && budget > 256 && isMessageObject(messages[0])) {
      kept.unshift(shortenMessage(messages[0], budget));
      budget = 0;
      continue;
    }
    elided = index + 1;
    break;
  }
  // A large `tools` block can consume the budget before a single message fits.
  // Falling back to a byte prefix there would lose the newest exchange for the
  // calls that need it most, so keep a shortened version of it instead.
  if (!kept.length && budget > 256 && isMessageObject(messages[messages.length - 1])) {
    kept.push(shortenMessage(messages[messages.length - 1], budget));
    elided = messages.length - 1;
  }
  if (!kept.length) return null;

  const preview = { ...envelope, messages: kept };
  if (elided) preview._elided_messages = elided;
  return {
    _truncated: true,
    _original_bytes: Buffer.byteLength(text),
    _preview: JSON.stringify(preview),
    _elided_messages: elided,
  };
}

/** Spreading a non-object message would turn a string into one key per
 *  character, so only real message objects can be shortened. */
function isMessageObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The longest whole-codepoint prefix of `buffer`. Emitting a replacement
 *  character instead would both corrupt the text and make it grow. */
function decodeWholeCodepoints(buffer) {
  for (let end = buffer.length; end >= 0 && end > buffer.length - 4; end -= 1) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)); } catch { /* split codepoint */ }
  }
  return '';
}

function shortenMessage(message, budget) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content == null ? '' : message.content);
  const raw = Buffer.from(content);
  const build = (room) => ({
    ...message,
    content: decodeWholeCodepoints(raw.subarray(0, room)),
    _content_truncated: true,
    _content_bytes: raw.byteLength,
  });
  // JSON escaping can turn one content byte into six, so the room a budget
  // allows cannot be derived by subtraction. Shrink until the serialized
  // message actually fits, which is the only measure that matters.
  let low = 0;
  let high = raw.byteLength;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(build(mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function validateEndpointRules(rules) {
  const ids = new Set();
  return rules.map((rule) => {
    if (!rule?.id || !['stt', 'llm', 'tts'].includes(rule.type) || !rule.url) throw new TypeError('Each endpoint needs id, type, and url.');
    if (ids.has(rule.id)) throw new TypeError(`Duplicate endpoint id: ${rule.id}`);
    ids.add(rule.id);
    const url = new URL(rule.url);
    return { ...rule, match: rule.match ?? 'path', url };
  });
}

function classifyUrl(value, rules) {
  const candidate = new URL(value);
  const matches = rules.filter((rule) => {
    if (candidate.protocol !== rule.url.protocol || candidate.host !== rule.url.host) return false;
    if (rule.match === 'origin') return true;
    if (rule.match === 'exact') return candidate.pathname === rule.url.pathname && candidate.search === rule.url.search;
    return candidate.pathname.startsWith(rule.url.pathname);
  });
  if (matches.length > 1) throw new Error(`Ambiguous Vaani endpoint rules for ${candidate.origin}${candidate.pathname}`);
  return matches[0];
}

function safeError(error) { return { name: error?.name ?? 'Error', message: String(error?.message ?? error) }; }

export { Session } from './session.js';
