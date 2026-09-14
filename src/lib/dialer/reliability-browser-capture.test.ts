import { describe, expect, it, vi } from "vitest";
import { startBrowserPlaybackCapture, type BrowserCaptureEvent } from "./reliability-browser-capture";

class FakeRecorder extends EventTarget {
  state: RecordingState = "inactive";
  timeslice?: number;
  start(timeslice: number) { this.state = "recording"; this.timeslice = timeslice; }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
  chunk(blob: Blob) {
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: blob });
    this.dispatchEvent(event);
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
