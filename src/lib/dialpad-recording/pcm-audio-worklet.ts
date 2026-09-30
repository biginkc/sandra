export const PCM_TARGET_SAMPLE_RATE_HZ = 16_000;
export const PCM_FRAME_SAMPLES = 320;
export const PCM_WORKLET_PROCESSOR_NAME = "sandra-dialpad-pcm16";

export type PcmTrack = "tab" | "mic";

export type PcmFrame = {
  readonly track: PcmTrack;
  readonly epoch: number;
  readonly frameIndex: number;
  readonly samples: Int16Array;
  readonly bytes: Uint8Array;
};

export type PcmTailReport = {
  readonly track: PcmTrack;
  readonly epoch: number;
  readonly sourceSampleRateHz: number;
  readonly totalInputSamples: number;
  readonly creditedSamples: number;
  readonly uncreditedTailSamples: number;
  /** True when the worklet did not acknowledge flush before the bounded deadline. */
  readonly timedOut?: boolean;
  /** True when accepted PCM callbacks did not drain before the bounded deadline. */
  readonly deliveryTimedOut?: boolean;
};

export type PcmTimingRecord = DialpadTimingAnchor | DialpadTimingContextClock;

export type PcmResamplerOptions = {
  readonly sourceSampleRateHz: number;
  readonly track: PcmTrack;
  readonly epoch: number;
  readonly maxBufferedSamples?: number;
};

export type PcmResamplerResult = {
  readonly frames: readonly PcmFrame[];
  readonly totalInputSamples: number;
  readonly creditedSamples: number;
  readonly uncreditedTailSamples: number;
};

function assertSampleRate(sampleRateHz: number): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz < PCM_TARGET_SAMPLE_RATE_HZ || sampleRateHz > 192_000) {
    throw new Error("Unsupported source sample rate; rates below 16 kHz are not accepted.");
  }
}

function toPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
}

export function pcm16LittleEndian(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index]!, true);
  return bytes;
}

/**
 * Streaming linear resampler. It keeps one source sample of look-behind and
 * never pads a partial output frame, so a tail remains explicit evidence.
 */
export class StatefulPcmResampler {
  private readonly sourceSampleRateHz: number;
  private readonly track: PcmTrack;
  private readonly epoch: number;
  private readonly maxBufferedSamples: number;
  private pending = new Float32Array(0);
  private pendingBaseSample = 0;
  private totalInputSamples = 0;
  private nextOutputIndex = 0;
  private frame = new Int16Array(PCM_FRAME_SAMPLES);
  private frameLength = 0;
  private nextFrameIndex = 0;
  private finished = false;

  constructor(options: PcmResamplerOptions) {
    assertSampleRate(options.sourceSampleRateHz);
    this.sourceSampleRateHz = options.sourceSampleRateHz;
    this.track = options.track;
    this.epoch = options.epoch;
    this.maxBufferedSamples = options.maxBufferedSamples ?? 8_192;
  }

  get sourceRateHz(): number {
    return this.sourceSampleRateHz;
  }

  get totalInput(): number {
    return this.totalInputSamples;
  }

  get creditedSamples(): number {
    return this.nextFrameIndex * PCM_FRAME_SAMPLES;
  }

