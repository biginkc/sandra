"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SearchResult = {
  type: "property" | "owner" | "thread";
  key: string;
  title: string;
  subtitle: string;
  matchedField: string;
  href: string;
};
type SearchState = {
  query: string;
  results: SearchResult[];
  status: "idle" | "loading" | "results" | "empty" | "unavailable";
  skeleton: boolean;
};
const idle = (): SearchState => ({ query: "", results: [], status: "idle", skeleton: false });

export function useGlobalSearch() {
  const [state, setState] = useState<SearchState>(idle);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const invalidate = useCallback(() => {
    generation.current++;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    pending.current?.abort();
    pending.current = null;
  }, []);
  const reset = useCallback(() => {
    invalidate();
    setState(idle());
  }, [invalidate]);
  const setQuery = useCallback((query: string) => {
    invalidate();
    const q = query.trim();
    if (q.length < 3) {
      setState({ ...idle(), query });
      return;
    }
    const id = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    const current = () => id === generation.current && !controller.signal.aborted;
    setState(previous => ({ ...previous, query, status: "loading", skeleton: false }));
    const finish = (results: SearchResult[], status: SearchState["status"]) => {
      if (!current()) return;
      setState({ query, results, status, skeleton: false });
      invalidate();
    };
    timers.current.push(setTimeout(async () => {
      if (!current()) return;
      // Prototype timing starts at dispatch, after the debounce.
      timers.current.push(setTimeout(() => {
        if (current()) setState(previous => ({ ...previous, skeleton: previous.results.length === 0 }));
      }, 400));
      // A client recovery deadline, not a database execution timeout.
      timers.current.push(setTimeout(() => finish([], "unavailable"), 15_000));
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (!current()) return;
        if (response.redirected || !response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Search unavailable");
        const body = await response.json();
        if (body.degraded || !Array.isArray(body.results)) throw new Error("Search unavailable");
        finish(body.results, body.results.length ? "results" : "empty");
      } catch {
        finish([], "unavailable");
      }
    }, 200));
  }, [invalidate]);
  useEffect(() => invalidate, [invalidate]);
  return { ...state, setQuery, reset };
}
