"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
export type FilterNavigationStartDetail = {
  blocksKey: string;
};

export function useFilterState(): UseFilterState {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const urlFilterState: FilterState = useMemo(() => {
    const raw = params?.get("filters") ?? null;
    return decodeFilters(raw);
  }, [params]);
  const [blocks, setBlocks] = useState<BlockStack>(urlFilterState.blocks);
  const latestBlocksRef = useRef<BlockStack>(urlFilterState.blocks);
  const urlBlocksKey = JSON.stringify(urlFilterState.blocks);

  useEffect(() => {
    latestBlocksRef.current = urlFilterState.blocks;
    setBlocks(urlFilterState.blocks);
    // urlBlocksKey is the stable dependency; urlFilterState.blocks is the
    // fresh decoded value to sync from when the URL actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlBlocksKey]);

  const getLatestBlocks = useCallback(() => {
    return latestBlocksRef.current;
  }, []);

  const navigate = useCallback(
    (nextStack: BlockStack) => {
      latestBlocksRef.current = nextStack;
      setBlocks(nextStack);
      if (typeof window !== "undefined") {
        // The table uses this event as a narrow client-side bridge: controls
        // update optimistically immediately, while the RSC table keeps showing
        // skeleton rows until the server-rendered block stack catches up.
        window.dispatchEvent(
          new CustomEvent<FilterNavigationStartDetail>(
            FILTER_NAVIGATION_START_EVENT,
            { detail: { blocksKey: JSON.stringify(nextStack) } },
          ),
        );
      }
      const currentSearch =
        typeof window === "undefined"
          ? (params?.toString() ?? "")
          // useSearchParams can lag behind rapid router.replace calls inside
          // the same interaction; reading the browser URL preserves unrelated
          // params from the latest committed navigation.
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
  const filterState: FilterState = useMemo(() => ({ v: 1, blocks }), [blocks]);

  return {
    blocks,
    filterState,
    addBlock,
    removeBlock,
    updateBlock,
    replaceStack,
    clearAll,
  };
}
