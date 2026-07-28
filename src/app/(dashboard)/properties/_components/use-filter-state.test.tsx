import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock next/navigation — hoisted so it runs before any imports
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => "/properties",
}));

import {
  FILTER_NAVIGATION_START_EVENT,
  useFilterState,
} from "./use-filter-state";
import { newBlockId } from "@/lib/prospects/filter-schema";

beforeEach(() => {
  replace.mockReset();
  window.history.replaceState({}, "", "/properties");
});

describe("useFilterState", () => {
  it("starts with empty blocks when ?filters= is absent", () => {
    const { result } = renderHook(() => useFilterState());
    expect(result.current.blocks).toEqual([]);
  });

  it("decodes ?filters= on render", () => {
    const block = { id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const };
    const encoded = encodeURIComponent(JSON.stringify({ v: 1, blocks: [block] }));
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    const { result } = renderHook(() => useFilterState());
    expect(result.current.blocks).toHaveLength(1);
    expect(result.current.blocks[0].kind).toBe("vacancy");
  });

  it("addBlock calls router.replace with encoded URL", () => {
    const { result } = renderHook(() => useFilterState());
    act(() => {
      result.current.addBlock({ id: newBlockId(), kind: "vacancy", tri: "yes" });
    });
    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0];
    expect(url).toContain("/properties?filters=");
  });

  it("dispatches a filter-navigation event before URL navigation", () => {
    const listener = vi.fn();
    window.addEventListener(FILTER_NAVIGATION_START_EVENT, listener);
    const { result } = renderHook(() => useFilterState());

    act(() => {
      result.current.addBlock({ id: newBlockId(), kind: "vacancy", tri: "yes" });
    });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(FILTER_NAVIGATION_START_EVENT, listener);
  });

  it("removeBlock removes by id and updates URL", () => {
    const id = newBlockId();
    const block = { id, kind: "vacancy" as const, tri: "yes" as const };
    const encoded = encodeURIComponent(JSON.stringify({ v: 1, blocks: [block] }));
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.removeBlock(id));
    expect(replace).toHaveBeenCalled();
  });

  it("clearAll strips ?filters= from URL", () => {
    const block = { id: newBlockId(), kind: "vacancy" as const, tri: "yes" as const };
    const encoded = encodeURIComponent(JSON.stringify({ v: 1, blocks: [block] }));
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.clearAll());
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0];
    expect(url).not.toContain("filters=");
  });

  it("updateBlock patches a block by id and updates URL", () => {
    const id = newBlockId();
    const block = { id, kind: "vacancy" as const, tri: "yes" as const };
    const encoded = encodeURIComponent(JSON.stringify({ v: 1, blocks: [block] }));
    window.history.replaceState({}, "", `/properties?filters=${encoded}`);
    const { result } = renderHook(() => useFilterState());
    act(() => result.current.updateBlock(id, { tri: "no" }));
    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0];
    expect(url).toContain("filters=");
  });

  it("uses the latest pending stack for back-to-back edits before rerender", () => {
    const id = newBlockId();
    const { result } = renderHook(() => useFilterState());

    act(() => {
      result.current.addBlock({ id, kind: "vacancy", tri: "any" });
      result.current.updateBlock(id, { tri: "yes" });
    });

    expect(replace).toHaveBeenCalledTimes(2);
    const [url] = replace.mock.calls[1];
    const raw = new URL(`http://test.local${url}`).searchParams.get("filters");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({
      v: 1,
      blocks: [{ id, kind: "vacancy", tri: "yes" }],
    });
  });

  it("optimistically updates returned blocks before URL navigation settles", () => {
    const id = newBlockId();
    const { result } = renderHook(() => useFilterState());

    act(() => {
      result.current.addBlock({ id, kind: "vacancy", tri: "any" });
    });
    expect(result.current.blocks).toEqual([{ id, kind: "vacancy", tri: "any" }]);

    act(() => {
      result.current.updateBlock(id, { tri: "yes" });
    });
    expect(result.current.blocks).toEqual([{ id, kind: "vacancy", tri: "yes" }]);

    act(() => {
      result.current.removeBlock(id);
    });
    expect(result.current.blocks).toEqual([]);
  });

  it("replaceStack updates blocks and URL", () => {
    const { result } = renderHook(() => useFilterState());
    const newBlock = { id: newBlockId(), kind: "absentee" as const, tri: "yes" as const };
    act(() => result.current.replaceStack([newBlock]));
    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0];
    expect(url).toContain("filters=");
  });
});
