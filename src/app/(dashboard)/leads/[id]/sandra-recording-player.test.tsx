import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandraRecordingPlayer } from "./sandra-recording-player";

const fetchMock = vi.fn();

function recordingResponse(signedUrl: string, expiresAt: string) {
  return new Response(JSON.stringify({ signedUrl, expiresAt }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<SandraRecordingPlayer />", () => {
  it("lazily fetches a no-store signed URL only after the user asks to load", async () => {
    fetchMock.mockResolvedValueOnce(
      recordingResponse("https://storage.example.test/first.wav", "2099-01-01T00:00:00.000Z"),
    );
    render(<SandraRecordingPlayer callActivityId="call/id" durationSeconds={31} />);

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load recording (31s)" }));

    const audio = await screen.findByLabelText("Call recording");
    expect(audio).toHaveAttribute("src", "https://storage.example.test/first.wav");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leads/calls/call%2Fid/recording-url",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("refreshes the signed URL before its TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/first.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/second.wav",
          "2026-08-23T12:01:00.000Z",
        ),
      );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("sandra-recording-audio")).toHaveAttribute(
      "src",
      "https://storage.example.test/first.wav",
    );

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sandra-recording-audio")).toHaveAttribute(
      "src",
      "https://storage.example.test/second.wav",
    );
  });

  it("renews TTL without replacing or resetting actively playing audio", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/playing.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/renewed.wav",
          "2026-08-23T12:01:00.000Z",
        ),
      );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());
    const playingAudio = screen.getByTestId("sandra-recording-audio") as HTMLAudioElement;
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(playingAudio, "play", { configurable: true, value: play });
    Object.defineProperty(playingAudio, "paused", { configurable: true, value: false });
    Object.defineProperty(playingAudio, "ended", { configurable: true, value: false });
    fireEvent.play(playingAudio);
    playingAudio.currentTime = 17;

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sandra-recording-audio")).toBe(playingAudio);
    expect(playingAudio).toHaveAttribute("src", "https://storage.example.test/playing.wav");
    expect(playingAudio.currentTime).toBe(17);

    fireEvent.error(playingAudio);
    expect(screen.getByTestId("sandra-recording-audio")).toBe(playingAudio);
    expect(playingAudio).toHaveAttribute("src", "https://storage.example.test/renewed.wav");
    playingAudio.currentTime = 0;
    fireEvent.loadedMetadata(playingAudio);
    expect(playingAudio.currentTime).toBe(17);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("stops on a media error and reloads only after an explicit user action", async () => {
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse("https://storage.example.test/first.wav", "2099-01-01T00:00:00.000Z"),
      )
      .mockResolvedValueOnce(
        recordingResponse("https://storage.example.test/reloaded.wav", "2099-01-01T00:05:00.000Z"),
      );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    const firstAudio = await screen.findByTestId("sandra-recording-audio");

    fireEvent.error(firstAudio);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Recording could not be played. Reload to request a fresh link.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reload recording" }));

    await waitFor(() => {
      expect(screen.getByTestId("sandra-recording-audio")).toHaveAttribute(
        "src",
        "https://storage.example.test/reloaded.wav",
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not tight-loop when an automatic TTL refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/first.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockRejectedValueOnce(new Error("offline"));
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("offline");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a deliberately paused media session mounted when background renewal fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/playing.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockRejectedValueOnce(new Error("renewal offline"));
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());
    const playingAudio = screen.getByTestId("sandra-recording-audio") as HTMLAudioElement;
    Object.defineProperty(playingAudio, "paused", { configurable: true, value: false });
    Object.defineProperty(playingAudio, "ended", { configurable: true, value: false });
    fireEvent.play(playingAudio);
    Object.defineProperty(playingAudio, "paused", { configurable: true, value: true });
    fireEvent.pause(playingAudio);
    playingAudio.currentTime = 23;

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sandra-recording-audio")).toBe(playingAudio);
    expect(playingAudio).toHaveAttribute("src", "https://storage.example.test/playing.wav");
    expect(playingAudio.currentTime).toBe(23);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a paused session stable, then consumes its cached renewal without auto-playing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/paused.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/paused-renewed.wav",
          "2026-08-23T12:01:00.000Z",
        ),
      );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());
    const pausedAudio = screen.getByTestId("sandra-recording-audio") as HTMLAudioElement;
    const play = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(pausedAudio, "play", { configurable: true, value: play });
    Object.defineProperty(pausedAudio, "paused", { configurable: true, value: false });
    Object.defineProperty(pausedAudio, "ended", { configurable: true, value: false });
    fireEvent.play(pausedAudio);
    Object.defineProperty(pausedAudio, "paused", { configurable: true, value: true });
    fireEvent.pause(pausedAudio);
    pausedAudio.currentTime = 29;

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });
    expect(screen.getByTestId("sandra-recording-audio")).toBe(pausedAudio);
    expect(pausedAudio).toHaveAttribute("src", "https://storage.example.test/paused.wav");
    expect(pausedAudio.currentTime).toBe(29);

    fireEvent.error(pausedAudio);
    expect(pausedAudio).toHaveAttribute(
      "src",
      "https://storage.example.test/paused-renewed.wav",
    );
    pausedAudio.currentTime = 0;
    fireEvent.loadedMetadata(pausedAudio);
    expect(pausedAudio.currentTime).toBe(29);
    expect(play).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fences a late background renewal after media failure until manual reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
    let resolveRenewal!: (response: Response) => void;
    let renewalSignal: AbortSignal | undefined;
    fetchMock
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/first.wav",
          "2026-08-23T12:00:10.000Z",
        ),
      )
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((resolve) => {
            renewalSignal = init.signal as AbortSignal;
            resolveRenewal = resolve;
          }),
      )
      .mockResolvedValueOnce(
        recordingResponse(
          "https://storage.example.test/manual.wav",
          "2026-08-23T12:01:00.000Z",
        ),
      );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await act(async () => Promise.resolve());
    const audio = screen.getByTestId("sandra-recording-audio") as HTMLAudioElement;
    Object.defineProperty(audio, "paused", { configurable: true, value: false });
    Object.defineProperty(audio, "ended", { configurable: true, value: false });
    fireEvent.play(audio);
    await act(async () => vi.advanceTimersByTime(9_000));
    expect(renewalSignal?.aborted).toBe(false);

    fireEvent.error(audio);
    expect(renewalSignal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await act(async () =>
      resolveRenewal(
        recordingResponse(
          "https://storage.example.test/late.wav",
          "2026-08-23T12:01:00.000Z",
        ),
      ),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("sandra-recording-audio")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload recording" }));
    await act(async () => Promise.resolve());
    expect(screen.getByTestId("sandra-recording-audio")).toHaveAttribute(
      "src",
      "https://storage.example.test/manual.wav",
    );
  });

  it("shows a recoverable error when playback lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Recording is not available yet" }), { status: 409 }),
    );
    render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Recording is not available yet");
    expect(screen.getByRole("button", { name: "Reload recording" })).toBeInTheDocument();
  });

  it("aborts an in-flight signed URL lookup when unmounted without surfacing an error", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init.signal as AbortSignal;
          requestSignal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const view = render(<SandraRecordingPlayer callActivityId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Load recording" }));
    await waitFor(() => expect(requestSignal).toBeDefined());

    view.unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => Promise.resolve());
  });
});
