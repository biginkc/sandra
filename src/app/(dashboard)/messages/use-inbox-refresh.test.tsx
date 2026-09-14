import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useInboxRefresh, type InboxRefreshSnapshot } from "./use-inbox-refresh";
const initial = { page: { threads: [], counts: { all: 1, mine: 0, unassigned: 0, unread: 0, escalated: 0, dispo: 0, needs_outcome: 0 }, total: 1, page: 1, pageSize: 200, hiddenCount: 0, degraded: false }, unknown: 2, dismissed: 1 } as InboxRefreshSnapshot;
const fetchMock = vi.fn();
const response = (count: number) => ({ ok: true, json: async () => ({ ...initial, page: { ...initial.page, counts: { ...initial.page.counts, all: count }, total: count }, unknown: count }) });
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); window.history.replaceState(null,"","/messages"); });
afterEach(() => vi.unstubAllGlobals());
it("coalesces event bursts and replaces rows/counts together", async () => {
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response(3));
  const { result } = renderHook(() => useInboxRefresh(initial, "filter=all", true));
  act(() => { for (let i=0;i<20;i++) result.current.refresh(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => finish(response(2)));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(result.current.snapshot.page.counts.all).toBe(3); expect(result.current.snapshot.unknown).toBe(3);
});
it("rejects a late old-filter response and its queued follow-up", async () => {
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ query }) => useInboxRefresh(initial, query, true), { initialProps: { query: "filter=all" } });
  act(() => { result.current.refresh(); result.current.refresh(); });
  const oldRefresh = result.current.refresh;
  rerender({ query: "filter=unread" });
  await act(async () => { finish(response(999)); oldRefresh(); });
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(result.current.snapshot).toBe(initial); expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("preserves the snapshot and exposes retry on failure", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response(4));
  const { result } = renderHook(() => useInboxRefresh(initial, "filter=all", true));
  act(() => result.current.refresh()); await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.snapshot).toBe(initial);
  act(() => result.current.refresh()); await waitFor(() => expect(result.current.failed).toBe(false));
  expect(result.current.snapshot.unknown).toBe(4);
});

it("rejects an A-pinned unread response after B is selected and reads B's snapshot", async () => {
  window.history.replaceState(null,"","/messages?filter=unread&thread=a");
  let finishA!: (value: unknown) => void;
  let finishB!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; }));
  const { result, rerender } = renderHook(({ selected }) => useInboxRefresh(initial,"filter=unread",true,selected,"a"), {initialProps:{selected:"a"}});
  act(() => result.current.refresh());
  const lateARefresh = result.current.refresh;
  window.history.replaceState(null,"","/messages?filter=unread&thread=b");
  rerender({selected:"b"});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(fetchMock.mock.calls[1][0]).toContain("thread=b");
  await act(async () => { finishA(response(999)); lateARefresh(); });
  expect(result.current.snapshot).toBe(initial);
  await act(async () => finishB(response(2)));
  expect(result.current.snapshot.page.counts.all).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("throttles a window focus/online storm to at most one auto-refresh per window (2026-09-14 incident)", async () => {
  fetchMock.mockResolvedValue(response(5));
  renderHook(() => useInboxRefresh(initial, "filter=all", true));
  // No refresh on mount — only ambient focus/online triggers are gated here.
  expect(fetchMock).toHaveBeenCalledTimes(0);
  // A rep alt-tabbing (or a flaky connection reconnecting) firing focus and
  // online repeatedly in a burst must not each hit the heavy RPC.
  act(() => {
    fireEvent.focus(window);
    fireEvent.focus(window);
    fireEvent(window, new Event("online"));
    fireEvent.focus(window);
    fireEvent(window, new Event("online"));
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  // Still inside the cooldown window — further ambient triggers are dropped.
  act(() => { fireEvent.focus(window); fireEvent(window, new Event("online")); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("re-allows an ambient auto-refresh once the cooldown window elapses", async () => {
  // Control only Date.now() (what the cooldown gate reads) rather than
  // vi.useFakeTimers(), which also fakes the scheduler/setTimeout React's
  // own `act` flushing relies on and hangs this test.
  const start = Date.now();
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Let the in-flight request settle so it isn't mistaken for a
    // still-pending request (a separate, existing coalescing guard) once
    // the cooldown window "elapses" below.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { fireEvent.focus(window); });
    expect(fetchMock).toHaveBeenCalledTimes(1); // still inside the window
    nowSpy.mockReturnValue(start + 10_001);
    act(() => { fireEvent.focus(window); });
    expect(fetchMock).toHaveBeenCalledTimes(2); // window elapsed — allowed again
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  } finally {
    nowSpy.mockRestore();
  }
});

it("an online event while hidden does not burn the cooldown for the next focus", async () => {
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  fetchMock.mockResolvedValue(response(5));
  renderHook(() => useInboxRefresh(initial, "filter=all", true));
  act(() => { fireEvent(window, new Event("online")); }); // fires while hidden — must not stamp
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  act(() => { fireEvent.focus(window); }); // must NOT be dropped by a bogus stamp
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
});

// --- Fable-mandated leading-edge + trailing-timer contract (2026-09-14) ---
// Astra blocked the leading-edge-only cooldown: a reconnect landing inside
// the window was simply dropped with nothing to recover it, so the inbox
// went stale until an unrelated event happened to fire. These tests use
// `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })`
// rather than the full fake-timer set — faking everything (including the
// scheduler's own internals) hangs React's `act()` flush.

it("arms a single trailing refresh for a suppressed event and fires it at window end", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); }); // t=0: leading edge, dispatches
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); }); // let it settle
    act(() => { vi.advanceTimersByTime(5_000); }); // t=5
    act(() => { fireEvent(window, new Event("online")); }); // suppressed — arms trailing for t=10
    expect(fetchMock).toHaveBeenCalledTimes(1); // no fetch yet
    await act(async () => { vi.advanceTimersByTime(4_999); }); // t=9.999
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); }); // t=10 — trailing fires
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("collapses multiple suppressed events into exactly one trailing timer — no re-arm, no extension (construction-count assertion)", async () => {
  // A prior version of this test only asserted fetch-call timing, which a
  // "clear + recreate with the same correctly-computed remaining delay"
  // re-arm would pass by coincidence (same net fire time, extra timer
  // churn under the hood). Astra flagged that as not mutation-sound. This
  // asserts construction directly: exactly one setTimeout for the whole
  // suppressed burst, zero clearTimeout calls (nothing was ever replaced).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); }); // t=0: leading edge, dispatches
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    setTimeoutSpy.mockClear();
    clearTimeoutSpy.mockClear();
    act(() => { vi.advanceTimersByTime(5_000); }); // t=5
    act(() => { fireEvent(window, new Event("online")); }); // arms the ONE trailing timer, for t=10
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1_000); }); // t=6
    act(() => { fireEvent.focus(window); }); // suppressed — must create/cancel nothing
    act(() => { vi.advanceTimersByTime(1_000); }); // t=7
    act(() => { fireEvent(window, new Event("online")); }); // suppressed — must create/cancel nothing
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1); // still exactly one ever created
    expect(clearTimeoutSpy).not.toHaveBeenCalled(); // never replaced
    await act(async () => { vi.advanceTimersByTime(2_999); }); // t=9.999
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); }); // t=10.000 — the ORIGINAL timer fires
    expect(fetchMock).toHaveBeenCalledTimes(2); // exactly one trailing dispatch, not three
  } finally {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    vi.useRealTimers();
  }
});