  process(monoSamples: Float32Array): readonly PcmFrame[] {
    if (this.finished) throw new Error("PCM resampler is finished.");
    if (monoSamples.length === 0) return [];
    const joined = new Float32Array(this.pending.length + monoSamples.length);
    joined.set(this.pending);
    joined.set(monoSamples, this.pending.length);
    this.pending = joined;
    this.totalInputSamples += monoSamples.length;

    const frames: PcmFrame[] = [];
    const ratio = this.sourceSampleRateHz / PCM_TARGET_SAMPLE_RATE_HZ;
    const targetSamples = Math.floor((this.totalInputSamples * PCM_TARGET_SAMPLE_RATE_HZ) / this.sourceSampleRateHz);
    while (this.nextOutputIndex < targetSamples) {
      const sourcePosition = this.nextOutputIndex * ratio;
      const sourceIndex = Math.floor(sourcePosition);
      const offset = sourceIndex - this.pendingBaseSample;
      if (offset < 0 || offset >= this.pending.length) break;
      const nextOffset = Math.min(offset + 1, this.pending.length - 1);
      const fraction = sourcePosition - sourceIndex;
      const sample = this.pending[offset]! + (this.pending[nextOffset]! - this.pending[offset]!) * fraction;
      this.frame[this.frameLength] = toPcm16(sample);
      this.frameLength += 1;
      this.nextOutputIndex += 1;
      if (this.frameLength === PCM_FRAME_SAMPLES) {
        const samples = this.frame;
        frames.push({
          track: this.track,
          epoch: this.epoch,
          frameIndex: this.nextFrameIndex,
          samples,
          bytes: pcm16LittleEndian(samples),
        });
        this.nextFrameIndex += 1;
        this.frame = new Int16Array(PCM_FRAME_SAMPLES);
        this.frameLength = 0;
      }
    }

    const keepFrom = Math.max(this.pendingBaseSample, Math.floor(this.nextOutputIndex * ratio) - 1);
    if (keepFrom > this.pendingBaseSample) {
      this.pending = this.pending.slice(keepFrom - this.pendingBaseSample);
      this.pendingBaseSample = keepFrom;
    }
    if (this.pending.length > this.maxBufferedSamples) throw new Error("PCM resampler buffer overflow.");
    return frames;
  }

  finish(): PcmTailReport {
    if (!this.finished) this.finished = true;
    const creditedSamples = this.creditedSamples;
    const targetSamples = Math.floor((this.totalInputSamples * PCM_TARGET_SAMPLE_RATE_HZ) / this.sourceSampleRateHz);
    return {
      track: this.track,
      epoch: this.epoch,
      sourceSampleRateHz: this.sourceSampleRateHz,
      totalInputSamples: this.totalInputSamples,
      creditedSamples,
      uncreditedTailSamples: Math.max(0, targetSamples - creditedSamples),
    };
  }

  flush(): PcmResamplerResult {
    const tail = this.finish();
    return {
      frames: [],
      totalInputSamples: tail.totalInputSamples,
      creditedSamples: tail.creditedSamples,
      uncreditedTailSamples: tail.uncreditedTailSamples,
    };
  }
}

export function downmixInterleaved(samples: Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8 || samples.length % channels !== 0) {
    throw new Error("Invalid PCM channel layout.");
  }
  if (channels === 1) return samples.slice();
  const mono = new Float32Array(samples.length / channels);
  for (let frame = 0; frame < mono.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += samples[frame * channels + channel]!;
    mono[frame] = sum / channels;
  }
  return mono;
}

