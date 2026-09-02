import Link from "next/link";

import { getCallerMemberships } from "@/lib/auth/memberships";
import { loadTeamMembersForOrgs } from "@/lib/auth/team-roster";
import { createClient } from "@/lib/supabase/server";
import {
  buildTableHref,
  parseTableSearch,
  type SortDirection,
} from "@/components/table/use-table-url-state.helpers";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import type { BlockOptions } from "@/app/(dashboard)/properties/_components/blocks/_block-shell";

import {
  CampaignsTable,
  type CampaignRow,
  type CampaignsFilters,
} from "./campaigns-table";
import { CreateCampaignForm } from "./create-campaign-form";

export const metadata = {
  title: "Campaigns · Sandra CRM",
};

const PAGE_SIZE = 50;

export const CAMPAIGNS_SORTABLE_COLUMNS = [
  "name",
  "status",
  "created_at",
] as const;

type CampaignStatus =
  "active" | "launching" | "paused" | "completed" | "failed" | "archived";

const CAMPAIGNS_BUILD_CONFIG = {
  defaultSort: "created_at" as const,
  defaultDir: "desc" as SortDirection,
  buildFilterParams: (
    filters: Partial<CampaignsFilters>,
    sp: URLSearchParams,
  ) => {
    if (filters.archived) sp.set("archived", "1");
  },
};

const PIPELINE_STATUSES = [
  "prospect",
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];

const MOTIVATION_LEVELS = ["hot", "warm", "cold"];

const OUTREACH_DISPOS = [
  "wrong_number",
  "bad_number",
  "not_interested",
  "opted_out",
  "dnc",
  "nurture",
  "callback_requested",
  "needs_sequence",
];

const SOURCES = [
  "dealmachine",
  "propstream",
  "titlepro",
  "reisift",
  "agent_outreach",
  "driving_for_dollars",
  "referral",
  "cold_call",
  "sms",
  "web_form",
  "direct_mail",
];

function summarizeAudience(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return "No audience saved";
  }

  const raw = snapshot as {
    search?: unknown;
    filters?: { search?: unknown; blockStack?: unknown };
    blockStack?: unknown;
  };
  const filterSource =
    raw.filters &&
    typeof raw.filters === "object" &&
    !Array.isArray(raw.filters)
      ? raw.filters
      : raw;
  const blockStack = Array.isArray(filterSource.blockStack)
    ? filterSource.blockStack
    : [];
  const search =
    typeof filterSource.search === "string" &&
    filterSource.search.trim().length > 0
      ? filterSource.search.trim()
      : null;

  const parts: string[] = [];
  if (search) parts.push(`search "${search}"`);
  if (blockStack.length > 0) {
    parts.push(
      `${blockStack.length} filter${blockStack.length === 1 ? "" : "s"}`,
    );
  }

  return parts.length > 0 ? parts.join(" + ") : "No audience saved";
}

function summarizeMessage(
  body: string | null,
  templateCategory: string | null,
): string {
  const trimmedBody = body?.trim() ?? "";
  if (trimmedBody.length > 0) {
    return trimmedBody.length > 90
      ? `${trimmedBody.slice(0, 87)}...`
      : trimmedBody;
  }
  if (templateCategory?.trim()) {
    return `Template pool: ${templateCategory.trim()}`;
  }
  return "No message saved";
}

async function loadBlockOptions(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<BlockOptions> {
  const memberships = await getCallerMemberships();
  const orgIds = memberships.map((membership) => membership.org_id);
  const assigneesPromise =
    orgIds.length > 0
      ? loadTeamMembersForOrgs(orgIds, { includeInactiveMembers: true })
      : Promise.resolve([]);

  const [countyResult, stateResult, listResult, tagResult, assignees] =
    await Promise.all([
      supabase
        .from("counties")
        .select("market")
        .order("market", { ascending: true }),
      supabase
        .from("properties")
        .select("state")
        .is("deleted_at", null)
        .not("state", "is", null),
      supabase
        .from("lists")
        .select("id, name, color, archived_at, system_managed")
        .is("archived_at", null)
        .order("system_managed", { ascending: false })
        .order("name", { ascending: true }),
      supabase
        .from("tags")
        .select("id, name, color")
        .eq("category", "custom")
        .eq("system_managed", false)
        .order("name", { ascending: true }),
      assigneesPromise,
    ]);

  const markets: string[] = (countyResult.data ?? []).map((c) => c.market);
  const states: string[] = Array.from(
    new Set(
      (stateResult.data ?? [])
        .map((row) => row.state)
        .filter(Boolean) as string[],
    ),
  ).sort();
  const listRows = listResult.data;
  const tagRows = tagResult.data;

  return {
    lists: (listRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? undefined,
    })),
    tags: (tagRows ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color ?? undefined,
    })),
    markets,
    states,
    assignees,
    sources: SOURCES,
    pipelineStatuses: PIPELINE_STATUSES,
    motivationLevels: MOTIVATION_LEVELS,
    outreachDispos: OUTREACH_DISPOS,
    cassStatuses: ["verified", "unverified", "invalid", "ambiguous"],
  };
}

