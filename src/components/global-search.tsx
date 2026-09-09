"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";

type SearchResult = {
  type: "property" | "owner" | "thread";
  key: string;
  title: string;
  subtitle: string;
  matchedField: string;
  href: string;
};

export function GlobalSearch() {
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    pending.current = null;
  }, []);
  const changeOpen = useCallback((next: boolean) => {
    invalidate();
    setOpen(next);
    setQuery("");
    setResults([]);
    setStatus("idle");
    if (!next) requestAnimationFrame(() => trigger.current?.focus());
  }, [invalidate]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        changeOpen(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, changeOpen]);
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 3) return;
    const current = generation.current;
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (response.redirected || !response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Search unavailable");
        const body = await response.json();
        if (body.degraded || !Array.isArray(body.results)) throw new Error("Search unavailable");
        if (current !== generation.current || controller.signal.aborted) return;
        setResults(body.results);
        setSelected(body.results[0]?.key ?? "");
        setStatus("ready");
      } catch {
        if (current !== generation.current || controller.signal.aborted) return;
        setResults([]);
        setStatus("error");
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  useEffect(() => invalidate, [invalidate]);

  return <>
    <button ref={trigger} type="button" aria-label="Search" onClick={() => changeOpen(true)} className="flex items-center gap-2 rounded-full border border-white/20 px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
      <SearchIcon className="size-4" /><span className="hidden sm:inline">Search…</span><span className="hidden sm:inline">⌘K</span>
    </button>
    <CommandDialog open={open} onOpenChange={changeOpen} title="Search Sandra" description="Search properties, owners, and SMS messages">
      <Command shouldFilter={false} value={selected} onValueChange={setSelected} loop>
        <CommandInput placeholder="Search properties, owners, messages…" value={query} maxLength={100} onValueChange={value => {
          invalidate(); setQuery(value); setResults([]); setSelected(""); setStatus(value.trim().length >= 3 ? "loading" : "idle");
        }} />
        <CommandList>
          {status === "idle" && <div className="p-6 text-center text-sm text-muted-foreground">Type at least 3 characters</div>}
          {status === "loading" && <div role="status" className="p-6 text-center text-sm">Searching…</div>}
          {status === "error" && <div role="alert" className="p-6 text-center text-sm">Search unavailable</div>}
          {status === "ready" && results.length === 0 && <CommandEmpty>No matches for “{query.trim()}”</CommandEmpty>}
          {([['property', 'Properties'], ['owner', 'Owners'], ['thread', 'Messages']] as const).map(([type, label]) => {
            const items = results.filter(item => item.type === type);
            return items.length > 0 && <CommandGroup key={type} heading={label}>
              {items.map(item => <CommandItem key={item.key} value={item.key} onSelect={() => { changeOpen(false); router.push(item.href); }}>
                <div className="min-w-0"><div className="truncate">{item.title}</div><div className="truncate text-xs text-muted-foreground">{item.subtitle}</div></div>
                {(item.matchedField === "phone" || item.matchedField === "email") && <CommandShortcut>{item.matchedField}</CommandShortcut>}
              </CommandItem>)}
            </CommandGroup>;
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  </>;
}
