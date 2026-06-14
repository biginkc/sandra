import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

import { CampaignScoreboard } from "./campaign-scoreboard";

export const metadata = {
  title: "Campaign Scoreboard · Sandra CRM",
};

type Campaign = Pick<
  Database["public"]["Tables"]["campaigns"]["Row"],
  "id" | "name" | "status" | "archived_at" | "body" | "template_category" | "created_at"
>;

type CampaignKpis = Database["public"]["Functions"]["campaign_kpis"]["Returns"][number];

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [campaignRes, kpiRes] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name, status, archived_at, body, template_category, created_at")
      .eq("id", id)
      .maybeSingle(),
    supabase.rpc("campaign_kpis", { p_campaign_id: id }),
  ]);

  if (campaignRes.error || !campaignRes.data) {
    notFound();
  }

  const campaign = campaignRes.data as Campaign;
  const kpis = normalizeKpis(kpiRes.data?.[0]);

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
            <Badge variant="secondary">{campaign.archived_at ? "archived" : campaign.status}</Badge>
            <span>{describeCampaign(campaign)}</span>
          </span>
        }
      />

      {kpiRes.error ? (
        <div className="text-destructive text-sm">
          Failed to load campaign KPIs: {kpiRes.error.message}
        </div>
      ) : (
        <CampaignScoreboard kpis={kpis} />
      )}
    </Page>
  );
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
