"use client";

import { useTransition } from "react";
import { ChevronDownIcon, StarIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from "@/components/ui/dropdown-menu";
import { useFilterState } from "./use-filter-state";
import { togglePinSavedFilter } from "@/app/(dashboard)/properties/_actions/saved-filters";
import { newBlockId, type FilterBlock } from "@/lib/prospects/filter-schema";
import type { Preset } from "./quick-filter-chip";
import { toast } from "sonner";

export type PresetDropdownProps = {
  orgId: string;
  presets: Preset[];
};

/**
 * Preset dropdown at the top of the filter drawer.
 *
 * Groups presets: ─ Base ─ (non-user, is_base=true) then ─ Mine ─ (user presets).
 * Base presets are read-only — no star toggle (RLS prevents starring them; UX hides
 * the control entirely per the gotcha in D-19).
 * Mine presets show a star toggle to pin/unpin to the Quick Filters bar.
 *
 * Selecting any preset calls replaceStack with fresh UUIDs (per D-14) so that
 * editing the loaded stack doesn't clobber the saved preset's IDs in the URL.
 *
 * After star/unstar: router.refresh() repaints the QuickFiltersBar RSC.
 */
export function PresetDropdown({ orgId, presets }: PresetDropdownProps) {
  const { replaceStack } = useFilterState();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const base = presets.filter((p) => p.is_base);
  const mine = presets.filter((p) => !p.is_base);

  /** Rehydrate with fresh UUIDs so editing doesn't mutate the preset's own IDs. */
  const apply = (p: Preset) => {
    const fresh: FilterBlock[] = (p.filters_json.blocks ?? []).map(
      (b) => ({ ...b, id: newBlockId() } as FilterBlock)
    );
    replaceStack(fresh);
  };

  const togglePin = (p: Preset) => {
    startTransition(async () => {
      const result = await togglePinSavedFilter({
        orgId,
        id: p.id,
        starred: !p.starred,
      });
      if (result.ok) {
        toast.success(
          result.data.starred ? `Pinned "${p.name}".` : `Unpinned "${p.name}".`
        );
        router.refresh();
      } else {
        toast.error(`Couldn't update pin: ${result.error.message}`);
      }
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="preset-dropdown-trigger"
        className="inline-flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted focus:outline-none"
      >
        <span className="flex-1 text-left">Preset…</span>
        <ChevronDownIcon className="size-4 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {base.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Base</DropdownMenuLabel>
            {base.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => apply(p)}>
                {p.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {base.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Mine</DropdownMenuLabel>
          {mine.length > 0 ? (
            mine.map((p) => (
              <div
                key={p.id}
                className="flex items-center"
                data-preset-row
                data-preset-name={p.name}
              >
                <DropdownMenuItem
                  onClick={() => apply(p)}
                  className="flex-1"
                >
                  {p.name}
                </DropdownMenuItem>
                <button
                  onClick={() => togglePin(p)}
                  aria-label={p.starred ? `Unpin ${p.name}` : `Pin ${p.name}`}
                  className="px-2 py-1 hover:opacity-70 focus:outline-none"
                >
                  <StarIcon
                    className={`size-4 ${p.starred ? "fill-current text-amber-500" : "text-muted-foreground"}`}
                  />
                </button>
              </div>
            ))
          ) : (
            <DropdownMenuItem disabled>No saved presets yet</DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
