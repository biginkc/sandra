import { MPEGDecoder } from 'mpg123-decoder';

import type { DecodeResult } from './recording-audio';

/**
 * Real MP3 validation with `mpg123-decoder` (a WebAssembly build of mpg123: pure WASM, so it runs in Vercel's Node
 * runtime with no native binary or ffmpeg). `MPEGDecoder.decode` is synchronous, so the time bound is chunked:
 * 16 KB slices (about 1 s of 128 kbps audio each), a wall-clock check before every slice (abort with `timeout`),
 * and PCM discarded after each slice so memory is the decoder plus one slice of PCM.
 *
 * Pass = at least one frame decoded, zero decoder errors, and a decoded duration. The caller compares the duration
 * to the provider's own (within max(2 s, 5%)) and requires at least 1 s.
 */
export const DECODE_SLICE_BYTES = 16 * 1024;

export interface DecodeOptions {
  now?: () => number;
  /** Test hook: runs after each slice (a fake clock advances here). */
  afterSlice?: () => void;
}

export async function decodeMp3(bytes: Uint8Array, budgetMs: number, options: DecodeOptions = {}): Promise<DecodeResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  let decoder: MPEGDecoder | null = null;
  try {
    decoder = new MPEGDecoder();
    await decoder.ready;
    let samples = 0;
    let sampleRate = 0;
    for (let at = 0; at < bytes.length; at += DECODE_SLICE_BYTES) {
      if (now() - started >= budgetMs) return { ok: false, reason: 'timeout' };
      const result = decoder.decode(bytes.subarray(at, at + DECODE_SLICE_BYTES));
      if (result.errors.length > 0) return { ok: false, reason: 'invalid' };
      samples += result.samplesDecoded;
      if (result.sampleRate > 0) sampleRate = result.sampleRate;
      options.afterSlice?.();
    }
    if (samples <= 0 || sampleRate <= 0) return { ok: false, reason: 'invalid' };
    return { ok: true, durationMs: Math.round((samples / sampleRate) * 1000) };
  } catch {
    return { ok: false, reason: 'invalid' };
  } finally {
    try {
      decoder?.free();
    } catch {
      // nothing left to release
    }
  }
}
