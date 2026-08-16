import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getOutboundSmsMetrics } from "@/lib/messages/message-metrics";
import { createClient } from "@/lib/supabase/server";
import type { Database, Json } from "@/lib/supabase/types";

import { JobDetail, type BulkSmsJobMetrics } from "./job-detail";

export const metadata = {
  title: "Job · Sandra CRM",
};

type Job = Database["public"]["Tables"]["jobs"]["Row"];
type JobItem = Database["public"]["Tables"]["job_items"]["Row"];

const ITEM_PAGE_SIZE = 200;

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (jobErr || !job) {
    notFound();
  }

  const bulkSmsCampaignId =
    job.type === "bulk_sms" ? extractBulkSmsCampaignId(job.input_params) : null;

  // Fetch related rows in parallel — items, parent, children, csv_imports
  // metadata when applicable. Each query is small + indexed; no need to
  // chain them.
  const [itemsRes, parentRes, childrenRes, csvImportRes, smsMetricsRes, promotionRetryableRes] =
    await Promise.all([
      supabase
        .from("job_items")
        .select("*")
        .eq("job_id", id)
        .order("status")
        .limit(ITEM_PAGE_SIZE),
      job.parent_job_id
        ? supabase
            .from("jobs")
            .select("id, type, status, title")
            .eq("id", job.parent_job_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("jobs")
        .select("id, type, status, title")
        .eq("parent_job_id", id)
        .order("created_at", { ascending: false }),
      job.related_import_id
        ? supabase
            .from("csv_imports")
            .select(
              "id, filename, source, market, total_rows, inserted_properties, skipped_duplicates, failed_rows, storage_path",
            )
            .eq("id", job.related_import_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      bulkSmsCampaignId
        ? getOutboundSmsMetrics(supabase, {
            scope: { campaignId: bulkSmsCampaignId, orgId: job.org_id },
          })
            .then((data) => ({ data, error: null }))
            .catch((error: unknown) => ({
              data: null,
              error: error instanceof Error ? error.message : "Unknown error",
            }))
        : Promise.resolve({ data: null, error: null }),
      job.type === "promote_leads"
        ? supabase
            .from("job_items")
            .select("id", { count: "exact", head: true })
            .eq("job_id", id)
            .eq("status", "error")
            .contains("output_payload", { retryable: true })
        : Promise.resolve({ count: null, error: null }),
    ]);

  if (itemsRes.error) {
    throw new Error(`Could not load job items: ${itemsRes.error.message}`);
  }
  if (job.type === "promote_leads" && promotionRetryableRes.error) {
    throw new Error(
      `Could not load exact promotion retry count: ${promotionRetryableRes.error.message}`,
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Jobs", href: "/jobs" },
          { label: shortenForCrumb(job) },
        ]}
        title={job.title ?? job.id.slice(0, 8)}
        description={`${job.type} · ${humanizeAge(job.created_at)}`}
      />

      <JobDetail
        job={job as Job}
        items={(itemsRes.data ?? []) as JobItem[]}
        parent={parentRes.data ?? null}
        childJobs={childrenRes.data ?? []}
        csvImport={csvImportRes.data ?? null}
        bulkSmsMetrics={toBulkSmsJobMetrics(smsMetricsRes.data)}
        bulkSmsMetricsError={smsMetricsRes.error}
        promotionRetryableCount={promotionRetryableRes.count}
      />
    </Page>
  );
}

function extractBulkSmsCampaignId(inputParams: Json | null): string | null {
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

function toBulkSmsJobMetrics(
  metrics: Awaited<ReturnType<typeof getOutboundSmsMetrics>> | null,
): BulkSmsJobMetrics | null {
  if (!metrics) return null;
  return {
    queued: metrics.queued,
    dueQueued: metrics.dueQueued,
    pending: metrics.pending,
    sent: metrics.sent,
    delivered: metrics.delivered,
    failed: metrics.failed,
    handedOff: metrics.handedOff,
    nextScheduledFor: metrics.nextScheduledFor,
    lastScheduledFor: metrics.lastScheduledFor,
  };
}

function shortenForCrumb(job: Job): string {
  if (job.title) {
    return job.title.length > 50 ? `${job.title.slice(0, 47)}…` : job.title;
  }
  return job.id.slice(0, 8);
}

function humanizeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
