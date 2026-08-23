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
    Object.defineProperty(playingAudio, "paused", { configurable: true, value: false });
    Object.defineProperty(playingAudio, "ended", { configurable: true, value: false });
    playingAudio.currentTime = 17;

    await act(async () => {
      vi.advanceTimersByTime(9_000);
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("sandra-recording-audio")).toBe(playingAudio);
    expect(playingAudio).toHaveAttribute("src", "https://storage.example.test/playing.wav");
    expect(playingAudio.currentTime).toBe(17);

    fireEvent.ended(playingAudio);
    expect(screen.getByTestId("sandra-recording-audio")).toBe(playingAudio);
    expect(playingAudio).toHaveAttribute("src", "https://storage.example.test/renewed.wav");
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

  it("keeps active playback mounted when background TTL renewal fails", async () => {
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
