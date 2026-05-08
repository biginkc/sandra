"use client";

/**
 * STUB — Plan 06 ships the real implementation of useFilterState.
 * This stub exists in the Plan 08 worktree solely to unblock development
 * of components that import it (ActiveFiltersChips, PresetDropdown).
 *
 * Plan 09 will wire the real use-filter-state.ts from Plan 06's merged files,
 * replacing this stub at integration time.
 *
 * Interface matches Plan 06's contract exactly (see 05-06-PLAN.md).
 */

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  decodeFilters,
  encodeFilters,
  type FilterBlock,
  type FilterState,
} from "@/lib/prospects/filter-schema";

export type UseFilterStateReturn = {
  blocks: FilterBlock[];
  filterState: FilterState;
  addBlock: (block: FilterBlock) => void;
  removeBlock: (id: string) => void;
  updateBlock: (id: string, patch: Partial<FilterBlock>) => void;
  replaceStack: (blocks: FilterBlock[]) => void;
  clearAll: () => void;
};

export function useFilterState(): UseFilterStateReturn {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const raw = params?.get("filters") ?? null;
  const filterState = decodeFilters(raw);
  const blocks = filterState.blocks;

  const commit = (nextBlocks: FilterBlock[]) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (nextBlocks.length === 0) {
      next.delete("filters");
    } else {
      next.set("filters", encodeFilters({ v: 1, blocks: nextBlocks }));
    }
    const qs = next.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    router.replace(url, { scroll: false });
    router.refresh();
  };

  const addBlock = (block: FilterBlock) => commit([...blocks, block] as FilterBlock[]);

  const removeBlock = (id: string) => commit(blocks.filter((b) => b.id !== id));

  const updateBlock = (id: string, patch: Partial<FilterBlock>) =>
    commit(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as FilterBlock) : b)));

  const replaceStack = (nextBlocks: FilterBlock[]) => commit(nextBlocks);

  const clearAll = () => commit([]);

  return { blocks, filterState, addBlock, removeBlock, updateBlock, replaceStack, clearAll };
}