/** Browser module source; sampleRate is the actual AudioContext rate. */
export const PCM_AUDIO_WORKLET_SOURCE = String.raw`
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320;
class SandraDialpadPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(0);
    this.pendingBase = 0;
    this.totalInput = 0;
    this.nextOutput = 0;
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.frameLength = 0;
    this.frameIndex = 0;
    this.flushing = false;
    this.unsupported = sampleRate < TARGET_RATE || sampleRate > 192000;
    this.closed = false;
    this.inputChannels = 0;
    this.contextId = null;
    this.anchorSeq = 0;
    this.lastContextEnd = 0;
    this.hasContextEnd = false;
    this.nextPeriodicContextFrame = sampleRate * 10;
    this.gapPending = false;
    this.initialized = false;
    this.port.onmessage = (event) => {
      if (event.data?.type === "init") {
        this.contextId = event.data.contextId;
        return;
      }
      if (event.data?.type !== "flush") return;
      if (this.flushing || this.unsupported) return;
      this.flushing = true;
      this.emitAnchor("final", this.lastContextEnd, this.totalInput, 0, this.gapPending ? "empty_input_gap" : "continuous", Math.max(0, Math.floor(this.totalInput * TARGET_RATE / sampleRate) - this.frameIndex * FRAME_SAMPLES));
      this.port.postMessage({ type: "tail", totalInputSamples: this.totalInput, creditedSamples: this.frameIndex * FRAME_SAMPLES, uncreditedTailSamples: Math.max(0, Math.floor(this.totalInput * TARGET_RATE / sampleRate) - this.frameIndex * FRAME_SAMPLES) });
    };
  }
  emitAnchor(anchor, contextFrame, sourceCursor, blockLength, continuity, discardedTailSamples) {
    if (!this.contextId) return;
    const product = BigInt(Math.trunc(this.nextOutput)) * BigInt(Math.trunc(sampleRate));
    this.port.postMessage({ type: "anchor", record: { kind: "anchor", track: this.contextId.track, seq: this.anchorSeq++, contextId: this.contextId.id, anchor, contextFrame, sourceCursor, blockLength, sourceRateHz: sampleRate, outputCursor: this.nextOutput, outputFrameIndex: Math.floor(this.nextOutput / FRAME_SAMPLES), phaseNumerator: Number(product % 16000n), continuity, previousContextEndFrame: this.hasContextEnd ? this.lastContextEnd : null, discardedTailSamples } });
  }
  process(inputs) {
    if (this.closed) return false;
    if (this.unsupported) {
      this.port.postMessage({ type: "unsupported-rate", sourceSampleRateHz: sampleRate });
      this.closed = true;
      return false;
    }
    if (this.flushing) return false;
    const contextFrame = typeof currentFrame === "number" ? currentFrame : this.lastContextEnd;
      const channels = inputs[0] ?? [];
    if (!this.contextId) return true;
    if (channels.length === 0 || channels[0].length === 0) {
      this.gapPending = true;
      return true;
    }
    if (this.inputChannels === 0) {
      this.inputChannels = channels.length;
      this.port.postMessage({ type: "input-format", inputChannels: this.inputChannels });
    } else if (channels.length !== this.inputChannels) {
      this.port.postMessage({ type: "channel-change", inputChannels: channels.length });
      this.closed = true;
      return false;
    }
    if (channels.length > 2) {
      this.port.postMessage({ type: "unsupported-channels", inputChannels: channels.length });
      this.closed = true;
      return false;
    }
    const length = channels[0].length;
    const contextFrameGap = this.hasContextEnd && contextFrame !== this.lastContextEnd;
    const continuity = !this.initialized ? "continuous" : (contextFrameGap ? "context_frame_gap" : this.gapPending ? "empty_input_gap" : "continuous");
    if (!this.initialized || continuity !== "continuous" || contextFrame >= this.nextPeriodicContextFrame) {
      this.emitAnchor(!this.initialized ? "start" : continuity !== "continuous" ? "discontinuity" : "periodic", contextFrame, this.totalInput, length, continuity, null);
      while (this.nextPeriodicContextFrame <= contextFrame) this.nextPeriodicContextFrame += sampleRate * 10;
    }
    this.initialized = true;
    this.gapPending = false;
    const joined = new Float32Array(this.pending.length + length);
    joined.set(this.pending);
    for (let index = 0; index < length; index += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[index] ?? 0;
      joined[this.pending.length + index] = sum / channels.length;
    }
    this.pending = joined;
    this.totalInput += length;
    const ratio = sampleRate / TARGET_RATE;
    const targetSamples = Math.floor(this.totalInput * TARGET_RATE / sampleRate);
    while (this.nextOutput < targetSamples) {
      const sourceIndex = Math.floor(this.nextOutput * ratio);
      const offset = sourceIndex - this.pendingBase;
      if (offset < 0 || offset >= this.pending.length) break;
      const nextOffset = Math.min(offset + 1, this.pending.length - 1);
      const fraction = this.nextOutput * ratio - sourceIndex;
      const sample = this.pending[offset] + (this.pending[nextOffset] - this.pending[offset]) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.frame[this.frameLength++] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      this.nextOutput += 1;
      if (this.frameLength === FRAME_SAMPLES) {
        const copy = this.frame;
        this.port.postMessage({ type: "frame", frameIndex: this.frameIndex++, samples: copy.buffer }, [copy.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.frameLength = 0;
      }
    }
    const keepFrom = Math.max(this.pendingBase, Math.floor(this.nextOutput * ratio) - 1);
    if (keepFrom > this.pendingBase) {
      this.pending = this.pending.slice(keepFrom - this.pendingBase);
      this.pendingBase = keepFrom;
    }
    this.lastContextEnd = contextFrame + length;
    this.hasContextEnd = true;
    return true;
  }
}
registerProcessor("sandra-dialpad-pcm16", SandraDialpadPcm16Processor);
`;

