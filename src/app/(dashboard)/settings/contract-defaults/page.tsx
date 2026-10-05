import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createClient } from "@/lib/supabase/server";

import { ContractDefaultsForm, type ContractDefaultsInitial } from "./form";
import { centsToDollars, formatTemplateFieldDefaults } from "./validation";

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

export default async function ContractDefaultsPage() {
  const resolution = await getSingleActiveMembership();
  if (!resolution.ok || resolution.membership.role !== "owner") notFound();
  const orgId = resolution.membership.org_id;

  const header = (
    <PageHeader
      breadcrumb={[{ label: "Settings", href: "/settings/integrations" }, { label: "Contract defaults" }]}
      title="Contract defaults"
      description="Title companies, buyer entities, and defaults used when sending a contract."
    />
  );

  if (!(await schemaReady("contract_defaults"))) {
    return (
      <Page>
        {header}
        <p role="status" className="text-muted-foreground text-sm">
          Contract defaults are not available yet.
        </p>
      </Page>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = (await createClient()) as any;
  const [settings, titles, buyers, markets] = await Promise.all([
    supabase.from("acquisition_contract_settings").select("*").eq("org_id", orgId).maybeSingle(),
    supabase.from("acquisition_contract_title_companies").select("*").eq("org_id", orgId).order("created_at"),
    supabase.from("acquisition_contract_buyer_entities").select("*").eq("org_id", orgId).order("created_at"),
    supabase.from("acquisition_contract_title_market_defaults").select("*").eq("org_id", orgId),
  ]);
  if ([settings, titles, buyers, markets].some((r) => r.error)) {
    return (
      <Page>
        {header}
        <p role="alert" className="text-destructive text-sm">
          Could not load contract defaults. Refresh to try again.
        </p>
      </Page>
    );
  }

  const st = (settings.data ?? null) as Row | null;
  const initial: ContractDefaultsInitial = {
    titleCompanies: ((titles.data ?? []) as Row[]).map((r) => ({
      id: String(r.id),
      name: s(r.name),
      closingAgentName: s(r.closing_agent_name),
      closingAgentPhone: s(r.closing_agent_phone),
      closingAgentAddress: s(r.closing_agent_address),
      closingAgentEmail: s(r.closing_agent_email),
      isActive: r.is_active !== false,
    })),
    buyerEntities: ((buyers.data ?? []) as Row[]).map((r) => ({
      id: String(r.id),
      name: s(r.name),
      phone: s(r.phone),
      email: s(r.email),
      attorneyInFact: s(r.attorney_in_fact),
      isActive: r.is_active !== false,
    })),
    marketDefaults: ((markets.data ?? []) as Row[]).map((r) => ({
      market: s(r.market),
      stateCode: typeof r.state_code === "string" ? r.state_code : null,
      titleCompanyId: String(r.title_company_id),
    })),
    settings: {
      // Blank until the owner saves a settings row: earnest money has no approved default.
      earnestMoney: st ? centsToDollars(st.earnest_money_cents as number | string) : "",
      followUpDays: st ? Number(st.follow_up_days_before_closing) : 3,
      followUpHour: st ? Number(st.follow_up_hour_central) : 9,
      defaultTitleCompanyId: typeof st?.default_title_company_id === "string" ? st.default_title_company_id : null,
      defaultBuyerEntityId: typeof st?.default_buyer_entity_id === "string" ? st.default_buyer_entity_id : null,
      templateFieldDefaultsText: formatTemplateFieldDefaults(st?.template_field_defaults as Row | undefined),
    },
  };

  return (
    <Page>
      {header}
      <ContractDefaultsForm initial={initial} />
    </Page>
  );
}
