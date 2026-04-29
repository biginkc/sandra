"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CASS_COST_PER_LOOKUP_USD,
  isAwaitingManualStart,
} from "@/lib/enrichment/cass-job";
import { callAction } from "@/lib/errors/call-action";
import {
  approveSkipTraceJob,
  denySkipTraceJob,
} from "@/lib/skip-trace/actions";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

import { retryFailedCassItems, startQueuedCassJob } from "./actions";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

// One credit per lookup at the batch normal rate. The vendor (currently
// Tracerfy) is configured in /admin/skip-trace-settings; UI copy below
// uses the capability label "skip-trace credits" so a vendor swap stays
// a config change rather than a UI relabel.
const SKIP_TRACE_CREDITS_PER_LEAD = 1;

export function JobsList({ isAdmin }: { isAdmin: boolean }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      // setAuth() must resolve BEFORE subscribing — otherwise the socket
      // opens as anon and RLS on `jobs` drops every event silently.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);

      if (!mounted) return;

      channel = supabase
        .channel("jobs:list")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "jobs" },
          (payload) => {
            if (payload.eventType === "INSERT") {
              setJobs((prev) => [payload.new as Job, ...prev].slice(0, 50));
            } else if (payload.eventType === "UPDATE") {
              setJobs((prev) =>
                prev.map((j) =>
                  j.id === (payload.new as Job).id ? (payload.new as Job) : j,
                ),
              );
            } else if (payload.eventType === "DELETE") {
              setJobs((prev) =>
                prev.filter((j) => j.id !== (payload.old as Job).id),
              );
            }
          },
        )
        .subscribe();

      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (!mounted) return;
      if (error) setError(error.message);
      else setJobs(data ?? []);
      setLoading(false);
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  if (loading) {
    return (
      <div className="text-muted-foreground text-sm">Loading jobs…</div>
    );
  }

  if (error) {
    return <div className="text-destructive text-sm">Error: {error}</div>;
  }

  return (
    <div className="border-border rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-muted-foreground py-8 text-center"
              >
                No jobs yet.
              </TableCell>
            </TableRow>
          ) : (
            jobs.map((job) => {
              const canStartCass =
                job.type === "cass_dsf2_ncoa" &&
                job.status === "queued" &&
                isAwaitingManualStart(job.result_summary);
              const canApproveSkipTrace =
                isAdmin &&
                job.type === "skip_trace" &&
                job.status === "pending_approval";
              const canRetryCass =
                job.type === "cass_dsf2_ncoa" &&
                (job.status === "partial" || job.status === "failed") &&
                job.failed_items > 0;
              return (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">
                    {job.title ?? job.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{job.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(job.status)}>
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {job.processed_items}/{job.total_items}
                    {job.failed_items > 0 && (
                      <span className="text-destructive">
                        {" "}
                        · {job.failed_items} failed
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDistanceToNow(new Date(job.created_at), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    {canStartCass ? (
                      <StartCassButton
                        jobId={job.id}
                        totalItems={job.total_items}
                      />
                    ) : null}
                    {canRetryCass ? (
                      <RetryCassButton
                        jobId={job.id}
                        failedItems={job.failed_items}
                      />
                    ) : null}
                    {canApproveSkipTrace ? (
                      <SkipTraceApproveButtons
                        jobId={job.id}
                        totalItems={job.total_items}
                      />
                    ) : null}
                    <Link
                      href={`/jobs/${job.id}`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      View details
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "partial") return "secondary";
  if (status === "canceled" || status === "denied") return "outline";
  return "secondary";
}

function SkipTraceApproveButtons({
  jobId,
  totalItems,
}: {
  jobId: string;
  totalItems: number;
}) {
  const [pending, startTransition] = useTransition();
  const estimatedCredits = totalItems * SKIP_TRACE_CREDITS_PER_LEAD;

  const onApprove = () => {
    if (
      !window.confirm(
        `Approve skip-trace for ${totalItems} propert${totalItems === 1 ? "y" : "ies"}? Estimated cost: ${estimatedCredits} skip-trace credit${estimatedCredits === 1 ? "" : "s"}.`,
      )
    )
      return;
    startTransition(async () => {
      await callAction(approveSkipTraceJob(jobId), {
        successMessage: "Skip-trace approved — running.",
        fallbackMessage: "Could not approve",
      });
    });
  };

  const onDeny = () => {
    const reason = window.prompt("Optional reason for denial:") ?? undefined;
    startTransition(async () => {
      await callAction(denySkipTraceJob(jobId, reason || undefined), {
        successMessage: "Skip-trace denied.",
        fallbackMessage: "Could not deny",
      });
    });
  };

  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="outline"
        size="sm"
        onClick={onDeny}
        disabled={pending}
      >
        Deny
      </Button>
      <Button size="sm" onClick={onApprove} disabled={pending}>
        Approve
      </Button>
    </div>
  );
}

function StartCassButton({
  jobId,
  totalItems,
}: {
  jobId: string;
  totalItems: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const estimatedCost = (totalItems * CASS_COST_PER_LOOKUP_USD).toFixed(2);

  const run = () => {
    startTransition(async () => {
      const result = await callAction(startQueuedCassJob(jobId), {
        successMessage: "CASS job started — progress will stream live.",
        fallbackMessage: "Failed to start CASS job",
      });
      if (result.ok) setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Start CASS
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start CASS verification?</DialogTitle>
          <DialogDescription>
            This will verify {totalItems} propert
            {totalItems === 1 ? "y" : "ies"} against SmartyStreets. Estimated
            cost: ${estimatedCost} ({totalItems} × $
            {CASS_COST_PER_LOOKUP_USD.toFixed(2)}/lookup). Cached addresses
            from prior imports count as $0.
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
            {pending ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetryCassButton({
  jobId,
  failedItems,
}: {
  jobId: string;
  failedItems: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      const result = await callAction(retryFailedCassItems(jobId), {
        successMessage: "Retry started — watch the new CASS job above.",
        fallbackMessage: "Failed to retry CASS items",
      });
      if (result.ok) setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Retry {failedItems.toLocaleString()} failed
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retry failed CASS verifications?</DialogTitle>
          <DialogDescription>
            Creates a fresh CASS job for the {failedItems.toLocaleString()}{" "}
            {failedItems === 1 ? "property" : "properties"} that previously
            failed. Already-verified addresses come from the cache (no new
            API calls); anything not in the cache costs $
            {CASS_COST_PER_LOOKUP_USD.toFixed(2)}/lookup.
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