export type PcmWorkletPort = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close?: () => void;
};

export type PcmWorkletSession = {
  readonly sourceSampleRateHz: number;
  /** Actual input layout observed by the AudioContext source before collection starts. */
  readonly inputChannels: number;
  readonly contextId?: string;
  /** Drain only callbacks accepted before this call; future frames do not extend the snapshot. */
  readonly drainAcceptedFrames?: () => Promise<void>;
  stop(): Promise<PcmTailReport>;
};

export type PcmWorkletRuntime = {
  readonly createAudioContext: () => AudioContext;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly createNode?: (context: AudioContext) => AudioWorkletNode;
  readonly waitMs?: (ms: number) => Promise<void>;
};

export type PcmWorkletStartOptions = {
  readonly timeoutMs?: number;
  /** Optional separate deadline for accepted frame/tail callbacks after the worklet reports its tail. */
  readonly deliveryTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onFailure?: (error: Error) => void;
  readonly maxPendingFrames?: number;
  readonly onTiming?: (record: PcmTimingRecord) => void | Promise<void>;
};

const DEFAULT_PCM_TIMEOUT_MS = 1_000;
const DEFAULT_PCM_STARTUP_TIMEOUT_MS = 2_000;
const MAX_PCM_PENDING_FRAMES = 64;
let contextIdCounter = 0;

