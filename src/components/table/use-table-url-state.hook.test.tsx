import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  TableUrlStateContext,
  useTableUrlState,
  useTableUrlStateContext,
  type ParsedTableSearch,
  type SortDirection,
} from "./use-table-url-state";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const SORTABLE_COLUMNS = ["address", "market", "created_at"] as const;

type EmptyFilters = Record<string, never>;

const DEFAULT_PARSED: ParsedTableSearch<EmptyFilters> = {
  page: 1,
  search: null,
  sort: "created_at",
  dir: "desc",
  filters: {},
};

const DEFAULT_OPTIONS = {
  basePath: "/test",
  parsed: DEFAULT_PARSED,
  config: {
    defaultSort: "created_at",
    defaultDir: "desc" as SortDirection,
    sortableColumns: SORTABLE_COLUMNS,
  },
};

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTableUrlState (ssr mode)", () => {
  it("navigate(url) calls router.replace with { scroll: false } and engages skeleton floor", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));
    expect(result.current.navPending).toBe(false);

    act(() => result.current.navigate("/test?page=2"));

    expect(routerReplace).toHaveBeenCalledWith("/test?page=2", { scroll: false });
    expect(result.current.navPending).toBe(true);

    // Advance past the 150ms floor — navPending releases.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.navPending).toBe(false);
  });

  it("onSort('address') when sort='created_at' navigates with sort=address&dir=asc and resets page=1", () => {
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));
    act(() => result.current.onSort("address"));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe("/test?sort=address&dir=asc");
  });

  it("onSort(currentSort) flips dir asc → desc → asc", () => {
    // Render with sort=address dir=asc, then click address again
    const { result, rerender } = renderHook(
      (opts: typeof DEFAULT_OPTIONS) => useTableUrlState(opts),
      {
        initialProps: {
          ...DEFAULT_OPTIONS,
          parsed: { ...DEFAULT_PARSED, sort: "address", dir: "asc" as SortDirection },
        },
      },
    );

    act(() => result.current.onSort("address"));
    // asc → desc; desc on the prospects-like config matches default → URL omits dir
    expect(routerReplace.mock.calls[0][0]).toBe("/test?sort=address");

    routerReplace.mockReset();
    rerender({
      ...DEFAULT_OPTIONS,
      parsed: { ...DEFAULT_PARSED, sort: "address", dir: "desc" as SortDirection },
    });
    act(() => result.current.onSort("address"));
    expect(routerReplace.mock.calls[0][0]).toBe("/test?sort=address&dir=asc");
  });

  it("debouncedSearch waits 250ms before firing router.replace", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));

    act(() => {
      result.current.debouncedSearch("h");
      result.current.debouncedSearch("he");
      result.current.debouncedSearch("hel");
      result.current.debouncedSearch("hello");
    });

    expect(routerReplace).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(250));
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe("/test?search=hello");
  });

  it("debouncedSearch then immediate navigate cancels the debounce timer (Pitfall 3)", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));

    act(() => {
      result.current.debouncedSearch("stale");
      result.current.navigate("/test?page=3");
    });

    // Advance past the 250ms debounce window — only the direct navigate should have fired.
    act(() => vi.advanceTimersByTime(500));

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe("/test?page=3");
  });

  it("debouncedSearch with whitespace-only collapses to no ?search param", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));

    act(() => result.current.debouncedSearch("   "));
    act(() => vi.advanceTimersByTime(250));

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe("/test");
  });

  it("respects custom minSkeletonMs option", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useTableUrlState({ ...DEFAULT_OPTIONS, minSkeletonMs: 300 }),
    );

    act(() => result.current.navigate("/test?page=2"));
    expect(result.current.navPending).toBe(true);

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.navPending).toBe(true); // still true at 150ms

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.navPending).toBe(false); // released at 300ms
  });

  it("returns search='' when parsed.search is null (consumer-friendly default for <Input defaultValue=>)", () => {
    const { result } = renderHook(() => useTableUrlState(DEFAULT_OPTIONS));
    expect(result.current.search).toBe("");
  });
});

describe("useTableUrlState (client mode)", () => {
  it("navigate(url) in client mode calls router.replace WITHOUT startTransition; transitionPending stays false", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useTableUrlState({ ...DEFAULT_OPTIONS, mode: "client" }),
    );

    act(() => result.current.navigate("/test?page=2"));

    expect(routerReplace).toHaveBeenCalledWith("/test?page=2", { scroll: false });
    // navPending true ONLY because of forceSkeleton (no transition wrapper)
    expect(result.current.navPending).toBe(true);

    act(() => vi.advanceTimersByTime(150));
    expect(result.current.navPending).toBe(false);
  });
});

describe("TableUrlStateContext + useTableUrlStateContext", () => {
  it("returns the hook value when used inside a Provider", () => {
    function Provider({ children }: { children: React.ReactNode }) {
      const ts = useTableUrlState(DEFAULT_OPTIONS);
      return (
        <TableUrlStateContext.Provider
          value={ts as unknown as React.ContextType<typeof TableUrlStateContext>}
        >
          {children}
        </TableUrlStateContext.Provider>
      );
    }

    const { result } = renderHook(() => useTableUrlStateContext(), {
      wrapper: Provider,
    });

    expect(result.current.basePath).toBe("/test");
    expect(result.current.sort).toBe("created_at");
    expect(typeof result.current.debouncedSearch).toBe("function");
  });

  it("throws when used outside a Provider", () => {
    // Suppress React's error log for this expected throw
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useTableUrlStateContext())).toThrow(
      /must be used inside a useTableUrlState consumer/,
    );
    errSpy.mockRestore();
  });
});
