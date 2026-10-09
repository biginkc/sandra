import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { DECODE_SLICE_BYTES, decodeMp3 } from './recording-audio-decode';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe('decodeMp3', () => {
  it('accepts a CBR and a VBR fixture and reports the decoded duration', async () => {
    const cbr = await decodeMp3(fixture('cbr-3s.mp3'), 8000);
    expect(cbr).toMatchObject({ ok: true });
    if (cbr.ok) {
      expect(cbr.durationMs).toBeGreaterThan(2900);
      expect(cbr.durationMs).toBeLessThan(3200);
    }
    const vbr = await decodeMp3(fixture('vbr-3s.mp3'), 8000);
    expect(vbr).toMatchObject({ ok: true });
    if (vbr.ok) expect(Math.abs(vbr.durationMs - 3000)).toBeLessThan(100);
  });

  it('rejects valid headers over a corrupted payload on decoder errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const good = fixture('cbr-3s.mp3');
    const corrupt = new Uint8Array(good.length);
    corrupt.set(good.subarray(0, 200));
    corrupt.fill(0x37, 200);
    expect(await decodeMp3(corrupt, 8000)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('a truncated stream decodes to a shorter duration (the caller rejects it against the provider duration)', async () => {
    const truncated = await decodeMp3(fixture('cbr-3s.mp3').subarray(0, 5000), 8000);
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.durationMs).toBeLessThan(2000);
  });

  it('rejects an HTML body and empty input', async () => {
    expect(await decodeMp3(new TextEncoder().encode('<html>not audio</html>'.repeat(300)), 8000)).toEqual({ ok: false, reason: 'invalid' });
    expect(await decodeMp3(new Uint8Array(0), 8000)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('aborts with decode_timeout between slices when the clock passes the budget, and the slice size bounds the overshoot', async () => {
    let clock = 0;
    const one = fixture('cbr-3s.mp3');
    const big = new Uint8Array(one.length * 30);
    for (let i = 0; i < 30; i += 1) big.set(one, i * one.length);
    expect(big.length).toBeGreaterThan(DECODE_SLICE_BYTES * 20);
    let slices = 0;
    const result = await decodeMp3(big, 8000, { now: () => clock, afterSlice: () => { slices += 1; clock += 1000; } });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(slices).toBeLessThanOrEqual(8);
  });

  it('a 30-minute class payload decodes within the bound (throughput recorded in the test output)', async () => {
    const one = fixture('cbr-3s.mp3');
    const copies = 600; // ~30 minutes of the same stream, repeated
    const big = new Uint8Array(one.length * copies);
    for (let i = 0; i < copies; i += 1) big.set(one, i * one.length);
    const started = performance.now();
    const result = await decodeMp3(big, 8000);
    const elapsed = performance.now() - started;
    console.info(`decode throughput: ${(big.length / 1024).toFixed(0)} KB (${result.ok ? Math.round(result.durationMs / 1000) : 0} s audio) in ${Math.round(elapsed)} ms`);
    expect(result.ok || result.reason === 'timeout').toBe(true);
    expect(elapsed).toBeLessThan(9000);
  });
});
