"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Database } from "@/lib/supabase/types";

import { RetrySkipTraceButton } from "../retry-skip-trace-button";
import { RetryPromoteLeadsButton } from "../retry-promote-leads-button";
import { RetryCsvImportButton } from "../retry-csv-import-button";

type Job = Database["public"]["Tables"]["jobs"]["Row"];
type JobItem = Database["public"]["Tables"]["job_items"]["Row"];
type CsvImport = Pick<
  Database["public"]["Tables"]["csv_imports"]["Row"],
  | "id"
  | "filename"
  | "source"
  | "market"
  | "total_rows"
  | "inserted_properties"
  | "skipped_duplicates"
  | "failed_rows"
  | "storage_path"
>;

export type BulkSmsJobMetrics = {
  queued: number;
  dueQueued: number;
  pending: number;
  sent: number;
  delivered: number;
  failed: number;
  handedOff: number;
  nextScheduledFor: string | null;
  lastScheduledFor: string | null;
};

export type JobDetailProps = {
  job: Job;
  items: JobItem[];
  parent: {
    id: string;
    type: string;
    status: string;
    title: string | null;
  } | null;
  /** Renamed from `children` to avoid shadowing React's reserved prop name. */
  childJobs: {
    id: string;
    type: string;
    status: string;
    title: string | null;
  }[];
  csvImport: CsvImport | null;
  bulkSmsMetrics?: BulkSmsJobMetrics | null;
  bulkSmsMetricsError?: string | null;
  promotionRetryableCount?: number | null;
  csvRetryAvailable?: boolean;
};

