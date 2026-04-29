"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import { retryFailedSkipTraceItems } from "./actions";

const TRACERFY_USD_PER_CREDIT = 0.02;

export function RetrySkipTraceButton({
  jobId,
  retryCount,
  inFlightChildId,
}: {
  jobId: string;
  /** Properties that will be retried (errored items, or all from input_params for pre-#59 jobs). */
  retryCount: number;
  /** If a child retry is already queued/running, lock the button and link to it. */
  inFlightChildId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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

  const cost = (retryCount * TRACERFY_USD_PER_CREDIT).toFixed(2);

  const run = () => {
    startTransition(async () => {
      const result = await callAction(retryFailedSkipTraceItems(jobId), {
        successMessage: "Retry started — opening the new job…",
        fallbackMessage: "Failed to retry skip-trace",
      });
      if (result.ok) {
        setOpen(false);
        router.push(`/jobs/${result.data.childJobId}`);
        router.refresh();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Retry {retryCount.toLocaleString()}{" "}
            {retryCount === 1 ? "property" : "properties"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retry skip-trace?</DialogTitle>
          <DialogDescription>
            Creates a fresh skip-trace job for{" "}
            {retryCount.toLocaleString()}{" "}
            {retryCount === 1 ? "property" : "properties"}. Estimated cost:{" "}
            ${cost} ({retryCount} × ${TRACERFY_USD_PER_CREDIT.toFixed(2)} per
            lookup). Cached addresses cost $0.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={run} disabled={pending}>
            {pending ? "Starting…" : "Retry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
