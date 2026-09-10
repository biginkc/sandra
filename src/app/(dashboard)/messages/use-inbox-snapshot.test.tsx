import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadPage } from "@/lib/messages/list-threads";
import { useInboxSnapshot } from "./use-inbox-snapshot";
const initial = { threads: [], counts: { all: 1 }, page: 1, total: 1, hiddenCount: 0, pageSize: 200 } as unknown as ThreadPage;
const fetchMock = vi.fn();
beforeEach(() => { window.history.replaceState(null, "", "/messages"); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
it("replaces page and counts together, coalesces bursts, and pins current selection", async () => {
  let finish!: (value: unknown) => void;
  const fresh = { ...initial, total: 2, counts: { all: 2 } };
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ page: fresh }) });
  const { result } = renderHook(() => useInboxSnapshot(initial, "filter=unread", true));
  window.history.replaceState(null, "", "/messages?thread=selected");
  act(() => { for (let i = 0; i < 12; i++) void result.current.refresh(); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toContain("thread=selected");
  await act(async () => finish({ ok: true, json: async () => ({ page: fresh }) }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(result.current.page).toEqual(fresh);
});
it("rejects stale responses after filter navigation", async () => {
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ query }) => useInboxSnapshot(initial, query, true), { initialProps: { query: "filter=all" } });
  act(() => { void result.current.refresh(); });
  rerender({ query: "filter=unread" });
  await act(async () => finish({ ok: true, json: async () => ({ page: { ...initial, total: 99 } }) }));
  expect(result.current.page).toBe(initial);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
});
it("keeps the last snapshot visibly failed when refreshing fails", async () => {
  fetchMock.mockResolvedValue({ ok: false });
  const { result } = renderHook(() => useInboxSnapshot(initial, "filter=all", true));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.page).toBe(initial);
  expect(result.current.failed).toBe(true);
});
