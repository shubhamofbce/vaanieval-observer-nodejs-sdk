import { readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TEMP_TRACK_FILES = {
  caller: '.caller.audio.tmp',
  agent: '.agent.audio.tmp',
};

export async function composeStereo(directory, tracks, events, durationMs) {
  if (!tracks.size) return null;
  for (const [track, format] of tracks) {
    if (format.encoding !== 'pcm_s16le') throw new Error(`${track} audio must use pcm_s16le for stereo finalization.`);
    if (!Number.isInteger(format.sample_rate_hz) || format.sample_rate_hz <= 0) throw new Error(`${track} audio is missing a valid sample rate.`);
    if (!Number.isInteger(format.channels) || format.channels <= 0) throw new Error(`${track} audio is missing a valid channel count.`);
  }

  const outputRate = Math.max(...[...tracks.values()].map((format) => format.sample_rate_hz));
  const rendered = new Map();
  for (const [track, format] of tracks) {
    rendered.set(track, await renderTrack(directory, track, format, events, outputRate));
  }
  const frames = Math.max(
    Math.round(Math.max(0, durationMs) * outputRate / 1000),
    ...[...rendered.values()].map((samples) => samples.length),
  );
  const caller = rendered.get('caller') ?? new Int16Array();
  const agent = rendered.get('agent') ?? new Int16Array();
  const output = Buffer.alloc(frames * 4);
  for (let index = 0; index < frames; index++) {
    output.writeInt16LE(index < agent.length ? agent[index] : 0, index * 4);
    output.writeInt16LE(index < caller.length ? caller[index] : 0, index * 4 + 2);
  }
  await writeFile(join(directory, 'call.audio'), output);
  await Promise.all(Object.values(TEMP_TRACK_FILES).map(async (filename) => {
    const path = join(directory, filename);
    try { await unlink(path); } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code === 'EISDIR' || error.code === 'EPERM') {
        await rmdir(path);
        return;
      }
      throw error;
    }
  }));
  return {
    file: 'call.audio',
    encoding: 'pcm_s16le',
    sample_rate_hz: outputRate,
    channels: 2,
    channel_layout: { left: 'agent', right: 'caller' },
  };
}

async function renderTrack(directory, track, format, events, outputRate) {
  let raw;
  try { raw = await readFile(join(directory, TEMP_TRACK_FILES[track])); } catch (error) {
    if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
    raw = Buffer.alloc(0);
  }
  let chunks = events
    .filter((event) => event.kind === 'audio_chunk' && event.track === track)
    .map((event) => [Math.max(0, Math.round(event.occurred_at_ms)), Math.max(0, event.byte_length)]);
  if (!chunks.length && raw.length) chunks = [[0, raw.length]];

  const segments = [];
  let offset = 0;
  let required = 0;
  for (const [occurredAt, size] of chunks) {
    const data = raw.subarray(offset, offset + size);
    offset += data.length;
    const mono = decodeMono(data, format.channels);
    if (!mono.length) continue;
    const start = Math.round(occurredAt * outputRate / 1000);
    const samples = resample(mono, format.sample_rate_hz, outputRate);
    segments.push({ start, samples });
    required = Math.max(required, start + samples.length);
  }
  if (offset < raw.length) {
    const samples = resample(decodeMono(raw.subarray(offset), format.channels), format.sample_rate_hz, outputRate);
    segments.push({ start: required, samples });
    required += samples.length;
  }
  const output = new Int16Array(required);
  for (const { start, samples } of segments) output.set(samples, start);
  return output;
}

function decodeMono(data, channels) {
  const frames = Math.floor(data.length / (channels * 2));
  const output = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += data.readInt16LE((frame * channels + channel) * 2);
    }
    output[frame] = Math.round(sum / channels);
  }
  return output;
}

function resample(samples, sourceRate, outputRate) {
  if (sourceRate === outputRate) return Int16Array.from(samples);
  const output = new Int16Array(Math.max(1, Math.round(samples.length * outputRate / sourceRate)));
  if (samples.length < 2) {
    output.fill(samples[0] ?? 0);
    return output;
  }
  for (let index = 0; index < output.length; index++) {
    const position = index * sourceRate / outputRate;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = Math.round(samples[left] + (samples[right] - samples[left]) * fraction);
  }
  return output;
}
