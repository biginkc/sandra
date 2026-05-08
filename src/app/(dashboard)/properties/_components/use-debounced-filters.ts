"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockStack } from "@/lib/prospects/filter-schema";
import { countProspectsForFilter } from "@/app/(dashboard)/properties/_actions/count";

export type CountState = {
  status: "idle" | "loading" | "ready" | "error";
  count: number;
  error?: string;
};

export function useDebouncedFilters(
  orgId: string,
  blocks: BlockStack,
  ms = 250,
): CountState {
  const [state, setState] = useState<CountState>({ status: "idle", count: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  // Stable dep: stringify blocks to avoid re-firing on every reference change.
  // Inside the effect, the closure over `blocks` is still fresh (captured at
  // effect-run time after the dep comparison). This matches the D-12 pattern.
  const blocksKey = JSON.stringify(blocks);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      const reqId = ++reqIdRef.current;
      setState((s) => ({ status: "loading", count: s.count }));

      try {
        const result = await countProspectsForFilter({ orgId, blocks });
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
  }, [orgId, blocksKey, ms]);

  return state;
}
