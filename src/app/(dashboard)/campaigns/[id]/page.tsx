import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { getOutboundSmsMetrics } from "@/lib/messages/message-metrics";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

import { CampaignCadenceControl } from "./campaign-cadence-control";
import {
  CampaignOperationsPanel,
  type CampaignJobSummary,
  type CampaignOperationsStats,
} from "./campaign-operations-panel";
import { CampaignScoreboard } from "./campaign-scoreboard";

export const metadata = {
  title: "Campaign Scoreboard · Sandra CRM",
};

type Campaign = Pick<
  Database["public"]["Tables"]["campaigns"]["Row"],
  | "id"
  | "org_id"
  | "name"
  | "status"
  | "archived_at"
  | "body"
  | "template_category"
  | "pace_seconds"
  | "created_at"
>;

type CampaignKpis = Database["public"]["Functions"]["campaign_kpis"]["Returns"][number];
type JobRow = Pick<
  Database["public"]["Tables"]["jobs"]["Row"],
  | "id"
  | "status"
  | "total_items"
  | "processed_items"
  | "succeeded_items"
  | "failed_items"
  | "error_message"
>;

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const campaignRes = await supabase
    .from("campaigns")
    .select(
      "id, org_id, name, status, archived_at, body, template_category, pace_seconds, created_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (campaignRes.error || !campaignRes.data) {
    notFound();
  }

  const campaign = campaignRes.data as Campaign;
  const [kpiRes, metricsRes, jobRes] = await Promise.all([
    supabase.rpc("campaign_kpis", { p_campaign_id: id }),
    getOutboundSmsMetrics(supabase, {
      scope: { campaignId: id, orgId: campaign.org_id },
    })
      .then((data) => ({ ok: true as const, data }))
      .catch((error: unknown) => ({ ok: false as const, error })),
    loadLatestCampaignBulkSmsJob(supabase, id),
  ]);
  const kpis = kpiRes.error ? null : normalizeKpis(kpiRes.data?.[0]);
  const liveStats = metricsRes.ok && kpis
    ? toOperationsStats({
        campaign,
        kpis,
        job: jobRes.job,
        metrics: metricsRes.data,
      })
    : null;
  const liveStatsError = !metricsRes.ok
    ? `Message metrics failed: ${formatUnknownError(metricsRes.error)}`
    : kpiRes.error
      ? `Campaign KPIs failed: ${kpiRes.error.message}`
      : "Unknown live stats error.";

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Campaigns", href: "/campaigns" },
          { label: campaign.name },
        ]}
        title={campaign.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {formatCampaignSetupBadge(campaign)}
            </Badge>
            <span>{describeCampaign(campaign)}</span>
          </span>
        }
      />

      {liveStats ? (
        <>
          <CampaignOperationsPanel stats={liveStats} />
          <CampaignCadenceControl
            campaignId={campaign.id}
            currentPaceSeconds={campaign.pace_seconds}
          />
        </>
      ) : (
        <div className="text-destructive text-sm">
          Failed to load live campaign send stats: {liveStatsError}
        </div>
      )}
      {jobRes.error ? (
        <div className="text-destructive text-sm">
          Failed to load queue-building job state: {jobRes.error}
        </div>
      ) : null}

      {kpiRes.error || !kpis ? (
        <div className="text-destructive text-sm">
          Failed to load campaign KPIs:{" "}
          {kpiRes.error?.message ?? "Unknown error"}
        </div>
      ) : (
        <CampaignScoreboard kpis={kpis} />
      )}
    </Page>
  );
}

async function loadLatestCampaignBulkSmsJob(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
): Promise<{ job: CampaignJobSummary | null; error: string | null }> {
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, status, total_items, processed_items, succeeded_items, failed_items, error_message",
    )
    .eq("type", "bulk_sms")
    .contains("input_params", { opts: { campaignId } })
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) return { job: null, error: error.message };
  const row = (data?.[0] ?? null) as JobRow | null;
  if (!row) return { job: null, error: null };

  return {
    job: {
      id: row.id,
      status: row.status,
      totalItems: row.total_items,
      processedItems: row.processed_items,
      succeededItems: row.succeeded_items,
      failedItems: row.failed_items,
      errorMessage: row.error_message,
    },
    error: null,
  };
}

function toOperationsStats(args: {
  campaign: Campaign;
  kpis: ReturnType<typeof normalizeKpis>;
  metrics: Awaited<ReturnType<typeof getOutboundSmsMetrics>>;
  job: CampaignJobSummary | null;
}): CampaignOperationsStats {
  return {
    campaignStatus: args.campaign.status,
    audience: args.kpis.audience,
    queued: args.metrics.queued,
    dueQueued: args.metrics.dueQueued,
    pending: args.metrics.pending,
    sent: args.metrics.sent,
    delivered: args.metrics.delivered,
    failed: args.metrics.failed,
    handedOff: args.metrics.handedOff,
    replied: args.kpis.replied,
    optedOut: args.kpis.opted_out,
    nextScheduledFor: args.metrics.nextScheduledFor,
    lastScheduledFor: args.metrics.lastScheduledFor,
    paceSeconds: args.campaign.pace_seconds,
    job: args.job,
  };
}

function normalizeKpis(input: CampaignKpis | undefined) {
  return {
    audience: Number(input?.audience ?? 0),
    attempted: Number(input?.attempted ?? 0),
    delivered: Number(input?.delivered ?? 0),
    delivered_rate: Number(input?.delivered_rate ?? 0),
    failed: Number(input?.failed ?? 0),
    failed_rate: Number(input?.failed_rate ?? 0),
    replied: Number(input?.replied ?? 0),
    reply_rate: Number(input?.reply_rate ?? 0),
    opted_out: Number(input?.opted_out ?? 0),
    opt_out_rate: Number(input?.opt_out_rate ?? 0),
  };
}

function describeCampaign(campaign: Campaign): string {
  const trimmedBody = campaign.body?.trim() ?? "";
  if (trimmedBody.length > 0) {
    return trimmedBody.length > 120
      ? `${trimmedBody.slice(0, 117)}...`
      : trimmedBody;
  }

  if (campaign.template_category?.trim()) {
    return `Template pool: ${campaign.template_category.trim()}`;
  }

  return `Created ${new Date(campaign.created_at).toLocaleDateString("en-US")}`;
}

function formatCampaignSetupBadge(campaign: Campaign): string {
  if (campaign.archived_at) return "Archived";
  switch (campaign.status) {
    case "completed":
      return "Queue setup: built";
    case "launching":
      return "Queue setup: building";
    case "active":
      return "Queue setup: not launched";
    case "failed":
      return "Queue setup: failed";
    default:
      return `Queue setup: ${campaign.status}`;
  }
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
