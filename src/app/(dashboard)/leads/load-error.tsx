"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

export function LeadsLoadError() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div
      className="border-border bg-card flex min-h-72 flex-col items-center justify-center rounded-2xl border p-8 text-center"
      role="alert"
    >
      <h2 className="text-lg font-bold">We couldn&apos;t load your leads</h2>
      <p className="text-muted-foreground mt-2 max-w-md text-sm">
        The pipeline is temporarily unavailable. No leads were changed.
      </p>
      <Button
        className="mt-5"
        disabled={isPending}
        onClick={() => startTransition(() => router.refresh())}
      >
        <RefreshCwIcon data-icon="inline-start" />
        {isPending ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}
