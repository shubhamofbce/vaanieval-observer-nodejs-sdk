# Vaani Voice Observability: Node.js SDK and Python Backend MVP Plan

## 1. Product summary

Build a small Node.js SDK that can be added to an existing, framework-independent voice agent. The SDK captures one complete call session containing:

1. The caller's inbound audio.
2. The agent's outbound audio.
3. The STT, LLM, and TTS traffic sent to user-configured HTTP or WebSocket URLs, including generic timing, transport metadata, status, errors, and frame/stream milestones. Full request/response bodies, transcripts, prompts, generated text, and provider-specific semantic milestones are optional enrichment rather than part of automatic transport capture.

After the call ends, the SDK sends a session package to a separate Python backend. The backend stores and processes the package, and a web console displays a synchronized timeline where the user can:

- play the call audio;
- see when caller and agent speech occurred;
- see classified STT, LLM, and TTS HTTP operations and WebSocket transport activity on the same time axis;
- see how long each captured HTTP operation or WebSocket connection took;
- click an operation to inspect its safe HTTP or streaming-protocol metadata, milestones, status, error, and any optional safely captured content;
- correlate each provider operation with the relevant part of the recording.

This is an MVP. It should remain easy to integrate and operate, but its contracts should not prevent adding a Python SDK, more providers, or a moderate number of concurrent calls later.

The SDK is provider-agnostic, not magically transport-agnostic: any vendor or self-hosted service works when its URL is configured and it uses a documented instrumented transport. A provider SDK that hides traffic in an unsupported transport uses the same neutral manual operation API; Vaani must never add vendor conditionals to compensate.

## 2. MVP boundaries

### In scope

- A framework-independent Node.js SDK.
- Explicit call session start and end.
- Separate inbound caller and outbound agent audio tracks.
- Automatic OpenTelemetry tracing of outbound Node.js `fetch` calls used for STT, LLM, and TTS.
- Generic WebSocket instrumentation for user-configured STT, LLM, and TTS URLs over the Node.js `ws` package. It captures connection and frame lifecycle without interpreting any provider's message schema.
- Streaming and non-streaming operation events where practical.
- Post-call upload rather than network uploads on the live audio path.
- A Python ingestion and processing backend.
- Object storage for recordings and PostgreSQL for session metadata/events.
- A web timeline and audio player.
- Basic retries, bounded buffering, idempotency, and incomplete-session reporting.
- A language-neutral event schema that a future Python SDK can implement.

### Not in the first MVP

- Automatic semantic interpretation of provider-specific payloads, such as deciding whether an arbitrary JSON message is a final transcript, token, flush acknowledgement, or synthesis completion. URLs identify transport traffic, not the meaning of proprietary messages.
- Automatic support for every WebSocket implementation or non-HTTP transport. The MVP supports documented Node.js `fetch`/Undici, Node HTTP, and `ws` versions only; other transports use the provider-neutral manual operation API.
- Automatic semantic evaluation, WER calculation, or transcript grading.
- Speaker separation when several humans share one inbound audio stream.
- Realtime dashboards while the call is still happening.
- Distributed traces across all of the customer's unrelated services.
- A mandatory customer-managed OpenTelemetry Collector deployment.
- Advanced alerting, billing, cost calculation, or long-term analytics.
- Live audio mixing, denoising, diarization, or source separation.
- A guarantee that recording continues after the customer's process or machine crashes.

## 3. Core design decisions

### 3.1 The call session is the top-level unit

Every captured item belongs to a `session_id`. Every conversational turn may additionally have a `turn_id`.

```text
session
  caller audio track
  agent audio track
  turn 1
    STT operation
    LLM operation
    TTS operation
  turn 2
    STT operation
    LLM operation
    TTS operation
```

The SDK should generate identifiers when the customer does not supply them. Identifiers must be unique and opaque, for example UUIDv7 or ULID values.

### 3.2 Use one monotonic session clock

All event timestamps must be offsets from the same monotonic clock started by `vaani.startSession()`. Do not build the timeline only from wall-clock timestamps because the system clock may change during a call.

Each event should contain:

- `occurred_at_ms`: milliseconds since the session started;
- `duration_ms`, when applicable;
- `wall_time`, for operational correlation only.

Audio chunks also need their session-relative timestamp. This is what makes audio and provider calls line up accurately in the console.

### 3.3 Record two independent audio tracks

- Capture caller audio where it enters the application, before it is sent to STT.
- Capture agent audio after interruption/cancellation handling and immediately before it is sent for playback, so the recording represents what was actually intended to be played.
- Preserve each track's encoding, sample rate, channel count, and timestamps.
- Do not mix the tracks in the live call process. A backend worker may produce a stereo or mixed preview later.

