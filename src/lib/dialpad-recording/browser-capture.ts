import {
  PCM_AUDIO_WORKLET_SOURCE,
  PCM_FRAME_SAMPLES,
  type PcmFrame,
  type PcmTailReport,
  type PcmTrack,
  startPcmWorkletSession,
  type PcmWorkletSession,
} from "./pcm-audio-worklet";
import type { PcmTimingRecord } from "./pcm-audio-worklet";

export const MAX_MEDIA_CHUNK_BYTES = 1_048_576;
export const DEFAULT_MEDIA_TIMESLICE_MS = 1_000;
export const MAX_PENDING_PCM_FRAMES = 64;
export const MEDIA_RECORDER_MIME_TYPE = "audio/webm;codecs=opus";

export type CaptureFailureCode =
  | "unsupported"
  | "wrong_tab"
  | "missing_audio"
  | "permission_denied"
  | "interrupted"
  | "buffer_overflow"
  | "sink_failure"
  | "timeout";

export class BrowserCaptureError extends Error {
  readonly code: CaptureFailureCode;

  constructor(code: CaptureFailureCode, message: string) {
    super(message);
    this.name = "BrowserCaptureError";
    this.code = code;
  }
}

export type CaptureHandleProof = {
  readonly handle: string;
  readonly origin: string;
};

export type CaptureHandleConfig = {
  readonly handle: string;
  readonly exposeOrigin: boolean;
  readonly permittedOrigins: readonly string[];
};

export type CaptureHandleDocument = {
  readonly origin: string;
  setCaptureHandleConfig?: (config: CaptureHandleConfig) => void;
};

export function createSandraCaptureHandleProof(
  documentPort: CaptureHandleDocument,
  randomUUID: () => string = () => crypto.randomUUID(),
): CaptureHandleProof {
  const origin = documentPort.origin;
  const handle = randomUUID();
  if (!documentPort.setCaptureHandleConfig) throw new BrowserCaptureError("unsupported", "Capture Handle is unavailable.");
  documentPort.setCaptureHandleConfig({ handle, exposeOrigin: true, permittedOrigins: [origin] });
  return { handle, origin };
}

type CaptureHandleTrack = MediaStreamTrack & {
  getCaptureHandle?: () => { handle?: unknown; origin?: unknown } | null;
};

export function assertSandraCaptureHandle(track: MediaStreamTrack, proof: CaptureHandleProof): void {
  const captured = (track as CaptureHandleTrack).getCaptureHandle?.();
  if (!captured || captured.handle !== proof.handle || captured.origin !== proof.origin) {
    throw new BrowserCaptureError("wrong_tab", "The selected tab is not the current Sandra tab.");
  }
}

export type CaptureHandleMonitor = { stop(): void };

export function monitorDialpadTrackEnded(
  track: MediaStreamTrack,
  onFailure: (error: BrowserCaptureError) => void,
): CaptureHandleMonitor {
  let active = true;
  const ended = () => {
    if (!active) return;
    active = false;
    track.removeEventListener("ended", ended);
    onFailure(new BrowserCaptureError("interrupted", "A Dialpad audio capture track ended."));
  };
  track.addEventListener("ended", ended);
  if (track.readyState === "ended") ended();
  return {
    stop: () => {
      if (!active) return;
      active = false;
      track.removeEventListener("ended", ended);
    },
  };
}

export function monitorSandraCaptureHandle(
  track: MediaStreamTrack,
  proof: CaptureHandleProof,
  onFailure: (error: BrowserCaptureError) => void,
): CaptureHandleMonitor {
  let active = true;
  const detach = () => {
    track.removeEventListener("capturehandlechange", verify);
    track.removeEventListener("ended", ended);
  };
  const fail = (error: BrowserCaptureError) => {
    if (!active) return;
    active = false;
    detach();
    onFailure(error);
  };
  const verify = () => {
    try {
      assertSandraCaptureHandle(track, proof);
    } catch (error) {
      fail(error instanceof BrowserCaptureError ? error : new BrowserCaptureError("wrong_tab", "Capture Handle verification failed."));
    }
  };
  const ended = () => fail(new BrowserCaptureError("interrupted", "The captured Sandra tab ended."));
  track.addEventListener("capturehandlechange", verify);
  track.addEventListener("ended", ended);
  verify();
  return {
    stop: () => {
      if (!active) return;
      active = false;
      detach();
    },
  };
}

export type EncodedMediaChunk = {
  readonly track: PcmTrack;
  readonly epoch: number;
  readonly seq: number;
  readonly blob: Blob;
  readonly byteLength: number;
};

export type MediaRecorderLike = EventTarget & {
  readonly state: string;
  start(timeslice?: number): void;
  stop(): void;
};

type CollectorGeneration = {
  readonly id: number;
  readonly epoch: number;
  readonly recorder: MediaRecorderLike;
  readonly onData: (event: Event) => void;
  readonly onError: () => void;
  readonly onStop: () => void;
  readonly recorderStop: Promise<void>;
  resolveRecorderStop: (() => void) | null;
  queue: Promise<void>;
  sequence: number;
  pendingChunks: number;
  pendingBytes: number;
  abandoned: boolean;
};

