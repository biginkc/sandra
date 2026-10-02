"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockStack } from "@/lib/prospects/filter-schema";
import type { QueryOrigin } from "@/lib/prospects/search-scope";
import { countProspectsForFilter } from "@/app/(dashboard)/properties/_actions/count";

export type CountState = {
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  error?: string;
};

export type DebouncedFilterScope = {
  /** Page `?search=`; the count must match the rows the page shows. */
  search?: string | null;
  imported?: "today" | null;
  origin?: QueryOrigin;
};

export function useDebouncedFilters(
  orgId: string,
  blocks: BlockStack,
  ms = 250,
  scope: DebouncedFilterScope = {},
): CountState {
  const [state, setState] = useState<CountState>({ status: "idle", count: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  // Stable dep: stringify blocks to avoid re-firing on every reference change.
  // Inside the effect, the closure over `blocks` is still fresh (captured at
  // effect-run time after the dep comparison). This matches the D-12 pattern.
  const blocksKey = JSON.stringify(blocks);
  const search = scope.search ?? null;
  const imported = scope.imported ?? null;
  const origin = scope.origin;

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current;
      setState((s) => ({ status: "loading", count: s.count }));

      try {
        const result = await countProspectsForFilter({
          orgId,
          blocks,
          search,
          imported,
          origin,
        });
        if (reqId !== reqIdRef.current) return; // stale — drop

        if (result.ok) {
          setState({ status: "ready", count: result.data.count });
        } else {
          setState({
            status: "error",
            count: 0,
            error: result.error.message,
          });
        }
      } catch (e) {
        if (reqId !== reqIdRef.current) return; // stale — drop
        setState({ status: "error", count: 0, error: String(e) });
      }
    }, ms);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, blocksKey, ms, search, imported, origin]);

  return state;
}
