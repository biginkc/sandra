"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  encodeFilters,
  decodeFilters,
  type FilterState,
  type FilterBlock,
} from "@/lib/prospects/filter-schema";

export type Preset = {
  id: string;
  name: string;
  filters_json: FilterState;
  starred: boolean;
  is_base: boolean;
};

export type QuickFilterChipProps = {
  preset: Preset;
  orgId: string;
  currentFilterStateRaw: string | null;
};

/**
 * Compare two block stacks ignoring the `id` field per D-17 — user-saved
 * blocks have different UUIDs than the same-shape URL state blocks.
 * Only kind + config fields matter for active-chip detection.
 */
function blocksEqualIgnoringId(a: FilterBlock[], b: FilterBlock[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (blk: FilterBlock) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...rest } = blk as FilterBlock & { id: string };
    return rest;
  };
  return JSON.stringify(a.map(norm)) === JSON.stringify(b.map(norm));
}

export function QuickFilterChip({
  preset,
  currentFilterStateRaw,
}: QuickFilterChipProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const current = decodeFilters(currentFilterStateRaw);
  const isActive = blocksEqualIgnoringId(
    current.blocks,
    preset.filters_json.blocks ?? []
  );

  const onClick = () => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (isActive) {
      next.delete("filters");
    } else {
      next.set("filters", encodeFilters(preset.filters_json));
    }
    const qs = next.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    router.replace(url, { scroll: false });
    router.refresh();
  };

  return (
    <button
      onClick={onClick}
      aria-pressed={isActive}
      className="focus:outline-none"
      data-quick-filter-chip
      data-preset-name={preset.name}
      data-active={isActive}
    >
      <Badge variant={isActive ? "default" : "outline"} className="cursor-pointer">
        {preset.name}
      </Badge>
    </button>
  );
}