If the inbound media already contains acoustic echo, `caller` audio may contain faint agent speech. The SDK cannot reliably remove that without echo cancellation in the customer's media stack.

### 3.4 Never await telemetry on the call path

Audio capture and event capture must be best effort and non-blocking:

```text
live call callback -> bounded queue -> recording worker -> local spool
```

The live call must not wait for:

- a Vaani network request;
- an object-storage upload;
- audio compression;
- database insertion;
- timeline processing.

When the bounded queue is full, the default policy is to drop observability data, increment a dropped-data counter, and continue the call. The console must visibly mark that session as incomplete.

### 3.5 Upload after the session, using a durable local spool

During the call, write audio and events to a per-session local spool directory. At session end, finalize a manifest and enqueue it for upload.

```text
<spool>/session-id/
  manifest.json
  events.jsonl
  caller.audio
  agent.audio
```

An upload worker sends this package after the call. It retries transient failures and removes local files only after the backend acknowledges successful ingestion.

This is safer than holding the entire call in RAM. It also allows the SDK to retry after a temporary backend outage. It does not protect data if the machine has ephemeral storage and terminates before upload; the SDK must report this limitation clearly.

### 3.6 Use OpenTelemetry `fetch` spans for HTTP provider calls

The Node.js SDK should initialize OpenTelemetry tracing and instrument the HTTP implementations used by Node.js `fetch` (normally Undici) and, where required, the Node HTTP client. Each outbound call made while a Vaani session context is active becomes a child HTTP client span automatically.

Standard HTTP spans provide useful information without wrapping each provider call:

- request start time and duration;
- HTTP method and destination;
- response status code;
- network/HTTP errors;
- trace and parent-span correlation.

The SDK should classify traffic only through customer-configured endpoint rules:

```ts
const vaani = new VaaniObserver({
  endpoints: [
    { type: "stt", url: process.env.STT_URL },
    { type: "llm", url: process.env.LLM_URL },
    { type: "tts", url: process.env.TTS_URL },
  ],
});
```

The classification processor adds low-cardinality attributes such as `vaani.operation.type` and the endpoint-rule identifier. `provider` and `model` are included only when the customer supplies them as static labels or emits them through the neutral enrichment API. Unknown outbound HTTP calls may remain visible as ordinary HTTP spans but should not be placed in the STT/LLM/TTS lanes.

Important limitation: ordinary OTel HTTP instrumentation does **not** capture arbitrary request and response bodies. It deliberately focuses on metadata, timing, status, and errors; body interception is expensive, risky for secrets/PII, and complicated for streaming responses. Therefore the body-inspection panel has two MVP levels:

1. Default: show HTTP metadata, timing, status, and error automatically.
2. Optional: add a generic endpoint-scoped content interceptor for JSON/text HTTP traffic, with strict redaction and size limits and no provider schema assumptions.

This preserves zero-touch timing instrumentation. It also makes clear that full STT transcripts, LLM messages, and TTS payloads cannot be promised from plain OTel auto-instrumentation alone.

OTel HTTP/Undici instrumentation does not observe application messages sent over an established WebSocket. It may see the HTTP upgrade handshake, but that is not an STT or TTS operation and must not be presented as one.

### 3.7 Instrument configured WebSocket URLs without provider assumptions

The SDK must generically instrument WebSocket connections created through documented versions of the Node.js `ws` package. A customer classifies traffic by supplying the STT, LLM, and TTS endpoint URLs. Vaani must not contain provider hostnames, path conventions, JSON field names, message types, model names, or protocol parsers.

Endpoint matching should use normalized URL rules. By default, a configured URL matches its scheme, host, port, and path while ignoring query values, because temporary tokens and model parameters may change. Customers may choose exact, origin, or path-prefix matching and may attach static, non-sensitive labels such as their own provider or model name.

Overlapping rules can make URL-only classification ambiguous, for example when the same gateway URL handles both LLM and TTS traffic. The SDK must reject ambiguous rules at startup or require the application to select a neutral endpoint scope explicitly:

```ts
await session.withEndpoint("primary-llm", () => runExistingLlmCall());
```

`withEndpoint()` identifies only the configured rule; it contains no vendor logic and is unnecessary when URL matching is unambiguous.

For every matched WebSocket, generic instrumentation should capture:

