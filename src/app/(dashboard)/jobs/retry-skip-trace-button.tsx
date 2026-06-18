"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SkipTracePreflightDialog } from "@/components/skip-trace-preflight-dialog";
import { Button, buttonVariants } from "@/components/ui/button";

import { retryFailedSkipTraceItems } from "./actions";

export function RetrySkipTraceButton({
  jobId,
  propertyIds,
  retryCount,
  noDataCount = 0,
  cassUnverifiedCount = 0,
  inFlightChildId,
}: {
  jobId: string;
  propertyIds: string[];
  /** Properties that will be retried (only retryable error classes; or all from input_params for pre-#59 jobs). */
  retryCount: number;
  /** Errored items classified as terminal "vendor has no data." Shown as a sub-message. */
  noDataCount?: number;
  /** Errored items needing CASS verification before they can be skip-traced. Shown as a sub-message. */
  cassUnverifiedCount?: number;
  /** If a child retry is already queued/running, lock the button and link to it. */
  inFlightChildId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (inFlightChildId) {
    return (
      <Link
        href={`/jobs/${inFlightChildId}`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Retry running…
      </Link>
    );
  }

  // Summary of excluded categories shown beneath the button. Empty
  // when nothing's been excluded — keeps the UI quiet on the happy
  // path where every error is retryable.
  const excludedSummary = (() => {
    const parts: string[] = [];
    if (noDataCount > 0) {
      parts.push(
        `${noDataCount} confirmed no-data`,
      );
    }
    if (cassUnverifiedCount > 0) {
      parts.push(
        `${cassUnverifiedCount} need${cassUnverifiedCount === 1 ? "s" : ""} CASS verification`,
      );
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={propertyIds.length === 0}
        >
          Retry {retryCount.toLocaleString()} retryable
        </Button>
        {excludedSummary ? (
          <span className="text-muted-foreground text-xs">
            {excludedSummary}
          </span>
        ) : null}
      </div>
      <SkipTracePreflightDialog
        open={open}
        onOpenChange={setOpen}
        propertyIds={propertyIds}
        title="Retry skip-trace preflight"
        launchButtonLabel="Retry skip-trace"
        launchSuccessMessage="Retry started - opening the new job..."
        launchFallbackMessage="Failed to retry skip-trace"
        onLaunchSkipTrace={() => retryFailedSkipTraceItems(jobId)}
        onLaunchSuccess={(data) => {
          if (
            data &&
            typeof data === "object" &&
            "childJobId" in data &&
            typeof data.childJobId === "string"
          ) {
            router.push(`/jobs/${data.childJobId}`);
          }
          router.refresh();
        }}
      />
    </>
  );
}
