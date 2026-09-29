import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  BrowserCaptureError,
  MAX_MEDIA_CHUNK_BYTES,
  MEDIA_RECORDER_MIME_TYPE,
  MediaRecorderCollector,
  assertSandraCaptureHandle,
  createSandraCaptureHandleProof,
  monitorSandraCaptureHandle,
  monitorDialpadTrackEnded,
  prepareDialpadBrowserCapture,
  splitMediaBlob,
  type BrowserCaptureRuntime,
  type MediaRecorderLike,
} from "./browser-capture";
import { PCM_FRAME_SAMPLES, startPcmWorkletSession, type PcmFrame, type PcmTailReport, type PcmWorkletPort } from "./pcm-audio-worklet";

class FakeTrack extends EventTarget {
  stopped = 0;
  constructor(public handle: string | null = "tab-handle") { super(); }
  getCaptureHandle = () => this.handle ? { handle: this.handle, origin: "https://sandra.example" } : null;
  stop = () => { this.stopped += 1; this.dispatchEvent(new Event("ended")); };
}

class FakeStream {
  constructor(private readonly videoTracks: FakeTrack[], private readonly audioTracks: FakeTrack[]) {}
  getTracks = () => [...this.videoTracks, ...this.audioTracks];
  getAudioTracks = () => this.audioTracks;
  getVideoTracks = () => this.videoTracks;
}

class FakeRecorder extends EventTarget implements MediaRecorderLike {
  state = "inactive";
  startCalls = 0;
  constructor(private readonly finalBlob: Blob | null = null, private readonly delayedFinal = false) { super(); }
  start() { this.state = "recording"; this.startCalls += 1; }
  emit(blob: Blob) { this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: blob })); }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
    if (this.finalBlob) {
      const emit = () => this.emit(this.finalBlob!);
      if (this.delayedFinal) setTimeout(emit, 0);
      else emit();
    }
  }
}

function mediaStream(video: FakeTrack, audio: FakeTrack): MediaStream {
  return new FakeStream([video], [audio]) as unknown as MediaStream;
}

function runtime(display: MediaStream, microphone: MediaStream, recorderFactory: () => MediaRecorderLike, pcmFactory?: BrowserCaptureRuntime["createPcmSession"]): BrowserCaptureRuntime {
  return {
    getDisplayMedia: vi.fn(async () => display),
    getUserMedia: vi.fn(async () => microphone),
    createMediaStream: (tracks) => new FakeStream([], [...tracks] as unknown as FakeTrack[]) as unknown as MediaStream,
    createRecorder: () => recorderFactory(),
    createPcmSession: pcmFactory ?? (async () => ({ sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track: "tab", epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) })),
  };
}

