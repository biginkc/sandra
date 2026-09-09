"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchInputPill } from "@/components/ui/search-input-pill";

export function InboxSearch({ degraded = false }: { degraded?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const query = params.toString();
  const search = params.get("search") ?? "";
  const localNavigations = useRef(0);
  const [value, setValue] = useState(search);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // React batches overlapping navigations into one transition. Once it
    // settles, every dispatch in that batch has completed or been superseded.
    if (!pending) localNavigations.current = 0;
  }, [pending]);
  useEffect(() => {
    // The URL owns the draft only while idle. An older completion must never
    // overwrite typing or cancel its debounce, regardless of dispatch order.
    if (timer.current === null && localNavigations.current === 0 && !pending) {
      setValue(search);
    }
  }, [query, search, pending]);
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
            if (normalized) url.set("search", normalized);
            else url.delete("search");
            url.delete("inboxPage");
            startTransition(() => {
              localNavigations.current += 1;
              router.replace(`/messages?${url.toString()}`, { scroll: false });
            });
          }, 200);
        }}
      />
      {degraded ? <p role="status" className="mt-1 text-sm text-muted-foreground">Search unavailable</p> : null}
    </div>
  );
}
