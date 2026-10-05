"use server";

import { revalidatePath } from "next/cache";

import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { reportError } from "@/lib/errors/report";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createClient } from "@/lib/supabase/server";

import {
  MARKETS,
  dollarsToCents,
  parseTemplateFieldDefaults,
} from "./validation";

export type ContractDefaultsActionResult = { ok: true } | { ok: false; message: string };

// The new tables are not in the generated types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

const NOT_OWNER = "Only the account owner can change contract defaults.";
const NOT_READY = "Contract defaults are not available yet.";
const SAVE_FAILED = "Could not save. Try again.";
const PATH = "/settings/contract-defaults";

async function requireOwner(): Promise<
  | { ok: true; orgId: string; userId: string; supabase: LooseClient }
  | { ok: false; message: string }
> {
  const resolution = await getSingleActiveMembership();
  if (!resolution.ok || resolution.membership.role !== "owner") {
    return { ok: false, message: NOT_OWNER };
  }
  if (!(await schemaReady("contract_defaults"))) return { ok: false, message: NOT_READY };
  return {
    ok: true,
    orgId: resolution.membership.org_id,
    userId: resolution.membership.user_id,
    supabase: (await createClient()) as LooseClient,
  };
}

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

async function finish(
  error: { code?: string; message?: string } | null,
  context: string,
  fkMessage?: string,
): Promise<ContractDefaultsActionResult> {
  if (!error) {
    revalidatePath(PATH);
    return { ok: true };
  }
  if (error.code === "23503" && fkMessage) return { ok: false, message: fkMessage };
  if (error.code === "23505") return { ok: false, message: "That entry already exists." };
  reportError(error, { tags: { area: "contract-defaults", op: context } });
  return { ok: false, message: SAVE_FAILED };
}

export type TitleCompanyInput = {
  id?: string;
  name: string;
  closingAgentName: string;
  closingAgentPhone?: string;
  closingAgentAddress?: string;
  closingAgentEmail?: string;
  isActive: boolean;
};

export async function saveTitleCompanyAction(input: TitleCompanyInput): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const name = input.name.trim();
  const closingAgentName = input.closingAgentName.trim();
  if (!name) return { ok: false, message: "Title company name is required." };
  if (!closingAgentName) return { ok: false, message: "Closing agent name is required." };
  const row = {
    name,
    closing_agent_name: closingAgentName,
    closing_agent_phone: clean(input.closingAgentPhone),
    closing_agent_address: clean(input.closingAgentAddress),
    closing_agent_email: clean(input.closingAgentEmail),
    is_active: input.isActive,
  };
  const table = gate.supabase.from("acquisition_contract_title_companies");
  const { error } = input.id
    ? await table.update(row).eq("id", input.id).eq("org_id", gate.orgId)
    : await table.insert({ ...row, org_id: gate.orgId });
  return finish(error, "saveTitleCompany");
}

export async function deleteTitleCompanyAction(id: string): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const { error } = await gate.supabase
    .from("acquisition_contract_title_companies")
    .delete()
    .eq("id", id)
    .eq("org_id", gate.orgId);
  return finish(error, "deleteTitleCompany", "This title company is still used as a default. Remove it there first, or mark it inactive.");
}

export type BuyerEntityInput = {
  id?: string;
  name: string;
  phone?: string;
  email?: string;
  attorneyInFact?: string;
  isActive: boolean;
};

export async function saveBuyerEntityAction(input: BuyerEntityInput): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Buyer entity name is required." };
  const row = {
    name,
    phone: clean(input.phone),
    email: clean(input.email),
    attorney_in_fact: clean(input.attorneyInFact),
    is_active: input.isActive,
  };
  const table = gate.supabase.from("acquisition_contract_buyer_entities");
  const { error } = input.id
    ? await table.update(row).eq("id", input.id).eq("org_id", gate.orgId)
    : await table.insert({ ...row, org_id: gate.orgId });
  return finish(error, "saveBuyerEntity");
}

export async function deleteBuyerEntityAction(id: string): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const { error } = await gate.supabase
    .from("acquisition_contract_buyer_entities")
    .delete()
    .eq("id", id)
    .eq("org_id", gate.orgId);
  return finish(error, "deleteBuyerEntity", "This buyer entity is still used as a default. Remove it there first, or mark it inactive.");
}

export type MarketDefaultInput = { market: string; stateCode?: string; titleCompanyId: string };

export async function saveMarketDefaultAction(input: MarketDefaultInput): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  if (!(MARKETS as readonly string[]).includes(input.market)) {
    return { ok: false, message: "Choose a market." };
  }
  const stateCode = clean(input.stateCode)?.toUpperCase() ?? null;
  if (stateCode !== null && !/^[A-Z]{2}$/.test(stateCode)) {
    return { ok: false, message: "State must be a 2-letter code." };
  }
  if (!input.titleCompanyId) return { ok: false, message: "Choose a title company." };
  const { error } = await gate.supabase.from("acquisition_contract_title_market_defaults").insert({
    org_id: gate.orgId,
    market: input.market,
    state_code: stateCode,
    title_company_id: input.titleCompanyId,
  });
  return finish(error, "saveMarketDefault", "Choose a title company from this account.");
}

export async function deleteMarketDefaultAction(input: {
  market: string;
  stateCode: string | null;
}): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  let q = gate.supabase
    .from("acquisition_contract_title_market_defaults")
    .delete()
    .eq("org_id", gate.orgId)
    .eq("market", input.market);
  q = input.stateCode ? q.eq("state_code", input.stateCode) : q.is("state_code", null);
  const { error } = await q;
  return finish(error, "deleteMarketDefault");
}

export type ContractSettingsInput = {
  /** Dollars as typed by the owner. Required; there is no default. */
  earnestMoney: string;
  followUpDays: number;
  followUpHour: number;
  defaultTitleCompanyId: string | null;
  defaultBuyerEntityId: string | null;
  templateFieldDefaultsText: string;
};

export async function saveContractSettingsAction(input: ContractSettingsInput): Promise<ContractDefaultsActionResult> {
  const gate = await requireOwner();
  if (!gate.ok) return gate;
  const cents = dollarsToCents(input.earnestMoney);
  if (cents === null) {
    return { ok: false, message: "Enter the earnest money amount (dollars). It has no default." };
  }
  if (!Number.isInteger(input.followUpDays) || input.followUpDays < 1 || input.followUpDays > 60) {
    return { ok: false, message: "Follow-up days must be a whole number from 1 to 60." };
  }
  if (!Number.isInteger(input.followUpHour) || input.followUpHour < 0 || input.followUpHour > 23) {
    return { ok: false, message: "Follow-up hour must be a whole number from 0 to 23." };
  }
  const parsed = parseTemplateFieldDefaults(input.templateFieldDefaultsText);
  if (!parsed.ok) return { ok: false, message: parsed.errors.join(" ") };
  const { error } = await gate.supabase.from("acquisition_contract_settings").upsert(
    {
      org_id: gate.orgId,
      earnest_money_cents: cents,
      follow_up_days_before_closing: input.followUpDays,
      follow_up_hour_central: input.followUpHour,
      default_title_company_id: input.defaultTitleCompanyId || null,
      default_buyer_entity_id: input.defaultBuyerEntityId || null,
      template_field_defaults: parsed.value,
      updated_by: gate.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" },
  );
  return finish(error, "saveSettings", "Choose a title company and buyer entity from this account.");
}