export type MediaRecorderCollectorOptions = {
  readonly track: PcmTrack;
  readonly stream: MediaStream;
  readonly epoch?: number;
  readonly mimeType?: string;
  readonly createRecorder: (stream: MediaStream, mimeType?: string) => MediaRecorderLike;
  readonly onChunk: (chunk: EncodedMediaChunk) => void | Promise<void>;
  readonly onFailure?: (error: BrowserCaptureError) => void;
  readonly maxPendingChunks?: number;
  readonly maxPendingBytes?: number;
  readonly timesliceMs?: number;
  readonly stopTimeoutMs?: number;
  readonly finalizationWaitMs?: number;
};

export type MediaRecorderCollectorState = "idle" | "recording" | "stopping" | "stopped" | "interrupted";

export function splitMediaBlob(blob: Blob, maxBytes = MAX_MEDIA_CHUNK_BYTES): readonly Blob[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid media chunk limit.");
  const parts: Blob[] = [];
  for (let offset = 0; offset < blob.size; offset += maxBytes) parts.push(blob.slice(offset, Math.min(offset + maxBytes, blob.size), blob.type));
  return parts;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collects one recorder and preserves every dataavailable byte in order. */
export class MediaRecorderCollector {
  private readonly options: Required<Pick<MediaRecorderCollectorOptions, "maxPendingChunks" | "maxPendingBytes" | "timesliceMs" | "stopTimeoutMs" | "finalizationWaitMs">>;
  private recorder: MediaRecorderLike | null = null;
  private stateValue: MediaRecorderCollectorState = "idle";
  private epochValue: number;
  private generationId = 0;
  private generation: CollectorGeneration | null = null;
  private stopPromise: Promise<void> | null = null;
  private failure: BrowserCaptureError | null = null;

  constructor(private readonly optionsInput: MediaRecorderCollectorOptions) {
    this.epochValue = optionsInput.epoch ?? 1;
    this.options = {
      maxPendingChunks: optionsInput.maxPendingChunks ?? 8,
      maxPendingBytes: optionsInput.maxPendingBytes ?? 8 * MAX_MEDIA_CHUNK_BYTES,
      timesliceMs: optionsInput.timesliceMs ?? DEFAULT_MEDIA_TIMESLICE_MS,
      stopTimeoutMs: optionsInput.stopTimeoutMs ?? 2_000,
      finalizationWaitMs: optionsInput.finalizationWaitMs ?? 50,
    };
  }

  get state(): MediaRecorderCollectorState { return this.stateValue; }
  get error(): BrowserCaptureError | null { return this.failure; }

  start(epoch = this.epochValue): void {
    if (this.stateValue !== "idle" && this.stateValue !== "stopped") throw new BrowserCaptureError("interrupted", "Media recorder has already started.");
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new BrowserCaptureError("unsupported", "Invalid recording epoch.");
    this.epochValue = epoch;
    this.failure = null;
    this.stopPromise = null;
    const recorder = this.optionsInput.createRecorder(this.optionsInput.stream, this.optionsInput.mimeType ?? MEDIA_RECORDER_MIME_TYPE);
    let resolveRecorderStop!: () => void;
    const recorderStop = new Promise<void>((resolve) => { resolveRecorderStop = resolve; });
    const generation: CollectorGeneration = {
      id: ++this.generationId,
      epoch,
      recorder,
      onData: (event) => this.onDataAvailable(generation, event),
      onError: () => this.onRecorderError(generation),
      onStop: () => this.onRecorderStop(generation),
      recorderStop,
      resolveRecorderStop,
      queue: Promise.resolve(),
      sequence: 0,
      pendingChunks: 0,
      pendingBytes: 0,
      abandoned: false,
    };
    this.generation = generation;
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", generation.onData);
    recorder.addEventListener("error", generation.onError);
    recorder.addEventListener("stop", generation.onStop);
    try {
      this.stateValue = "recording";
      recorder.start(this.options.timesliceMs);
    } catch (error) {
      this.fail(new BrowserCaptureError("unsupported", error instanceof Error ? error.message : "MediaRecorder could not start."), generation);
      throw this.failure;
    }
  }

  private onRecorderError(generation: CollectorGeneration): void {
    this.fail(new BrowserCaptureError("interrupted", "MediaRecorder reported an error."), generation);
  }

  private onRecorderStop(generation: CollectorGeneration): void {
    if (this.generation !== generation) return;
    generation.resolveRecorderStop?.();
    generation.resolveRecorderStop = null;
  }

  private onDataAvailable(generation: CollectorGeneration, event: Event): void {
    if (this.generation !== generation || generation.abandoned || this.stateValue === "interrupted") return;
    const blob = (event as BlobEvent).data;
    if (!(blob instanceof Blob) || blob.size === 0) return;
    if (generation.pendingChunks >= this.options.maxPendingChunks || generation.pendingBytes + blob.size > this.options.maxPendingBytes) {
      this.fail(new BrowserCaptureError("buffer_overflow", "Media recorder sink capacity was exceeded."), generation);
      return;
    }
    generation.pendingChunks += 1;
    generation.pendingBytes += blob.size;
    const parts = splitMediaBlob(blob);
    generation.queue = generation.queue.then(async () => {
      for (const part of parts) {
        if (generation.abandoned || this.generation !== generation) break;
        await this.optionsInput.onChunk({ track: this.optionsInput.track, epoch: generation.epoch, seq: generation.sequence++, blob: part, byteLength: part.size });
      }
    }).catch((error: unknown) => {
      this.fail(new BrowserCaptureError("sink_failure", error instanceof Error ? error.message : "Media chunk sink failed."), generation);
    }).finally(() => {
      generation.pendingChunks -= 1;
      generation.pendingBytes -= blob.size;
    });
  }

  private fail(error: BrowserCaptureError, generation = this.generation): void {
    if (!generation || this.generation !== generation) return;
    generation.abandoned = true;
    if (!this.failure) {
      this.failure = error;
      this.stateValue = "interrupted";
      try { this.optionsInput.onFailure?.(error); } catch { /* the original capture failure remains authoritative */ }
    }
    if (generation.recorder.state !== "inactive") {
      try { generation.recorder.stop(); } catch { /* the original failure remains authoritative */ }
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stateValue === "idle" || this.stateValue === "stopped") {
      this.stateValue = "stopped";
      return;
    }
    const generation = this.generation;
    if (!generation) {
      this.stateValue = "stopped";
      return;
    }
    this.stopPromise = (async () => {
      if (this.stateValue === "recording") {
        this.stateValue = "stopping";
        if (generation.recorder.state !== "inactive") {
          try { generation.recorder.stop(); } catch (error) { this.fail(new BrowserCaptureError("interrupted", error instanceof Error ? error.message : "MediaRecorder stop failed."), generation); }
        }
        const recorderStopped = await Promise.race([
          generation.recorderStop.then(() => true),
          waitMs(this.options.stopTimeoutMs).then(() => false),
        ]);
        if (!recorderStopped) this.fail(new BrowserCaptureError("timeout", "MediaRecorder did not finish within the stop deadline."), generation);
        await waitMs(this.options.finalizationWaitMs);
      }
      const queueDrained = await Promise.race([generation.queue.then(() => true), waitMs(this.options.stopTimeoutMs).then(() => false)]);
      if (!queueDrained) this.fail(new BrowserCaptureError("timeout", "Media chunk sink did not drain within the stop deadline."), generation);
      if (this.failure) this.stateValue = "interrupted";
      else this.stateValue = "stopped";
      generation.recorder.removeEventListener("dataavailable", generation.onData);
      generation.recorder.removeEventListener("error", generation.onError);
      generation.recorder.removeEventListener("stop", generation.onStop);
    })();
    return this.stopPromise;
  }
}

export type BrowserCaptureRuntime = {
  readonly getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createMediaStream: (tracks: readonly MediaStreamTrack[]) => MediaStream;
  readonly supportsMediaRecorder?: (mimeType: string) => boolean;
  readonly createRecorder: (stream: MediaStream, mimeType?: string) => MediaRecorderLike;
  readonly createPcmSession?: (stream: MediaStream, track: PcmTrack, epoch: number, onFrame: (frame: PcmFrame) => void | Promise<void>, onTail: (tail: PcmTailReport) => void | Promise<void>, options?: { readonly signal?: AbortSignal; readonly onFailure?: (error: Error) => void; readonly onTiming?: (record: PcmTimingRecord) => void | Promise<void> }) => Promise<PcmWorkletSession>;
};

function browserRuntime(): BrowserCaptureRuntime {
  return {
    getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createMediaStream: (tracks) => new MediaStream([...tracks]),
    supportsMediaRecorder: (mimeType) => MediaRecorder.isTypeSupported(mimeType),
    createRecorder: (stream, mimeType = MEDIA_RECORDER_MIME_TYPE) => new MediaRecorder(stream, { mimeType }),
    createPcmSession: (stream, track, epoch, onFrame, onTail, options) => startPcmWorkletSession({
      createAudioContext: () => new AudioContext(),
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
    }, stream, track, epoch, onFrame, onTail, options),
  };
}

export type BrowserCaptureSinks = {
  /** Actual worklet format, emitted before either binary sink is allowed. */
  readonly onTrackFormat?: (format: BrowserCaptureTrackFormat) => void | Promise<void>;
  readonly onWebmChunk: (chunk: EncodedMediaChunk) => void | Promise<void>;
  readonly onPcmFrame: (frame: PcmFrame) => void | Promise<void>;
  readonly onPcmTail?: (tail: PcmTailReport) => void | Promise<void>;
  /** Timing observations are diagnostic evidence and have an independent failure budget. */
  readonly onTiming?: (record: PcmTimingRecord) => void | Promise<void>;
  readonly onTimingFailure?: (error: BrowserCaptureError) => void;
  readonly onFailure?: (error: BrowserCaptureError) => void;
};

export type BrowserCaptureTrackFormat = {
  readonly track: PcmTrack;
  readonly contextSampleRateHz: number;
  readonly inputChannels: number;
  readonly recordingMimeType: typeof MEDIA_RECORDER_MIME_TYPE;
  readonly pcmSampleRateHz: 16_000;
  readonly pcmChannels: 1;
  readonly pcmEncoding: "s16le";
};

export type PreparedDialpadCapture = {
  readonly proof: CaptureHandleProof;
  readonly start: (sinks?: BrowserCaptureSinks, epoch?: number) => Promise<ActiveDialpadCapture>;
  /** Starts bounded local capture before the provider call is dispatched. */
  readonly startLocal?: (epoch?: number) => Promise<ActiveDialpadCapture>;
  readonly dispose: () => Promise<void>;
};

export type ActiveDialpadCapture = {
  readonly state: () => "starting" | "recording" | "stopping" | "stopped" | "interrupted";
  /** Attaches an authenticated network sink without resetting local clocks or sequence origins. */
  readonly attach?: (sinks: BrowserCaptureSinks, epoch?: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly dispose: () => Promise<void>;
};

export const DEFAULT_LOCAL_SPOOL_MAX_BYTES = 16 * MAX_MEDIA_CHUNK_BYTES;
export const DEFAULT_LOCAL_SPOOL_MAX_MS = 120_000;

// Chrome otherwise excludes the requesting tab from its chooser. These hints
// offer the tab; Capture Handle verification below still proves its identity.
const DEFAULT_DISPLAY_CONSTRAINTS: DisplayMediaStreamOptions & {
  selfBrowserSurface: "include";
  preferCurrentTab: true;
} = { video: true, audio: true, selfBrowserSurface: "include", preferCurrentTab: true };

type ActiveDialpadCaptureState = ReturnType<ActiveDialpadCapture["state"]>;

export type DialpadCaptureSourceLease = {
  readonly display: MediaStream;
  readonly microphone: MediaStream;
  readonly signal: AbortSignal;
  assertValid(): void;
  release(): void;
  invalidate(): void;
};

/** Owns permission sources only. No recorder, worklet or spool exists while idle. */
export function createDialpadCaptureSourceSession(options: {
  proof: CaptureHandleProof;
  runtime?: BrowserCaptureRuntime;
  onStopped?: () => void;
}) {
  const runtime = options.runtime ?? browserRuntime();
  let display: MediaStream | null = null;
  let microphone: MediaStream | null = null;
  let disposed = false;
  let leased = false;
  const monitors: CaptureHandleMonitor[] = [];
  const invalidation = new AbortController();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    invalidation.abort();
    for (const monitor of monitors) monitor.stop();
    stopTracks(display);
    stopTracks(microphone);
    options.onStopped?.();
  };
  const validate = () => {
    if (disposed || !display || !microphone) throw new BrowserCaptureError("interrupted", "Audio sharing has stopped. Allow sharing again before calling.");
    const video = display.getVideoTracks()[0];
    if (!video || [...display.getTracks(), ...microphone.getTracks()].some((track) => track.readyState === "ended")) {
      throw new BrowserCaptureError("interrupted", "An audio sharing source ended.");
    }
    assertSandraCaptureHandle(video, options.proof);
  };
  return {
    proof: options.proof,
    dispose,
    async acquire(): Promise<DialpadCaptureSourceLease> {
      if (disposed || leased) throw new BrowserCaptureError("interrupted", "Audio sharing is unavailable or already in use.");
      leased = true;
      try {
        if (!display) {
          display = await runtime.getDisplayMedia(DEFAULT_DISPLAY_CONSTRAINTS);
          if (disposed) { stopTracks(display); throw new BrowserCaptureError("interrupted", "Audio sharing was cancelled."); }
          const video = display.getVideoTracks()[0];
          if (!video) throw new BrowserCaptureError("unsupported", "Display capture has no identity track.");
          assertSandraCaptureHandle(video, options.proof);
          if (display.getAudioTracks().length === 0) throw new BrowserCaptureError("missing_audio", "Share the Sandra tab audio before calling.");
          monitors.push(monitorSandraCaptureHandle(video, options.proof, dispose));
          for (const track of display.getTracks()) monitors.push(monitorDialpadTrackEnded(track, dispose));
          if (disposed) throw new BrowserCaptureError("interrupted", "Audio sharing was cancelled.");
          microphone = await runtime.getUserMedia({ audio: true });
          if (disposed) { stopTracks(microphone); throw new BrowserCaptureError("interrupted", "Audio sharing was cancelled."); }
          if (microphone.getAudioTracks().length === 0) throw new BrowserCaptureError("missing_audio", "Microphone capture has no audio track.");
          for (const track of microphone.getAudioTracks()) monitors.push(monitorDialpadTrackEnded(track, dispose));
        }
        validate();
        let released = false;
        return {
          display: display!, microphone: microphone!, signal: invalidation.signal,
          assertValid() { if (released) throw new BrowserCaptureError("interrupted", "Audio lease has ended."); validate(); },
          release() { if (!released) { released = true; leased = false; } },
          invalidate: dispose,
        };
      } catch (error) {
        leased = false;
        dispose();
        // dispose may have run while a permission promise was pending.
        stopTracks(display); stopTracks(microphone);
        throw error;
      }
    },
  };
}

export type PrepareDialpadCaptureOptions = {
  readonly proof: CaptureHandleProof;
  readonly sources?: DialpadCaptureSourceLease;
  readonly runtime?: BrowserCaptureRuntime;
  readonly displayConstraints?: DisplayMediaStreamOptions;
  readonly microphoneConstraints?: MediaStreamConstraints;
  readonly localSpoolMaxBytes?: number;
  readonly localSpoolMaxMs?: number;
};

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

type LocalSpool = {
  readonly maxBytes: number;
  readonly maxMs: number;
  readonly startedAt: number;
  readonly formats: Partial<Record<PcmTrack, BrowserCaptureTrackFormat>>;
  readonly webm: EncodedMediaChunk[];
  readonly pcm: PcmFrame[];
  readonly tails: PcmTailReport[];
  readonly timing: PcmTimingRecord[];
  bytes: number;
  overflow: BrowserCaptureError | null;
};

function createLocalSpool(maxBytes: number, maxMs: number): LocalSpool {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxMs) || maxMs < 1) {
    throw new BrowserCaptureError("unsupported", "Local capture spool limits are invalid.");
  }
  return { maxBytes, maxMs, startedAt: Date.now(), formats: {}, webm: [], pcm: [], tails: [], timing: [], bytes: 0, overflow: null };
}

