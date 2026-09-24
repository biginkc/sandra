"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { SkipTracePreflightDialog } from "@/components/skip-trace-preflight-dialog";
import { Button } from "@/components/ui/button";

import {
  preflightProspectSkipTrace,
  requestProspectSkipTrace,
} from "../properties/dnc-safe-actions";

/**
 * Starts the normal DNC- and CASS-gated skip-trace preflight for exactly the
 * IDs persisted on a completed CASS job. This deliberately never derives an
 * audience from market, search, or the currently visible table page.
 */
export function CassSkipTraceButton({ propertyIds }: { propertyIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [launchState, setLaunchState] = useState<
    "started" | "pending_approval" | null
  >(null);
  const router = useRouter();

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={propertyIds.length === 0 || launchState !== null}
      >
        {launchState === "started"
          ? "Skip-trace started"
          : launchState === "pending_approval"
            ? "Skip-trace awaiting approval"
            : "Prepare exact cohort for skip-trace"}
      </Button>
      <SkipTracePreflightDialog
        open={open}
        onOpenChange={setOpen}
        propertyIds={propertyIds}
        title="Skip-trace exact CASS cohort"
        launchButtonLabel="Start skip-trace"
        launchFallbackMessage="Could not start skip-trace for this CASS cohort"
        onPreflight={preflightProspectSkipTrace}
        onLaunchSkipTrace={() => requestProspectSkipTrace(propertyIds)}
        onLaunchSuccess={(data) => {
          const status =
            data &&
            typeof data === "object" &&
            "status" in data &&
            typeof data.status === "string"
              ? data.status
              : null;
          if (status === "none_eligible") {
            toast.info("No exact-cohort records are eligible for skip-trace.");
          } else if (status === "pending_approval") {
            setLaunchState("pending_approval");
            toast.success("Exact-cohort skip-trace is awaiting approval.");
          } else {
            setLaunchState("started");
            toast.success("Exact-cohort skip-trace started.");
          }
          if (
            data &&
            typeof data === "object" &&
            "jobId" in data &&
            typeof data.jobId === "string"
          ) {
            router.push(`/jobs/${data.jobId}`);
          }
          router.refresh();
        }}
      />
    </>
  );
}
