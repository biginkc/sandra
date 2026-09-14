/** Captures the media presented to Sandra's remote playback element for QA runs. */
export type BrowserCaptureEvent = {
  readonly kind: "started" | "chunk" | "stopped" | "unsupported" | "no_audio_track" | "error";
  readonly atMonotonicMs: number;
  readonly detail?: string;
};

export type BrowserCaptureChunk = {
  readonly blob: Blob;
  readonly atMonotonicMs: number;
  readonly sequence: number;
};

export type BrowserCaptureOptions = {
  readonly audio: HTMLAudioElement;
  readonly onChunk: (chunk: BrowserCaptureChunk) => void | Promise<void>;
  readonly onEvent: (event: BrowserCaptureEvent) => void;
  readonly now?: () => number;
  readonly recorderFactory?: (stream: MediaStream) => MediaRecorder;
  readonly timesliceMs?: number;
  readonly maxPendingChunks?: number;
};

export type BrowserCaptureHandle = {
  stop(): Promise<void>;
};

export function startBrowserPlaybackCapture(options: BrowserCaptureOptions): BrowserCaptureHandle | null {
  const now = options.now ?? (() => performance.now());
  const report = (kind: BrowserCaptureEvent["kind"], detail?: string) =>
    options.onEvent({ kind, atMonotonicMs: now(), ...(detail ? { detail } : {}) });
  const playbackFault = () => options.audio.paused === true
    ? "remote playback paused"
    : options.audio.muted === true || options.audio.volume === 0
      ? "remote playback muted"
      : null;
  const initialPlaybackFault = playbackFault();
  if (initialPlaybackFault) {
    report("error", initialPlaybackFault);
    return null;
  }
  const capturableAudio = options.audio as HTMLAudioElement & { captureStream?: () => MediaStream };
  const captureStream = capturableAudio.captureStream;
  if (typeof captureStream !== "function") {
    report("unsupported", "HTMLMediaElement.captureStream unavailable");
    return null;
  }
  let stream: MediaStream;
  try {
    stream = captureStream.call(capturableAudio);
  } catch (error) {
    report("error", error instanceof Error ? error.message : "captureStream failed");
    return null;
  }
  if (stream.getAudioTracks().length === 0) {
    report("no_audio_track");
    return null;
  }
  let recorder: MediaRecorder;
  try {
    recorder = options.recorderFactory
      ? options.recorderFactory(stream)
      : new MediaRecorder(stream);
  } catch (error) {
    report("error", error instanceof Error ? error.message : "MediaRecorder construction failed");
    return null;
  }
  let sequence = 0;
  const pending = new Set<Promise<void>>();
  let stopRequested = false;
  let playbackFaultReported = false;
  const reportPlaybackFault = () => {
    if (stopRequested) return;
    const fault = playbackFault();
    if (fault && !playbackFaultReported) {
      playbackFaultReported = true;
      report("error", fault);
    }
  };
  for (const eventName of ["pause", "volumechange", "stalled", "error", "abort"])
    options.audio.addEventListener?.(eventName, reportPlaybackFault);
  recorder.addEventListener("dataavailable", (event) => {
    reportPlaybackFault();
    if (event.data.size === 0) return;
    if (pending.size >= (options.maxPendingChunks ?? 8)) {
      report("error", "capture chunk sink backpressure");
      if (recorder.state !== "inactive") recorder.stop();
      return;
    }
    const chunk = { blob: event.data, atMonotonicMs: now(), sequence: ++sequence };
    const write = Promise.resolve().then(() => options.onChunk(chunk)).catch((error) => {
      report("error", error instanceof Error ? error.message : "chunk sink failed");
    });
    pending.add(write);
    void write.finally(() => pending.delete(write));
    report("chunk");
  });
  // Recorder errors remain evidence even during final flush/teardown. The
  // intentional-stop guard applies only to playback faults caused by cleanup.
  recorder.addEventListener("error", () => report("error", "MediaRecorder error"));
  try {
    recorder.start(options.timesliceMs ?? 1_000);
  } catch (error) {
    for (const eventName of ["pause", "volumechange", "stalled", "error", "abort"])
      options.audio.removeEventListener?.(eventName, reportPlaybackFault);
    report("error", error instanceof Error ? error.message : "MediaRecorder start failed");
    return null;
  }
  report("started");
  return {
    stop: async () => {
      // Teardown can pause the media element before MediaRecorder emits stop.
      // Mark the intentional stop first so DOM removal is not reported as a
      // playback fault in the evidence stream.
      stopRequested = true;
      if (recorder.state !== "inactive") {
        await new Promise<void>((resolve) => {
          recorder.addEventListener("stop", () => resolve(), { once: true });
          recorder.stop();
        });
      }
      await Promise.all([...pending]);
      for (const eventName of ["pause", "volumechange", "stalled", "error", "abort"])
        options.audio.removeEventListener?.(eventName, reportPlaybackFault);
      report("stopped");
    },
  };
}
