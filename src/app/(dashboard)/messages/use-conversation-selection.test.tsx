import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { InboxDetail } from "./inbox-detail-data";
const markRead = vi.hoisted(() => vi.fn(async (_id: string) => ({ ok: true })));
const navigation = vi.hoisted(() => ({ destinationSearch: undefined as string | undefined }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.destinationSearch ?? window.location.search),
}));
vi.mock("../leads/actions", () => ({ markMessagesReadForThread: markRead }));
import { useConversationSelection } from "./use-conversation-selection";
const detail = (id: string) => ({ threadId: id }) as InboxDetail;
const response = (id: string | null) => ({ ok: true, json: async () => ({ detail: id ? detail(id) : null }) });
const fetchMock = vi.fn();
beforeEach(() => {
  navigation.destinationSearch = undefined;
  window.history.replaceState(null, "", "/messages");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  markRead.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
describe("conversation selection", () => {
  it("uses destination router params before the browser address changes during a soft navigation", async () => {
    window.history.replaceState(null, "", "/leads/property-b");
    navigation.destinationSearch = "thread=b";
    const serverDetail = detail("b");
    const { result } = renderHook(() => useConversationSelection("b", serverDetail));
    expect(result.current.selectedId).toBe("b");
    expect(result.current.detail).toBe(serverDetail);
    expect(result.current.loading).toBe(false);
    window.history.replaceState(null, "", "/messages?thread=b");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(result.current.detail).toBe(serverDetail);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores the URL conversation when cached server props remount after popstate", async () => {
    window.history.replaceState(null, "", "/messages?thread=b");
    fetchMock.mockResolvedValue(response("b"));
    const { result, rerender } = renderHook(({ data }) => useConversationSelection("a", data), {
      initialProps: { data: detail("a") },
    });
    // The first render must not expose A or its action targets, even briefly.
    expect(result.current.selectedId).toBe("b");
    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.detail?.threadId).toBe("b"));
    rerender({ data: detail("a") });
    expect(result.current.detail?.threadId).toBe("b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores the list when its URL remounts cached selected-thread props", async () => {
    const { result } = renderHook(() => useConversationSelection("a", detail("a")));
    expect(result.current.selectedId).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(false);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(result.current.detail).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let mount restoration overwrite a newer user selection", async () => {
    window.history.replaceState(null, "", "/messages?thread=b");
    const initial = detail("a");
    fetchMock.mockResolvedValue(response("c"));
    const { result } = renderHook(() => useConversationSelection("a", initial));
    window.history.replaceState(null, "", "/messages?thread=c");
    await act(async () => { await result.current.select("c"); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(result.current.detail?.threadId).toBe("c");
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/api/messages/thread-detail?thread=c"]);
  });

  it("reads only the selected thread and ignores a late response after a faster click", async () => {
    let resolveA!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
    fetchMock.mockResolvedValueOnce(response("b"));
    const { result } = renderHook(() => useConversationSelection(null, null));
    act(() => { void result.current.select("a"); });
    expect(result.current.loading).toBe(true);
    expect(result.current.detail).toBeNull();
    await act(async () => { await result.current.select("b"); });
    expect(result.current.detail?.threadId).toBe("b");
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => resolveA(response("a")));
    expect(result.current.detail?.threadId).toBe("b");
    expect(markRead.mock.calls.map(call => call[0])).toEqual(["b"]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/api/messages/thread-detail?thread=a", "/api/messages/thread-detail?thread=b",
    ]);
  });
  it("shows failure without stale detail and allows a fresh retry", async () => {
    window.history.replaceState(null, "", "/messages?thread=a");
    fetchMock.mockResolvedValueOnce({ ok: false });
    fetchMock.mockResolvedValueOnce(response("b"));
    const { result } = renderHook(() => useConversationSelection("a", detail("a")));
    window.history.replaceState(null, "", "/messages?thread=b");
    await act(async () => { await result.current.select("b"); });
    expect(result.current.detail).toBeNull();
    expect(result.current.error).toMatch(/retry/i);
    await act(async () => { await result.current.select("b"); });
    expect(result.current.detail?.threadId).toBe("b");
    expect(result.current.error).toBeNull();
  });
  it("closing cancels a pending selection and does not mark it read", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useConversationSelection(null, null));
    act(() => { void result.current.select("a"); });
    await act(async () => { await result.current.select(null); resolve(response("a")); });
    expect(result.current.selectedId).toBeNull();
    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
  });
  it("accepts refreshed server detail but ignores a server response for the previous URL", async () => {
    const initial = detail("a");
    fetchMock.mockResolvedValue(response("b"));
    const { result, rerender } = renderHook(({ id, data }) => useConversationSelection(id, data), {
      initialProps: { id: "a", data: initial },
    });
    window.history.replaceState(null, "", "/messages?thread=b");
    await act(async () => { await result.current.select("b"); });
    rerender({ id: "a", data: detail("a") });
    expect(result.current.detail?.threadId).toBe("b");
    const fresh = { ...detail("b"), contactName: "Fresh server label" };
    rerender({ id: "b", data: fresh });
    await waitFor(() => expect(result.current.detail).toBe(fresh));
  });
  it("restores a selected URL on browser history navigation", async () => {
    fetchMock.mockResolvedValue(response("b"));
    const { result } = renderHook(() => useConversationSelection(null, null));
    window.history.replaceState(null, "", "/messages?thread=b");
    act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
    await waitFor(() => expect(result.current.detail?.threadId).toBe("b"));
  });

  it("clears for navigation until matching server props arrive", async () => {
    window.history.replaceState(null, "", "/messages?thread=a");
    fetchMock.mockResolvedValue(response("b"));
    const { result, rerender } = renderHook(({ id, data }) => useConversationSelection(id, data), {
      initialProps: { id: "a" as string | null, data: detail("a") as InboxDetail | null },
    });
    window.history.replaceState(null, "", "/messages?thread=b");
    await act(async () => { await result.current.select("b"); });
    act(() => { result.current.reset(); });
    expect(result.current.selectedId).toBeNull();
    expect(result.current.detail).toBeNull();
    window.history.replaceState(null, "", "/messages?inboxPage=2");
    rerender({ id: "a", data: detail("a") });
    expect(result.current.detail).toBeNull();
    rerender({ id: null, data: null });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(result.current.selectedId).toBeNull();
    const fresh = detail("c");
    window.history.replaceState(null, "", "/messages?thread=c");
    rerender({ id: "c", data: fresh });
    await waitFor(() => expect(result.current.detail).toBe(fresh));
  });

  it("does not reload an already loaded local selection but refetches after leaving it", async () => {
    fetchMock.mockResolvedValue(response("b"));
    const { result } = renderHook(() => useConversationSelection(null, null));
    window.history.replaceState(null, "", "/messages?thread=b");
    await act(async () => { await result.current.select("b"); });
    const loaded = result.current.detail;
    await act(async () => { await result.current.select("b"); });
    expect(result.current.detail).toBe(loaded);
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.select(null); });
    await act(async () => { await result.current.select("b"); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("coalesces event bursts into one read plus one trailing read without acknowledging again", async () => {
  window.history.replaceState(null, "", "/messages?thread=a");
  const initial = detail("a");
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fetchMock.mockResolvedValueOnce(response("a"));
  const { result } = renderHook(() => useConversationSelection("a", initial));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  act(() => {
    void result.current.revalidateSelectedDetail();
    for (let i = 0; i < 20; i++) void result.current.revalidateSelectedDetail();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.current.detail).toBe(initial);
  expect(result.current.loading).toBe(false);
  expect(result.current.revalidating).toBe(true);
  await act(async () => finish(response("a")));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.revalidating).toBe(false));
  expect(markRead).not.toHaveBeenCalled();
});

it("preserves loaded detail on refresh failure and keeps safety gated until retry succeeds", async () => {
  window.history.replaceState(null, "", "/messages?thread=a");
  const initial = detail("a");
  fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response("a"));
  const { result } = renderHook(() => useConversationSelection("a", initial));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { await result.current.revalidateSelectedDetail(); });
  expect(result.current.detail).toBe(initial);
  expect(result.current.error).toBeNull();
  expect(result.current.refreshError).toMatch(/before replying/);
  await act(async () => { await result.current.revalidateSelectedDetail(); });
  expect(result.current.refreshError).toBeNull();
  expect(result.current.detail?.threadId).toBe("a");
});

it("ignores a late refresh and its dirty follow-up after selecting another conversation", async () => {
  window.history.replaceState(null, "", "/messages?thread=a");
  const initial = detail("a");
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fetchMock.mockResolvedValueOnce(response("b"));
  const { result } = renderHook(() => useConversationSelection("a", initial));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  act(() => { void result.current.revalidateSelectedDetail(); void result.current.revalidateSelectedDetail(); });
  window.history.replaceState(null, "", "/messages?thread=b");
  await act(async () => { await result.current.select("b"); finish(response("a")); });
  expect(result.current.detail?.threadId).toBe("b");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("ignores a callback retained by the old conversation after a new selection starts", async () => {
  window.history.replaceState(null, "", "/messages?thread=a");
  const initial = detail("a");
  const { result } = renderHook(() => useConversationSelection("a", initial));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const oldRefresh = result.current.revalidateSelectedDetail;
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => { void result.current.select("b"); void oldRefresh(); });
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/api/messages/thread-detail?thread=b"]);
  await act(async () => finish(response("b")));
  expect(result.current.detail?.threadId).toBe("b");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
