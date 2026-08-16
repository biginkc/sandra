"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  createPromoteLeadsJob,
  preflightPromoteLeads,
  type PromoteLeadsPreflight,
} from "./promote-leads-actions";

export function PromoteLeadsDialog({
  open,
  onOpenChange,
  orgId,
  propertyIds,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  propertyIds: string[];
  onStarted: (jobId: string) => void;
}) {
  const propertyIdsKey = useMemo(() => [...propertyIds].sort().join(","), [propertyIds]);
  const [preflight, setPreflight] = useState<PromoteLeadsPreflight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startStatus, setStartStatus] = useState<string | null>(null);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let canceled = false;
    preflightPromoteLeads({ orgId, propertyIds }).then((result) => {
      if (canceled) return;
      if (result.ok) setPreflight(result.data);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [open, orgId, propertyIds, propertyIdsKey]);

  const confirm = () => {
    if (!preflight || preflight.eligible === 0 || !requestKey || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await createPromoteLeadsJob({
        orgId,
        propertyIds,
        idempotencyKey: requestKey,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setJobId(result.data.jobId);
      setStartStatus(result.data.status);
      onStarted(result.data.jobId);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Promote selected Prospects to Leads?</DialogTitle>
          <DialogDescription>
            This runs in the background. You can leave this page and follow exact results in Jobs.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground rounded-lg border p-4 text-sm">Checking the current selection…</div>
        ) : preflight ? (
          <div className="grid grid-cols-2 gap-3" aria-label="Promotion eligibility">
            <Count label="selected" value={preflight.selected} />
            <Count label="eligible" value={preflight.eligible} tone="positive" />
            <Count label="permanently DNC locked" value={preflight.dncLocked} />
            <Count label="stale or already a Lead" value={preflight.staleOrNotProspect} />
          </div>
        ) : null}

        <p className="text-muted-foreground text-xs">
          Permanently DNC-locked records stay in Prospects. Every item is checked again immediately before it moves.
        </p>

        {error ? (
          <div role="alert" className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm">
            {error}
          </div>
        ) : null}

        {jobId ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            <p className="font-medium">
              {startStatus === "failed_to_start"
                ? "The job was saved, but the background run could not start."
                : startStatus === "completed"
                  ? "Promotion finished. No background work was needed."
                : "Promotion started in the background."}
            </p>
            <Link href={`/jobs/${jobId}`} className={`${buttonVariants({ variant: "outline", size: "sm" })} mt-3`}>
              View progress
            </Link>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          {!jobId ? (
            <Button
              onClick={confirm}
              disabled={loading || pending || !preflight || preflight.eligible === 0}
            >
              {pending
                ? "Starting…"
                : preflight?.eligible
                  ? `Promote ${preflight.eligible.toLocaleString()} to Leads`
                  : "No eligible prospects"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Count({
  value,
  label,
  tone = "neutral",
}: {
  value: number;
  label: string;
  tone?: "neutral" | "positive";
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className={tone === "positive" ? "text-emerald-700" : "text-foreground"}>
        <span className="font-mono text-lg font-bold">{value.toLocaleString()}</span>{" "}
        <span className="text-sm">{label}</span>
      </div>
    </div>
  );
}
