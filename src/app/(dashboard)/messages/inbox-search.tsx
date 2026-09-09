"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchInputPill } from "@/components/ui/search-input-pill";

export function InboxSearch({ degraded = false }: { degraded?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const search = params.get("search") ?? "";
  const lastDispatchedSearch = useRef<string | null>(null);
  const [value, setValue] = useState(search);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // A local replace may finish after a newer edit scheduled its debounce.
    // Consume the dispatch marker so later Back/Forward or filter changes
    // remain external navigation, even when they reuse this search value.
    if (search !== lastDispatchedSearch.current) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // URL navigation is an external source; local completions must not sync.
      setValue(search);
    }
    lastDispatchedSearch.current = null;
  }, [query, search]);
  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  return (
    <div className="w-full" aria-busy={pending}>
      <SearchInputPill
        aria-label="Search messages"
        placeholder="Search name, phone, or message…"
        maxLength={100}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setValue(next);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const url = new URLSearchParams(query);
            const normalized = next.trim();
            timer.current = null;
            lastDispatchedSearch.current = normalized;
            if (normalized) url.set("search", normalized);
            else url.delete("search");
            url.delete("inboxPage");
            startTransition(() => router.replace(`/messages?${url.toString()}`, { scroll: false }));
          }, 200);
        }}
      />
      {degraded ? <p role="status" className="mt-1 text-sm text-muted-foreground">Search unavailable</p> : null}
    </div>
  );
}