- classified operation type: `stt`, `llm`, or `tts`;
- connection start, open, close, close code, generic error, ping, and pong timing;
- outgoing and incoming frame timestamps, direction, text/binary kind, and byte size;
- time to first outgoing frame and first incoming frame;
- aggregate sent/received frame and byte counts;
- the active `session_id` and `turn_id`, when available.

The instrumentation must never serialize authentication headers or raw binary frames into operation JSON. Text-frame capture is also disabled by default; when explicitly enabled, it is treated as sensitive generic content with redaction and size limits, not parsed into provider-specific fields. Caller and agent audio remain captured through the explicit application audio hooks, where encoding and playback boundaries are known.

A URL alone cannot reliably reveal semantic operation boundaries inside a long-lived socket. For example, Vaani cannot universally infer which arbitrary message means partial transcript, final transcript, token, flush, first synthesized audio, completion, or cancellation. Automatic URL-based capture therefore creates a transport operation for the connection and generic frame milestones. Applications that need per-turn semantic operations use the provider-neutral `startOperation()`, `event()`, and `end()` APIs; those APIs contain no provider-specific code.

The SDK must associate each matched socket with the active Vaani session and restore that context when dispatching socket events. This allows downstream work triggered by a socket message to remain attached to the correct concurrent call. Instrumentation must declare and test supported `ws` versions, fail open if it cannot instrument them, and mark the capture status instead of affecting the call.

## 4. Proposed Node.js SDK API

The public API should be small and should avoid provider-specific concepts at its core.

```ts
import { VaaniObserver } from "@vaanieal/observer";

const vaani = new VaaniObserver({
  apiKey: process.env.VAANI_API_KEY,
  endpoint: "https://ingest.example.com",
  spoolDirectory: "/var/tmp/vaani",
  capture: {
    audio: true,
    httpBodies: false,
    websocketTextFrames: false,
  },
  instrumentations: {
    fetch: true,
    websocket: true,
  },
  endpoints: [
    { id: "primary-stt", type: "stt", url: process.env.STT_URL },
    { id: "primary-llm", type: "llm", url: process.env.LLM_URL },
    { id: "primary-tts", type: "tts", url: process.env.TTS_URL },
  ],
});

const session = vaani.startSession({
  sessionId: callId,
  agentId: "support-agent",
  metadata: {
    environment: "production",
  },
});

session.recordInboundAudio(inboundChunk, {
  timestampMs: session.now(),
  encoding: "pcm_s16le",
  sampleRateHz: 16000,
  channels: 1,
});

session.recordOutboundAudio(outboundChunk, {
  timestampMs: session.now(),
  encoding: "pcm_s16le",
  sampleRateHz: 24000,
  channels: 1,
});

const turn = session.startTurn();

// Existing application fetch and matched WebSocket traffic is observed while
// this session/turn context is active. Provider wrappers are not required for
// generic transport capture.
await runExistingAgentTurn();

turn.end();

await session.end({ outcome: "completed" });
```

The observer must be initialized before `undici`, `ws`, or provider modules are loaded. ESM applications that statically import their providers should use a bootstrap entry point:

```ts
// bootstrap.ts
import "./observability.js";
await import("./application.js");
```

For the reference Node voice agent, the required application integration is session start/end plus the two existing PCM boundaries:

```ts
const session = vaani.startSession({ sessionId: callId });

// Browser -> application, immediately before STT.
session.recordInboundAudio(pcm, inboundFormat);

// Application -> browser, after stale/cancelled TTS frames are discarded.
session.recordOutboundAudio(pcm, outboundFormat);

await session.end({ outcome: "completed" });
```

The application does not add provider protocol parsing for transport capture. If it needs semantic milestones beyond generic frame timing, it emits them with the provider-neutral operation API shown below. If a detached callback cannot be associated automatically, the SDK provides `session.run(callback)` and `session.bind(handler)` as narrowly scoped context-recovery APIs.

### Required behavior

- `startSession()` starts the monotonic clock and local session writer.
- `recordInboundAudio()` and `recordOutboundAudio()` enqueue audio and return immediately.
- `startTurn()` creates a child correlation scope.
- OTel HTTP/Undici instrumentation records outbound `fetch` spans automatically.
- A Vaani span processor classifies configured endpoint URL rules as STT, LLM, or TTS.
- Generic WebSocket instrumentation classifies matched sockets by the customer's endpoint rules and records connection/frame timing without interpreting their payloads.
- WebSocket callbacks retain the session context captured when the socket was created; `run()` and `bind()` are available for unusual detached callback structures.
- `withEndpoint(endpointId, callback)` resolves overlapping/dynamic URL rules without provider-specific wrappers.
- Unsupported transports or WebSocket implementations require the generic explicit operation API and must be reported as unsupported rather than silently appearing as fully captured.
- `session.end()` stops accepting new data and schedules finalization/upload.
- The call should not have to wait for remote upload. The returned promise may represent local finalization only.
- `vaani.flush()` should be available for graceful application shutdown and tests.
- SDK failures must never throw into the customer's live call unless strict/debug mode is explicitly enabled.

