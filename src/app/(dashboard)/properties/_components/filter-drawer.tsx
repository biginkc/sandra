"use client";

import { useState } from "react";
import { FilterIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  newBlockId,
  type BlockKind,
  type FilterBlock,
} from "@/lib/prospects/filter-schema";
import { useFilterState } from "./use-filter-state";
import { AddBlockPicker } from "./add-block-picker";

// ---------------------------------------------------------------------------
// defaultBlockForKind — builds a sensible default config per block kind.
// Plan 07 may call this directly when wiring block components.
// ---------------------------------------------------------------------------
export function defaultBlockForKind(kind: BlockKind): FilterBlock {
  switch (kind) {
    case "vacancy":
    case "absentee":
    case "has_unread_inbound":
    case "needs_human_attention":
    case "has_open_tasks":
      return { id: newBlockId(), kind, tri: "any" } as FilterBlock;

    case "list":
    case "tag":
    case "cass":
    case "outreach_dispo":
    case "source":
    case "state":
    case "market":
    case "pipeline_status":
    case "engagement":
    case "assignee":
    case "motivation_level":
      return { id: newBlockId(), kind, combinator: "any", values: [] } as FilterBlock;

    case "list_count":
    case "beds":
    case "baths":
    case "year_built":
    case "estimated_value":
    case "equity_pct":
      return { id: newBlockId(), kind, range: { min: null, max: null } } as FilterBlock;

    case "created_date":
      return {
        id: newBlockId(),
        kind: "created_date",
        date: { mode: "since", days: 30 },
      };

    default: {
      const _exhaustive: never = kind;
      throw new Error(`defaultBlockForKind: unknown kind ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type FilterDrawerProps = {
  orgId: string;
  /**
   * Optional block renderer — Plan 07 injects a per-kind dispatcher here.
   * When absent, each block row shows a placeholder "(Plan 07 will render this)".
   */
  renderBlock?: (
    block: FilterBlock,
    onChange: (patch: Partial<FilterBlock>) => void,
    onRemove: () => void,
  ) => React.ReactNode;
  /**
   * Slot rendered at the top of the drawer body, inside SheetHeader.
   * Plan 09 uses this for <PresetDropdown />.
   */
  topSlot?: React.ReactNode;
  /** Slot rendered inside SheetFooter. Plan 09 uses this for <SavePresetInline />. */
  footerSlot?: React.ReactNode;
  /**
   * Controlled open state — passed through to Sheet (base-ui Dialog.Root).
   * Used in tests to bypass the trigger click. When undefined, the Sheet
   * manages its own open state (uncontrolled, driven by the trigger button).
   */
  open?: boolean;
  /** Called when the sheet open state changes (controlled mode). */
  onOpenChange?: (open: boolean) => void;
};

// ---------------------------------------------------------------------------
// FilterDrawer
// ---------------------------------------------------------------------------
export function FilterDrawer({
  orgId: _orgId,
  renderBlock,
  topSlot,
  footerSlot,
  open,
  onOpenChange,
}: FilterDrawerProps) {
  const { blocks, addBlock, removeBlock, updateBlock } = useFilterState();
  const [pickerOpen, setPickerOpen] = useState(false);

  const onPickerSelect = (kind: BlockKind) => {
    addBlock(defaultBlockForKind(kind));
    setPickerOpen(false);
  };

  // Build Sheet props: controlled when open/onOpenChange provided, uncontrolled otherwise.
  const sheetRootProps =
    open !== undefined ? { open, onOpenChange } : {};

  return (
    <Sheet modal="trap-focus" {...sheetRootProps}>
      {/* Trigger is hidden in controlled/test mode (no need for it when open is forced) */}
      {open === undefined && (
        <SheetTrigger
          render={
            <Button variant="outline" className="gap-2">
              <FilterIcon className="size-4" />
              {blocks.length > 0 ? `Filters (${blocks.length})` : "Filters"}
            </Button>
          }
        />
      )}

      <SheetContent
        side="right"
        overlayClassName="pointer-events-none bg-transparent supports-backdrop-filter:backdrop-blur-none"
        className="!max-w-[440px] sm:!max-w-[440px] flex flex-col p-0"
      >
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle>Filters</SheetTitle>
          {topSlot ? (
            <div data-top-slot className="mt-2">
              {topSlot}
            </div>
          ) : null}
        </SheetHeader>

        {/* Body — relative so AddBlockPicker can absolute-fill it */}
        <div className="relative flex-1 overflow-y-auto px-4 pb-2">
          {blocks.length === 0 ? (
            <div data-empty-filter-state className="h-0" aria-hidden="true" />
          ) : (
            <div className="space-y-3">
              {blocks.map((b) => (
                <div
                  key={b.id}
                  data-block-row
                  data-kind={b.kind}
                  className="rounded border p-3"
                >
                  {renderBlock ? (
                    renderBlock(
                      b,
                      (patch) => updateBlock(b.id, patch),
                      () => removeBlock(b.id),
                    )
                  ) : (
                    <PlaceholderBlockRow
                      block={b}
                      onRemove={() => removeBlock(b.id)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            className="mt-3 w-full gap-2"
            onClick={() => setPickerOpen(true)}
          >
            <PlusIcon className="size-4" />
            Add Filter Block
          </Button>

          {/* Picker overlays the body when open */}
          <AddBlockPicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelect={onPickerSelect}
          />
        </div>

        <SheetFooter className="flex flex-col gap-2 px-4 pb-4">
          {footerSlot ? (
            <div data-footer-slot>{footerSlot}</div>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// PlaceholderBlockRow — shown until Plan 07 ships real block components
// ---------------------------------------------------------------------------
function PlaceholderBlockRow({
  block,
  onRemove,
}: {
  block: FilterBlock;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">
        Block: {block.kind} — not yet implemented
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label="Remove block"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