function abortError(): Error {
  const error = new Error("PCM AudioWorklet startup was cancelled.");
  error.name = "AbortError";
  return error;
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function randomContextId(): string {
  const maybeCrypto = (globalThis as typeof globalThis & { crypto?: { randomUUID?: () => string } }).crypto;
  return maybeCrypto?.randomUUID?.() ?? `00000000-0000-4000-8000-${(++contextIdCounter).toString(16).padStart(12, '0')}`;
}

async function boundedAwait<T>(
  operation: Promise<T>,
  timeoutMs: number,
  wait: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<T> {
  let abortListener: (() => void) | null = null;
  const cancellation = signal
    ? new Promise<never>((_, reject) => {
      abortListener = () => reject(abortError());
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    })
    : null;
  try {
    return await Promise.race([
      operation,
      wait(timeoutMs).then(() => { throw timeoutError("PCM AudioWorklet operation exceeded its deadline."); }),
      ...(cancellation ? [cancellation] : []),
    ]);
  } finally {
    if (abortListener && signal) signal.removeEventListener("abort", abortListener);
  }
}

export async function startPcmWorkletSession(
  runtime: PcmWorkletRuntime,
  stream: MediaStream,
  track: PcmTrack,
  epoch: number,
  onFrame: (frame: PcmFrame) => void | Promise<void>,
  onTail: (tail: PcmTailReport) => void | Promise<void>,
  optionsOrTimeout: number | PcmWorkletStartOptions = {},
): Promise<PcmWorkletSession> {
  const options = typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PCM_TIMEOUT_MS;
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_PCM_STARTUP_TIMEOUT_MS;
  const wait = runtime.waitMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const context = runtime.createAudioContext();
  let url: string;
  try {
    url = runtime.createObjectURL(new Blob([PCM_AUDIO_WORKLET_SOURCE], { type: "application/javascript" }));
  } catch (error) {
    await Promise.race([
      Promise.resolve().then(() => context.close()).catch(() => undefined),
      wait(startupTimeoutMs),
    ]);
    throw error;
  }
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  const contextId = randomContextId();
  let inputChannels = 0;
  let deliveryActive = true;
  let acceptingFrames = true;
  let tailReceived: PcmTailReport | null = null;
  let resolveTailReceived!: (tail: PcmTailReport) => void;
  const tailReceivedPromise = new Promise<PcmTailReport>((resolve) => { resolveTailReceived = resolve; });
  let deliveryQueue = Promise.resolve();
  let timingQueue = Promise.resolve();
  let timingSequence = 0;
  const onContextStateChange = () => emitContextClock('state_change', context.state === 'closed' ? 'closed' : context.state === 'suspended' ? 'suspended' : 'running');
  let pendingDeliveries = 0;
  let failureNotified = false;
  let deliveryFailure: Error | null = null;
  const notifyFailure = (error: Error) => {
    if (failureNotified) return;
    failureNotified = true;
    deliveryFailure = error;
    deliveryActive = false;
    try { options.onFailure?.(error); } catch { /* the original PCM failure remains authoritative */ }
  };
  const enqueueDelivery = (delivery: () => void | Promise<void>) => {
    deliveryQueue = deliveryQueue.then(async () => {
      if (!deliveryActive) return;
      await delivery();
    }).catch((error: unknown) => {
      notifyFailure(error instanceof Error ? error : new Error("PCM sink failed."));
    });
  };
  const enqueueTiming = (record: PcmTimingRecord) => {
    if (!options.onTiming) return;
    timingQueue = timingQueue.then(() => options.onTiming!(record)).catch(() => undefined);
  };
  const emitContextClock = (observation: DialpadTimingContextClock['observation'], state: DialpadTimingContextClock['state']) => {
    const perf = typeof performance !== 'undefined' ? performance : null;
    const before = perf?.now() ?? 0;
    const contextTime = typeof context.currentTime === 'number' ? context.currentTime * 1000 : 0;
    const after = perf?.now() ?? before;
    enqueueTiming({ kind: 'context_clock', track, seq: timingSequence++, contextId, observation, browserBeforeMs: before, contextTimeMs: contextTime, browserAfterMs: after, browserTimeOriginMs: perf?.timeOrigin ?? 0, state });
  };
  const cleanup = async () => {
    context.removeEventListener?.('statechange', onContextStateChange);
    if (node) {
      node.port.onmessage = null;
      node.port.close?.();
    }
    node?.disconnect();
    source?.disconnect();
    await Promise.race([
      Promise.resolve().then(() => context.close()).catch(() => undefined),
      wait(startupTimeoutMs),
    ]);
    runtime.revokeObjectURL(url);
  };
  try {
    await boundedAwait(context.audioWorklet.addModule(url), startupTimeoutMs, wait, options.signal);
    if (options.signal?.aborted) throw abortError();
    source = context.createMediaStreamSource(stream);
    node = runtime.createNode ? runtime.createNode(context) : new AudioWorkletNode(context, PCM_WORKLET_PROCESSOR_NAME);
    const actualRate = context.sampleRate;
    assertSampleRate(actualRate);
    let resolveInputFormat!: (channels: number) => void;
    const inputFormatPromise = new Promise<number>((resolve) => { resolveInputFormat = resolve; });
    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; frameIndex?: number; samples?: ArrayBuffer; totalInputSamples?: number; creditedSamples?: number; uncreditedTailSamples?: number; sourceSampleRateHz?: number; inputChannels?: number; record?: PcmTimingRecord };
      if (message.type === 'anchor' && message.record) {
        enqueueTiming({ ...message.record, track });
        if (message.record.kind === 'anchor' && message.record.anchor === 'periodic') emitContextClock('periodic', context.state === 'suspended' ? 'suspended' : 'running');
        else if (message.record.kind === 'anchor' && message.record.anchor === 'discontinuity') emitContextClock('state_change', context.state === 'suspended' ? 'suspended' : 'running');
        return;
      }
      if (message.type === "unsupported-rate") {
        notifyFailure(new Error(`Unsupported source sample rate: ${message.sourceSampleRateHz ?? actualRate} Hz.`));
        return;
      }
      if (message.type === "unsupported-channels" || message.type === "channel-change") {
        notifyFailure(new Error(`Unsupported input channel layout: ${message.inputChannels ?? "unknown"}.`));
        return;
      }
      if (message.type === "input-format") {
        if (!Number.isInteger(message.inputChannels) || message.inputChannels! < 1 || message.inputChannels! > 2) {
          notifyFailure(new Error("Unsupported input channel layout; expected one or two channels."));
          return;
        }
        inputChannels = message.inputChannels!;
        resolveInputFormat(inputChannels);
        return;
      }
      if (message.type === "tail") {
        if (tailReceived) return;
        acceptingFrames = false;
        tailReceived = { track, epoch, sourceSampleRateHz: actualRate, totalInputSamples: message.totalInputSamples ?? 0, creditedSamples: message.creditedSamples ?? 0, uncreditedTailSamples: message.uncreditedTailSamples ?? 0 };
        enqueueDelivery(() => onTail(tailReceived!));
        resolveTailReceived(tailReceived);
        return;
      }
      if (!acceptingFrames || !deliveryActive || message.type !== "frame" || !(message.samples instanceof ArrayBuffer) || !Number.isInteger(message.frameIndex)) return;
      const samples = new Int16Array(message.samples);
      if (samples.length !== PCM_FRAME_SAMPLES) return;
      if (pendingDeliveries >= (options.maxPendingFrames ?? MAX_PCM_PENDING_FRAMES)) {
        notifyFailure(new Error("PCM sink capacity was exceeded."));
        return;
      }
      pendingDeliveries += 1;
      enqueueDelivery(async () => {
        try {
          await onFrame({ track, epoch, frameIndex: message.frameIndex!, samples, bytes: pcm16LittleEndian(samples) });
        } finally {
          pendingDeliveries -= 1;
        }
      });
    };
    source.connect(node);
    node.port.postMessage({ type: 'init', contextId: { id: contextId, track } });
    context.addEventListener?.('statechange', onContextStateChange);
    emitContextClock('start', context.state === 'suspended' ? 'suspended' : 'running');
    const silent = context.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(context.destination);
    if (context.state === "suspended") {
      await boundedAwait(context.resume(), startupTimeoutMs, wait, options.signal);
      emitContextClock('state_change', 'running');
    }
    if (options.signal?.aborted) throw abortError();
    inputChannels = await boundedAwait(inputFormatPromise, startupTimeoutMs, wait, options.signal);
  } catch (error) {
    deliveryActive = false;
    await cleanup();
    throw error;
  }
  let stopPromise: Promise<PcmTailReport> | null = null;
  return {
    sourceSampleRateHz: context.sampleRate,
    inputChannels,
    contextId,
    drainAcceptedFrames: async () => {
      const accepted = deliveryQueue;
      await accepted;
      if (deliveryFailure) throw deliveryFailure;
    },
    stop: async () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const deadline = Date.now() + timeoutMs;
        const remaining = () => Math.max(0, deadline - Date.now());
        node?.port.postMessage({ type: "flush" });
        const timedOut = await Promise.race([tailReceivedPromise.then(() => false), wait(remaining()).then(() => true)]);
        let tail = tailReceived;
        if (timedOut && !tail) {
          deliveryActive = false;
          acceptingFrames = false;
          tail = { track, epoch, sourceSampleRateHz: context.sampleRate, totalInputSamples: 0, creditedSamples: 0, uncreditedTailSamples: 0, timedOut: true };
          tailReceived = tail;
          try { await Promise.race([Promise.resolve(onTail(tail)), wait(remaining())]); } catch (error) { notifyFailure(error instanceof Error ? error : new Error("PCM tail sink failed.")); }
        } else if (tail) {
          // A prompt worklet tail proves acquisition completed. Give already
          // accepted callbacks their own bounded drain window measured from
          // that proof instead of consuming the acquisition deadline.
          const deliveryDeadline = options.deliveryTimeoutMs === undefined ? deadline : Date.now() + options.deliveryTimeoutMs;
          const deliveryRemaining = () => Math.max(0, deliveryDeadline - Date.now());
          const drained = await Promise.race([deliveryQueue.then(() => true), wait(deliveryRemaining()).then(() => false)]);
          if (!drained) {
            deliveryActive = false;
            tail = { ...tail, deliveryTimedOut: true };
            notifyFailure(timeoutError("PCM sink did not drain within the stop deadline."));
          }
        }
        deliveryActive = false;
        acceptingFrames = false;
        emitContextClock('final', context.state === 'closed' ? 'closed' : context.state === 'suspended' ? 'suspended' : 'running');
        await Promise.race([timingQueue, wait(remaining())]);
        await cleanup();
        return tail!;
      })();
      return stopPromise;
    },
  };
}
import type { DialpadTimingAnchor, DialpadTimingContextClock } from './timing-evidence';
