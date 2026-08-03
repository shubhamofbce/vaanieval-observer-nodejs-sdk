import { appendFile, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SDK = { name: '@vaanieal/observer', language: 'nodejs', version: '0.1.0' };

export class Session {
  #observer; #started = performance.now(); #ended = false; #events = []; #writes = Promise.resolve(); #tracks = new Map(); #trackTimelineEnds = new Map(); #turns = new Set(); #pendingCaptures = new Set();
  constructor(observer, input) {
    this.#observer = observer;
    this.id = input.sessionId ?? randomUUID();
    this.agentId = input.agentId ?? null;
    this.metadata = input.metadata ?? {};
    this.startedAt = new Date().toISOString();
    this.directory = join(observer.options.spoolDirectory, this.id);
    this.captureStatus = { events_complete: true, caller_audio_complete: true, agent_audio_complete: true, http_instrumentation: observer.options.instrumentations.fetch ? 'active' : 'disabled', websocket_instrumentation: observer.options.instrumentations.websocket ? 'active' : 'disabled', dropped_event_count: 0, dropped_audio_chunk_count: 0 };
    this.ready = mkdir(this.directory, { recursive: true });
    this.finished = new Promise((resolve, reject) => { this.resolveFinished = resolve; this.rejectFinished = reject; });
  }
  now() { return Math.round(performance.now() - this.#started); }
  run(callback) { return this.#observer.run(this, callback); }
  bind(handler) { return (...args) => this.run(() => handler(...args)); }
  startTurn(input = {}) { const turn = { id: String(input.turnId ?? randomUUID()), ended: false, end: () => { turn.ended = true; this.#turns.delete(turn); }, startOperation: (op) => this.startOperation({ ...op, turnId: turn.id }), run: (callback) => this.withTurn(turn.id, callback) }; this.#turns.add(turn); return turn; }
  withEndpoint(endpointId, callback, { turnId } = {}) { if (!this.#observer.endpointRules.some((rule) => rule.id === endpointId)) throw new Error(`Unknown endpoint: ${endpointId}`); return this.#observer.runWithEndpoint(this, endpointId, callback, turnId); }
  /** Runs `callback` with `turnId` attached, so auto-instrumented work is grouped by turn. */
  withTurn(turnId, callback) { return this.#observer.runWithTurn(this, turnId, callback); }
  deferCapture(promise) { this.#pendingCaptures.add(promise); promise.finally(() => this.#pendingCaptures.delete(promise)); }
  recordInboundAudio(chunk, format) { return this.#recordAudio('caller', chunk, format); }
  recordOutboundAudio(chunk, format) { return this.#recordAudio('agent', chunk, format); }
  #recordAudio(track, chunk, format = {}) {
    if (this.#ended || !this.#observer.options.capture.audio) return false;
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new TypeError('Audio chunk must be a Buffer or Uint8Array.');
    const previous = this.#tracks.get(track);
    const normalized = { encoding: format.encoding, sample_rate_hz: format.sampleRateHz, channels: format.channels };
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw new Error(`${track} audio format cannot change within a session.`);
    this.#tracks.set(track, normalized);
    const receivedAt = format.timestampMs ?? this.now();
    // TTS often arrives in a burst even though it will be played in real time.
    // Advance its recording clock by PCM duration so the track retains the
    // pauses before and between replies instead of compressing them away.
    const durationMs = pcmDurationMs(chunk.byteLength, normalized);
    const occurredAt = track === 'agent' && durationMs != null
      ? Math.max(receivedAt, this.#trackTimelineEnds.get(track) ?? 0)
      : receivedAt;
    if (durationMs != null) this.#trackTimelineEnds.set(track, occurredAt + durationMs);
    this.#queue(async () => appendFile(join(this.directory, `${track}.audio`), chunk));
    this.#event({ kind: 'audio_chunk', track, occurred_at_ms: occurredAt, byte_length: chunk.byteLength, ...(durationMs != null ? { duration_ms: durationMs } : {}) });
    return true;
  }
  startOperation(input) {
    if (this.#ended) return inertOperation();
    if (!['stt', 'llm', 'tts', 'tool'].includes(input.type)) throw new TypeError('Operation type must be stt, llm, tts, or tool.');
    const startedAt = input.startedAtMs ?? this.now();
    const event = { event_id: randomUUID(), session_id: this.id, turn_id: input.turnId != null ? String(input.turnId) : null, scope: input.scope ?? 'turn', type: input.type, endpoint_id: input.endpointId ?? null, provider: input.provider ?? null, model: input.model ?? null, transport: input.transport ?? 'manual', started_at_ms: startedAt, ended_at_ms: null, duration_ms: null, status: 'in_progress', milestones: {}, request: this.#boundedPayload(input.request ?? {}), response: {}, error: null };
    let done = false;
    return {
      /**
       * Repeated milestones accumulate instead of overwriting, so a streaming
       * transport keeps first/last timing and counts without one event per frame.
       */
      event: (name, data = {}) => {
        if (done) return;
        const { occurred_at_ms: at = this.now(), ...rest } = data;
        const previous = event.milestones[name];
        event.milestones[name] = previous
          ? { ...previous, ...rest, occurred_at_ms: previous.occurred_at_ms, last_at_ms: at, count: (previous.count ?? 1) + 1 }
          : { occurred_at_ms: at, last_at_ms: at, count: 1, ...rest };
      },
      setTurn: (turnId) => { if (!done) event.turn_id = turnId != null ? String(turnId) : null; },
      setRequest: (request, { bounded = false } = {}) => { if (!done) event.request = bounded ? request : this.#boundedPayload(request); },
      get ended() { return done; },
      end: (result = {}) => {
        if (done) return;
        done = true;
        event.ended_at_ms = result.endedAtMs ?? this.now();
        event.duration_ms = Math.max(0, event.ended_at_ms - event.started_at_ms);
        event.status = result.status ?? 'ok';
        event.response = result.payloadBounded ? (result.response ?? {}) : this.#boundedPayload(result.response ?? {});
        event.error = result.error ?? null;
        this.#event(event);
      },
    };
  }
  #boundedPayload(value) {
    const limit = this.#observer.options.capture.payloadMaxBytes;
    if (!Number.isFinite(limit) || limit < 0) return value;
    let json;
    try { json = JSON.stringify(value); } catch { return { _capture_error: 'Payload is not JSON serializable.' }; }
    const bytes = Buffer.byteLength(json);
    if (bytes <= limit) return value;
    return { _truncated: true, _original_bytes: bytes, _preview: Buffer.from(json).subarray(0, limit).toString('utf8') };
  }
  /** Records generic ws lifecycle/frame data from any supported ws integration. */
  recordWebSocketEvent(input) { this.#event({ kind: 'websocket', session_id: this.id, occurred_at_ms: this.now(), ...input }); }
  #event(event) { if (this.#ended) return; this.#events.push(event); this.#queue(async () => appendFile(join(this.directory, 'events.jsonl'), `${JSON.stringify(event)}\n`)); }
  #queue(work) { this.#writes = this.#writes.then(() => this.ready).then(work).catch((error) => { this.captureStatus.events_complete = false; this.captureStatus.dropped_event_count++; if (this.#observer.options.strict) throw error; }); }
  async end(input = {}) {
    if (this.#ended) return this.finished;
    await Promise.allSettled([...this.#pendingCaptures]);
    this.#ended = true;
    for (const turn of this.#turns) turn.end();
    try {
      await this.ready;
      await this.#writes;
      const manifest = this.#manifest(input);
      await writeFile(join(this.directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2));
      await rename(join(this.directory, 'manifest.json.tmp'), join(this.directory, 'manifest.json'));
      this.resolveFinished({ sessionId: this.id, directory: this.directory, manifest });
    } catch (error) { this.rejectFinished(error); if (this.#observer.options.strict) throw error; }
    return this.finished;
  }
  #manifest(input) { const audio = {}; for (const [track, format] of this.#tracks) audio[track] = { file: `${track}.audio`, ...format }; return { schema_version: '1.0', sdk: SDK, session_id: this.id, agent_id: this.agentId, metadata: this.metadata, started_at: this.startedAt, duration_ms: this.now(), outcome: input.outcome ?? 'unknown', capture_status: this.captureStatus, audio }; }
}
function pcmDurationMs(byteLength, format) {
  if (format.encoding !== 'pcm_s16le' || !Number.isInteger(format.sample_rate_hz) || format.sample_rate_hz <= 0 || !Number.isInteger(format.channels) || format.channels <= 0) return null;
  return (byteLength / (format.sample_rate_hz * format.channels * 2)) * 1000;
}
function inertOperation() { return { event() {}, setTurn() {}, setRequest() {}, ended: true, end() {} }; }
export function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
