"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
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
  // Sort keys before stringify so two objects with the same fields in
  // different orders compare equal. Without this, the DB seed shape
  // {id,kind,tri} and the narrowBlock-reordered URL shape {id,tri,kind}
  // would mismatch despite being semantically identical.
  const norm = (blk: FilterBlock) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...rest } = blk as FilterBlock & { id: string };
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return a.map(norm).join("|") === b.map(norm).join("|");
}

export function QuickFilterChip({
  preset,
}: QuickFilterChipProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Derive active state from the live URL via useSearchParams() rather than
  // the server-passed currentFilterStateRaw prop. Reason: the prop only
  // updates when the RSC parent re-renders, which can lag behind a
  // router.replace soft-nav. useSearchParams() is reactive to URL changes
  // immediately. The prop is preserved on the type for the SSR-stable
  // initial render but the client-side source of truth is the URL.
  const liveRaw = params?.get("filters") ?? null;
  const current = decodeFilters(liveRaw);
  const isActive = blocksEqualIgnoringId(
    current.blocks,
    preset.filters_json.blocks ?? []
  );

  const onClick = () => {
    const browserSearch =
      typeof window === "undefined" ? "" : window.location.search;
    const next = new URLSearchParams(browserSearch || (params?.toString() ?? ""));
    const activeAtClick = blocksEqualIgnoringId(
      decodeFilters(next.get("filters")).blocks,
      preset.filters_json.blocks ?? []
    );

    if (activeAtClick) {
      next.delete("filters");
    } else {
      // Raw JSON; URLSearchParams.toString() URL-encodes once.
      // Using encodeFilters() here would double-encode.
      next.set("filters", JSON.stringify(preset.filters_json));
    }
    const qs = next.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    // router.replace updates the URL, but in Next 16 the RSC tree (which
    // owns this chip's currentFilterStateRaw prop) only re-fetches when
    // refresh() runs. Without refresh(), aria-pressed lags behind the URL.
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