### Generic streaming fallback and enrichment hooks

An HTTP span alone is insufficient for partial STT transcripts and token/audio streaming milestones. A generic operation/event handle may be offered as optional enrichment:

```ts
const stt = turn.startOperation({
  type: "stt",
  endpointId: "primary-stt",
});

stt.event("partial", { transcript: "I need to" });
stt.event("final", { transcript: "I need to reset my password" });
stt.end({ status: "ok" });
```

This hook is optional for generic transport visibility but required when a customer wants precise provider-semantic milestones that cannot be inferred from a URL and opaque frames. It works identically for any provider.

## 5. Language-neutral event contract

Define the contract independently of TypeScript so the future Python SDK can emit identical packages.

### Session manifest

```json
{
  "schema_version": "1.0",
  "sdk": {
    "name": "@vaanieal/observer",
    "language": "nodejs",
    "version": "0.1.0"
  },
  "session_id": "01...",
  "agent_id": "support-agent",
  "started_at": "2026-08-02T12:00:00Z",
  "duration_ms": 30000,
  "outcome": "completed",
  "capture_status": {
    "events_complete": true,
    "caller_audio_complete": true,
    "agent_audio_complete": true,
    "http_instrumentation": "active",
    "websocket_instrumentation": "active",
    "dropped_event_count": 0,
    "dropped_audio_chunk_count": 0
  },
  "audio": {
    "caller": {
      "file": "caller.audio",
      "encoding": "pcm_s16le",
      "sample_rate_hz": 16000,
      "channels": 1
    },
    "agent": {
      "file": "agent.audio",
      "encoding": "pcm_s16le",
      "sample_rate_hz": 24000,
      "channels": 1
    }
  }
}
```

### Provider operation event

```json
{
  "event_id": "01...",
  "session_id": "01...",
  "turn_id": "01...",
  "type": "llm",
  "endpoint_id": "primary-llm",
  "provider": null,
  "model": null,
  "transport": "http",
  "started_at_ms": 500,
  "ended_at_ms": 1300,
  "duration_ms": 800,
  "status": "ok",
  "milestones": {
    "first_output_at_ms": 720
  },
  "request": {},
  "response": {},
  "error": null
}
```

For a generic WebSocket operation, `transport` is `websocket` and automatic milestones may contain `connected_at_ms`, `first_sent_frame_at_ms`, `first_received_frame_at_ms`, and `closed_at_ms`. Provider-neutral manual enrichment may add semantic event names selected by the application. Connection lifecycle events should remain distinct from conversational turns when one long-lived socket serves the entire session.

Use an append-only `events.jsonl` file so a partially completed session remains inspectable. Keep a version on every manifest and validate all inbound data against a formal JSON Schema. The manifest must also state whether each requested instrumentation was `active`, `unsupported`, `disabled`, or `failed`; this prevents missing STT/TTS operations from being mistaken for a quiet call.

## 6. Request and response capture policy

Standard OTel HTTP spans do not contain arbitrary request or response bodies. In the default MVP, HTTP `request` and `response` fields therefore contain safe metadata only: destination, method, selected non-secret attributes, status, sizes when available, and errors.

For generic WebSocket instrumentation, the same fields contain safe transport metadata rather than raw frames: endpoint-rule identifier, direction, frame kind, byte count, connection timing, close code, and generic errors. Vaani must not infer model, language, message type, transcript state, flush state, or any other provider-specific meaning. Authentication headers, raw frames, transcripts, prompts, and TTS input text are excluded by default.

An optional generic content interceptor may inspect endpoint-allowlisted JSON/text `fetch` requests and responses. Request and response bodies can contain transcripts, prompts, phone numbers, credentials, health information, payment information, and other sensitive data. Capturing everything blindly is unsafe.

For the MVP:

- Capture bodies only when explicitly enabled.
- Apply configurable size limits per request/response.
- Redact common authorization headers and API-key fields in the SDK.
- Never record raw provider authentication headers.
- Replace unserializable values and binary bodies with metadata such as byte length and content type.
- Truncate oversized values and mark them as truncated.
- Allow a customer-supplied redaction callback before data reaches disk.
- Treat redaction as a safeguard, not a complete privacy solution.

