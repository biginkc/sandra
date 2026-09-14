import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
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
