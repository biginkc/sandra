"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import { SortableHeader } from "@/components/table/sortable-header";
import {
  TableToolbar,
  TableToolbarFilterPill,
  TableToolbarSearch,
} from "@/components/table/table-toolbar";
import {
  useTableUrlState,
  type ParsedTableSearch,
  type SortDirection,
  type UseTableUrlStateReturn,
} from "@/components/table/use-table-url-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DataTableFooter,
  DataTableShell,
} from "@/components/ui/data-table-shell";
import { SkipTracePreflightDialog } from "@/components/skip-trace-preflight-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAwaitingManualStart } from "@/lib/enrichment/cass-job-state";
import { callAction } from "@/lib/errors/call-action";
import { CASS_COST_PER_LOOKUP_USD } from "@/lib/provider-pricing";
import { denySkipTraceJob } from "@/lib/skip-trace/actions";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import {
  JOB_STATUS_LABELS,
  JOB_TYPE_LABELS,
  jobDisplayTitle,
  systemLabel,
} from "@/lib/presentation/system-labels";

import { retryFailedCassItems, startQueuedCassJob } from "./actions";
import type { JobStatus, JobsFilters, JobsSortableColumn } from "./page";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

const JOBS_SORTABLE_COLUMNS = [
  "title",
  "type",
  "status",
  "created_at",
] as const;

const BUILD_CONFIG = {
  defaultSort: "created_at" as const,
  defaultDir: "desc" as SortDirection,
  sortableColumns: JOBS_SORTABLE_COLUMNS,
  buildFilterParams: (filters: Partial<JobsFilters>, sp: URLSearchParams) => {
    if (filters.status) sp.set("status", filters.status);
  },
};

