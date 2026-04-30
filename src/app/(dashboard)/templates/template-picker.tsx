"use client";

import { FileText } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

import { listTemplates, type TemplateRow } from "./actions";

type Props = {
  /** Called when the user selects a template. */
  onSelect: (template: TemplateRow) => void;
};

/**
 * Popover-based template picker. Loads templates on first open,
 * groups by category, and supports search. Used in InlineReply
 * and the sequence step editor.
 */
export function TemplatePicker({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");

  // Lazy-load templates on first open
  useEffect(() => {
    if (open && !loaded) {
      listTemplates().then((result) => {
        if (result.ok) setTemplates(result.data);
        setLoaded(true);
      });
    }
  }, [open, loaded]);

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
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
            placeholder="Search templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
            autoFocus
          />
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {!loaded ? (
            <div className="text-muted-foreground p-4 text-center text-xs">
              Loading…
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
                    className="hover:bg-muted flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors"
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
