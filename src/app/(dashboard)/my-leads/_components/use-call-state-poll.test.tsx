import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_CALL_STATE, type CallPromptItem, type CallStateSnapshot } from "@/lib/my-leads/call-state";

const pollMock = vi.fn();
vi.mock("../call-state-actions", () => ({ pollMyLeadsCallStateAction: (...a: unknown[]) => pollMock(...a) }));

import { useCallStatePoll } from "./use-call-state-poll";

const prompt = (id: string): CallPromptItem => ({
  attemptId: id, propertyId: "p", callActivityId: `c-${id}`, endedAt: "2026-10-04T10:00:00Z",
  durationSeconds: 5, talkDurationSeconds: 0, origin: "sandra", outcomeGuess: null, voicemail: false,
});
const snap = (over: Partial<CallStateSnapshot> = {}): CallStateSnapshot => ({ ...EMPTY_CALL_STATE, ...over });
const ok = (over: Partial<CallStateSnapshot> = {}) => ({ ok: true as const, state: snap(over) });

let visibility = "visible";
const setVisibility = (v: string) => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  pollMock.mockReset();
  pollMock.mockResolvedValue(ok());
});
afterEach(() => {
  vi.useRealTimers();
});

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("useCallStatePoll", () => {
  it("fetches on mount and every 10 seconds", async () => {
    renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    expect(pollMock).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(pollMock).toHaveBeenCalledTimes(2);
    await tick(10_000);
    expect(pollMock).toHaveBeenCalledTimes(3);
  });

  it("does not fetch while hidden and fetches immediately when visible again", async () => {
    visibility = "hidden";
    renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(35_000);
    expect(pollMock).not.toHaveBeenCalled();
    await act(async () => { setVisibility("visible"); });
    expect(pollMock).toHaveBeenCalledTimes(1);
  });

  it("skips while suspended and fetches once when suspension lifts", async () => {
    const { rerender } = renderHook(({ s }) => useCallStatePoll({ enabled: true, suspended: s }), { initialProps: { s: true } });
    await tick(25_000);
    expect(pollMock).not.toHaveBeenCalled();
    rerender({ s: false });
    await tick(0);
    expect(pollMock).toHaveBeenCalledTimes(1);
  });

  it("backs off to 30 seconds after an error and recovers after success", async () => {
    pollMock.mockResolvedValueOnce({ ok: false, message: "nope" });
    const { result } = renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    expect(result.current.error).toBe("nope");
    await tick(29_000);
    expect(pollMock).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(pollMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    await tick(10_000);
    expect(pollMock).toHaveBeenCalledTimes(3);
  });

  it("keeps last data on a thrown error", async () => {
    pollMock.mockResolvedValueOnce(ok({ prompts: [prompt("a")] }));
    pollMock.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    await tick(10_000);
    expect(result.current.error).toBe("boom");
    expect(result.current.prompts.map((p) => p.attemptId)).toEqual(["a"]);
  });

  it("never overlaps requests", async () => {
    let resolve!: (v: unknown) => void;
    pollMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    await tick(10_000);
    await tick(10_000);
    expect(pollMock).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(ok()); });
    await tick(10_000);
    expect(pollMock).toHaveBeenCalledTimes(2);
  });

  it("never fetches when disabled", async () => {
    const { result } = renderHook(() => useCallStatePoll({ enabled: false, suspended: false }));
    await tick(60_000);
    expect(pollMock).not.toHaveBeenCalled();
    expect(result.current.state).toBe(EMPTY_CALL_STATE);
  });

  it("ignores a response that lands after unmount", async () => {
    let resolve!: (v: unknown) => void;
    pollMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    unmount();
    await act(async () => { resolve(ok({ prompts: [prompt("late")] })); });
    expect(result.current.prompts).toEqual([]);
  });

  it("loadMorePrompts appends and dedupes using the cursor", async () => {
    const cursor = { beforeEnded: "2026-10-04T09:00:00Z", beforeId: "b" };
    pollMock.mockResolvedValueOnce(ok({ prompts: [prompt("a"), prompt("b")], promptsCursor: cursor }));
    const { result } = renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    pollMock.mockResolvedValueOnce(ok({ prompts: [prompt("b"), prompt("c")], promptsCursor: null }));
    await act(async () => { result.current.loadMorePrompts(); });
    expect(pollMock).toHaveBeenLastCalledWith({ promptsCursor: cursor });
    expect(result.current.prompts.map((p) => p.attemptId)).toEqual(["a", "b", "c"]);
    await act(async () => { result.current.loadMorePrompts(); });
    expect(pollMock).toHaveBeenCalledTimes(2);
  });

  it("stops polling after the server says no polled flag is on", async () => {
    pollMock.mockResolvedValue(ok({ idle: true }));
    renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    expect(pollMock).toHaveBeenCalledTimes(1);
    await tick(60_000);
    expect(pollMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good value for a surface whose read failed and updates the rest", async () => {
    pollMock.mockResolvedValueOnce(ok({ prompts: [prompt("a")], callbacksDue: [{ taskId: "t1", propertyId: "p", dueAt: "x", title: "c", minutesLate: 1 }] }));
    const { result } = renderHook(() => useCallStatePoll({ enabled: true, suspended: false }));
    await tick(0);
    pollMock.mockResolvedValueOnce(ok({ prompts: [prompt("b")], callbacksDue: [], failedSurfaces: ["callbacks"] }));
    await tick(10_000);
    expect(result.current.prompts.map((p) => p.attemptId)).toEqual(["b"]);
    expect(result.current.callbacksDue.map((c) => c.taskId)).toEqual(["t1"]);
    expect(result.current.error).toBe("Some call state could not refresh.");
  });
});
