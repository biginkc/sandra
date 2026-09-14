import { describe, expect, it, vi } from "vitest";
import { startBrowserPlaybackCapture, type BrowserCaptureEvent } from "./reliability-browser-capture";

class FakeRecorder extends EventTarget {
  state: RecordingState = "inactive";
  timeslice?: number;
  beforeStop?: () => void;
  start(timeslice: number) { this.state = "recording"; this.timeslice = timeslice; }
  stop() {
    this.beforeStop?.();
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
  chunk(blob: Blob) {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
  }
}

class AutoStoppedRecorder extends FakeRecorder {
  autoStopWithFinalChunk(blob: Blob): void {
    this.state = "inactive";
    setTimeout(() => {
      this.chunk(blob);
      this.dispatchEvent(new Event("stop"));
    }, 0);
  }

  autoStopBeforeQueuedFinalChunk(blob: Blob): void {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
    setTimeout(() => this.chunk(blob), 0);
  }
}

describe("browser playback capture", () => {
  it("reports unavailable playback capture instead of treating it as silence", () => {
    const events: BrowserCaptureEvent[] = [];
    const audio = {} as HTMLAudioElement;
    expect(startBrowserPlaybackCapture({ audio, onChunk: () => {}, onEvent: (event) => events.push(event), now: () => 7 })).toBeNull();
    expect(events).toEqual([{ kind: "unsupported", atMonotonicMs: 7, detail: "HTMLMediaElement.captureStream unavailable" }]);
  });

  it("rejects an element without a captured audio track", () => {
    const events: BrowserCaptureEvent[] = [];
    const audio = { captureStream: () => ({ getAudioTracks: () => [] }) } as unknown as HTMLAudioElement;
    expect(startBrowserPlaybackCapture({ audio, onChunk: () => {}, onEvent: (event) => events.push(event), now: () => 8 })).toBeNull();
    expect(events.at(-1)?.kind).toBe("no_audio_track");
  });

  it("does not start when browser playback is paused", () => {
    const events: BrowserCaptureEvent[] = [];
    const audio = { paused: true, captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    expect(startBrowserPlaybackCapture({ audio, onChunk: () => {}, onEvent: (event) => events.push(event) })).toBeNull();
    expect(events.at(-1)?.detail).toBe("remote playback paused");
  });

  it("reports a later browser mute even when media chunks continue", async () => {
    const recorder = new FakeRecorder();
    const events: BrowserCaptureEvent[] = [];
    const audio = Object.assign(new EventTarget(), {
      paused: false, muted: false, volume: 1,
      captureStream: () => ({ getAudioTracks: () => [{}] }),
    }) as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: () => {},
      onEvent: (event) => events.push(event),
    });
    audio.muted = true;
    audio.dispatchEvent(new Event("volumechange"));
    recorder.chunk(new Blob(["still encoded"]));
    await handle?.stop();
    expect(events.filter((event) => event.detail === "remote playback muted")).toHaveLength(1);
  });

  it("does not report DOM-removal pause during intentional teardown", async () => {
    const recorder = new FakeRecorder();
    const events: BrowserCaptureEvent[] = [];
    const audioState = Object.assign(new EventTarget(), {
      paused: false, muted: false, volume: 1,
      captureStream: () => ({ getAudioTracks: () => [{}] }),
    });
    const audio = audioState as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: () => {},
      onEvent: (event) => events.push(event),
    });
    recorder.beforeStop = () => {
      audioState.paused = true;
      audio.dispatchEvent(new Event("pause"));
    };

    await handle?.stop();

    expect(events.map((event) => event.kind)).toEqual(["started", "stopped"]);
    expect(events.some((event) => event.detail === "remote playback paused")).toBe(false);
  });

  it("reports recorder errors during final flush before the last chunk", async () => {
    const recorder = new FakeRecorder();
    const events: BrowserCaptureEvent[] = [];
    const audio = { captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: () => {},
      onEvent: (event) => events.push(event),
    });
    recorder.beforeStop = () => {
      recorder.dispatchEvent(new Event("error"));
      recorder.chunk(new Blob(["final flush"]));
    };

    await handle?.stop();

    expect(events.map((event) => event.kind)).toEqual(["started", "error", "chunk", "stopped"]);
    expect(events.find((event) => event.kind === "error")?.detail).toBe("MediaRecorder error");
  });

  it("waits for a final chunk and stop event after the recorder auto-stops", async () => {
    const recorder = new AutoStoppedRecorder();
    const events: BrowserCaptureEvent[] = [];
    const chunks: Blob[] = [];
    const audio = { captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: (chunk) => { chunks.push(chunk.blob); },
      onEvent: (event) => events.push(event),
    });
    recorder.autoStopWithFinalChunk(new Blob(["final flush"]));

    await handle?.stop();

    expect(chunks).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(["started", "chunk", "stopped"]);
  });

  it("waits for dataavailable queued after an already-observed stop", async () => {
    const recorder = new AutoStoppedRecorder();
    const events: BrowserCaptureEvent[] = [];
    const chunks: Blob[] = [];
    const audio = { captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: (chunk) => { chunks.push(chunk.blob); },
      onEvent: (event) => events.push(event),
    });
    recorder.autoStopBeforeQueuedFinalChunk(new Blob(["queued final flush"]));

    await handle?.stop();

    expect(chunks).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(["started", "chunk", "stopped"]);
  });

  it("notifies the owner when the playback element swaps srcObject", async () => {
    vi.useFakeTimers();
    try {
      const recorder = new FakeRecorder();
      const onSourceChange = vi.fn();
      const events: BrowserCaptureEvent[] = [];
      const firstSource = {} as MediaStream;
      const audioState = Object.assign(new EventTarget(), {
        paused: false, muted: false, volume: 1, srcObject: firstSource,
        captureStream: () => ({ getAudioTracks: () => [{}] }),
      });
      const audio = audioState as unknown as HTMLAudioElement;
      const handle = startBrowserPlaybackCapture({
        audio,
        recorderFactory: () => recorder as unknown as MediaRecorder,
        onChunk: () => {},
        onEvent: (event) => events.push(event),
        onSourceChange,
      });

      audioState.srcObject = {} as MediaStream;
      audioState.paused = true;
      audio.dispatchEvent(new Event("pause"));
      recorder.chunk(new Blob(["queued final chunk"]));
      vi.advanceTimersByTime(250);

      expect(onSourceChange).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.detail === "remote playback paused")).toBe(false);
      await handle?.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("timestamps and delivers chunks, including sink failures as visible errors", async () => {
    const recorder = new FakeRecorder();
    const events: BrowserCaptureEvent[] = [];
    const chunks: number[] = [];
    let time = 10;
    const audio = { captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      now: () => time,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onEvent: (event) => events.push(event),
      onChunk: vi.fn(async (chunk) => { chunks.push(chunk.sequence); if (chunk.sequence === 2) throw new Error("disk full"); }),
    });
    expect(handle).not.toBeNull();
    expect(recorder.timeslice).toBe(1_000);
    time = 20;
    recorder.chunk(new Blob(["a"]));
    recorder.chunk(new Blob());
    time = 30;
    recorder.chunk(new Blob(["b"]));
    await handle?.stop();
    expect(chunks).toEqual([1, 2]);
    expect(events.map((event) => event.kind)).toEqual(["started", "chunk", "chunk", "error", "stopped"]);
    expect(events.find((event) => event.kind === "error")?.detail).toBe("disk full");
  });

  it("stops and reports backpressure rather than silently losing a long recording", async () => {
    const recorder = new FakeRecorder();
    const events: BrowserCaptureEvent[] = [];
    let finish!: () => void;
    const sink = new Promise<void>((resolve) => { finish = resolve; });
    const audio = { captureStream: () => ({ getAudioTracks: () => [{}] }) } as unknown as HTMLAudioElement;
    const handle = startBrowserPlaybackCapture({
      audio,
      recorderFactory: () => recorder as unknown as MediaRecorder,
      onChunk: () => sink,
      onEvent: (event) => events.push(event),
      maxPendingChunks: 1,
    });
    recorder.chunk(new Blob(["a"]));
    recorder.chunk(new Blob(["b"]));
    expect(recorder.state).toBe("inactive");
    expect(events.find((event) => event.kind === "error")?.detail).toBe("capture chunk sink backpressure");
    finish();
    await handle?.stop();
  });
});
