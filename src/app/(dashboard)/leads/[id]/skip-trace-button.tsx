"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { requestSkipTrace } from "@/lib/skip-trace/actions";

/**
 * Per-property skip-trace trigger for the lead-detail page header chip
 * row. Calls the same `requestSkipTrace` action as the bulk surface —
 * single-element list. The job runner picks the sync (lookupSingle)
 * path automatically when len===1, so admins see the result in <2s.
 *
 * Hidden by the parent server component when there's already fresh
 * cached skip-trace data for this property.
 */
export function SkipTraceButton({ propertyId }: { propertyId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    startTransition(async () => {
      const result = await callAction(requestSkipTrace([propertyId]), {
        fallbackMessage: "Could not request skip trace",
      });
      if (!result.ok) return;
      if (result.data.status === "queued") {
        toast.success("Skip-trace started", {
          description: "Refresh in a few seconds for results",
        });
      } else {
        toast.success("Skip-trace request sent", {
          description: "Admin will approve on /jobs",
        });
      }
      // The sync path can finish in ~2s; refresh after a short delay so
      // the new phones land. Async/approval paths are no-ops on refresh.
      setTimeout(() => router.refresh(), 2500);
    });
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={pending}
      className="h-7 px-2 text-xs"
    >
      {pending ? "Requesting…" : "🔍 Skip trace"}
    </Button>
  );
}
