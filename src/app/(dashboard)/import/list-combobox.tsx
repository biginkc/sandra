"use client";

import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import {
  classifyListQuery,
  type ListEntry,
} from "./list-combobox-helpers";

/**
 * List picker for the import wizard's optional "Add to list" field.
 * Surfaces every existing list (active only — archived lists hidden by
 * default to keep the picker focused) plus a "Create '<query>'" option
 * when the typed name doesn't match anything.
 *
 * The wizard's contract is unchanged: this component just sets a
 * `listName: string | null` on the wizard state. `resolveOrCreateList()`
 * server-side does the case-insensitive lookup-or-create, so picking an
 * existing list and creating-via-typing both end up at the same
 * server-side behavior.
 */
export function ListCombobox({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? "");
  const [lists, setLists] = useState<ListEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Pull active lists once on mount. Cheap query (rarely more than a few
  // dozen rows) and the wizard is short-lived so we don't bother with
  // refetching on focus.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from("lists")
      .select("id, name, system_managed")
      .is("archived_at", null)
      // System-managed lists pin to the top of the picker so VAs see the
      // 20 PropStream-style buckets first; everything else stays
      // alphabetical underneath.
      .order("system_managed", { ascending: false })
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (cancelled) return;
        setLists((data ?? []) as ListEntry[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the input in sync when the parent clears the value externally
  // (e.g. mode switch resets state.listName).
  useEffect(() => {
    if (value === null) setQuery("");
    else setQuery(value);
  }, [value]);

  const classification = useMemo(
    () => classifyListQuery(query, lists),
    [query, lists],
  );

  const select = (next: string | null) => {
    onChange(next);
    setQuery(next ?? "");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span
          className={cn(
            "truncate",
            !value && "text-muted-foreground",
          )}
        >
          {value ?? "e.g. Absentee Low Equity (search or create)"}
        </span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--anchor-size)] min-w-[280px] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a new list name…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>
              {loading
                ? "Loading lists…"
                : classification.canCreate
                  ? `Press Enter to create "${classification.trimmed}"`
                  : "No lists yet"}
            </CommandEmpty>
            {classification.matches.length > 0 && (
              <CommandGroup heading="Existing lists">
                {classification.matches.map((l) => {
                  const selected =
                    value !== null &&
                    l.name.toLowerCase() === value.toLowerCase();
                  return (
                    <CommandItem
                      key={l.id}
                      value={l.name}
                      onSelect={() => select(l.name)}
                    >
                      <Check
                        className={cn(
                          "mr-2 size-4",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {l.name}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
            {classification.canCreate && (
              <CommandGroup heading="Create new">
                <CommandItem
                  // Prefix avoids collision with a real list name like
                  // "create new" if the user happens to type that.
                  value={`__create__${classification.trimmed}`}
                  onSelect={() => select(classification.trimmed)}
                >
                  <Plus className="mr-2 size-4" />
                  <span>Create &ldquo;{classification.trimmed}&rdquo;</span>
                </CommandItem>
              </CommandGroup>
            )}
            {value !== null && (
              <CommandGroup heading="Or">
                <CommandItem
                  value="__clear__"
                  onSelect={() => select(null)}
                >
                  <X className="mr-2 size-4" />
                  Don&apos;t add to a list
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
