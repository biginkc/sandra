"use client";

import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";

export function LeadLoadFailure({
  title,
  detail,
  testId = "lead-load-failure",
}: {
  title: string;
  detail: string;
  testId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div
      className="border-destructive/40 bg-destructive/5 flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
      data-testid={testId}
    >
      <div className="flex min-w-0 gap-3">
        <AlertTriangleIcon className="text-destructive mt-0.5 size-5 shrink-0" />
        <div>
          <div className="text-foreground text-sm font-bold">{title}</div>
          <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
        className="min-h-11 w-full sm:min-h-8 sm:w-auto"
      >
        <RotateCcwIcon className="size-3.5" />
        {pending ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