async function loadTemplateCategories(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<Array<{ category: string; count: number }>> {
  const { data } = await supabase
    .from("sms_templates")
    .select("category")
    .is("deleted_at", null);

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => ({ category, count }));
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    archived?: string;
  }>;
}) {
  const raw = await searchParams;
  const parsed = parseTableSearch<CampaignsFilters>(raw, {
    sortableColumns: CAMPAIGNS_SORTABLE_COLUMNS,
    defaultSort: "created_at",
    defaultDir: "desc",
    parseFilters: (params) => {
      const value = Array.isArray(params.archived)
        ? params.archived[0]
        : params.archived;
      return { archived: value === "1" || value === "true" };
    },
  });
  const { page, search, sort, dir, filters } = parsed;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();
  const [blockOptions, templateCategories] = await Promise.all([
    loadBlockOptions(supabase),
    loadTemplateCategories(supabase),
  ]);

  let campaignsQuery = supabase
    .from("campaigns")
    .select(
      "id, name, status, archived_at, audience_snapshot, body, template_category, pace_seconds, skip_if_contacted, created_at",
      { count: "exact" },
    );

  if (search) {
    campaignsQuery = campaignsQuery.ilike("name", `%${search}%`);
  }
  if (filters.archived) {
    campaignsQuery = campaignsQuery.not("archived_at", "is", null);
  } else {
    campaignsQuery = campaignsQuery.is("archived_at", null);
  }

  campaignsQuery = campaignsQuery
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true });

  const {
    data: campaignsData,
    count,
    error,
  } = await campaignsQuery.range(from, to);

  const pageIds = (campaignsData ?? []).map((campaign) => campaign.id);
  const recipientCounts = new Map<string, number>();
  if (pageIds.length > 0) {
    const { data: recipients } = await supabase
      .from("campaign_recipients")
      .select("campaign_id")
      .in("campaign_id", pageIds);

    for (const row of recipients ?? []) {
      recipientCounts.set(
        row.campaign_id,
        (recipientCounts.get(row.campaign_id) ?? 0) + 1,
      );
    }
  }

  const rows: CampaignRow[] = (campaignsData ?? []).map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    status: (campaign.archived_at
      ? "archived"
      : campaign.status) as CampaignStatus,
    archived_at: campaign.archived_at,
    created_at: campaign.created_at,
    bodyPreview: summarizeMessage(campaign.body, campaign.template_category),
    audienceSummary: summarizeAudience(campaign.audience_snapshot),
    pace_seconds: campaign.pace_seconds,
    skip_if_contacted: campaign.skip_if_contacted,
    recipientCount: recipientCounts.get(campaign.id) ?? 0,
  }));

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function pageHref(targetPage: number): string {
    return `/campaigns${buildTableHref<CampaignsFilters>(
      { page: targetPage, search, sort, dir, filters },
      CAMPAIGNS_BUILD_CONFIG,
    )}`;
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Campaigns" }]}
        title="Campaigns"
        description="Build a saved audience, lock the message, and launch a one-shot SMS blast."
      />

      <CreateCampaignForm
        blockOptions={blockOptions}
        templateCategories={templateCategories}
      />

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load campaigns: {error.message}
        </div>
      ) : null}

      <CampaignsTable rows={rows} parsed={parsed} total={total} />

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                ← Prev
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                ← Prev
              </Button>
            )}
            {page < totalPages ? (
              <Link
                href={pageHref(page + 1)}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                Next →
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next →
              </Button>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
