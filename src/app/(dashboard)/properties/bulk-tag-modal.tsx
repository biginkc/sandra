"use client";

import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import {
  createAndApplyCustomTagBulk,
  createAndApplyCustomTagBulkFromFilters,
  type BulkOutcome,
} from "./dnc-safe-actions";
import type { FilterBlock } from "./prospects-query";
import type { TagOption } from "./prospects-table";

type Props = {
  open: boolean;
  propertyIds: string[];
  filterArgs?: {
    search?: string | null;
    blockStack: FilterBlock[];
    imported?: "today" | null;
  };
  tags: TagOption[];
  allMatching: boolean;
  totalCount: number;
  onClose: () => void;
  onApplied: (outcome: BulkOutcome) => void;
};

export function BulkTagModal({
  open,
  propertyIds,
  filterArgs,
  tags,
  allMatching,
  totalCount,
  onClose,
  onApplied,
}: Props) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmed = query.trim();
  const matchingTags = useMemo(() => {
    const needle = trimmed.toLowerCase();
    return tags
      .filter((tag) => (needle ? tag.name.toLowerCase().includes(needle) : true))
      .slice(0, 6);
  }, [tags, trimmed]);
  const exactMatch = useMemo(
    () =>
      trimmed
        ? tags.find((tag) => tag.name.toLowerCase() === trimmed.toLowerCase())
        : null,
    [tags, trimmed],
  );

  const audienceLabel = allMatching
    ? `All ${totalCount.toLocaleString()} matching prospects`
    : `${propertyIds.length.toLocaleString()} selected prospect${propertyIds.length === 1 ? "" : "s"}`;
  const submitLabel = exactMatch
    ? `Apply #${exactMatch.name}`
    : trimmed
      ? `Create #${trimmed} and apply`
      : "Create/apply tag";
  const submitDisabled =
    pending ||
    (!allMatching && propertyIds.length === 0) ||
    (allMatching && filterArgs === undefined) ||
    trimmed.length === 0 ||
    trimmed.length > 60;

  const submit = (name: string) => {
    const cleanName = name.trim();
    if (
      !cleanName ||
      pending ||
      (!allMatching && propertyIds.length === 0) ||
      (allMatching && filterArgs === undefined)
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const action = allMatching
        ? createAndApplyCustomTagBulkFromFilters({
            name: cleanName,
            color: null,
            search: filterArgs?.search ?? null,
            blockStack: filterArgs?.blockStack ?? [],
            imported: filterArgs?.imported ?? null,
          })
        : createAndApplyCustomTagBulk({
            name: cleanName,
            color: null,
            propertyIds,
          });
      const result = await callAction(action, {
        fallbackMessage: "Could not apply tag",
      });
      if (result.ok) {
        setQuery("");
        onApplied(result.data.outcome);
        onClose();
      } else {
        setError(result.error.message);
      }
    });
  };

  const handleClose = () => {
    if (pending) return;
    setError(null);
    setQuery("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create/apply tag</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-sm font-medium">{audienceLabel}</p>
            <p className="text-muted-foreground text-xs">
              This tag will be applied to the current selection.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="bulk-tag-name" className="text-sm font-medium">
              Tag name
            </label>
            <input
              id="bulk-tag-name"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setError(null);
              }}
              placeholder="Probate follow-up"
              className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              maxLength={80}
              autoFocus
            />
            {trimmed.length > 60 ? (
              <p className="text-destructive text-xs">
                Tag names are capped at 60 characters.
              </p>
            ) : null}
          </div>

          {tags.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Existing custom tags</p>
              {matchingTags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {matchingTags.map((tag) => (
                    <button
                      type="button"
                      key={tag.id}
                      onClick={() => submit(tag.name)}
                      disabled={pending}
                      className="border-input hover:bg-muted rounded-md border px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      #{tag.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No existing custom tags match.
                </p>
              )}
            </div>
          ) : null}

          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="items-stretch sm:grid sm:grid-cols-[auto_minmax(0,1fr)]">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={() => submit(trimmed)}
            disabled={submitDisabled}
            title={pending ? "Applying..." : submitLabel}
            className="min-w-0 max-w-full overflow-hidden px-4 sm:w-full sm:shrink"
          >
            <span className="block min-w-0 max-w-full truncate">
              {pending ? "Applying..." : submitLabel}
            </span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
