import { describe, expect, it, vi } from "vitest";

import {
  PCM_AUDIO_WORKLET_SOURCE,
  PCM_FRAME_SAMPLES,
  type PcmWorkletPort,
  StatefulPcmResampler,
  downmixInterleaved,
  pcm16LittleEndian,
  startPcmWorkletSession,
} from "./pcm-audio-worklet";

type HarnessMessage = { type?: string; frameIndex?: number; samples?: ArrayBuffer; totalInputSamples?: number; creditedSamples?: number; uncreditedTailSamples?: number; sourceSampleRateHz?: number; record?: Record<string, unknown>; summary?: { emptyInputQuanta: number; inputFrames: number; channelNonzero: number[]; channelPeak: number[]; downmixNonzero: number; downmixPeak: number; framesCreated: number } };

function generatedProcessor(sourceRateHz: number, diagnostics = false): { processor: { port: PcmWorkletPort; process(inputs: Float32Array[][]): boolean }; messages: HarnessMessage[] } {
  let Processor!: new () => { port: PcmWorkletPort; process(inputs: Float32Array[][]): boolean };
  const messages: HarnessMessage[] = [];
  class HarnessBase {
    port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message: unknown) => { messages.push(message as HarnessMessage); },
    };
  }
  const registerProcessor = (_name: string, constructor: new () => typeof HarnessBase) => { Processor = constructor as unknown as typeof Processor; };
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", PCM_AUDIO_WORKLET_SOURCE)(HarnessBase, registerProcessor, sourceRateHz);
  const processor = new Processor();
  processor.port.onmessage?.({ data: { type: "init", contextId: { track: "tab", id: "00000000-0000-4000-8000-000000000001" }, diagnostics } } as MessageEvent);
  return { processor, messages };
}

function inputSamples(length: number): Float32Array {
  const samples = new Float32Array(length);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index / 17) * 0.4;
  return samples;
}

function announceInputFormat(port: PcmWorkletPort, inputChannels = 1): void {
  queueMicrotask(() => port.onmessage?.({ data: { type: "input-format", inputChannels } } as MessageEvent));
}

function runGeneratedProcessor(sourceRateHz: number, chunks: readonly number[]): { frames: Int16Array[]; messages: HarnessMessage[]; processor: { port: PcmWorkletPort; process(inputs: Float32Array[][]): boolean } } {
  const harness = generatedProcessor(sourceRateHz);
  let offset = 0;
  const samples = inputSamples(chunks.reduce((total, length) => total + length, 0));
  for (const length of chunks) {
    harness.processor.process([[samples.slice(offset, offset + length)]]);
    offset += length;
  }
  return { ...harness, frames: harness.messages.filter((message) => message.type === "frame").map((message) => new Int16Array(message.samples!)) };
}