Body or sensitive-content capture must use an explicit endpoint allowlist. The console must show whether content was unavailable from OTel, unsupported by the active transport instrumentation, excluded, redacted, or truncated so missing information is not mistaken for an SDK failure.

## 7. Audio format and post-processing

For the simplest reliable implementation:

- Write the audio format already available to the application when possible.
- If the application supplies raw PCM, append it to a raw file during the call.
- Store timing discontinuities in the event/manifest data rather than writing silence during the call.
- After upload, use a Python worker with FFmpeg to produce a normalized preview.
- Produce a stereo preview with caller on the left and agent on the right, or expose separate tracks in the player.

Raw mono 16 kHz, 16-bit PCM uses about 115 MB per hour per track. Two raw tracks can therefore use roughly 230 MB per call-hour before compression. This is acceptable for a small MVP with short calls and prompt post-call compression, but it requires spool quotas and cleanup.

Do not run CPU-heavy transcoding on the Node.js call thread. If encoding is required locally, perform it in a worker thread or separate process.

## 8. Upload protocol

Avoid one huge multipart request that must restart completely after a network failure. Keep the initial protocol simple but independently upload the components:

1. `POST /v1/sessions` with the manifest; use `session_id` as the idempotency key.
2. Backend returns short-lived upload URLs for caller audio, agent audio, and events.
3. SDK uploads each object directly to object storage.
4. `POST /v1/sessions/{session_id}/complete` with object checksums and sizes.
5. Backend enqueues processing and returns `202 Accepted`.

For a very small local POC, the backend may accept one multipart upload. The production-shaped MVP should prefer direct object-storage uploads because routing large audio through Python workers consumes application bandwidth and memory and becomes a scaling bottleneck.

Required upload properties:

- authentication with a project-scoped ingestion key;
- idempotency by `session_id` and object name;
- SHA-256 checksum and byte size verification;
- request and object size limits;
- retry with exponential backoff and jitter;
- local spool deletion only after completion acknowledgement;
- stale spool cleanup after a configurable retention period.

## 9. Python backend architecture

Keep the backend as three logical components. They can run in one repository and initially share a deployment, but their responsibilities should remain separate.

### API service

Suggested implementation: FastAPI.

Responsibilities:

- authenticate SDK ingestion requests;
- create an idempotent session record;
- issue object upload URLs;
- validate completion requests;
- expose authenticated console read APIs;
- enqueue session processing.

The API should not transcode audio synchronously.

### Background worker

Responsibilities:

- validate manifest and event schema;
- verify uploaded object checksums;
- normalize caller and agent audio;
- generate preview audio and waveform data;
- calculate operation durations and timeline bounds;
- mark the session `ready`, `partial`, or `failed`;
- retry safe processing steps idempotently.

For the MVP, a PostgreSQL-backed job table or a small Redis queue is sufficient. A PostgreSQL job table reduces infrastructure, while Redis provides cleaner worker semantics but introduces another service. Avoid Kafka for this stage.

### Storage

- PostgreSQL: projects, sessions, operations, audio metadata, processing status.
- S3-compatible or cloud blob object storage: raw audio, normalized audio, event packages, waveform data.
- Do not store large audio blobs directly in PostgreSQL.

## 10. Minimal data model

### `sessions`

- `id`
- `project_id`
- `external_session_id`
- `agent_id`
- `started_at`
- `duration_ms`
- `outcome`
- `status`: `uploading`, `processing`, `ready`, `partial`, `failed`
- completeness counters/flags
- SDK language and version
- created/updated timestamps

Unique constraint: `(project_id, external_session_id)`.

### `operations`

- `id`
- `session_id`
- `turn_id`
- `type`: `stt`, `llm`, `tts`
- `endpoint_id`
- `provider`
- `model`
- `transport`: `http`, `websocket`, or `manual`
- `started_at_ms`
- `ended_at_ms`
- `duration_ms`
- `status`
- `milestones_json`
- `request_json`
- `response_json`
- `error_json`

Index `(session_id, started_at_ms)` for timeline reads.

### `recordings`

- `id`
- `session_id`
- `track`: `caller`, `agent`, `preview`
- `object_key`
- `encoding`
- `sample_rate_hz`
- `channels`
- `duration_ms`
- `size_bytes`
- `checksum`
- `status`

## 11. Console experience

The primary page is a single session detail view.

