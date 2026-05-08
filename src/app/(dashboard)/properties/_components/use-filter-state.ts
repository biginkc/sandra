"use client";

import { useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  decodeFilters,
  type BlockStack,
  type FilterBlock,
  type FilterState,
} from "@/lib/prospects/filter-schema";

export type UseFilterState = {
  blocks: BlockStack;
  filterState: FilterState;
  addBlock: (block: FilterBlock) => void;
  removeBlock: (id: string) => void;
  updateBlock: (id: string, patch: Partial<FilterBlock>) => void;
  replaceStack: (next: BlockStack) => void;
  clearAll: () => void;
};

export const FILTER_NAVIGATION_START_EVENT = "properties:filters-navigation-start";

export function useFilterState(): UseFilterState {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const filterState: FilterState = useMemo(() => {
    const raw = params?.get("filters") ?? null;
    return decodeFilters(raw);
  }, [params]);
  const latestBlocksRef = useRef<BlockStack>(filterState.blocks);

  useEffect(() => {
    latestBlocksRef.current = filterState.blocks;
  }, [filterState.blocks]);

  const getLatestBlocks = useCallback(() => {
    return latestBlocksRef.current;
  }, []);

  const navigate = useCallback(
    (nextStack: BlockStack) => {
      latestBlocksRef.current = nextStack;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(FILTER_NAVIGATION_START_EVENT));
      }
      const currentSearch =
        typeof window === "undefined"
          ? (params?.toString() ?? "")
          : window.location.search;
      const next = new URLSearchParams(currentSearch);
      if (nextStack.length === 0) {
        next.delete("filters");
      } else {
        // Pass raw JSON; URLSearchParams.toString() URL-encodes once.
        // Using encodeFilters() (which already URL-encodes) here would
        // produce a double-encoded value in the URL string.
        next.set("filters", JSON.stringify({ v: 1, blocks: nextStack }));
      }
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      startTransition(() => {
        router.replace(url, { scroll: false });
        router.refresh();
      });
    },
    [pathname, params, router],
  );

  const addBlock = useCallback(
    (block: FilterBlock) => navigate([...getLatestBlocks(), block]),
    [getLatestBlocks, navigate],
  );

  const removeBlock = useCallback(
    (id: string) => navigate(getLatestBlocks().filter((b) => b.id !== id)),
    [getLatestBlocks, navigate],
  );

  const updateBlock = useCallback(
    (id: string, patch: Partial<FilterBlock>) => {
      navigate(
        getLatestBlocks().map((b) =>
          b.id === id ? ({ ...b, ...patch } as FilterBlock) : b,
        ),
      );
    },
    [getLatestBlocks, navigate],
  );

  const replaceStack = useCallback(
    (next: BlockStack) => navigate(next),
    [navigate],
  );

  const clearAll = useCallback(() => navigate([]), [navigate]);

  return {
    blocks: filterState.blocks,
    filterState,
    addBlock,
    removeBlock,
    updateBlock,
    replaceStack,
    clearAll,
  };
}
