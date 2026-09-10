import { act, renderHook, waitFor } from "@testing-library/react";
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
  rerender({ query: "filter=unread" });
  await act(async () => finish(response(999)));
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