export function JobDetail({
  job,
  items,
  parent,
  childJobs,
  csvImport,
  bulkSmsMetrics = null,
  bulkSmsMetricsError = null,
  promotionRetryableCount: exactPromotionRetryableCount = null,
  csvRetryAvailable = false,
}: JobDetailProps) {
  const router = useRouter();
  const promotionRunning =
    job.type === "promote_leads" &&
    ["queued", "running", "processing", "finalizing"].includes(job.status);
  useEffect(() => {
    if (!promotionRunning) return;
    const interval = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(interval);
  }, [promotionRunning, router]);

  const skippedFromCount = Math.max(
    0,
    (job.processed_items ?? 0) -
      (job.succeeded_items ?? 0) -
      (job.failed_items ?? 0),
  );

  // Skip-trace retry — categorize errored items so the user can see
  // which are retryable, which are confirmed no-data (terminal), and
  // which need CASS verification first.
  const RETRYABLE_CLASSES = new Set([
    "provider_transient",
    "provider_unknown",
    "provider", // legacy
    "database",
    "internal",
    "transient",
  ]);
  const isSkipTraceRetryable =
    job.type === "skip_trace" &&
    ["failed", "partial", "partially_completed"].includes(job.status);
  const erroredItems = items.filter((i) => i.status === "error");
  const hasErroredItems = erroredItems.length > 0;
  const noDataCount = erroredItems.filter(
    (i) => i.error_class === "provider_no_data",
  ).length;
  const cassUnverifiedCount = erroredItems.filter(
    (i) => i.error_class === "address_unverified",
  ).length;
  const itemRetryableCount = erroredItems.filter(
    (i) =>
      i.error_class === null || RETRYABLE_CLASSES.has(i.error_class as string),
  ).length;
  const itemRetryablePropertyIds = erroredItems
    .filter(
      (i) =>
        i.error_class === null ||
        RETRYABLE_CLASSES.has(i.error_class as string),
    )
    .map((i) => i.property_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const fallbackPropertyIds = (() => {
    const ids = (job.input_params as { property_ids?: unknown } | null)
      ?.property_ids;
    return Array.isArray(ids)
      ? ids.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  })();
  const fallbackPropertyCount = (() => {
    return fallbackPropertyIds.length;
  })();
  // When we have items, use the retryable-only count; otherwise fall back
  // to input_params (pre-#59 jobs that never wrote items at all).
  const retryCount = hasErroredItems
    ? itemRetryableCount
    : fallbackPropertyCount;
  const retryPropertyIds = hasErroredItems
    ? itemRetryablePropertyIds
    : fallbackPropertyIds;
  const inFlightChild =
    childJobs.find(
      (c) =>
        c.type === "skip_trace" &&
        (c.status === "queued" ||
          c.status === "running" ||
          c.status === "processing" ||
          c.status === "finalizing"),
    ) ?? null;
  const showRetry = isSkipTraceRetryable && retryCount > 0;
  const promotionRetryableCount =
    exactPromotionRetryableCount ??
    items.filter(
      (item) =>
        item.status === "error" &&
        isRecord(item.output_payload) &&
        item.output_payload.retryable === true,
    ).length;
  const isPromotionRetryable =
    job.type === "promote_leads" &&
    ["failed", "partial", "partially_completed"].includes(job.status) &&
    promotionRetryableCount > 0;
  const inFlightPromotionChild =
    childJobs.find(
      (child) =>
        child.type === "promote_leads" &&
        ["queued", "running", "processing", "finalizing"].includes(
          child.status,
        ),
    ) ?? null;
  const isCsvRetryable =
    csvRetryAvailable &&
    job.type === "csv_import" &&
    ["failed", "partial", "partially_completed"].includes(job.status) &&
    !["validation", "authorization"].includes(job.error_class ?? "");

  return (
    <div className="flex flex-col gap-6">
      {/* Sub-header strip with status + duration + provider, with retry on the right */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
          <span>{durationLabel(job)}</span>
          {job.provider && <span>via {job.provider}</span>}
        </div>
        {showRetry ? (
          <RetrySkipTraceButton
            jobId={job.id}
            propertyIds={retryPropertyIds}
            retryCount={retryCount}
            noDataCount={noDataCount}
            cassUnverifiedCount={cassUnverifiedCount}
            inFlightChildId={inFlightChild?.id ?? null}
          />
        ) : isPromotionRetryable ? (
          <RetryPromoteLeadsButton
            jobId={job.id}
            retryableCount={promotionRetryableCount}
            inFlightChildId={inFlightPromotionChild?.id ?? null}
          />
        ) : isCsvRetryable ? (
          <RetryCsvImportButton jobId={job.id} />
        ) : null}
      </div>

      {/* KPI tiles — universal */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile
          label="Processed"
          value={`${job.processed_items}/${job.total_items}`}
        />
        <Tile
          label="Succeeded"
          value={(job.succeeded_items ?? 0).toLocaleString()}
          tone="positive"
        />
        <Tile
          label="Failed"
          value={(job.failed_items ?? 0).toLocaleString()}
          tone={job.failed_items > 0 ? "destructive" : "neutral"}
        />
        <Tile
          label="Skipped"
          value={skippedFromCount.toLocaleString()}
          tone="neutral"
        />
      </div>

      {/* Type-specific panel */}
      <TypePanel
        job={job}
        csvImport={csvImport}
        bulkSmsMetrics={bulkSmsMetrics}
        bulkSmsMetricsError={bulkSmsMetricsError}
      />

      {/* Linked jobs */}
      {(parent || childJobs.length > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Linked jobs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {parent && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground w-16">Parent</span>
                <LinkedJobLine job={parent} />
              </div>
            )}
            {childJobs.length > 0 && (
              <div className="flex items-start gap-2 text-sm">
                <span className="text-muted-foreground w-16 pt-0.5">
                  Children
                </span>
                <div className="flex flex-col gap-1">
                  {childJobs.map((c) => (
                    <LinkedJobLine key={c.id} job={c} />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Job items + audit (tabbed) */}
      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">
            Items (
            {items.length < job.total_items
              ? `showing ${items.length.toLocaleString()} of ${job.total_items.toLocaleString()}`
              : items.length.toLocaleString()}
            )
          </TabsTrigger>
          <TabsTrigger value="audit">Audit / raw</TabsTrigger>
        </TabsList>
        <TabsContent value="items" className="mt-4">
          <ItemsTable items={items} totalItems={job.total_items} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditPanel job={job} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------- KPI tile ---------------------------------------------------------

function Tile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "destructive";
}) {
  return (
    <div
      className={cn(
        "border-border bg-card rounded-2xl border px-5 py-4",
        tone === "destructive" && "border-destructive/40 bg-destructive/5",
        tone === "positive" &&
          "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/5",
      )}
    >
      <div
        className={cn(
          "text-[11px] font-bold tracking-widest uppercase",
          tone === "destructive"
            ? "text-destructive"
            : tone === "positive"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <div className="text-foreground mt-1 text-3xl font-extrabold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}

// ---------- Type-specific panels --------------------------------------------

function TypePanel({
  job,
  csvImport,
  bulkSmsMetrics,
  bulkSmsMetricsError,
}: {
  job: Job;
  csvImport: CsvImport | null;
  bulkSmsMetrics: BulkSmsJobMetrics | null;
  bulkSmsMetricsError: string | null;
}) {
  switch (job.type) {
    case "csv_import":
      return <CsvImportPanel job={job} csvImport={csvImport} />;
    case "csv_update":
      return <CsvUpdatePanel job={job} />;
    case "cass_dsf2_ncoa":
    case "cass_refresh":
    case "ncoa_refresh":
      return <CassPanel job={job} />;
    case "skip_trace":
      return <SkipTracePanel job={job} />;
    case "bulk_sms":
      return (
        <BulkSmsPanel
          job={job}
          metrics={bulkSmsMetrics}
          metricsError={bulkSmsMetricsError}
        />
      );
    case "promote_leads":
      return <PromoteLeadsPanel job={job} />;
    default:
      return <DefaultPanel job={job} />;
  }
}

function PromoteLeadsPanel({ job }: { job: Job }) {
  const counts = promotionCounts(job.result_summary);
  return (
    <Card data-testid="promote-leads-job-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Promotion results</CardTitle>
        <CardDescription>
          Permanently DNC-locked records stay in Prospects and count as safe
          skips, not failures.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0 md:grid-cols-5">
        <DetailRow label="Promoted" value={counts.promoted.toLocaleString()} />
        <DetailRow
          label="Already Leads"
          value={counts.alreadyLead.toLocaleString()}
        />
        <DetailRow
          label="Became permanently DNC"
          value={counts.dncLocked.toLocaleString()}
        />
        <DetailRow
          label="Stale or missing"
          value={counts.missing.toLocaleString()}
        />
        <DetailRow label="Failed" value={counts.failed.toLocaleString()} />
      </CardContent>
    </Card>
  );
}

function promotionCounts(summary: Job["result_summary"]): {
  promoted: number;
  alreadyLead: number;
  dncLocked: number;
  missing: number;
  failed: number;
} {
  const value = isRecord(summary) ? summary : {};
  const count = (key: string) =>
    typeof value[key] === "number" ? (value[key] as number) : 0;
  return {
    promoted: count("promoted"),
    alreadyLead: count("already_lead"),
    dncLocked: count("dnc_locked"),
    missing: count("missing"),
    failed: count("failed"),
  };
}

function CsvImportPanel({
  job,
  csvImport,
}: {
  job: Job;
  csvImport: CsvImport | null;
}) {
  const params = (job.input_params as Record<string, unknown> | null) ?? {};
  const mapping = (params.mapping as Record<string, string | null>) ?? {};
  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Import details</CardTitle>
        <CardDescription>
          {csvImport?.filename ??
            (params.filename as string | undefined) ??
            "—"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 pt-0 sm:grid-cols-2">
        <DetailRow label="Source" value={(params.source as string) ?? "—"} />
        <DetailRow label="Market" value={(params.market as string) ?? "—"} />
        <DetailRow
          label="Mapped columns"
          value={`${mappedCount} field${mappedCount === 1 ? "" : "s"}`}
        />
        <DetailRow
          label="Storage"
          value={
            csvImport?.storage_path
              ? `csv-imports/${csvImport.storage_path}`
              : ((params.storagePath as string) ?? "—")
          }
          mono
        />
        {csvImport && (
          <>
            <DetailRow
              label="Inserted"
              value={`${csvImport.inserted_properties ?? 0}`}
            />
            <DetailRow
              label="Skipped (dup)"
              value={`${csvImport.skipped_duplicates ?? 0}`}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CsvUpdatePanel({ job }: { job: Job }) {
  const params = (job.input_params as Record<string, unknown> | null) ?? {};
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Update details</CardTitle>
        <CardDescription>{(params.filename as string) ?? "—"}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 pt-0 sm:grid-cols-2">
        <DetailRow
          label="Operation"
          value={(params.subOperationId as string) ?? "—"}
        />
        <DetailRow
          label="Rows in file"
          value={`${(params.rowCount as number) ?? "—"}`}
        />
      </CardContent>
    </Card>
  );
}

function CassPanel({ job }: { job: Job }) {
  const summary =
    (job.result_summary as Record<string, number | null> | null) ?? {};
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">CASS verification</CardTitle>
        <CardDescription>
          USPS-grade address verification via {job.provider ?? "(no provider)"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0 md:grid-cols-4">
        <DetailRow label="Verified" value={`${summary.verified ?? 0}`} />
        <DetailRow label="Invalid" value={`${summary.invalid ?? 0}`} />
        <DetailRow label="Ambiguous" value={`${summary.ambiguous ?? 0}`} />
        <DetailRow label="Cache hits" value={`${summary.cacheHits ?? 0}`} />
      </CardContent>
    </Card>
  );
}

function SkipTracePanel({ job }: { job: Job }) {
  const summary = (job.result_summary as Record<string, unknown> | null) ?? {};
  const params = (job.input_params as Record<string, unknown> | null) ?? {};
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Skip-trace</CardTitle>
        <CardDescription>
          Owner phone/email lookup via {job.provider ?? "(no provider)"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 pt-0 md:grid-cols-3">
        <DetailRow
          label="Hit"
          value={`${(summary.hits as number | undefined) ?? "—"}`}
        />
        <DetailRow
          label="No match"
          value={`${(summary.no_matches as number | undefined) ?? "—"}`}
        />
        <DetailRow
          label="Credits used"
          value={`${(summary.credits_used as number | undefined) ?? "—"}`}
        />
        <DetailRow
          label="Provider run id"
          value={(job.provider_run_id ?? "—") as string}
          mono
        />
        <DetailRow
          label="Trace type"
          value={(params.trace_type as string) ?? "normal"}
        />
        {(summary.cached_hits as number | undefined) !== undefined && (
          <DetailRow label="Cache hits" value={`${summary.cached_hits ?? 0}`} />
        )}
      </CardContent>
    </Card>
  );
}

function BulkSmsPanel({
  job,
  metrics,
  metricsError,
}: {
  job: Job;
  metrics: BulkSmsJobMetrics | null;
  metricsError: string | null;
}) {
  const campaignId = extractBulkSmsCampaignId(job.input_params);

  return (
    <Card data-testid="bulk-sms-job-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Bulk SMS send progress</CardTitle>
        <CardDescription>
          Job status tracks queue-building. Message delivery can continue after
          the job is completed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pt-0">
        {campaignId ? (
          <Link
            href={`/campaigns/${campaignId}`}
            className="text-primary text-sm font-semibold hover:underline"
          >
            Open campaign live progress
          </Link>
        ) : (
          <div className="text-muted-foreground text-sm">
            This legacy bulk SMS job was not stamped with a campaign id.
          </div>
        )}

        {metricsError ? (
          <div className="text-destructive text-sm">
            Failed to load SMS send metrics: {metricsError}
          </div>
        ) : metrics ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <DetailRow
              label="Queued to send"
              value={metrics.queued.toLocaleString()}
            />
            <DetailRow
              label="Due now"
              value={metrics.dueQueued.toLocaleString()}
            />
            <DetailRow
              label="Pending provider result"
              value={metrics.pending.toLocaleString()}
            />
            <DetailRow
              label="Handed to provider"
              value={metrics.handedOff.toLocaleString()}
            />
            <DetailRow
              label="Sent, not delivered"
              value={metrics.sent.toLocaleString()}
            />
            <DetailRow
              label="Delivered"
              value={metrics.delivered.toLocaleString()}
            />
            <DetailRow label="Failed" value={metrics.failed.toLocaleString()} />
            <DetailRow
              label="Next send"
              value={formatNextRelease(metrics.nextScheduledFor)}
            />
            <DetailRow
              label="Drain ETA"
              value={formatDrainEta(metrics.lastScheduledFor)}
            />
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">
            SMS send metrics are available once a campaign id is present.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DefaultPanel({ job }: { job: Job }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{job.type}</CardTitle>
        <CardDescription>
          No type-specific view registered yet — see Audit tab below for the raw
          input/result.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          "text-foreground text-sm",
          mono && "font-mono text-xs break-all",
        )}
      >
        {value || "—"}
      </div>
    </div>
  );
}

// ---------- Items table ------------------------------------------------------

function ItemsTable({
  items,
  totalItems,
}: {
  items: JobItem[];
  totalItems: number;
}) {
  const [filter, setFilter] = useState<"all" | "error" | "skipped" | "success">(
    "all",
  );

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((i) => i.status === filter);
  }, [items, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
    return c;
  }, [items]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm">Items</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={filter === "all"}
              label={`All ${items.length.toLocaleString()}`}
              onClick={() => setFilter("all")}
            />
            {counts.error > 0 && (
              <FilterChip
                active={filter === "error"}
                label={`Errors ${counts.error.toLocaleString()}`}
                tone="destructive"
                onClick={() => setFilter("error")}
              />
            )}
            {counts.skipped > 0 && (
              <FilterChip
                active={filter === "skipped"}
                label={`Skipped ${counts.skipped.toLocaleString()}`}
                onClick={() => setFilter("skipped")}
              />
            )}
            {counts.success > 0 && (
              <FilterChip
                active={filter === "success"}
                label={`Success ${counts.success.toLocaleString()}`}
                tone="positive"
                onClick={() => setFilter("success")}
              />
            )}
          </div>
        </div>
        <CardDescription>
          {items.length < totalItems
            ? items.length === 0
              ? `No item-level rows are available; exact totals for all ${totalItems.toLocaleString()} items are shown above.`
              : `Showing first ${items.length.toLocaleString()} of ${totalItems.toLocaleString()}; exact outcome totals are shown above.`
            : `${filtered.length.toLocaleString()} item${filtered.length === 1 ? "" : "s"}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="border-border rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead>Property / Contact</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Badge variant={itemStatusVariant(item.status)}>
                      {item.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    {item.property_id ? (
                      <Link
                        href={`/leads/${item.property_id}`}
                        className="hover:underline"
                      >
                        {item.property_id.slice(0, 8)}…
                      </Link>
                    ) : item.contact_id ? (
                      <span className="text-muted-foreground font-mono text-xs">
                        contact: {item.contact_id.slice(0, 8)}…
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <div className="flex flex-col items-start gap-1">
                      {item.error_class ? (
                        <Badge
                          variant={errorClassVariant(item.error_class)}
                          className="text-xs"
                        >
                          {errorClassLabel(item.error_class)}
                        </Badge>
                      ) : null}
                      {item.error_message ? (
                        <span>{item.error_message}</span>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="text-muted-foreground py-6 text-center"
                  >
                    No items match the current filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  active,
  label,
  onClick,
  tone,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  tone?: "destructive" | "positive";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground hover:bg-muted",
        !active && tone === "destructive" && "text-destructive",
        !active &&
          tone === "positive" &&
          "text-emerald-700 dark:text-emerald-400",
      )}
    >
      {label}
    </button>
  );
}

// ---------- Audit panel ------------------------------------------------------

function AuditPanel({ job }: { job: Job }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Timeline</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0 text-sm">
          <DetailRow label="Created" value={fmt(job.created_at)} mono />
          <DetailRow
            label="Started"
            value={fmt(job.started_at as string | null)}
            mono
          />
          <DetailRow
            label="Completed"
            value={fmt(job.completed_at as string | null)}
            mono
          />
          <DetailRow
            label="Last heartbeat"
            value={fmt(job.worker_heartbeat_at as string | null)}
            mono
          />
        </CardContent>
      </Card>

      {(job.error_message || job.error_class) && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-destructive text-sm">Error</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0 text-sm">
            <DetailRow label="Class" value={job.error_class ?? "—"} />
            <DetailRow label="Message" value={job.error_message ?? "—"} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Raw input_params</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <pre className="bg-muted/30 max-h-96 overflow-auto rounded-md p-3 text-xs">
            {JSON.stringify(job.input_params ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Raw result_summary</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <pre className="bg-muted/30 max-h-96 overflow-auto rounded-md p-3 text-xs">
            {JSON.stringify(job.result_summary ?? {}, null, 2)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Helpers ----------------------------------------------------------

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

function itemStatusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "success") return "default";
  if (status === "error") return "destructive";
  if (status === "skipped") return "secondary";
  return "outline";
}

/**
 * Human-readable label for a job_items.error_class value. Defaults to
 * the raw value for unknown classes so the UI doesn't go silent on a
 * legacy or future code we haven't taught it yet.
 */
function errorClassLabel(klass: string): string {
  switch (klass) {
    case "provider_no_data":
      return "No data at vendor";
    case "address_unverified":
      return "CASS unverified";
    case "provider_transient":
      return "Vendor transient";
    case "provider_unknown":
      return "Vendor error";
    case "provider":
      return "Vendor error"; // legacy
    case "database":
      return "Database error";
    case "internal":
      return "Internal error";
    case "transient":
      return "Transient";
    case "configuration":
      return "Config error";
    case "validation":
      return "Validation";
    case "authorization":
      return "Authorization";
    default:
      return klass;
  }
}

function errorClassVariant(
  klass: string,
): "default" | "secondary" | "destructive" | "outline" {
  // Terminal classes look distinct from retryable ones — use outline
  // so they read "informational, no action" rather than alarming.
  if (klass === "provider_no_data" || klass === "address_unverified") {
    return "outline";
  }
  return "secondary";
}

function durationLabel(job: Job): string {
  if (!job.started_at) return "not started";
  const end = job.completed_at ?? new Date().toISOString();
  const ms =
    new Date(end as string).getTime() -
    new Date(job.started_at as string).getTime();
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `ran ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `ran ${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `ran ${hr}h ${min % 60}m`;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function extractBulkSmsCampaignId(
  inputParams: Job["input_params"],
): string | null {
  if (!isRecord(inputParams)) return null;
  const opts = inputParams.opts;
  if (!isRecord(opts)) return null;
  return typeof opts.campaignId === "string" && opts.campaignId.trim()
    ? opts.campaignId.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatNextRelease(iso: string | null): string {
  if (!iso) return "none queued";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "now";
  const diffS = Math.round(diffMs / 1000);
  if (diffS < 60) return `in ${diffS}s`;
  return `in ${Math.round(diffS / 60)}m`;
}

function formatDrainEta(iso: string | null): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "draining now";
  if (diffMs < 60_000) return "<1m";
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function LinkedJobLine({
  job,
}: {
  job: { id: string; type: string; status: string; title: string | null };
}) {
  return (
    <Link
      href={`/jobs/${job.id}`}
      className="hover:bg-muted/40 -mx-1 flex items-center gap-2 rounded px-1 py-0.5 transition-colors"
    >
      <Badge variant="outline" className="text-xs">
        {job.type}
      </Badge>
      <Badge variant={statusVariant(job.status)} className="text-xs">
        {job.status}
      </Badge>
      <span className="text-foreground truncate">
        {job.title ?? job.id.slice(0, 8)}
      </span>
    </Link>
  );
}
