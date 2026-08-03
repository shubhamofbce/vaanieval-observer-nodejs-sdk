// Shared helpers for the observer test-suite. Contains no tests itself.
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaaniObserver } from '../src/index.js';

export async function tempDir() {
  return mkdtemp(join(tmpdir(), 'vaani-test-'));
}

/** An observer that always spools into a throwaway directory and never patches global fetch. */
export async function newObserver(options = {}) {
  return new VaaniObserver({
    spoolDirectory: await tempDir(),
    instrumentations: { fetch: false },
    ...options,
  });
}

export async function readEvents(directory) {
  let raw;
  try {
    raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function readManifest(directory) {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
}

export async function readTrack(directory, track) {
  return readFile(join(directory, `${track}.audio`));
}

export const PCM = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 };

/** Minimal `ws`-shaped socket: EventEmitter plus a send() that records payloads. */
export class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    return 'sent';
  }
}

/**
 * Replaces globalThis.fetch with a recording stub. Callers must invoke restore()
 * because the SDK also patches the global in its fetch instrumentation.
 */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async function stubbedFetch(input, init = {}) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const call = { url, init, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
