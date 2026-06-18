"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { SkipTracePreflightDialog } from "@/components/skip-trace-preflight-dialog";

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
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-7 px-2 text-xs"
      >
        🔍 Skip trace
      </Button>
      <SkipTracePreflightDialog
        open={open}
        onOpenChange={setOpen}
        propertyIds={[propertyId]}
        onFinished={() => {
          setTimeout(() => router.refresh(), 2500);
        }}
      />
    </>
  );
}