function spoolBytes(spool: LocalSpool, bytes: number, enforceElapsedBound: boolean): boolean {
  if (spool.overflow) return false;
  if ((enforceElapsedBound && Date.now() - spool.startedAt > spool.maxMs) || spool.bytes + bytes > spool.maxBytes) {
    spool.overflow = new BrowserCaptureError("buffer_overflow", "The pre-call recording buffer reached its bounded capacity.");
    return false;
  }
  spool.bytes += bytes;
  return true;
}

export async function prepareDialpadBrowserCapture(options: PrepareDialpadCaptureOptions): Promise<PreparedDialpadCapture> {
  const runtime = options.runtime ?? browserRuntime();
  let display: MediaStream | null = null;
  let microphone: MediaStream | null = null;
  try {
    options.sources?.assertValid();
    display = options.sources?.display ?? await runtime.getDisplayMedia(options.displayConstraints ?? DEFAULT_DISPLAY_CONSTRAINTS);
    const videoTrack = display.getVideoTracks()[0];
    if (!videoTrack) throw new BrowserCaptureError("unsupported", "Display capture did not provide a video identity track.");
    assertSandraCaptureHandle(videoTrack, options.proof);
    if (display.getAudioTracks().length === 0) throw new BrowserCaptureError("missing_audio", "The selected Sandra tab has no audio track.");
    try {
      microphone = options.sources?.microphone ?? await runtime.getUserMedia(options.microphoneConstraints ?? { audio: true });
    } catch (error) {
      throw new BrowserCaptureError("permission_denied", error instanceof Error ? error.message : "Microphone permission was denied.");
    }
    if (microphone.getAudioTracks().length === 0) throw new BrowserCaptureError("missing_audio", "Microphone capture has no audio track.");
  } catch (error) {
    options.sources?.invalidate();
    stopTracks(microphone);
    stopTracks(display);
    throw error instanceof BrowserCaptureError ? error : new BrowserCaptureError("permission_denied", error instanceof Error ? error.message : "Media capture permission failed.");
  }

  let disposed = false;
  let active: ActiveDialpadCapture | null = null;
  const disposePrepared = async () => {
    if (disposed) return;
    disposed = true;
    await active?.dispose();
    if (options.sources) options.sources.release();
    else { stopTracks(microphone); stopTracks(display); }
  };

  const prepared: PreparedDialpadCapture = {
    proof: options.proof,
    start: async (sinks, epoch = 1) => {
      if (disposed) throw new BrowserCaptureError("interrupted", "Capture has been disposed.");
      if (active) throw new BrowserCaptureError("interrupted", "Capture has already started.");
      let captureEpoch = epoch;
      let attachedSinks: BrowserCaptureSinks | null = sinks ?? null;
      let spoolMode: "live" | "buffering" | "draining" = sinks ? "live" : "buffering";
      const spool = sinks ? null : createLocalSpool(options.localSpoolMaxBytes ?? DEFAULT_LOCAL_SPOOL_MAX_BYTES, options.localSpoolMaxMs ?? DEFAULT_LOCAL_SPOOL_MAX_MS);
      let state: ActiveDialpadCaptureState = "starting";
      let failed: BrowserCaptureError | null = null;
      let timingFailed = false;
      let timingFailure: BrowserCaptureError | null = null;
      let timingFailureNotified = false;
      let handleMonitor: CaptureHandleMonitor | null = null;
      const trackMonitors: CaptureHandleMonitor[] = [];
      let tabCollector: MediaRecorderCollector | null = null;
      let micCollector: MediaRecorderCollector | null = null;
      let tabPcm: PcmWorkletSession | null = null;
      let micPcm: PcmWorkletSession | null = null;
      let tabStream: MediaStream | null = null;
      let micStream: MediaStream | null = null;
      let stopPromise: Promise<void> | null = null;
      let stopRequested = false;
      let pcmAdmissionOpen = true;
      let formatReady = false;
      let pcmPrefixDraining = false;
      const startupPcmFrames: PcmFrame[] = [];
      let pcmDeliveryQueue = Promise.resolve();
      let queuedPcmFrames = 0;
      const startupAbort = new AbortController();
      const fail = (error: BrowserCaptureError) => {
        if (!failed) {
          failed = error;
          state = "interrupted";
          try { attachedSinks?.onFailure?.(error); } catch { /* the original capture failure remains authoritative */ }
        }
        void stop();
      };
      const appendSpool = (bytes: number): boolean => {
        if (!spool) return false;
        if (spoolBytes(spool, bytes, spoolMode === "buffering")) return true;
        fail(spool.overflow ?? new BrowserCaptureError("buffer_overflow", "The pre-call recording buffer reached its bounded capacity."));
        return false;
      };
      const deliverFormat = async (format: BrowserCaptureTrackFormat): Promise<void> => {
        if (spoolMode !== "live" || !attachedSinks) {
          if (!spool || !appendSpool(128)) return;
          spool.formats[format.track] = format;
          return;
        }
        await attachedSinks.onTrackFormat?.(format);
      };
      const deliverWebm = async (chunk: EncodedMediaChunk): Promise<void> => {
        const normalized = { ...chunk, epoch: captureEpoch };
        if (spoolMode !== "live" || !attachedSinks) {
          if (!spool || !appendSpool(chunk.byteLength)) return;
          spool.webm.push(normalized);
          return;
        }
        await attachedSinks.onWebmChunk(normalized);
      };
      const deliverTiming = async (record: PcmTimingRecord): Promise<void> => {
        if (timingFailed) return;
        const notifyTimingFailure = (error: BrowserCaptureError) => {
          timingFailed = true;
          timingFailure ??= error;
          if (!attachedSinks) return;
          if (timingFailureNotified) return;
          timingFailureNotified = true;
          try { attachedSinks.onTimingFailure?.(timingFailure); } catch { /* timing failure remains sticky */ }
        };
        try {
          const bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
          if (spoolMode !== "live" || !attachedSinks) {
            if (!spool || spool.timing.length >= 64 || spool.overflow || spool.bytes + bytes > spool.maxBytes || (spoolMode === "buffering" && Date.now() - spool.startedAt > spool.maxMs)) {
              notifyTimingFailure(new BrowserCaptureError("buffer_overflow", "Timing evidence reached its bounded pre-call capacity."));
              return;
            }
            spool.bytes += bytes;
            spool.timing.push(record);
          } else {
            try { await attachedSinks.onTiming?.(record); } catch { notifyTimingFailure(new BrowserCaptureError("sink_failure", "Timing evidence sink failed.")); }
          }
        } catch {
          // Timing is diagnostic evidence. A persistence failure makes the
          // epoch incomplete and must not interrupt the audio capture.
          notifyTimingFailure(new BrowserCaptureError("sink_failure", "Timing evidence could not be retained."));
        }
      };
      const sourceInterrupted = () => fail(new BrowserCaptureError("interrupted", "Audio sharing was stopped."));
      const cleanup = async () => {
        options.sources?.signal.removeEventListener("abort", sourceInterrupted);
        handleMonitor?.stop();
        for (const monitor of trackMonitors) monitor.stop();
        startupAbort.abort();
        const results = await Promise.allSettled([tabPcm?.stop(), micPcm?.stop(), tabCollector?.stop(), micCollector?.stop()]);
        for (const result of results.slice(0, 2)) {
          if (result.status === "rejected") {
            fail(new BrowserCaptureError("interrupted", result.reason instanceof Error ? result.reason.message : "PCM capture cleanup failed."));
          } else if (result.value && (result.value.timedOut || result.value.deliveryTimedOut)) {
            fail(new BrowserCaptureError("timeout", "PCM capture did not drain within the stop deadline."));
          }
        }
        // Once authenticated sinks are attached, their network delivery queue is
        // governed by the session's receipt/attachment deadlines. The short
        // local cleanup watchdog must cover acquisition/worklet teardown only;
        // racing it against the authenticated prefix would interrupt a healthy
        // prefix when the server is processing a bounded batch of receipts.
        const networkDeliveryActive = Boolean(attachedSinks) && spoolMode !== "buffering";
        if (!networkDeliveryActive) {
          const drained = await Promise.race([pcmDeliveryQueue.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
          if (!drained && !failed) fail(new BrowserCaptureError("timeout", "PCM frame sink did not drain within the stop deadline."));
        }
        pcmAdmissionOpen = false;
        startupPcmFrames.length = 0;
        stopTracks(tabStream);
        stopTracks(micStream);
        if (options.sources) {
          if (failed) options.sources.invalidate();
          options.sources.release();
        } else { stopTracks(display); stopTracks(microphone); }
      };
      const stop = async () => {
        if (stopPromise) return stopPromise;
        stopRequested = true;
        stopPromise = (async () => {
          if (state !== "recording") pcmAdmissionOpen = false;
          if (state === "stopped" || state === "interrupted") {
            await cleanup();
            return;
          }
          state = "stopping";
          await cleanup();
          if (!failed) state = "stopped";
        })();
        return stopPromise;
      };
      let pendingPcmFrames = 0;
      const deliverPcmFrame = async (frame: PcmFrame) => {
        if (!pcmAdmissionOpen || failed) return;
        if (pendingPcmFrames >= MAX_PENDING_PCM_FRAMES) {
          fail(new BrowserCaptureError("buffer_overflow", "PCM sink capacity was exceeded."));
          return;
        }
        pendingPcmFrames += 1;
        try {
          const normalized = { ...frame, epoch: captureEpoch };
          if (spoolMode === "buffering" || (spoolMode === "draining" && spool) || !attachedSinks) {
            if (spool && appendSpool(normalized.bytes.byteLength)) spool.pcm.push(normalized);
          } else {
            await attachedSinks.onPcmFrame(normalized);
          }
        } catch (error) {
          fail(new BrowserCaptureError("sink_failure", error instanceof Error ? error.message : "PCM frame sink failed."));
        } finally {
          pendingPcmFrames -= 1;
        }
      };
      const queuePcmFrame = (frame: PcmFrame): Promise<void> => {
        if (!pcmAdmissionOpen || failed) return Promise.resolve();
        if (queuedPcmFrames >= MAX_PENDING_PCM_FRAMES) {
          fail(new BrowserCaptureError("buffer_overflow", "PCM sink capacity was exceeded."));
          return Promise.reject(failed ?? new BrowserCaptureError("buffer_overflow", "PCM sink capacity was exceeded."));
        }
        queuedPcmFrames += 1;
        pcmDeliveryQueue = pcmDeliveryQueue.then(() => deliverPcmFrame(frame)).finally(() => { queuedPcmFrames -= 1; });
        return pcmDeliveryQueue;
      };
      const attach = async (nextSinks: BrowserCaptureSinks, nextEpoch = captureEpoch): Promise<void> => {
        if (!spool || spoolMode !== "buffering" || state !== "recording" || failed || stopRequested) {
          throw failed ?? new BrowserCaptureError("interrupted", "Capture is not available for authenticated attachment.");
        }
        captureEpoch = nextEpoch;
        if (Date.now() - spool.startedAt > spool.maxMs) {
          spool.overflow = new BrowserCaptureError("buffer_overflow", "The pre-call recording buffer expired before authenticated attachment.");
          throw spool.overflow;
        }
        spoolMode = "draining";
        pcmPrefixDraining = true;
        attachedSinks = nextSinks;
        try {
          if (timingFailed && timingFailure && !timingFailureNotified) {
            timingFailureNotified = true;
            try { nextSinks.onTimingFailure?.(timingFailure); } catch { /* timing failure remains sticky */ }
          }
          for (const track of ["tab", "mic"] as const) {
            const format = spool.formats[track];
            if (format) await nextSinks.onTrackFormat?.(format);
          }
          let flushed = false;
          while (spool.webm.length > 0 || spool.pcm.length > 0 || spool.tails.length > 0 || spool.timing.length > 0 || startupPcmFrames.length > 0) {
            const webm = spool.webm.splice(0);
            const pcm = spool.pcm.splice(0);
            const tails = spool.tails.splice(0);
            const timing = spool.timing.splice(0);
            const latePcm = startupPcmFrames.splice(0);
            for (const record of timing) await nextSinks.onTiming?.(record);
            for (const chunk of webm) await nextSinks.onWebmChunk({ ...chunk, epoch: captureEpoch });
            for (const frame of [...pcm, ...latePcm]) {
              const normalized = { ...frame, epoch: captureEpoch };
              pcmDeliveryQueue = pcmDeliveryQueue.then(() => nextSinks.onPcmFrame(normalized));
              flushed = true;
            }
            if (flushed) await pcmDeliveryQueue;
            for (const tail of tails) await nextSinks.onPcmTail?.({ ...tail, epoch: captureEpoch });
          }
          spoolMode = "live";
          pcmPrefixDraining = false;
          if (spool.overflow) throw spool.overflow;
        } catch (error) {
          pcmPrefixDraining = false;
          const normalized = error instanceof BrowserCaptureError ? error : new BrowserCaptureError("sink_failure", error instanceof Error ? error.message : "Authenticated capture attachment failed.");
          fail(normalized);
          throw normalized;
        }
      };
      const emitPcmFrame = async (frame: PcmFrame) => {
        if (!pcmAdmissionOpen || failed) return;
        if (spool && spoolMode !== "live") {
          const normalized = { ...frame, epoch: captureEpoch };
          if (appendSpool(normalized.bytes.byteLength)) spool.pcm.push(normalized);
          return;
        }
        // A local capture has a byte/time bounded spool while the authenticated
        // prefix drains. A network-only start still needs its small startup
        // queue until format metadata is accepted.
        if (!formatReady || (pcmPrefixDraining && !spool)) {
          if (startupPcmFrames.length >= MAX_PENDING_PCM_FRAMES) {
            fail(new BrowserCaptureError("buffer_overflow", "PCM startup buffer capacity was exceeded."));
            return;
          }
          startupPcmFrames.push(frame);
          return;
        }
        await queuePcmFrame(frame);
      };
      const emitPcmTail = async (tail: PcmTailReport) => {
        if (!pcmAdmissionOpen) return;
        try {
          const normalized = { ...tail, epoch: captureEpoch };
          if (spoolMode !== "live" || !attachedSinks) {
            if (spool && appendSpool(64)) spool.tails.push(normalized);
          } else {
            await attachedSinks.onPcmTail?.(normalized);
          }
        } catch (error) {
          fail(new BrowserCaptureError("sink_failure", error instanceof Error ? error.message : "PCM tail sink failed."));
          return;
        }
        if (tail.timedOut || tail.deliveryTimedOut) fail(new BrowserCaptureError("timeout", "PCM capture did not drain within the stop deadline."));
      };
      active = { state: () => state, attach: spool ? attach : undefined, stop, dispose: stop };
      try {
        options.sources?.signal.addEventListener("abort", sourceInterrupted);
        options.sources?.assertValid();
        // Keep the original video track as the authoritative capture identity;
        // only per-call audio clones are stopped when this call finishes.
        tabStream = runtime.createMediaStream(display!.getAudioTracks().map((track) => options.sources ? track.clone() : track));
        micStream = runtime.createMediaStream(microphone!.getAudioTracks().map((track) => options.sources ? track.clone() : track));
        handleMonitor = monitorSandraCaptureHandle(display!.getVideoTracks()[0]!, options.proof, fail);
        for (const track of [...tabStream.getAudioTracks(), ...micStream.getAudioTracks(), ...(options.sources ? [...display!.getAudioTracks(), ...microphone!.getAudioTracks()] : [])]) {
          trackMonitors.push(monitorDialpadTrackEnded(track, fail));
        }
        if (failed) throw failed;
        if (runtime.supportsMediaRecorder && !runtime.supportsMediaRecorder(MEDIA_RECORDER_MIME_TYPE)) {
          throw new BrowserCaptureError("unsupported", `MediaRecorder does not support ${MEDIA_RECORDER_MIME_TYPE}.`);
        }
        if (!runtime.createPcmSession) throw new BrowserCaptureError("unsupported", "AudioWorklet capture is unavailable.");
        const pcmFailure = (error: Error) => {
          fail(new BrowserCaptureError(error.name === "TimeoutError" ? "timeout" : "sink_failure", error.message));
        };
        const startPcm = async (stream: MediaStream, pcmTrack: PcmTrack): Promise<PcmWorkletSession | null> => {
          const session = await runtime.createPcmSession!(stream, pcmTrack, epoch, emitPcmFrame, emitPcmTail, { signal: startupAbort.signal, onFailure: pcmFailure, onTiming: deliverTiming });
          if (stopRequested || failed || disposed) {
            await session.stop();
            return null;
          }
          return session;
        };
        const [tabResult, micResult] = await Promise.allSettled([startPcm(tabStream, "tab"), startPcm(micStream, "mic")]);
        tabPcm = tabResult.status === "fulfilled" ? tabResult.value : null;
        micPcm = micResult.status === "fulfilled" ? micResult.value : null;
        if (stopRequested || failed || disposed) {
          await Promise.allSettled([tabPcm?.stop(), micPcm?.stop()]);
          throw failed ?? new BrowserCaptureError("interrupted", "Capture stopped during start.");
        }
        if (tabResult.status === "rejected") throw tabResult.reason;
        if (micResult.status === "rejected") throw micResult.reason;
        if (!tabPcm || !micPcm) throw new BrowserCaptureError("interrupted", "PCM capture did not start.");
        const formats: BrowserCaptureTrackFormat[] = [
          { track: "tab", contextSampleRateHz: tabPcm.sourceSampleRateHz, inputChannels: tabPcm.inputChannels, recordingMimeType: MEDIA_RECORDER_MIME_TYPE, pcmSampleRateHz: 16_000, pcmChannels: 1, pcmEncoding: "s16le" },
          { track: "mic", contextSampleRateHz: micPcm.sourceSampleRateHz, inputChannels: micPcm.inputChannels, recordingMimeType: MEDIA_RECORDER_MIME_TYPE, pcmSampleRateHz: 16_000, pcmChannels: 1, pcmEncoding: "s16le" },
        ];
        try {
          await deliverFormat(formats[0]!);
          if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped while publishing format metadata.");
          await deliverFormat(formats[1]!);
          if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped while publishing format metadata.");
        } catch (error) {
          throw new BrowserCaptureError("sink_failure", error instanceof Error ? error.message : "Track format sink failed.");
        }
        formatReady = true;
        pcmPrefixDraining = true;
        while (startupPcmFrames.length > 0) {
          const queuedFrames = startupPcmFrames.splice(0);
          for (const frame of queuedFrames) await queuePcmFrame(frame);
        }
        pcmPrefixDraining = false;
        if (failed) throw failed;
        if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped before media collectors were allocated.");
        tabCollector = new MediaRecorderCollector({ track: "tab", stream: tabStream, epoch, createRecorder: runtime.createRecorder, onChunk: deliverWebm, onFailure: fail });
        if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped before media collectors were allocated.");
        micCollector = new MediaRecorderCollector({ track: "mic", stream: micStream, epoch, createRecorder: runtime.createRecorder, onChunk: deliverWebm, onFailure: fail });
        if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped before media collectors were started.");
        tabCollector.start(epoch);
        micCollector.start(epoch);
        if (stopRequested || failed || disposed) throw new BrowserCaptureError("interrupted", "Capture stopped while starting media collectors.");
        state = "recording";
        return active;
      } catch (error) {
        if (!failed) fail(error instanceof BrowserCaptureError ? error : new BrowserCaptureError(stopRequested ? "interrupted" : "unsupported", error instanceof Error ? error.message : "Media capture could not start."));
        await stop();
        throw failed ?? new BrowserCaptureError("interrupted", "Media capture could not start.");
      }
    },
    startLocal: async (epoch = 1) => prepared.start(undefined, epoch),
    dispose: disposePrepared,
  };
  return prepared;
}

export { PCM_AUDIO_WORKLET_SOURCE, PCM_FRAME_SAMPLES };
