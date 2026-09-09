"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useGlobalSearch } from "./use-global-search";
import { GlobalSearchLayer } from "./global-search-layer";

function useSearchProvider() {
  const search = useGlobalSearch();
  const { reset } = search;
  const [open, setOpen] = useState(false);
  const [modKey, setModKey] = useState("Ctrl");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(false);
  const focusFrame = useRef<number | null>(null);
  const changeOpen = useCallback((next: boolean) => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    reset();
    openRef.current = next;
    setOpen(next);
    if (!next) focusFrame.current = requestAnimationFrame(() => {
      if (!openRef.current) triggerRef.current?.focus({ preventScroll: true });
      focusFrame.current = null;
    });
  }, [reset]);
  useEffect(() => {
    // Platform is unavailable during SSR; this one post-mount update preserves hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModKey(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        changeOpen(!openRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    };
  }, [changeOpen]);
  return { open, changeOpen, triggerRef, modKey, search };
}
const SearchContext = createContext<ReturnType<typeof useSearchProvider> | null>(null);
export function useGlobalSearchContext() {
  const context = useContext(SearchContext);
  if (!context) throw new Error("Global search requires GlobalSearchProvider");
  return context;
}
export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const value = useSearchProvider();
  return <SearchContext.Provider value={value}>{children}<GlobalSearchLayer /></SearchContext.Provider>;
}