export function JobsList({
  isAdmin,
  parsed,
}: {
  isAdmin: boolean;
  parsed: ParsedTableSearch<JobsFilters>;
}) {
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

  // URL-state in client mode: realtime is the source of truth (D-06), the
  // URL is mirrored for back-button + sharable links (D-07). 50-row cap
  // means ?page= is decorative (D-08). Hook MUST be called unconditionally
  // before any early return to satisfy the rules-of-hooks contract.
  const ts = useTableUrlState<JobsFilters>({
    basePath: "/jobs",
    parsed,
    mode: "client",
    config: BUILD_CONFIG,
  });

  // Apply URL state in-memory over the realtime jobs array. Recomputes
  // whenever jobs mutates (realtime INSERT/UPDATE/DELETE) OR URL state
  // changes — Pitfall 5 protection. An INSERT during navPending mutates
  // `jobs`; the next render re-runs this useMemo and the visible slice
  // reflects both the new row and the active filter.
  const visibleJobs = useMemo(() => {
    const q = ts.search.toLowerCase().trim();
    let result = jobs.slice();

    if (q.length > 0) {
      result = result.filter(
        (j) =>
          (j.title ?? "").toLowerCase().includes(q) ||
          j.id.slice(0, 8).toLowerCase().includes(q),
      );
    }

    if (ts.filters.status) {
      result = result.filter((j) => j.status === ts.filters.status);
    }

    // Sort. Realtime initial query is created_at desc, so the default case
    // is a no-op; anything else needs an explicit sort.
    const sortKey = ts.sort as JobsSortableColumn;
    const ascending = ts.dir === "asc";
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "title") {
        const at = (a.title ?? a.id.slice(0, 8)).toLowerCase();
        const bt = (b.title ?? b.id.slice(0, 8)).toLowerCase();
        cmp = at.localeCompare(bt);
      } else if (sortKey === "created_at") {
        cmp =
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      } else {
        // type, status — string sort
        const av = (a as Record<string, unknown>)[sortKey];
        const bv = (b as Record<string, unknown>)[sortKey];
        cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      }
      return ascending ? cmp : -cmp;
    });

    return result;
  }, [jobs, ts.search, ts.sort, ts.dir, ts.filters.status]);

  // Status filter pill click: cycles between the clicked status and null.
  // FilterPill is a binary toggle by design (Plan 01-02), so we render
  // multiple pills and treat the URL ?status= as a single-select.
  const onStatusPillClick = (next: JobStatus) => {
    const newStatus = ts.filters.status === next ? null : next;
    ts.navigate(
      `/jobs${ts.buildHref({
        page: 1,
        search: ts.search === "" ? null : ts.search,
        sort: ts.sort,
        dir: ts.dir,
        filters: { status: newStatus },
      })}`,
    );
  };

  if (loading) {
    return <div className="text-muted-foreground text-sm">Loading jobs…</div>;
  }

  if (error) {
    return <div className="text-destructive text-sm">Error: {error}</div>;
  }

  return (
    <>
      <TableToolbar
        state={ts as unknown as UseTableUrlStateReturn<Record<string, unknown>>}
      >
        <TableToolbarSearch
          ariaLabel="Search jobs by title or id"
          placeholder="Search jobs…"
          testId="jobs-search"
        />
        {/* Compact filter row — most-used statuses surfaced as pills.
            The other four (completed/partial/canceled/denied) round-trip
            through ?status= but require manual URL editing — acceptable
            for Phase 1. */}
        <TableToolbarFilterPill
          active={ts.filters.status === "queued"}
          onClick={() => onStatusPillClick("queued")}
          testId="jobs-filter-queued"
        >
          Queued
        </TableToolbarFilterPill>
        <TableToolbarFilterPill
          active={ts.filters.status === "running"}
          onClick={() => onStatusPillClick("running")}
          testId="jobs-filter-running"
        >
          Running
        </TableToolbarFilterPill>
        <TableToolbarFilterPill
          active={ts.filters.status === "failed"}
          onClick={() => onStatusPillClick("failed")}
          testId="jobs-filter-failed"
        >
          Failed
        </TableToolbarFilterPill>
        <TableToolbarFilterPill
          active={ts.filters.status === "pending_approval"}
          onClick={() => onStatusPillClick("pending_approval")}
          testId="jobs-filter-pending_approval"
        >
          Pending approval
        </TableToolbarFilterPill>
      </TableToolbar>

      <DataTableShell
        data-pending={ts.navPending}
        data-testid="jobs-table-container"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader<JobsSortableColumn>
                column="title"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="jobs"
              >
                Title
              </SortableHeader>
              <SortableHeader<JobsSortableColumn>
                column="type"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="jobs"
              >
                Type
              </SortableHeader>
              <SortableHeader<JobsSortableColumn>
                column="status"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="jobs"
              >
                Status
              </SortableHeader>
              <TableHead>Progress</TableHead>
              <SortableHeader<JobsSortableColumn>
                column="created_at"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="jobs"
              >
                Created
              </SortableHeader>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ts.navPending ? (
              Array.from({ length: Math.max(visibleJobs.length, 5) }).map(
                (_, i) => (
                  <TableRow
                    key={`skeleton-${i}`}
                    data-testid="jobs-skeleton-row"
                  >
                    <TableCell>
                      <Skeleton className="h-4 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-8 w-20" />
                    </TableCell>
                  </TableRow>
                ),
              )
            ) : visibleJobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-8 text-center"
                >
                  {jobs.length === 0
                    ? "No jobs yet."
                    : "No jobs match the current filter."}
                </TableCell>
              </TableRow>
            ) : (
              visibleJobs.map((job) => {
                const cassSummary =
                  (job.result_summary as Record<string, unknown> | null) ?? {};
                const cassRetryable =
                  typeof cassSummary.retryableFailures === "number"
                    ? cassSummary.retryableFailures
                    : job.failed_items;
                const cassManual =
                  typeof cassSummary.manualReconciliation === "number"
                    ? cassSummary.manualReconciliation
                    : 0;
                const canStartCass =
                  job.type === "cass_dsf2_ncoa" &&
                  job.status === "queued" &&
                  isAwaitingManualStart(job.result_summary);
                const canApproveSkipTrace =
                  isAdmin &&
                  job.type === "skip_trace" &&
                  job.status === "pending_approval";
                const rawSkipTracePropertyIds = (
                  job.input_params as { property_ids?: unknown } | null
                )?.property_ids;
                const skipTracePropertyIds = Array.isArray(
                  rawSkipTracePropertyIds,
                )
                  ? rawSkipTracePropertyIds.filter(
                      (id): id is string => typeof id === "string",
                    )
                  : [];
                const canRetryCass =
                  job.type === "cass_dsf2_ncoa" &&
                  ["partial", "partially_completed", "failed"].includes(
                    job.status,
                  ) &&
                  cassRetryable > 0;
                return (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">
                      {jobDisplayTitle({
                        title: job.title,
                        type: job.type,
                        createdAt: job.created_at,
                      })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {systemLabel(JOB_TYPE_LABELS, job.type)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(job.status)}>
                        {systemLabel(JOB_STATUS_LABELS, job.status)}
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
                      {job.type === "cass_dsf2_ncoa" && cassRetryable > 0 ? (
                        <span> · {cassRetryable} retryable</span>
                      ) : null}
                      {job.type === "cass_dsf2_ncoa" && cassManual > 0 ? (
                        <span> · {cassManual} needs review</span>
                      ) : null}
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
                          failedItems={cassRetryable}
                        />
                      ) : null}
                      {canApproveSkipTrace ? (
                        <SkipTraceApproveButtons
                          jobId={job.id}
                          propertyIds={skipTracePropertyIds}
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
        <DataTableFooter>
          <span className="text-muted-foreground text-sm">
            {visibleJobs.length} of {jobs.length} job
            {jobs.length === 1 ? "" : "s"}
          </span>
        </DataTableFooter>
      </DataTableShell>
    </>
  );
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "partial" || status === "partially_completed")
    return "secondary";
  if (status === "canceled" || status === "denied") return "outline";
  return "secondary";
}

function SkipTraceApproveButtons({
  jobId,
  propertyIds,
}: {
  jobId: string;
  propertyIds: string[];
}) {
  const [pending, startTransition] = useTransition();
  const [preflightOpen, setPreflightOpen] = useState(false);

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
      <Button variant="outline" size="sm" onClick={onDeny} disabled={pending}>
        Deny
      </Button>
      <Button
        size="sm"
        onClick={() => setPreflightOpen(true)}
        disabled={pending || propertyIds.length === 0}
      >
        Approve
      </Button>
      <SkipTracePreflightDialog
        open={preflightOpen}
        onOpenChange={setPreflightOpen}
        propertyIds={propertyIds}
        approveJobId={jobId}
      />
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
            {CASS_COST_PER_LOOKUP_USD.toFixed(2)}/lookup). Cached addresses from
            prior imports count as $0.
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
            failed. Saved provider responses and cached addresses replay with no
            new charge; only addresses without saved output cost $
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
