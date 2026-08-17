"use client";

import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

import { listTemplates, type TemplateRow } from "./actions";

type Props = {
  /** Called when the user selects a template. */
  onSelect: (template: TemplateRow) => void;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; templates: TemplateRow[] }
  | { status: "error"; message: string };

/**
 * Popover-based template picker. Re-fetches templates on every open
 * so newly-created or deleted rows in another tab are reflected
 * without a full page reload (WR-06). Surfaces a retry button if the
 * fetch fails so the empty state isn't ambiguous (WR-05).
 */
export function TemplatePicker({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Focus the search input when the popover opens, but use preventScroll
  // so the browser doesn't scroll the page to bring the portaled popover
  // into view. The HTML `autoFocus` attribute does NOT support preventScroll
  // and was causing the page to jump to the top on lead detail pages.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  // WR-06: re-fetch on every open. Templates are small; a fresh read on
  // each click is cheaper than the bug class of "stale picker shows a
  // template that was deleted in another tab". WR-05: track an explicit
  // error state instead of swallowing the failure into "no templates yet".
  // The `cancelled` flag mirrors the pattern used elsewhere in this file
  // family (e.g. inline-reply.tsx) so a quick close-then-open doesn't
  // race two in-flight fetches.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- opening the external popover begins a new asynchronous loading lifecycle.
    setLoadState({ status: "loading" });
    listTemplates().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLoadState({ status: "ready", templates: result.data });
      } else {
        setLoadState({
          status: "error",
          message: result.error.message ?? "Couldn't load templates.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const templates =
    loadState.status === "ready" ? loadState.templates : [];

  const filtered = search.trim()
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          t.content.toLowerCase().includes(search.toLowerCase()),
      )
    : templates;

  // Group by category
  const grouped = filtered.reduce(
    (acc, t) => {
      if (!acc[t.category]) acc[t.category] = [];
      acc[t.category].push(t);
      return acc;
    },
    {} as Record<string, TemplateRow[]>,
  );

  const categoryOrder = Object.keys(grouped).sort();

  // Manually re-trigger the load on retry click without toggling `open`.
  // Re-using the effect via a key bump would require an extra state var;
  // a direct call here is simpler.
  const retry = () => {
    setLoadState({ status: "loading" });
    listTemplates().then((result) => {
      if (result.ok) {
        setLoadState({ status: "ready", templates: result.data });
      } else {
        setLoadState({
          status: "error",
          message: result.error.message ?? "Couldn't load templates.",
        });
      }
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 gap-1.5"
            aria-label="Insert template"
          />
        }
      >
        <FileText className="size-3.5" />
        Templates
      </PopoverTrigger>
      <PopoverContent
        className="w-[280px] p-0"
        side="top"
        align="start"
      >
        <div className="border-border border-b p-2">
          <Input
            ref={searchInputRef}
            placeholder="Search templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-h-11 text-xs"
          />
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {loadState.status === "loading" || loadState.status === "idle" ? (
            // Skeleton rows mirror the real row shape (category header +
            // two lines per template) so the layout doesn't shift when
            // real data arrives.
            <div aria-busy="true" aria-label="Loading templates">
              {[0, 1].map((group) => (
                <div key={group}>
                  <div className="bg-muted/40 px-3 py-1.5">
                    <Skeleton className="h-2 w-20" />
                  </div>
                  {[0, 1, 2].map((row) => (
                    <div
                      key={row}
                      className="flex flex-col gap-1.5 px-3 py-2.5"
                    >
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-2.5 w-full" />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : loadState.status === "error" ? (
            <div className="flex flex-col items-center gap-2 p-4 text-center">
              <p className="text-destructive text-xs">
                {loadState.message}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={retry}
                className="min-h-11 text-xs"
              >
                Retry
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground p-4 text-center text-xs">
              {templates.length === 0
                ? "No templates yet. Create one in Templates."
                : "No matches."}
            </div>
          ) : (
            categoryOrder.map((category) => (
              <div key={category}>
                <div className="text-muted-foreground bg-muted/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest">
                  {category}
                </div>
                {grouped[category].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      onSelect(t);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="hover:bg-muted flex min-h-11 w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors"
                  >
                    <span className="text-sm font-medium">{t.name}</span>
                    <span className="text-muted-foreground line-clamp-1 text-xs">
                      {t.content.slice(0, 60)}
                      {t.content.length > 60 ? "…" : ""}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
