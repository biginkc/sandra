"use client";

import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "List updated · Refresh": shown when a background read changed the membership or order of the list while
 * the rep is looking at it (design v8 section 6). Refresh swaps in the new page.
 */
export type ListUpdatedBannerProps = {
  /** A refresh is in flight. */
  refreshing?: boolean;
  onRefresh: () => void;
};

export function ListUpdatedBanner({ refreshing = false, onRefresh }: ListUpdatedBannerProps) {
  return (
    <div
      role="status"
      data-testid="work-list-updated"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
    >
      <span className="font-semibold">List updated</span>
      <span aria-hidden="true">·</span>
      <Button type="button" variant="link" size="xs" className="h-auto px-0 text-sm" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw className={refreshing ? "animate-spin" : undefined} aria-hidden="true" />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  );
}

/**
 * One-line notice after the rep acts on a row and its new placement is outside the current tab and chip
 * ("Moved to Waiting on them"). The container supplies the sentence and removes it after a while or on dismiss.
 */
export type RowRemovedNoticeProps = {
  message: string;
  onDismiss?: () => void;
};

export function RowRemovedNotice({ message, onDismiss }: RowRemovedNoticeProps) {
  return (
    <div
      role="status"
      data-testid="work-row-removed"
      className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      <span className="min-w-0 flex-1">{message}</span>
      {onDismiss && (
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss notice" onClick={onDismiss}>
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
