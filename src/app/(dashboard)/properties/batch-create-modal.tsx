"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

import {
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  previewBatchEligibilityAction,
} from "./actions";
import type { QueryOrigin } from "@/lib/prospects/search-scope";
import type { FilterBlock } from "./prospects-query";

type Counts = {
  callable: number;
  blocked: Record<string, number>;
  missing: number;
};

export type BatchCreateModalProps = {
  open: boolean;
  onClose: () => void;
  selectedIds?: string[];
  filterArgs?: {
    search?: string | null;
    blockStack: FilterBlock[];
    imported?: "today" | null;
    origin?: QueryOrigin;
  };
  /** 'search_page' makes the server report skipped leads for checkbox selections too. */
  origin?: QueryOrigin;
  totalCount: number;
  lockedExcludedCount?: number;
};

const EMPTY_BLOCK_STACK: FilterBlock[] = [];

function formatReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function totalBlocked(counts: Counts): number {
  return Object.values(counts.blocked).reduce((sum, count) => sum + count, 0);
}

function successMessage(batchId: string, counts: Counts): string {
  return `Batch ${batchId} created · ${counts.callable} callable / ${totalBlocked(counts)} blocked / ${counts.missing} missing`;
}

export function BatchCreateModal({
  open,
  onClose,
  selectedIds,
  filterArgs,
  origin,
  totalCount,
  lockedExcludedCount = 0,
}: BatchCreateModalProps) {
  const [title, setTitle] = useState("");
  const [counts, setCounts] = useState<Counts | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedIdsKey = useMemo(
    () => (selectedIds ?? []).join(","),
    [selectedIds],
  );
  const hasIds = Array.isArray(selectedIds) && selectedIds.length > 0;
  const hasFilters = filterArgs !== undefined;
  const mode: "ids" | "filters" | "error" = hasIds
    ? "ids"
    : hasFilters
      ? "filters"
      : "error";

  const filterSearch = filterArgs?.search ?? null;
  const filterBlockStack = filterArgs?.blockStack ?? EMPTY_BLOCK_STACK;
  const filterImported = filterArgs?.imported ?? null;
  const filterOrigin = filterArgs?.origin;
  const selectionOrigin = origin ?? filterArgs?.origin;
  const [skippedLeads, setSkippedLeads] = useState(0);
  const callabilityCounts = previewLoading || counts === null ? null : counts;
  const createDisabled =
    mode === "error" ||
    previewLoading ||
    pending ||
    !counts ||
    counts.callable === 0;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCounts(null);

    if (mode === "error") {
      setPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);

    async function loadPreview() {
      // Server-resolved preview: explicit ids are re-checked, a select-all-matching
      // sends only its filters (no id list round-trips through the client).
      const preview = await previewBatchEligibilityAction(
        mode === "ids"
          ? { ids: selectedIds ?? [], origin: selectionOrigin }
          : {
              filters: {
                search: filterSearch,
                blockStack: filterBlockStack,
                imported: filterImported,
                origin: filterOrigin,
              },
            },
      );
      if (cancelled) return;

      if (preview.ok) {
        const { skippedLeads: skipped = 0, ...rest } = preview.data;
        setSkippedLeads(skipped);
        setCounts(rest);
      } else {
        setError(preview.error.message);
      }
      setPreviewLoading(false);
    }

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [filterBlockStack, filterImported, filterOrigin, filterSearch, mode, open, selectedIds, selectedIdsKey, selectionOrigin]);

  const handleCreate = () => {
    if (createDisabled) return;

    const cleanTitle = title.trim() || undefined;
    setError(null);
    startTransition(async () => {
      const result =
        mode === "ids"
          ? await createDialerBatchFromPropertyIds(selectedIds ?? [], {
              sourceKind: "selected_ids",
              title: cleanTitle,
              origin: selectionOrigin,
            })
          : await createDialerBatchFromFilters({
              search: filterSearch,
              blockStack: filterBlockStack,
              imported: filterImported,
              title: cleanTitle,
              origin: filterOrigin,
            });

      if (result.ok) {
        const skipped = (result.data as { skippedLeads?: number }).skippedLeads ?? 0;
        toast.success(
          `${successMessage(result.data.batchId, result.data.counts)}${skipped > 0 ? ` · ${skipped} lead${skipped === 1 ? "" : "s"} skipped` : ""}`,
        );
        onClose();
      } else {
        setError(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create dialer batch</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {mode === "filters" ? "All matching prospects" : "Selected prospects"}
                </p>
                <p className="text-muted-foreground text-xs">
                  {mode === "filters"
                    ? `${totalCount.toLocaleString()} eligible from current filters`
                    : `${(selectedIds?.length ?? 0).toLocaleString()} selected`}
                </p>
                {skippedLeads > 0 && (
                  <p className="text-muted-foreground text-xs" data-testid="batch-skipped-leads">
                    {skippedLeads.toLocaleString()} lead{skippedLeads === 1 ? "" : "s"} skipped (dialer batches use prospects only)
                  </p>
                )}
                {lockedExcludedCount > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {lockedExcludedCount.toLocaleString()} DNC locked and excluded
                  </p>
                )}
              </div>
              <span className="rounded-md border bg-background px-2 py-1 font-mono text-xs">
                {mode === "filters" ? "Filters" : mode === "ids" ? "IDs" : "No selection"}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="dialer-batch-title" className="text-sm font-medium">
              Batch title
            </label>
            <input
              id="dialer-batch-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Optional"
              className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <section className="space-y-3" aria-label="Eligibility preview">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Callability preview</h3>
              {previewLoading ? (
                <span className="text-muted-foreground text-xs">
                  Checking callability...
                </span>
              ) : null}
            </div>

            {mode === "error" ? (
              <p className="text-destructive text-sm" role="alert">
                Select prospects or apply a filter to create a batch.
              </p>
            ) : null}

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
                <div className="text-lg font-semibold">
                  {previewLoading ? (
                    <Skeleton
                      aria-hidden="true"
                      className="mr-1 inline-block h-6 w-8 align-middle"
                    />
                  ) : callabilityCounts ? (
                    callabilityCounts.callable
                  ) : (
                    "—"
                  )} callable
                </div>
                <p className="text-xs opacity-80">ready now</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                <div className="text-lg font-semibold">
                  {previewLoading ? (
                    <Skeleton
                      aria-hidden="true"
                      className="mr-1 inline-block h-6 w-8 align-middle"
                    />
                  ) : callabilityCounts ? (
                    totalBlocked(callabilityCounts)
                  ) : (
                    "—"
                  )} blocked
                </div>
                <p className="text-xs opacity-80">current rules</p>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="text-lg font-semibold">
                  {previewLoading ? (
                    <Skeleton
                      aria-hidden="true"
                      className="mr-1 inline-block h-6 w-8 align-middle"
                    />
                  ) : callabilityCounts ? (
                    callabilityCounts.missing
                  ) : (
                    "—"
                  )} missing phone
                </div>
                <p className="text-muted-foreground text-xs">no number</p>
              </div>
            </div>

            {counts && Object.keys(counts.blocked).length > 0 ? (
              <ul
                aria-label="Blocked reasons"
                className="text-muted-foreground grid gap-1 text-xs"
              >
                {Object.entries(counts.blocked).map(([reason, count]) => (
                  <li key={reason}>
                    {formatReason(reason)}: {count}
                  </li>
                ))}
              </ul>
            ) : null}

            {counts?.callable === 0 ? (
              <p className="text-amber-700 text-sm dark:text-amber-300">
                No callable phones — adjust selection or filters.
              </p>
            ) : null}
          </section>

          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={createDisabled}>
            {pending ? "Creating..." : "Create batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
