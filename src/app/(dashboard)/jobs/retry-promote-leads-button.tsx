"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { retryPromoteLeadsJob } from "../properties/promote-leads-actions";

export function RetryPromoteLeadsButton({
  jobId,
  retryableCount,
  inFlightChildId,
}: {
  jobId: string;
  retryableCount: number;
  inFlightChildId: string | null;
}) {
  const router = useRouter();
  const requestKey = useRef<string>(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (inFlightChildId) {
    return (
      <Link href={`/jobs/${inFlightChildId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
        Retry running…
      </Link>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || retryableCount === 0}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await callAction(
              retryPromoteLeadsJob({
                parentJobId: jobId,
                idempotencyKey: requestKey.current,
              }),
              { fallbackMessage: "Could not retry promotion" },
            );
            if (!result.ok) {
              setError(result.error.message);
              return;
            }
            router.push(`/jobs/${result.data.jobId}`);
            router.refresh();
          });
        }}
      >
        {pending ? "Starting retry…" : `Retry ${retryableCount.toLocaleString()} failed`}
      </Button>
      {error ? <span role="alert" className="text-destructive max-w-72 text-right text-xs">{error}</span> : null}
    </div>
  );
}
