import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const countMock = vi.fn();

vi.mock("@/app/(dashboard)/properties/_actions/count", () => ({
  countProspectsForFilter: (...args: unknown[]) => countMock(...args),
}));

beforeEach(() => {
  countMock.mockReset();
  vi.useFakeTimers();
});

import { useDebouncedFilters } from "./use-debounced-filters";
import type { BlockStack } from "@/lib/prospects/filter-schema";

describe("useDebouncedFilters", () => {
  it("debounces by 250ms", async () => {
    countMock.mockResolvedValue({ ok: true, data: { count: 42 } });
    const { rerender } = renderHook(
      ({ blocks }: { blocks: BlockStack }) => useDebouncedFilters("orgId", blocks),
      { initialProps: { blocks: [] as BlockStack } },
    );
    rerender({ blocks: [{ id: "1", kind: "vacancy", tri: "yes" }] });
    expect(countMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(countMock).toHaveBeenCalledTimes(1);
  });

  it("cancels previous debounce when blocks change rapidly", async () => {
    countMock.mockResolvedValue({ ok: true, data: { count: 1 } });
    const { rerender } = renderHook(
      ({ blocks }: { blocks: BlockStack }) => useDebouncedFilters("orgId", blocks),
      { initialProps: { blocks: [] as BlockStack } },
    );
    rerender({ blocks: [{ id: "a", kind: "vacancy", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    rerender({ blocks: [{ id: "b", kind: "absentee", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(countMock).toHaveBeenCalledTimes(1); // only the latest fires
  });

  it("returns loading status during debounce window", async () => {
    countMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockStack }) => useDebouncedFilters("orgId", blocks),
      { initialProps: { blocks: [] as BlockStack } },
    );
    rerender({ blocks: [{ id: "1", kind: "vacancy", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.status).toBe("loading");
  });

  it("returns ready + count on success", async () => {
    countMock.mockResolvedValue({ ok: true, data: { count: 99 } });
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockStack }) => useDebouncedFilters("orgId", blocks),
      { initialProps: { blocks: [] as BlockStack } },
    );
    rerender({ blocks: [{ id: "1", kind: "vacancy", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.count).toBe(99);
    expect(result.current.status).toBe("ready");
  });

  // Race-condition test: if request 1 resolves AFTER request 2, the reqIdRef
  // guard must drop request 1's setState so the UI shows request 2's count.
  it("drops setState for a stale request that resolves after a newer request", async () => {
    let resolve1!: (v: unknown) => void;
    let resolve2!: (v: unknown) => void;
    const p1 = new Promise((r) => {
      resolve1 = r;
    });
    const p2 = new Promise((r) => {
      resolve2 = r;
    });
    countMock
      .mockImplementationOnce(() => p1) // request 1 (stale)
      .mockImplementationOnce(() => p2); // request 2 (latest)

    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: BlockStack }) => useDebouncedFilters("orgId", blocks),
      { initialProps: { blocks: [] as BlockStack } },
    );

    // Trigger request 1
    rerender({ blocks: [{ id: "a", kind: "vacancy", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Trigger request 2 (different blocks -> different stringify key -> debounce re-fires)
    rerender({ blocks: [{ id: "b", kind: "absentee", tri: "yes" }] });
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Resolve request 2 FIRST
    await act(async () => {
      resolve2({ ok: true, data: { count: 222 } });
      await Promise.resolve();
    });
    expect(result.current.count).toBe(222);
    expect(result.current.status).toBe("ready");

    // Now resolve request 1 LATE — its setState must be dropped (stale reqId)
    await act(async () => {
      resolve1({ ok: true, data: { count: 111 } });
      await Promise.resolve();
    });
    // Count must still be 222, NOT 111.
    expect(result.current.count).toBe(222);
  });
});