```text
Call: session-123                                  00:00 ───────── 00:30

Audio       [play/pause] [waveform================================]
Caller      [speech====]          [speech===]
Agent                   [speech=======]             [speech====]
STT          [STT 320ms]            [STT 410ms]
LLM                 [LLM 800ms]             [LLM 620ms]
TTS                           [TTS 240ms]                   [TTS]
```

Clicking an operation opens a detail panel containing:

- operation type, provider, and model;
- start time and duration;
- success/error state;
- safe HTTP or streaming-protocol request metadata and any optional captured content;
- safe HTTP or streaming-protocol response metadata and any optional captured content;
- error details;
- redaction/truncation indicators;
- linked `turn_id`.

The audio player's current time and timeline cursor must remain synchronized. Clicking a timeline operation should seek the player to that operation's start. Use signed, short-lived recording URLs rather than public object URLs.

The first UI does not need advanced charts. A clear waterfall/timeline is the product's central interaction.

## 12. OpenTelemetry position

OpenTelemetry traces are the primary mechanism for external HTTP/`fetch` capture. Generic WebSocket instrumentation captures matched socket connection/frame lifecycle. Both normalize into the same session/turn/operation event contract without interpreting provider payloads. Provider-neutral manual events can add semantic milestones when the application knows them.

The SDK should:

- initialize an OTel `NodeSDK` before the customer's application/provider modules load;
- enable Undici/HTTP instrumentation needed for Node.js `fetch`;
- initialize generic `ws` instrumentation before the `ws` module and application provider modules load;
- create one root span for each Vaani session;
- create an optional turn span for each conversational turn;
- allow automatic HTTP client spans to become children of the active session/turn;
- classify customer-configured endpoint URL rules as STT, LLM, or TTS;
- create generic connection/frame spans or events for configured WebSocket URLs rather than treating only the HTTP upgrade handshake as the provider operation;
- preserve standard OTel trace/span identifiers in the uploaded session.

OTel remains only part of the overall ingestion design because:

- audio does not belong inside ordinary trace payloads;
- voice-specific event and audio timing fields need a Vaani schema;
- generic HTTP spans do not contain arbitrary request/response bodies and cannot reliably capture streaming provider semantics;
- requiring customers to deploy an OTel Collector makes initial integration heavier.

Recommended approach:

- use OTel directly for session, turn, and automatic outbound HTTP spans;
- use generic WebSocket instrumentation to create OTel-compatible transport spans/events for configured streaming URLs;
- store audio separately and reference it from the session;
- buffer ended spans by session in Vaani's bounded local spool;
- at `session.end()`, send the session's spans through OTLP to the Python backend and upload the audio through the dedicated object-upload protocol;
- optionally allow an existing customer-managed Collector as the OTLP destination later.

The standard OTel `BatchSpanProcessor` normally exports batches on a timer and may transmit spans during the call. To guarantee post-call-only delivery, Vaani needs a small custom span processor/exporter that groups ended spans by root `session_id`, writes them to the local spool, and releases them only after `session.end()`. This component does not replace OTel instrumentation; it only controls delivery timing.

OTel context propagation must also be verified for the customer's event-driven call structure. Normal promise chains are usually propagated automatically, but detached event handlers may need `session.run(callback)` or `session.bind(handler)` so concurrent calls do not attach spans to the wrong session.

## 13. Reliability behavior

The SDK must follow these rules:

- Never fail or delay the customer's voice call because observability failed.
- Use bounded queues for audio and events.
- Record the number of dropped chunks/events.
- Write an append-only local spool during the call.
- Recover and upload finalized or interrupted spool directories after process restart.
- Use idempotent upload operations.
- Apply a maximum spool size and maximum age.
- Stop recording and mark the session partial if the quota is exhausted.
- Expose SDK health/debug logs without logging captured provider bodies.
- Fail open when an HTTP or WebSocket instrumentation cannot be installed, and mark its capture status `unsupported` or `failed`.
- Buffer OTel spans per session and export them only after that session ends.

`session.end()` should complete local finalization quickly. Provide two modes:

```ts
await session.end();                 // locally durable; upload continues in background
await vaani.flush({ timeoutMs: 5000 }); // optional graceful shutdown
```

Background upload after `end()` requires the process to remain alive. Document `flush()` for short-lived processes and serverless environments. Fully reliable post-call delivery from ephemeral serverless runtimes is not an MVP guarantee.

## 14. Security and privacy minimums

- TLS for all network transfers.
- Encryption at rest in object storage and PostgreSQL.
- Project-scoped ingestion keys stored as hashes on the backend.
- Tenant/project isolation on every database and object key.
- Private recordings accessed only through authorized, short-lived URLs.
- Configurable recording and metadata retention.
- Explicit audio-recording enablement and documentation about caller consent.
- Request/response capture disabled or minimized by default for sensitive deployments.
- Authentication headers and known secret fields always excluded.
- Audit access to recordings before broader production rollout.