function realPcmFactory(nodes: PcmWorkletPort[], timeoutMs = 20): NonNullable<BrowserCaptureRuntime["createPcmSession"]> {
  return async (stream, track, epoch, onFrame, onTail, options) => {
    const port: PcmWorkletPort = {
      onmessage: null,
      postMessage: (message) => {
        if ((message as { type?: string }).type === "flush") {
          port.onmessage?.({ data: { type: "tail", totalInputSamples: 960, creditedSamples: 320, uncreditedTailSamples: 0 } } as MessageEvent);
        }
      },
      close: vi.fn(),
    };
    nodes.push(port);
    const context = {
      sampleRate: 48_000,
      state: "running",
      audioWorklet: { addModule: async () => undefined },
      createMediaStreamSource: () => ({ channelCount: 1, connect: () => undefined, disconnect: () => undefined }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      destination: {},
      close: async () => undefined,
    } as unknown as AudioContext;
    return startPcmWorkletSession({
      createAudioContext: () => context,
      createObjectURL: () => `blob:${track}`,
      revokeObjectURL: () => undefined,
      createNode: () => {
        queueMicrotask(() => port.onmessage?.({ data: { type: "input-format", inputChannels: 1 } } as MessageEvent));
        return { port, connect: () => undefined, disconnect: () => undefined } as unknown as AudioWorkletNode;
      },
    }, stream, track, epoch, onFrame, onTail, { ...options, timeoutMs, startupTimeoutMs: timeoutMs });
  };
}

describe("Dialpad browser capture proof", () => {
  it("configures a fresh exact-origin capture handle", () => {
    const setCaptureHandleConfig = vi.fn();
    const proof = createSandraCaptureHandleProof({ origin: "https://sandra.example", setCaptureHandleConfig }, () => "fresh-handle");
    expect(proof).toEqual({ handle: "fresh-handle", origin: "https://sandra.example" });
    expect(setCaptureHandleConfig).toHaveBeenCalledWith({ handle: "fresh-handle", exposeOrigin: true, permittedOrigins: ["https://sandra.example"] });
  });

  it("rejects unsupported or wrong capture handles", () => {
    expect(() => createSandraCaptureHandleProof({ origin: "https://sandra.example" }, () => "x")).toThrowError(BrowserCaptureError);
    const track = new FakeTrack("other-handle");
    expect(() => assertSandraCaptureHandle(track as unknown as MediaStreamTrack, { handle: "fresh-handle", origin: "https://sandra.example" })).toThrowError(/current Sandra tab/);
  });

  it("stops on capture-handle change and track end", () => {
    const track = new FakeTrack();
    const failures: BrowserCaptureError[] = [];
    const monitor = monitorSandraCaptureHandle(track as unknown as MediaStreamTrack, { handle: "tab-handle", origin: "https://sandra.example" }, (error) => failures.push(error));
    track.handle = "other";
    track.dispatchEvent(new Event("capturehandlechange"));
    expect(failures[0]?.code).toBe("wrong_tab");
    monitor.stop();
    track.handle = "tab-handle";
    const second = monitorSandraCaptureHandle(track as unknown as MediaStreamTrack, { handle: "tab-handle", origin: "https://sandra.example" }, (error) => failures.push(error));
    track.dispatchEvent(new Event("ended"));
    expect(failures.at(-1)?.code).toBe("interrupted");
    second.stop();
  });

  it("interrupts when an audio permission track ends", () => {
    const track = new FakeTrack();
    const failures: BrowserCaptureError[] = [];
    const monitor = monitorDialpadTrackEnded(track as unknown as MediaStreamTrack, (error) => failures.push(error));
    track.dispatchEvent(new Event("ended"));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("interrupted");
    monitor.stop();
  });
});

describe("MediaRecorderCollector", () => {
  it("preserves delayed final data and splits oversized blobs without changing bytes", async () => {
    const first = new Uint8Array(MAX_MEDIA_CHUNK_BYTES + 3).map((_, index) => index % 251);
    const final = new Uint8Array(MAX_MEDIA_CHUNK_BYTES + 17).map((_, index) => (index + 17) % 251);
    const recorder = new FakeRecorder(new Blob([final]), true);
    const chunks: { seq: number; blob: Blob }[] = [];
    let requestedMimeType: string | undefined;
    const collector = new MediaRecorderCollector({ track: "tab", stream: {} as MediaStream, createRecorder: (_stream, mimeType) => { requestedMimeType = mimeType; return recorder; }, onChunk: (chunk) => { chunks.push({ seq: chunk.seq, blob: chunk.blob }); }, stopTimeoutMs: 100, finalizationWaitMs: 10 });
    collector.start(4);
    recorder.emit(new Blob([first]));
    await collector.stop();
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
    const bytes = new Uint8Array(await new Blob(chunks.map((chunk) => chunk.blob)).arrayBuffer());
    const expected = new Uint8Array(first.length + final.length);
    expected.set(first);
    expected.set(final, first.length);
    // Compare a native digest rather than asking the matcher to materialize
    // millions of per-index entries under constrained CI workers. This still
    // covers every byte and keeps the assertion bounded in diagnostic size.
    const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
    expect(bytes.byteLength).toBe(expected.byteLength);
    expect(digest(bytes)).toBe(digest(expected));
    expect(collector.state).toBe("stopped");
    expect(requestedMimeType).toBe(MEDIA_RECORDER_MIME_TYPE);
  });

  it("starts a fresh recorder and sequence for each epoch", async () => {
    const first = new FakeRecorder();
    const second = new FakeRecorder();
    const recorders = [first, second];
    const chunks: { epoch: number; seq: number; blob: Blob }[] = [];
    const collector = new MediaRecorderCollector({
      track: "tab",
      stream: {} as MediaStream,
      createRecorder: () => recorders.shift()!,
      onChunk: (chunk) => { chunks.push({ epoch: chunk.epoch, seq: chunk.seq, blob: chunk.blob }); },
      finalizationWaitMs: 0,
    });
    collector.start(7);
    first.emit(new Blob(["epoch-seven"]));
    await collector.stop();
    collector.start(8);
    second.emit(new Blob(["epoch-eight"]));
    await collector.stop();
    expect(chunks.map(({ epoch, seq }) => ({ epoch, seq }))).toEqual([{ epoch: 7, seq: 0 }, { epoch: 8, seq: 0 }]);
    expect(first.startCalls).toBe(1);
    expect(second.startCalls).toBe(1);
    expect(first.state).toBe("inactive");
    expect(second.state).toBe("inactive");
  });

  it("abandons queued split parts after a bounded sink timeout", async () => {
    const recorder = new FakeRecorder();
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const calls: number[] = [];
    const collector = new MediaRecorderCollector({
      track: "tab",
      stream: {} as MediaStream,
      createRecorder: () => recorder,
      onChunk: async (chunk) => {
        calls.push(chunk.seq);
        if (chunk.seq === 0) await stalled;
      },
      stopTimeoutMs: 10,
      finalizationWaitMs: 0,
    });
    collector.start(1);
    recorder.emit(new Blob([new Uint8Array(MAX_MEDIA_CHUNK_BYTES + 1)]));
    await Promise.resolve();
    await collector.stop();
    expect(collector.state).toBe("interrupted");
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([0]);
  });

  it("marks sink failures and bounded backpressure as interruptions", async () => {
    const recorder = new FakeRecorder();
    const failures: BrowserCaptureError[] = [];
    const collector = new MediaRecorderCollector({ track: "mic", stream: {} as MediaStream, createRecorder: () => recorder, onChunk: async () => { throw new Error("sink down"); }, onFailure: (error) => failures.push(error), finalizationWaitMs: 0 });
    collector.start();
    recorder.emit(new Blob(["payload"]));
    await collector.stop();
    expect(failures[0]?.code).toBe("sink_failure");
    expect(collector.state).toBe("interrupted");

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const overflow = new MediaRecorderCollector({ track: "tab", stream: {} as MediaStream, createRecorder: () => recorder, onChunk: () => pending, onFailure: (error) => failures.push(error), maxPendingChunks: 1 });
    overflow.start();
    recorder.emit(new Blob(["a"]));
    recorder.emit(new Blob(["b"]));
    release();
    await overflow.stop();
    expect(failures.some((error) => error.code === "buffer_overflow")).toBe(true);
  });
});

describe("Dialpad capture preparation", () => {
  it("prepares permissions without creating recorders, then captures tab and mic separately", async () => {
    const video = new FakeTrack();
    const tabAudio = new FakeTrack();
    const micAudio = new FakeTrack();
    const recorders = [new FakeRecorder(), new FakeRecorder()];
    let recorderIndex = 0;
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, _onFrame: unknown, _onTail: unknown) => {
      void _onFrame;
      void _onTail;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({ proof: { handle: "tab-handle", origin: "https://sandra.example" }, runtime: runtime(mediaStream(video, tabAudio), new FakeStream([], [micAudio]) as unknown as MediaStream, () => recorders[recorderIndex++]!, createPcmSession) });
    expect(recorderIndex).toBe(0);
    const active = await prepared.start({ onWebmChunk: vi.fn(), onPcmFrame: vi.fn() });
    expect(recorderIndex).toBe(2);
    expect(createPcmSession).toHaveBeenCalledTimes(2);
    await active.stop();
    await active.dispose();
    await prepared.dispose();
    await prepared.dispose();
    expect(video.stopped).toBeGreaterThan(0);
    expect(micAudio.stopped).toBeGreaterThan(0);
  });

  it("publishes actual PCM formats before releasing queued PCM or starting WebM", async () => {
    const events: string[] = [];
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (frame: PcmFrame) => void | Promise<void>) => {
      await onFrame({ track, epoch, frameIndex: 0, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
      return { sourceSampleRateHz: track === "tab" ? 48_000 : 44_100, inputChannels: track === "tab" ? 2 : 1, stop: async () => ({ track, epoch, sourceSampleRateHz: track === "tab" ? 48_000 : 44_100, totalInputSamples: 320, creditedSamples: 320, uncreditedTailSamples: 0 }) };
    });
    const recorders = [new FakeRecorder(), new FakeRecorder()];
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => recorders.shift()!, createPcmSession),
    });
    const active = await prepared.start({
      onTrackFormat: (format) => { events.push(`${format.track}:format:${format.contextSampleRateHz}:${format.inputChannels}`); },
      onPcmFrame: (frame) => { events.push(`${frame.track}:pcm`); },
      onWebmChunk: () => { events.push("webm"); },
    });
    expect(events.slice(0, 4)).toEqual(["tab:format:48000:2", "mic:format:44100:1", "tab:pcm", "mic:pcm"]);
    expect(events).not.toContain("webm");
    await active.stop();
    await prepared.dispose();
  });

  it("starts a bounded local spool and drains its immutable PCM prefix before live frames", async () => {
    const callbacks: Record<"tab" | "mic", ((frame: PcmFrame) => void | Promise<void>) | null> = { tab: null, mic: null };
    const recorders = [new FakeRecorder(), new FakeRecorder()];
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (frame: PcmFrame) => void | Promise<void>) => {
      callbacks[track] = onFrame;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 960, creditedSamples: 960, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => recorders.shift()!, createPcmSession),
      localSpoolMaxBytes: 1_000_000,
    });
    const first = (index: number): PcmFrame => ({ track: "tab", epoch: 1, frameIndex: index, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    const active = await prepared.startLocal!(1);
    await callbacks.tab?.(first(0));
    await callbacks.tab?.(first(1));
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    const attach = active.attach!({
      onTrackFormat: vi.fn(),
      onPcmFrame: async (frame) => { seen.push(frame.frameIndex); if (frame.frameIndex === 0) await delayed; },
      onWebmChunk: vi.fn(),
    }, 7);
    await Promise.resolve();
    await callbacks.tab?.(first(2));
    release();
    await attach;
    expect(seen).toEqual([0, 1, 2]);
    expect(active.state()).toBe("recording");
    await active.dispose();
    await prepared.dispose();
  });

  it("keeps attachment-time PCM in the bounded spool while a WebM prefix sink is stalled", async () => {
    const callbacks: { tab: ((frame: PcmFrame) => void | Promise<void>) | null; mic: ((frame: PcmFrame) => void | Promise<void>) | null } = { tab: null, mic: null };
    const tabRecorder = new FakeRecorder();
    const micRecorder = new FakeRecorder();
    const recorders = [tabRecorder, micRecorder];
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (frame: PcmFrame) => void | Promise<void>) => {
      callbacks[track] = onFrame;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => recorders.shift()!, createPcmSession),
      localSpoolMaxBytes: 128_000,
    });
    const active = await prepared.startLocal!(1);
    const frame = (index: number): PcmFrame => ({ track: "tab", epoch: 1, frameIndex: index, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    tabRecorder.emit(new Blob(["webm-prefix"]));
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const webm: number[] = [];
    const pcm: number[] = [];
    const attach = active.attach!({
      onTrackFormat: vi.fn(),
      onWebmChunk: async (chunk) => { webm.push(chunk.seq); await stalled; },
      onPcmFrame: (value) => { pcm.push(value.frameIndex); },
    }, 7);
    await Promise.resolve();
    for (let index = 0; index < 80; index += 1) await callbacks.tab?.(frame(index));
    release();
    await attach;
    expect(webm).toEqual([0]);
    expect(pcm).toEqual(Array.from({ length: 80 }, (_, index) => index));
    expect(active.state()).toBe("recording");
    await active.dispose();
    await prepared.dispose();
  });

  it("does not allocate a recorder after disposal wins during delayed format publication", async () => {
    const formatRelease = (() => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; })();
    const recorders = [new FakeRecorder(), new FakeRecorder()];
    const createRecorder = vi.fn(() => recorders.shift()!);
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, createRecorder),
    });
    const start = prepared.start({ onTrackFormat: async () => formatRelease.promise, onWebmChunk: vi.fn(), onPcmFrame: vi.fn() });
    await Promise.resolve();
    const dispose = prepared.dispose();
    formatRelease.resolve();
    await dispose;
    await expect(start).rejects.toMatchObject({ code: "interrupted" });
    expect(createRecorder).not.toHaveBeenCalled();
  });

  it("keeps a live PCM frame behind the complete buffered startup prefix", async () => {
    let tabFrame: ((frame: PcmFrame) => void | Promise<void>) | null = null;
    const frame = (index: number): PcmFrame => ({ track: "tab", epoch: 1, frameIndex: index, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (value: PcmFrame) => void | Promise<void>) => {
      if (track === "tab") {
        tabFrame = onFrame;
        await onFrame(frame(0));
        await onFrame(frame(1));
      }
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 640, creditedSamples: 640, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession),
    });
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    const start = prepared.start({
      onTrackFormat: vi.fn(),
      onPcmFrame: async (value) => {
        seen.push(value.frameIndex);
        if (value.frameIndex === 0) {
          await tabFrame?.(frame(2));
          await stalled;
        }
      },
      onWebmChunk: vi.fn(),
    });
    await Promise.resolve();
    release();
    const active = await start;
    expect(seen).toEqual([0, 1, 2]);
    await active.dispose();
    await prepared.dispose();
  });

  it("fails honestly when the pre-call spool reaches its byte capacity", async () => {
    let tabFrame: ((frame: PcmFrame) => void | Promise<void>) | null = null;
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (value: PcmFrame) => void | Promise<void>) => {
      if (track === "tab") tabFrame = onFrame;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      localSpoolMaxBytes: 500,
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession),
    });
    const active = await prepared.startLocal!(1);
    const emitTabFrame = tabFrame as unknown as ((frame: PcmFrame) => void | Promise<void>);
    await emitTabFrame({ track: "tab", epoch: 1, frameIndex: 0, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active.state()).toBe("interrupted");
    await active.dispose();
    await prepared.dispose();
  });

  it("fails honestly when the pre-call spool exceeds its elapsed bound", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let tabFrame: ((frame: PcmFrame) => void | Promise<void>) | null = null;
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (value: PcmFrame) => void | Promise<void>) => {
      if (track === "tab") tabFrame = onFrame;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      localSpoolMaxMs: 1,
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession),
    });
    const active = await prepared.startLocal!(1);
    clock.mockReturnValue(1_002);
    const emitTabFrame = tabFrame as unknown as (frame: PcmFrame) => void | Promise<void>;
    await emitTabFrame({ track: "tab", epoch: 1, frameIndex: 0, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active.state()).toBe("interrupted");
    await active.dispose();
    await prepared.dispose();
    clock.mockRestore();
  });

  it("ends the unauthenticated spool clock at attachment while retaining a bounded late prefix drain", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let tabFrame: ((frame: PcmFrame) => void | Promise<void>) | null = null;
    const recorders = [new FakeRecorder(), new FakeRecorder()];
    let recorderIndex = 0;
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic", epoch: number, onFrame: (value: PcmFrame) => void | Promise<void>) => {
      if (track === "tab") tabFrame = onFrame;
      return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: async () => ({ track, epoch, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }) };
    });
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      localSpoolMaxMs: 120_000,
      runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => recorders[recorderIndex++]!, createPcmSession),
    });
    const active = await prepared.startLocal!(1);
    const frame = (index: number): PcmFrame => ({ track: "tab", epoch: 1, frameIndex: index, samples: new Int16Array(PCM_FRAME_SAMPLES), bytes: new Uint8Array(PCM_FRAME_SAMPLES * 2) });
    const emitTabFrame = tabFrame as unknown as (value: PcmFrame) => void | Promise<void>;
    await emitTabFrame(frame(0));
    recorders[0]!.emit(new Blob(["webm-prefix"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const seen: number[] = [];
    clock.mockReturnValue(120_999);
    const attach = active.attach!({ onTrackFormat: vi.fn(), onWebmChunk: async () => held, onPcmFrame: (value) => { seen.push(value.frameIndex); } }, 7);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    clock.mockReturnValue(121_500);
    await emitTabFrame(frame(1));
    release();
    await attach;
    expect(seen).toEqual([0, 1]);
    expect(active.state()).toBe("recording");
    await active.dispose();
    await prepared.dispose();
    clock.mockRestore();
  });

  it("rejects wrong-tab and missing-tab-audio preparation", async () => {
    const wrongVideo = new FakeTrack("other-handle");
    await expect(prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(mediaStream(wrongVideo, new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder()),
    })).rejects.toMatchObject({ code: "wrong_tab" });
    expect(wrongVideo.stopped).toBe(1);

    const noAudioVideo = new FakeTrack();
    const noAudioDisplay = new FakeStream([noAudioVideo], []) as unknown as MediaStream;
    await expect(prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: runtime(noAudioDisplay, new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder()),
    })).rejects.toMatchObject({ code: "missing_audio" });
    expect(noAudioVideo.stopped).toBe(1);
  });

  it("rejects a browser without the required Opus WebM recorder", async () => {
    const prepared = await prepareDialpadBrowserCapture({
      proof: { handle: "tab-handle", origin: "https://sandra.example" },
      runtime: { ...runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder()), supportsMediaRecorder: (mimeType) => mimeType !== MEDIA_RECORDER_MIME_TYPE },
    });
    await expect(prepared.start({ onWebmChunk: vi.fn(), onPcmFrame: vi.fn() })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("cleans up display permission when microphone permission fails", async () => {
    const video = new FakeTrack();
    const tabAudio = new FakeTrack();
    const display = mediaStream(video, tabAudio);
    await expect(prepareDialpadBrowserCapture({ proof: { handle: "tab-handle", origin: "https://sandra.example" }, runtime: { ...runtime(display, new FakeStream([], []) as unknown as MediaStream, () => new FakeRecorder()), getUserMedia: vi.fn(async () => { throw new Error("denied"); }) } })).rejects.toMatchObject({ code: "permission_denied" });
    expect(video.stopped).toBe(1);
    expect(tabAudio.stopped).toBe(1);
  });

  it("stops a start in progress and keeps a wrong-tab failure authoritative", async () => {
    const video = new FakeTrack();
    const tabAudio = new FakeTrack();
    let resolveTab!: (session: Awaited<ReturnType<NonNullable<BrowserCaptureRuntime["createPcmSession"]>>>) => void;
    let resolveMic!: (session: Awaited<ReturnType<NonNullable<BrowserCaptureRuntime["createPcmSession"]>>>) => void;
    const pendingTab = new Promise<Awaited<ReturnType<NonNullable<BrowserCaptureRuntime["createPcmSession"]>>>>((resolve) => { resolveTab = resolve; });
    const pendingMic = new Promise<Awaited<ReturnType<NonNullable<BrowserCaptureRuntime["createPcmSession"]>>>>((resolve) => { resolveMic = resolve; });
    const tabStop = vi.fn(async () => ({ track: "tab" as const, epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }));
    const micStop = vi.fn(async () => ({ track: "mic" as const, epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }));
    const createPcmSession = vi.fn((_stream: MediaStream, track: "tab" | "mic") => track === "tab" ? pendingTab : pendingMic);
    const prepared = await prepareDialpadBrowserCapture({ proof: { handle: "tab-handle", origin: "https://sandra.example" }, runtime: runtime(mediaStream(video, tabAudio), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession) });
    const start = prepared.start({ onWebmChunk: vi.fn(), onPcmFrame: vi.fn() });
    await Promise.resolve();
    const dispose = prepared.dispose();
    resolveTab({ sourceSampleRateHz: 48_000, inputChannels: 1, stop: tabStop });
    resolveMic({ sourceSampleRateHz: 48_000, inputChannels: 1, stop: micStop });
    await dispose;
    await expect(start).rejects.toMatchObject({ code: "interrupted" });
    expect(tabStop).toHaveBeenCalledTimes(1);
    expect(micStop).toHaveBeenCalledTimes(1);
  });

  it.each(["tab", "mic"] as const)("stops the successful %s PCM sibling when the other startup rejects", async (successfulTrack) => {
    const successfulStop = vi.fn(async () => ({ track: successfulTrack, epoch: 1, sourceSampleRateHz: 48_000, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0 }));
    const createPcmSession = vi.fn(async (_stream: MediaStream, track: "tab" | "mic") => {
      if (track === successfulTrack) return { sourceSampleRateHz: 48_000, inputChannels: 1, stop: successfulStop };
      throw new Error(`${track} worklet startup failed`);
    });
    const prepared = await prepareDialpadBrowserCapture({ proof: { handle: "tab-handle", origin: "https://sandra.example" }, runtime: runtime(mediaStream(new FakeTrack(), new FakeTrack()), new FakeStream([], [new FakeTrack()]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession) });
    await expect(prepared.start({ onWebmChunk: vi.fn(), onPcmFrame: vi.fn() })).rejects.toMatchObject({ code: "unsupported" });
    expect(successfulStop).toHaveBeenCalledTimes(1);
  });

  it("marks active capture interrupted on a stalled real-worklet PCM delivery", async () => {
    const nodes: PcmWorkletPort[] = [];
    const displayVideo = new FakeTrack();
    const displayAudio = new FakeTrack();
    const microphoneAudio = new FakeTrack();
    let releaseFrame!: () => void;
    const stalledFrame = new Promise<void>((resolve) => { releaseFrame = resolve; });
    const failures: BrowserCaptureError[] = [];
    const frames: PcmFrame[] = [];
    const tails: PcmTailReport[] = [];
    const createPcmSession = realPcmFactory(nodes);
    const prepared = await prepareDialpadBrowserCapture({ proof: { handle: "tab-handle", origin: "https://sandra.example" }, runtime: runtime(mediaStream(displayVideo, displayAudio), new FakeStream([], [microphoneAudio]) as unknown as MediaStream, () => new FakeRecorder(), createPcmSession) });
    const active = await prepared.start({
      onWebmChunk: vi.fn(),
      onPcmFrame: async (frame) => { frames.push(frame); await stalledFrame; },
      onPcmTail: (tail) => { tails.push(tail); },
      onFailure: (error) => { failures.push(error); },
    });
    const samples = new Int16Array(PCM_FRAME_SAMPLES).buffer;
    nodes[0]!.onmessage?.({ data: { type: "frame", frameIndex: 0, samples } } as MessageEvent);
    await Promise.resolve();
    const startedAt = Date.now();
    await active.stop();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(active.state()).toBe("interrupted");
    expect(failures).toHaveLength(1);
    releaseFrame();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(frames).toHaveLength(1);
    expect(tails.some((tail) => tail.track === "tab")).toBe(false);
    await prepared.dispose();
  });
});

describe("small capture helpers", () => {
  it("rejects invalid split limits", () => {
    expect(() => splitMediaBlob(new Blob(["x"]), 0)).toThrow();
  });
});
