import { createClient } from "@/lib/supabase/server";
import { QuickFilterChip, type Preset } from "./quick-filter-chip";

export type QuickFiltersBarProps = {
  orgId: string;
  currentFilterStateRaw: string | null;
};

/**
 * Server component (RSC) — fetches saved_filters scoped to this org under
 * the user's JWT (RLS handles read isolation per D-16 and D-19).
 *
 * Query returns: rows where is_base = true OR (user_id = auth.uid() AND
 * starred = true), scoped to org_id to avoid cross-org base-preset leaks
 * when a user belongs to multiple orgs.
 *
 * No "use client" directive — this is intentionally an RSC so it can call
 * createClient() directly and avoid waterfall fetches in the page layout.
 */
export default async function QuickFiltersBar({
  orgId,
  currentFilterStateRaw,
}: QuickFiltersBarProps) {
  if (!orgId) return null;

  const sb = await createClient();

  const { data, error } = await sb
    .from("saved_filters")
    .select("id, name, filters_json, starred, is_base")
    .eq("org_id", orgId)
    .or("is_base.eq.true,starred.eq.true")
    .order("is_base", { ascending: false })
    .order("name", { ascending: true });

  if (error) {
    console.error("[QuickFiltersBar] failed to load presets:", error.message);
    return (
      <div className="text-xs text-muted-foreground">
        Failed to load Quick Filters.
      </div>
    );
  }

  const presets = (data ?? []) as Preset[];
  if (presets.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 items-center" data-quick-filters-bar>
      <span className="text-xs text-muted-foreground mr-1">Quick Filters:</span>
      {presets.map((p) => (
        <QuickFilterChip
          key={p.id}
          preset={p}
          orgId={orgId}
          currentFilterStateRaw={currentFilterStateRaw}
        />
      ))}
    </div>
  );
}
