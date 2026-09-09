"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchInputPill } from "@/components/ui/search-input-pill";

export function InboxSearch({ degraded = false }: { degraded?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const search = params.get("search") ?? "";
  const [draft, setDraft] = useState({ query, value: search });
  if (draft.query !== query) setDraft({ query, value: search });
  const value = draft.query === query ? draft.value : search;
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Navigation (including Back/Forward and filter changes) cancels old edits.
  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, search]);

  return (
    <div className="w-full" aria-busy={pending}>
      <SearchInputPill
        aria-label="Search messages"
        placeholder="Search name, phone, or message…"
        maxLength={100}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          setDraft({ query, value: next });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            const url = new URLSearchParams(query);
            const normalized = next.trim();
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