describe("stateful Dialpad PCM capture", () => {
  it("distinguishes true silence from stereo cancellation in opt-in aggregate receipts", () => {
    const silent = generatedProcessor(48_000, true);
    const cancelled = generatedProcessor(48_000, true);
    const signal = new Float32Array(960).fill(0.5);
    silent.processor.process([[new Float32Array(960), new Float32Array(960)]]);
    cancelled.processor.process([[signal, signal.map((sample) => -sample)]]);
    for (const harness of [silent, cancelled]) harness.processor.port.onmessage?.({ data: { type: 'flush' } } as MessageEvent);
    const silentSummary = silent.messages.find((message) => message.type === 'diagnostic')?.summary;
    const cancelledSummary = cancelled.messages.find((message) => message.type === 'diagnostic')?.summary;
    expect(silentSummary).toMatchObject({ inputFrames: 960, channelNonzero: [0, 0], downmixNonzero: 0, framesCreated: 1 });
    expect(cancelledSummary).toMatchObject({ inputFrames: 960, channelNonzero: [960, 960], channelPeak: [0.5, 0.5], downmixNonzero: 0, framesCreated: 1 });
    expect(new Int16Array(cancelled.messages.find((message) => message.type === 'frame')!.samples!)).toEqual(new Int16Array(320));
  });
  it("resamples 48 kHz input into exact 320-sample frames without padding", () => {
    const resampler = new StatefulPcmResampler({ sourceSampleRateHz: 48_000, track: "tab", epoch: 3 });
    const frames = [];
    for (let offset = 0; offset < 9_600; offset += 480) frames.push(...resampler.process(new Float32Array(480).fill(offset === 0 ? 0.5 : -0.5)));
    const tail = resampler.finish();
    expect(frames).toHaveLength(10);
    expect(frames.every((frame) => frame.samples.length === PCM_FRAME_SAMPLES && frame.bytes.length === 640)).toBe(true);
    expect(frames[0]).toMatchObject({ track: "tab", epoch: 3, frameIndex: 0 });
    expect(tail).toMatchObject({ totalInputSamples: 9_600, creditedSamples: 3_200, uncreditedTailSamples: 0 });
  });

  it("uses the actual 44.1 kHz source rate and reports a partial tail", () => {
    const resampler = new StatefulPcmResampler({ sourceSampleRateHz: 44_100, track: "mic", epoch: 1 });
    const frames = resampler.process(new Float32Array(8_823).fill(0.25));
    const tail = resampler.finish();
    expect(frames).toHaveLength(10);
    expect(tail).toMatchObject({ sourceSampleRateHz: 44_100, totalInputSamples: 8_823, creditedSamples: 3_200, uncreditedTailSamples: 1 });
  });

  it("downmixes interleaved input and serializes signed little-endian PCM16", () => {
    expect([...downmixInterleaved(new Float32Array([1, -1, 0.5, 0.5]), 2)]).toEqual([0, 0.5]);
    expect([...pcm16LittleEndian(new Int16Array([-32_768, 32_767]))]).toEqual([0, 128, 255, 127]);
  });

  it("ships an AudioWorklet processor that uses the actual sampleRate and never pads tails", () => {
    expect(PCM_AUDIO_WORKLET_SOURCE).toContain("registerProcessor(\"sandra-dialpad-pcm16\"");
    expect(PCM_AUDIO_WORKLET_SOURCE).toContain("sampleRate");
    expect(PCM_AUDIO_WORKLET_SOURCE).toContain("uncreditedTailSamples");
    expect(PCM_AUDIO_WORKLET_SOURCE).not.toContain("new Float32Array(320)");
  });

  it("keeps generated-worklet output invariant across 44.1/48 kHz block boundaries", () => {
    const oneBlock441 = runGeneratedProcessor(44_100, [8_820]);
    const manyBlocks441 = runGeneratedProcessor(44_100, Array.from({ length: 69 }, (_, index) => index === 68 ? 116 : 128));
    const oneBlock480 = runGeneratedProcessor(48_000, [9_600]);
    const manyBlocks480 = runGeneratedProcessor(48_000, Array.from({ length: 20 }, () => 480));
    expect(oneBlock441.frames).toHaveLength(10);
    expect(oneBlock480.frames).toHaveLength(10);
    expect(manyBlocks441.frames.map((frame) => [...frame])).toEqual(oneBlock441.frames.map((frame) => [...frame]));
    expect(manyBlocks480.frames.map((frame) => [...frame])).toEqual(oneBlock480.frames.map((frame) => [...frame]));
  });

  it("emits sparse periodic anchors and a final anchor with monotonic source geometry", () => {
    const harness = generatedProcessor(48_000);
    harness.processor.process([[inputSamples(128)]]);
    harness.processor.process([[inputSamples(480_000)]]);
    harness.processor.process([[inputSamples(128)]]);
    harness.processor.port.onmessage?.({ data: { type: "flush" } } as MessageEvent);
    const anchors = harness.messages.filter((message) => message.type === "anchor").map((message) => message.record!);
    expect(anchors.map((record) => record.anchor)).toEqual(["start", "periodic", "final"]);
    const periodic = anchors[1]!;
    const final = anchors[2]!;
    expect(periodic.sourceCursor).toBe(480_128);
    expect(periodic.outputCursor).toBe(160_042);
    expect(final.sourceCursor).toBe(480_256);
    expect(final.outputCursor).toBe(160_085);
    expect(final.discardedTailSamples).toBe(85);
    expect(Number(final.sourceCursor)).toBeGreaterThanOrEqual(Number(periodic.sourceCursor) + Number(periodic.blockLength));
    expect(final.contextFrame).toBe(final.previousContextEndFrame);
    expect(final.blockLength).toBe(0);
  });

  it("reports the observed input layout and stops on a channel-layout change", () => {
    const harness = generatedProcessor(48_000);
    expect(harness.processor.process([[inputSamples(128), inputSamples(128)]])).toBe(true);
    expect(harness.messages).toContainEqual({ type: "input-format", inputChannels: 2 });
    expect(harness.processor.process([[inputSamples(128)]])).toBe(false);
    expect(harness.messages.at(-1)).toEqual({ type: "channel-change", inputChannels: 1 });
  });

  it("freezes generated processing after one flush and rejects lower rates", () => {
    const harness = generatedProcessor(48_000);
    const input = inputSamples(960);
    harness.processor.process([[input]]);
    harness.processor.port.onmessage?.({ data: { type: "flush" } } as MessageEvent);
    const messageCount = harness.messages.length;
    expect(harness.processor.process([[input]])).toBe(false);
    harness.processor.port.onmessage?.({ data: { type: "flush" } } as MessageEvent);
    expect(harness.messages).toHaveLength(messageCount);
    expect(harness.messages.at(-1)?.type).toBe("tail");

    const unsupported = generatedProcessor(8_000);
    expect(unsupported.processor.process([[inputSamples(128)]])).toBe(false);
    expect(unsupported.messages).toEqual([{ type: "unsupported-rate", sourceSampleRateHz: 8_000 }]);
    expect(unsupported.processor.process([[inputSamples(128)]])).toBe(false);
    expect(unsupported.messages).toHaveLength(1);
    expect(() => new StatefulPcmResampler({ sourceSampleRateHz: 8_000, track: "tab", epoch: 1 })).toThrow(/below 16 kHz/);
  });

  it("flushes, reports the actual context rate, and releases worklet resources", async () => {
    const tails: unknown[] = [];
    const frames: unknown[] = [];
    const diagnostics: unknown[] = [];
    const portClose = vi.fn();
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "flush") {
          port.onmessage?.({ data: { type: "diagnostic", summary: { emptyInputQuanta: 0, inputFrames: 441, channelNonzero: [100, 0], channelPeak: [0.5, 0], downmixNonzero: 100, downmixPeak: 0.5, framesCreated: 0 } } } as MessageEvent);
          port.onmessage?.({ data: { type: "tail", totalInputSamples: 441, creditedSamples: 160, uncreditedTailSamples: 0 } } as MessageEvent);
        }
      },
      close: portClose,
    };
    const source = { channelCount: 1, connect: () => undefined, disconnect: () => undefined };
    const gain = { gain: { value: 1 }, connect: () => undefined };
    const context = {
      sampleRate: 44_100,
      state: "suspended",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => source,
      createGain: () => gain,
      resume: async () => undefined,
      close: async () => undefined,
    } as unknown as AudioContext;
    const node = { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode;
    const revoked: string[] = [];
    const session = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:pcm",
      revokeObjectURL: (url) => revoked.push(url),
      createNode: () => { announceInputFormat(port); return node; },
    }, {} as MediaStream, "mic", 4, (frame) => { frames.push(frame); }, (tail) => { tails.push(tail); }, { onDiagnostic: (summary) => diagnostics.push(summary) });
    const tail = await session.stop();
    expect(tail).toMatchObject({ track: "mic", epoch: 4, sourceSampleRateHz: 44_100, totalInputSamples: 441 });
    expect(tails).toHaveLength(1);
    expect(frames).toHaveLength(0);
    expect(revoked).toEqual(["blob:pcm"]);
    expect(portClose).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ track: 'mic', epoch: 4, worklet: { inputFrames: 441, channelNonzero: [100, 0] }, framesAccepted: 0, framesDelivered: 0, tailReceived: true });
  });

  it("marks an unacknowledged flush as timed out instead of fabricating counters", async () => {
    vi.useFakeTimers();
    try {
      const port = { onmessage: null, postMessage: () => undefined } as unknown as PcmWorkletPort;
      const context = {
        sampleRate: 48_000,
        state: "running",
        audioWorklet: { addModule: async () => undefined },
        createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
        createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
        close: async () => undefined,
      } as unknown as AudioContext;
      const session = await startPcmWorkletSession({
        createAudioContext: () => context,
        createObjectURL: () => "blob:timeout",
        revokeObjectURL: () => undefined,
        createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
      }, {} as MediaStream, "tab", 5, () => undefined, () => undefined, { timeoutMs: 1_000, deliveryTimeoutMs: 2_000 });
      const stopping = session.stop();
      let settled = false;
      void stopping.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).resolves.toMatchObject({ timedOut: true, totalInputSamples: 0, creditedSamples: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers accepted PCM frames before the tail and bounds a stalled sink", async () => {
    let resolveFrame!: () => void;
    const framePending = new Promise<void>((resolve) => { resolveFrame = resolve; });
    const order: string[] = [];
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "flush") {
          port.onmessage?.({ data: { type: "tail", totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 } } as MessageEvent);
        }
      },
    };
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      close: async () => undefined,
    } as unknown as AudioContext;
    const session = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:ordered",
      revokeObjectURL: () => undefined,
      createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
    }, {} as MediaStream, "tab", 6, async () => { order.push("frame"); await framePending; }, async () => { order.push("tail"); }, { timeoutMs: 10 });
    const samples = new Int16Array(PCM_FRAME_SAMPLES).buffer;
    port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
    const stopping = session.stop();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["frame"]);
    resolveFrame();
    const tail = await stopping;
    expect(tail.deliveryTimedOut).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["frame"]);
  });

  it("drains only the accepted worklet prefix and preserves the first callback failure", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const frames: number[] = [];
    const failures: Error[] = [];
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "flush") {
          port.onmessage?.({ data: { type: "tail", totalInputSamples: 640, creditedSamples: 640, uncreditedTailSamples: 0 } } as MessageEvent);
        }
      },
    };
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      close: async () => undefined,
    } as unknown as AudioContext;
    const session = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:prefix-drain",
      revokeObjectURL: () => undefined,
      createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
    }, {} as MediaStream, "tab", 13, async (frame) => {
      frames.push(frame.frameIndex);
      await (frame.frameIndex === 0 ? first : second);
    }, () => undefined, { timeoutMs: 1_000, onFailure: (error) => failures.push(error) });
    const samples = new Int16Array(PCM_FRAME_SAMPLES).buffer;
    port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
    await Promise.resolve();
    const prefix = session.drainAcceptedFrames!();
    port.onmessage?.({ data: { type: "frame", frameIndex: 1, samples } } as MessageEvent);
    releaseFirst();
    const settled = await Promise.race([prefix.then(() => "prefix" as const), second.then(() => "future" as const)]);
    expect(settled).toBe("prefix");
    expect(frames).toEqual([0, 1]);
    expect(failures).toEqual([]);
    releaseSecond();
    await session.stop();

    const rejected = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:prefix-reject",
      revokeObjectURL: () => undefined,
      createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
    }, {} as MediaStream, "tab", 14, () => { throw new Error("accepted callback failed"); }, () => undefined, { timeoutMs: 1_000 });
    port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
    await expect(rejected.drainAcceptedFrames!()).rejects.toThrow("accepted callback failed");
    await rejected.stop();
  });

  it.each([
    { label: "waits for a 1.65 second accepted delivery", tailDelayMs: 0, delayedDeliveryMs: 1_650, deliveryTimeoutMs: 2_000, deliveryTimedOut: false },
    { label: "starts delivery timing at tail receipt", tailDelayMs: 900, delayedDeliveryMs: 1_650, deliveryTimeoutMs: 2_000, deliveryTimedOut: false },
    { label: "reports a delivery timeout after a stalled delivery exceeds 2 seconds", tailDelayMs: 0, delayedDeliveryMs: 2_100, deliveryTimeoutMs: 2_000, deliveryTimedOut: true },
    { label: "preserves the original deadline without a delivery option", tailDelayMs: 900, delayedDeliveryMs: 200, deliveryTimeoutMs: undefined, deliveryTimedOut: true },
  ])("$label after a prompt flush tail", async ({ tailDelayMs, delayedDeliveryMs, deliveryTimeoutMs, deliveryTimedOut }) => {
    vi.useFakeTimers();
    try {
      const workletDrainTimeoutMs = 1_000;
      const callbackBudgetMs = deliveryTimeoutMs ?? workletDrainTimeoutMs;
      const callbackCompletionFromDeadlineStartMs = deliveryTimeoutMs === undefined
        ? tailDelayMs + delayedDeliveryMs
        : delayedDeliveryMs;
      if (deliveryTimeoutMs === undefined) expect(tailDelayMs).toBeLessThan(workletDrainTimeoutMs);
      else expect(delayedDeliveryMs).toBeGreaterThan(workletDrainTimeoutMs);
      if (deliveryTimedOut) expect(callbackCompletionFromDeadlineStartMs).toBeGreaterThanOrEqual(callbackBudgetMs);
      else expect(callbackCompletionFromDeadlineStartMs).toBeLessThan(callbackBudgetMs);
      const failures: Error[] = [];
      const tails: unknown[] = [];
      let resolveFrameStarted!: () => void;
      const frameStarted = new Promise<void>((resolve) => { resolveFrameStarted = resolve; });
      const port: PcmWorkletPort = {
        onmessage: null,
        postMessage: (message) => {
          if ((message as { type?: string }).type === "flush") {
            setTimeout(() => port.onmessage?.({ data: { type: "tail", totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 } } as MessageEvent), tailDelayMs);
          }
        },
      };
      const context = {
        sampleRate: 48_000,
        state: "running",
        audioWorklet: { addModule: async () => undefined },
        createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
        createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
        close: async () => undefined,
      } as unknown as AudioContext;
      const session = await startPcmWorkletSession({
        createAudioContext: () => context,
        createObjectURL: () => "blob:late-delivery",
        revokeObjectURL: () => undefined,
        createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
      }, {} as MediaStream, "tab", 9, async () => {
        resolveFrameStarted();
        await new Promise<void>((resolve) => setTimeout(resolve, tailDelayMs + delayedDeliveryMs));
      }, (tail) => { tails.push(tail); }, {
        timeoutMs: workletDrainTimeoutMs,
        ...(deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs }),
        startupTimeoutMs: 2_000,
        onFailure: (error) => failures.push(error),
      });
      const samples = new Int16Array(PCM_FRAME_SAMPLES).buffer;
      port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
      await frameStarted;

      const stopping = session.stop();
      await vi.advanceTimersByTimeAsync(deliveryTimedOut ? callbackBudgetMs : tailDelayMs + delayedDeliveryMs);
      const tail = await stopping;
      expect(tail).toMatchObject({ totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 });
      expect(Boolean(tail.deliveryTimedOut)).toBe(deliveryTimedOut);
      if (deliveryTimedOut) {
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ name: "TimeoutError" });
        expect(tails).toEqual([]);
        // The callback completes after its configured delivery budget, so the
        // late tail is suppressed rather than reported as clean.
        await vi.advanceTimersByTimeAsync(tailDelayMs + delayedDeliveryMs - callbackBudgetMs);
        await Promise.resolve();
        expect(tails).toEqual([]);
      } else {
        expect(failures).toEqual([]);
        expect(tails).toHaveLength(1);
        expect(tails[0]).toMatchObject({ totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an accepted callback rejection without publishing a clean tail", async () => {
    const failures: Error[] = [];
    const tails: unknown[] = [];
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "flush") {
          port.onmessage?.({ data: { type: "tail", totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 } } as MessageEvent);
        }
      },
    };
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      close: async () => undefined,
    } as unknown as AudioContext;
    const session = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:rejected-delivery",
      revokeObjectURL: () => undefined,
      createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
    }, {} as MediaStream, "tab", 10, () => { throw new Error("network sink rejected"); }, (tail) => { tails.push(tail); }, { timeoutMs: 1_000, deliveryTimeoutMs: 2_000, onFailure: (error) => failures.push(error) });
    const samples = new Int16Array(PCM_FRAME_SAMPLES).buffer;
    port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const tail = await session.stop();
    expect(tail.deliveryTimedOut).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("network sink rejected");
    expect(tails).toEqual([]);
  });

  it("reports delivery timeout when the tail callback itself stalls after publication", async () => {
    vi.useFakeTimers();
    try {
      const failures: Error[] = [];
      const tails: unknown[] = [];
      const port: PcmWorkletPort = {
        onmessage: null,
        postMessage: (message) => {
          if ((message as { type?: string }).type === "flush") {
            port.onmessage?.({ data: { type: "tail", totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 } } as MessageEvent);
          }
        },
      };
      const context = {
        sampleRate: 48_000,
        state: "running",
        audioWorklet: { addModule: async () => undefined },
        createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
        createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
        close: async () => undefined,
      } as unknown as AudioContext;
      const session = await startPcmWorkletSession({
        createAudioContext: () => context,
        createObjectURL: () => "blob:stalled-tail",
        revokeObjectURL: () => undefined,
        createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
      }, {} as MediaStream, "tab", 12, () => undefined, async (tail) => {
        tails.push(tail);
        await new Promise<void>((resolve) => setTimeout(resolve, 2_100));
      }, { timeoutMs: 1_000, deliveryTimeoutMs: 2_000, onFailure: (error) => failures.push(error) });
      const stopping = session.stop();
      await vi.advanceTimersByTimeAsync(2_000);
      const tail = await stopping;
      expect(tail).toMatchObject({ deliveryTimedOut: true, totalInputSamples: 0, creditedSamples: 0 });
      expect(tails).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes callback admission after a tail and makes repeated stop idempotent", async () => {
    let frameCalls = 0;
    const tails: unknown[] = [];
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: () => undefined,
    };
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      close: async () => undefined,
    } as unknown as AudioContext;
    const session = await startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:frozen-after-tail",
      revokeObjectURL: () => undefined,
      createNode: () => { announceInputFormat(port); return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode; },
    }, {} as MediaStream, "mic", 11, () => { frameCalls += 1; }, (tail) => { tails.push(tail); }, { timeoutMs: 1_000, deliveryTimeoutMs: 2_000 });
    port.onmessage?.({ data: { type: "tail", totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 } } as MessageEvent);
    port.onmessage?.({ data: { type: "frame", frameIndex: 0, samples: new Int16Array(PCM_FRAME_SAMPLES).buffer } } as MessageEvent);
    await Promise.resolve();
    expect(frameCalls).toBe(0);
    const firstStop = session.stop();
    const secondStop = session.stop();
    const firstTail = await firstStop;
    expect(await secondStop).toBe(firstTail);
    expect(tails).toHaveLength(1);
  });

  it("bounds startup and releases context and object URL on a hung addModule", async () => {
    const close = vi.fn(async () => undefined);
    const revoke = vi.fn();
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: () => new Promise<void>(() => undefined) },
      close,
    } as unknown as AudioContext;
    await expect(startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:startup-timeout",
      revokeObjectURL: revoke,
      waitMs: async () => undefined,
    }, {} as MediaStream, "tab", 7, () => undefined, () => undefined, { startupTimeoutMs: 1 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:startup-timeout");
  });

  it("bounds a hung AudioContext resume after the worklet module loads", async () => {
    const close = vi.fn(async () => undefined);
    const revoke = vi.fn();
    const context = {
      sampleRate: 48_000,
      state: "suspended",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      destination: {},
      resume: () => new Promise<void>(() => undefined),
      close,
    } as unknown as AudioContext;
    await expect(startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => "blob:resume-timeout",
      revokeObjectURL: revoke,
      createNode: () => ({ port: { onmessage: null, postMessage: () => undefined }, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode),
      waitMs: async () => undefined,
    }, {} as MediaStream, "mic", 8, () => undefined, () => undefined, { startupTimeoutMs: 1 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:resume-timeout");
  });
});