These controls add implementation work, but postponing tenant isolation or private object storage creates a serious migration and data-exposure risk once real calls are captured.

## 15. Implementation phases

### Phase 1: Local capture prototype

- Define JSON Schema version 1 for manifests and events.
- Initialize OTel Node.js tracing before application imports.
- Enable automatic Undici/HTTP instrumentation for outbound `fetch` calls.
- Implement and version-test generic URL-matched instrumentation for the Node.js `ws` package without provider parsers.
- Implement `startSession()`, active session/turn context, audio track capture, `end()`, and `flush()`.
- Implement user-configured endpoint URL classification for STT, LLM, and TTS spans.
- Implement a bounded post-call OTel span buffer/exporter.
- Write per-session local spool directories.
- Build a local script that reconstructs a timeline from one session.
- Test with a synthetic Node.js agent and fake STT/LLM/TTS functions.
- Integrate the SDK with the reference `node-voice-agent` through its configured `STT_URL`, `LLM_URL`, and `TTS_URL`, without hard-coding or branching on the selected providers.

Exit criteria: one reference-agent call produces caller audio, agent audio, classified LLM/STT/TTS HTTP or WebSocket transport operations, generic stream/frame milestones, and accurate session-relative timing for whatever endpoint URLs are configured. The reference agent adds only SDK bootstrap, endpoint configuration, session lifecycle, two audio hooks, and any documented context binding. Optional semantic milestones use only the neutral operation API.

### Phase 2: Backend ingestion and processing

- Add authenticated, idempotent session creation.
- Add direct object-storage upload URLs.
- Add completion endpoint.
- Store sessions and operations in PostgreSQL.
- Add a background processing job.
- Generate normalized preview audio and waveform data.

Exit criteria: an SDK session is uploaded once, safely retried, processed, and marked ready.

### Phase 3: Session console

- Build session list and session detail APIs.
- Add synchronized player and timeline.
- Add separate caller/agent lanes.
- Add clickable STT/LLM/TTS operations and JSON detail panel.
- Clearly show partial capture, instrumentation `unsupported`/`failed` state, processing failure, redaction, and truncation states.

Exit criteria: a developer can diagnose the sequence and duration of one real voice-agent call from the console.

### Phase 4: MVP hardening

- Add queue and spool limits.
- Add crash-recovery scanning.
- Add upload retry/backoff and checksum verification.
- Load test ingestion and processing with representative audio sizes.
- Add retention cleanup and tenant-access tests.
- Harden generic WebSocket instrumentation across the documented `ws` version matrix.
- Add support for further transport libraries only based on actual users, without adding provider protocol logic to the core SDK.

Exit criteria: moderate concurrent use does not affect customer calls, cross tenant boundaries, or cause unbounded storage/memory growth.

## 16. MVP testing plan

### SDK tests

- Session and turn identifiers propagate correctly.
- Automatic `fetch` spans appear under the correct session during concurrent calls.
- User-configured endpoint URL rules classify STT, LLM, and TTS traffic correctly.
- Successful, failed, timed-out, and cancelled HTTP operations are recorded.
- Arbitrary configured `ws://` and `wss://` STT, LLM, and TTS URLs produce correctly classified connection operations and generic frame milestones.
- URL matching handles configurable exact, origin, and path-prefix rules without treating query tokens or model parameters as defaults.
- Ambiguous overlapping endpoint rules are rejected unless the application supplies a neutral `withEndpoint()` scope.
- No provider hostname, path, JSON property, message type, or model name is built into the SDK or its tests.
- Provider-semantic partial/final/token/flush/completion milestones appear only when emitted through the neutral operation API.
- WebSocket text content remains absent by default and appears only with explicit sensitive-content capture.
- Raw WebSocket binary frames and authorization headers are never serialized into event JSON.
- Unsupported `ws` versions fail open, emit a diagnostic, and mark capture status without interrupting the voice call.
- A configured WebSocket message that triggers a configured `fetch` remains attached to the correct session under concurrent calls.
- No OTel spans are sent over the network before their session ends.
- Inbound and outbound tracks remain separate.
- Audio callback returns without awaiting disk or network I/O.
- Queue overflow does not interrupt the call and marks capture incomplete.
- Process restart discovers and retries pending session spools.
- Secrets and binary bodies are not serialized into events.

### Backend tests

