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
      capture: { audio: true, httpBodies: false, websocketTextFrames: false, payloadMaxBytes: 16 * 1024, ...options.capture },
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
    for (const file of ['events.jsonl', 'caller.audio', 'agent.audio']) {
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
  return { _truncated: true, _original_bytes: bytes.byteLength, _preview: bytes.subarray(0, limit).toString('utf8') };
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
