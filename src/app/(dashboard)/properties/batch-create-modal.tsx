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

import {
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  getAllMatchingProspectIds,
  previewBatchEligibilityAction,
} from "./actions";
import type { ParsedProspectsFilters } from "./prospects-query";

type Counts = {
  callable: number;
  blocked: Record<string, number>;
  missing: number;
};

export type BatchCreateModalProps = {
  open: boolean;
  onClose: () => void;
  selectedIds?: string[];
  filterArgs?: { search?: string | null; filters?: ParsedProspectsFilters };
  totalCount: number;
};

const EMPTY_FILTERS: ParsedProspectsFilters = {
  vacant: false,
  cass: null,
  engagement: null,
  market: null,
  assignee: null,
};

function formatReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function totalBlocked(counts: Counts | null): number {
  return counts
    ? Object.values(counts.blocked).reduce((sum, count) => sum + count, 0)
    : 0;
}

function successMessage(batchId: string, counts: Counts): string {
  return `Batch ${batchId} created · ${counts.callable} callable / ${totalBlocked(counts)} blocked / ${counts.missing} missing`;
}

export function BatchCreateModal({
  open,
  onClose,
  selectedIds,
  filterArgs,
  totalCount,
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
  const filterValues = filterArgs?.filters ?? EMPTY_FILTERS;
  const blockedTotal = totalBlocked(counts);
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
      const idsResult =
        mode === "ids"
          ? { ok: true as const, data: selectedIds ?? [] }
          : await getAllMatchingProspectIds({
              search: filterSearch,
              filters: filterValues,
            });

      if (cancelled) return;
      if (!idsResult.ok) {
        setError(idsResult.error.message);
        setPreviewLoading(false);
        return;
      }

      const preview = await previewBatchEligibilityAction(idsResult.data);
      if (cancelled) return;

      if (preview.ok) {
        setCounts(preview.data);
      } else {
        setError(preview.error.message);
      }
      setPreviewLoading(false);
    }

    loadPreview();
    return () => {
      cancelled = true;
    };
  }, [filterSearch, filterValues, mode, open, selectedIds, selectedIdsKey]);

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
            })
          : await createDialerBatchFromFilters({
              search: filterSearch,
              filters: filterValues,
              title: cleanTitle,
            });

      if (result.ok) {
        toast.success(successMessage(result.data.batchId, result.data.counts));
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
                    ? `${totalCount.toLocaleString()} matching current filters`
                    : `${(selectedIds?.length ?? 0).toLocaleString()} selected`}
                </p>
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
                <p className="text-lg font-semibold">
                  {counts?.callable ?? 0} callable
                </p>
                <p className="text-xs opacity-80">ready now</p>
              </div>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="text-lg font-semibold">{blockedTotal} blocked</p>
                <p className="text-xs opacity-80">current rules</p>
              </div>
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="text-lg font-semibold">
                  {counts?.missing ?? 0} missing phone
                </p>
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