- Repeating session creation/completion is idempotent.
- Invalid manifests and checksums are rejected.
- A project cannot read or overwrite another project's data.
- Worker retries do not duplicate operations or recordings.
- Partially uploaded sessions receive an accurate state.
- Expired signed audio URLs stop working.

### Performance tests

- Measure event-loop delay with capture disabled and enabled.
- Run short and long calls with simultaneous inbound/outbound audio.
- Measure generic frame accounting and context-restoration overhead with many concurrent WebSocket connections.
- Test queue behavior with intentionally slow disk.
- Test upload recovery during backend unavailability.
- Test processing concurrency with representative call durations.

Initial targets should be validated experimentally rather than marketed as guarantees. A reasonable engineering goal is that SDK capture adds no network wait to the call path, keeps recording work bounded, and produces no material increase in p95 event-loop delay under the documented concurrency limit.

## 17. Scaling implications and tradeoffs

### Audio is the main cost

Trace/event metadata is comparatively small. Raw audio drives temporary disk, object storage, processing CPU, and playback egress. Post-call compression, lifecycle deletion, and per-project quotas should exist in the MVP even if their initial settings are simple.

### Post-call-only delivery delays visibility

The console will not show live calls, and data can be lost if the customer's host disappears before upload. This is acceptable for the stated MVP because it protects the live call path. Later, optional segmented background upload can reduce loss without blocking the call.

### Local spooling depends on the deployment environment

It works well for persistent servers and containers with writable storage. It is weaker for serverless functions and ephemeral containers. Supporting external durable spools or provider-side recording can be added after the primary Node server use case is proven.

### Automatic HTTP spans have limited voice semantics

Automatic instrumentation minimizes customer integration, but endpoint metadata alone may not identify the model, transcript, token/audio milestones, or whether generated TTS was actually played. Use customer-configured URL rules for the MVP, make missing details explicit in the UI, and use the neutral enrichment API when users require semantic details.

### Generic WebSocket instrumentation has semantic limits

URL matching avoids provider lock-in and provider-specific maintenance, but automatic data is limited to connection/frame facts. It cannot reliably produce per-utterance STT, per-generation TTS, token, flush, transcript-finality, model-usage, or provider error semantics from opaque messages. Applications that need those details pay a small integration cost by emitting neutral operation events. The console must distinguish `transport-only` operations from `semantically-enriched` operations.

Patching `ws` still couples Vaani to documented library behavior. New `ws` versions can break instrumentation even when the voice call works, so maintain a version compatibility matrix and visible `unsupported`/`failed` capture status. Frame accounting and context restoration add CPU work on every frame. Do not parse or copy binary payloads by default; count bytes, use bounded event queues, and benchmark concurrent sockets. At higher call concurrency, frame-event volume can exceed ordinary HTTP span volume, so aggregate routine frames rather than writing one durable database row per audio frame.

### Post-call span buffering is custom behavior

OTel instrumentation is standard, but per-session delayed delivery is not provided by the default periodic batch exporter. Vaani must own a small bounded buffering/export component. Buffer limits and disk spooling are required so long or concurrent calls do not cause unbounded memory growth.

### Capturing full bodies increases security and storage risk

Full provider requests/responses improve debugging but can expose highly sensitive data and create high-cardinality, expensive records. Use opt-in body capture, size limits, redaction, and short retention. Avoid indexing entire JSON bodies; store them as JSON for detail reads and index only timeline/filter fields.

### A single Python service is enough initially

The API and worker can begin in the same codebase and deployment. Keep job execution asynchronous so audio processing cannot exhaust API workers. As traffic grows, scale the API and processing worker independently before introducing more complex messaging infrastructure.

## 18. Definition of MVP success

The MVP is successful when a developer can:

1. Install one Node.js package.
2. Initialize Vaani before provider imports and add session start/end plus two audio capture hooks.
3. Complete a voice call without waiting for Vaani network activity.
4. See the uploaded call appear after the session ends.
5. Play caller and agent audio independently or together.
6. View HTTP/`fetch` and WebSocket STT/LLM/TTS transport operations on one synchronized timeline for arbitrary user-configured endpoint URLs.
7. Click any operation and inspect its timing, safe transport metadata, generic streaming milestones, status, and error; see semantic milestones only when the application emits neutral enrichment events, and inspect sensitive content only when explicitly enabled.
8. Trust that SDK/backend failures will not break the voice call.

That is the product's narrow first promise. Evaluation, automatic instrumentation, realtime monitoring, more SDK languages, and advanced analytics should follow only after this capture-and-replay workflow is reliable.