it("a leading dispatch cancels a pending trailing timer so it cannot also fire (no double dispatch)", async () => {
  // Astra: a leading dispatch (e.g. focus at t=10.001) can run before an
  // already-overdue trailing callback gets its turn on the event loop —
  // real event ordering doesn't guarantee the timer fires first just
  // because its target time passed first. Left uncancelled, that stale
  // timer would fire right after and double-hit the RPC inside what
  // should be a fresh window.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); }); // t=0: leading edge, dispatches
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(5_000); }); // t=5
    act(() => { fireEvent(window, new Event("online")); }); // suppressed — arms trailing for t=10
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // vi.setSystemTime moves only what Date.now() reports — the fake-timer
    // engine's own scheduling clock (what actually fires callbacks) is
    // untouched until advanceTimersByTime runs it forward. This reproduces
    // the real race precisely: Date perceives t=10.001 (so the ambient
    // gate's elapsed check takes the leading-edge branch), while the
    // trailing callback's due point hasn't actually been reached by the
    // scheduler yet — exactly like an overdue real setTimeout that hasn't
    // had its macrotask turn when a focus handler runs first.
    vi.setSystemTime(new Date(Date.now() + 5_001)); // Date now reads t=10.001
    act(() => { fireEvent.focus(window); }); // leading edge per Date — must cancel the trailing timer
    expect(fetchMock).toHaveBeenCalledTimes(2); // this dispatch
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Now let the scheduler's own clock actually reach the trailing timer's
    // original due point (it was armed at internal t=5 for +5000ms). If it
    // wasn't cancelled, it fires here.
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2); // NOT 3 — the stale trailing timer must not have fired
  } finally {
    vi.useRealTimers();
  }
});

it("a trailing refresh that fires while hidden does not dispatch or stamp; the next visible focus does", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); }); // t=0: leading edge, dispatches
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(5_000); }); // t=5, still visible
    act(() => { fireEvent(window, new Event("online")); }); // suppressed — arms trailing for t=10
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await act(async () => { vi.advanceTimersByTime(5_000); }); // t=10 — trailing fires while hidden
    expect(fetchMock).toHaveBeenCalledTimes(1); // reconcile's own visibility gate blocked it — no dispatch, no stamp
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { fireEvent.focus(window); }); // next visible focus — must dispatch, not be dropped
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  } finally {
    vi.useRealTimers();
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  }
});

it("a suppressed ambient event that arrives while hidden arms no trailing timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    fetchMock.mockResolvedValue(response(5));
    renderHook(() => useInboxRefresh(initial, "filter=all", true));
    act(() => { fireEvent.focus(window); }); // t=0: leading edge, dispatches
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(5_000); }); // t=5, inside window
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => { fireEvent(window, new Event("online")); }); // suppressed AND hidden — arms nothing
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { vi.advanceTimersByTime(5_000); }); // t=10 — a wrongly-armed timer would fire here
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just the leading-edge dispatch
  } finally {
    vi.useRealTimers();
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  }
});

it("a disabled ambient event does not burn the window for the next enabled event", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    fetchMock.mockResolvedValue(response(5));
    const { rerender } = renderHook(
      ({ enabled }) => useInboxRefresh(initial, "filter=all", enabled),
      { initialProps: { enabled: false } },
    );
    act(() => { fireEvent.focus(window); }); // disabled — reconcile returns false, must not stamp
    expect(fetchMock).toHaveBeenCalledTimes(0);
    rerender({ enabled: true });
    act(() => { fireEvent.focus(window); }); // same instant, now enabled — must dispatch immediately
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  } finally {
    vi.useRealTimers();
  }
});
