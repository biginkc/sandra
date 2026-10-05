import { formatDollars } from "@/lib/calculators/closr-v1";
import type { BuyerEntity, TitleCompany } from "@/lib/contract-defaults/resolve";
import type { EsignMergeFieldName } from "@/lib/esign/contracts";

/**
 * Contract prefill mapper (TECH-PLAN-2026-10 §3.8). Pure, no I/O. Never reads properties.arv or
 * repair_estimate. Never invents text: a field with no source stays empty, is tagged `unsourced`
 * and blocks Send (except `additional_terms`).
 */
export type PrefillSource =
  | "lead" | "public_record" | "org_default" | "title_company" | "buyer_entity" | "rep" | "computed" | "unsourced";

export type PrefillInput = {
  schemaVersion: "legacy-v1" | "residential-v1" | "novation-v1";
  fieldNames: readonly EsignMergeFieldName[];
  lead: { sellerName: string; sellerEmail: string; sellerPhone: string | null; street: string; city: string; state: string; zip: string; fullAddress: string };
  comp: {
    legalDescription: string | null; legalComplete: boolean; confidence: "high" | "medium" | "low" | null;
    fetchedAt: string | null; provider: "attom" | "fixture" | null; ownerOfRecord: string | null;
  } | null;
  settings: { earnestMoneyCents: number; templateFieldDefaults: Record<string, string> };
  titleCompany: TitleCompany | null;
  buyerEntity: BuyerEntity | null;
  rep: { priceCents: number; closingDate: string; overrides: Partial<Record<EsignMergeFieldName, string>> };
  todayCentral: string;
  /** ISO instant used to age the comp (injected for tests). */
  now?: Date;
};

export type PrefillBase = Omit<PrefillInput, "rep" | "titleCompany" | "buyerEntity" | "todayCentral" | "now">;

export type PrefillResult = {
  values: Record<string, string>;
  sources: Record<string, PrefillSource>;
  missing: EsignMergeFieldName[];
  review: { sellerNames: string; legalDescription: string | null; price: string; closingDate: string | null; ownerOfRecordWarning: string | null };
  economics: { priceCents: number; closingDate: string; earnestMoneyCents: number };
  rejectedOverrides: string[];
  blocked: boolean;
};

export const ECONOMIC_FIELDS = ["offer_price", "cash_balance", "closing_date", "earnest_money"] as const;
export const OVERRIDABLE_FIELDS = [
  "seller_closing_cost_cap", "due_diligence_days", "access_days_per_week", "access_hours_per_visit",
  "offer_expiration", "acceptance_date", "release_date", "additional_terms", "legal_description",
] as const;
const ORG_DEFAULT_FIELDS = OVERRIDABLE_FIELDS.filter((f) => f !== "legal_description");
const LEGAL_MAX_AGE_MS = 90 * 24 * 3600 * 1000;

export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);

function ownerWarning(owner: string | null, seller: string): string | null {
  if (!owner || !owner.trim()) return null;
  const o = new Set(norm(owner));
  const shared = norm(seller).some((t) => t.length > 1 && o.has(t));
  return shared ? null : `Owner of record is "${owner.trim()}", which does not match the seller name.`;
}

export function buildContractPrefill(i: PrefillInput): PrefillResult {
  const names = i.fieldNames as readonly string[];
  const values: Record<string, string> = {};
  const sources: Record<string, PrefillSource> = {};
  const set = (name: string, value: string | null | undefined, source: PrefillSource) => {
    if (!names.includes(name)) return;
    const v = (value ?? "").trim();
    values[name] = v;
    sources[name] = v === "" ? "unsourced" : source;
  };
  for (const n of names) { values[n] = ""; sources[n] = "unsourced"; }

  const price = formatDollars(i.rep.priceCents / 100);
  const earnest = formatDollars(i.settings.earnestMoneyCents / 100);
  set("seller_name", i.lead.sellerName, "lead");
  set("seller_email", i.lead.sellerEmail, "lead");
  set("seller_phone", i.lead.sellerPhone, "lead");
  if (i.schemaVersion === "residential-v1") {
    set("property_address", i.lead.street, "lead");
    set("property_city", i.lead.city, "lead");
    set("property_state", i.lead.state, "lead");
    set("property_zip", i.lead.zip, "lead");
  } else {
    set("property_address", i.lead.fullAddress, "lead");
    set("property_state", i.lead.state, "lead");
  }
  set("offer_price", i.rep.priceCents > 0 ? price : "", "rep");
  set("cash_balance", i.rep.priceCents > 0 ? price : "", "rep");
  set("closing_date", i.rep.closingDate, "rep");
  set("earnest_money", earnest, "org_default");
  const t = i.titleCompany;
  set("earnest_money_holder", t?.name, "title_company");
  set("closing_agent_name", t?.closingAgentName, "title_company");
  set("closing_agent_phone", t?.closingAgentPhone, "title_company");
  set("closing_agent_address", t?.closingAgentAddress, "title_company");
  const b = i.buyerEntity;
  set("buyer_name", b?.name, "buyer_entity");
  set("buyer_phone", b?.phone, "buyer_entity");
  set("buyer_email", b?.email, "buyer_entity");
  set("attorney_in_fact", b?.attorneyInFact, "buyer_entity");
  set("agreement_date", i.todayCentral, "computed");
  for (const f of ORG_DEFAULT_FIELDS) set(f, i.settings.templateFieldDefaults[f], "org_default");

  // Legal description: only from a complete, non-low-confidence, ATTOM, <= 90 day old record.
  const c = i.comp;
  const nowMs = (i.now ?? new Date()).getTime();
  const fetched = c?.fetchedAt ? Date.parse(c.fetchedAt) : NaN;
  const legalOk = !!c && c.legalComplete && c.confidence !== "low" && c.provider === "attom" &&
    Number.isFinite(fetched) && nowMs - fetched <= LEGAL_MAX_AGE_MS && !!c.legalDescription?.trim();
  set("legal_description", legalOk ? c!.legalDescription : "", "public_record");

  // Rep overrides: allow-listed, non-economic only; a human-typed value is tagged `rep`.
  const rejectedOverrides: string[] = [];
  for (const [key, raw] of Object.entries(i.rep.overrides)) {
    if (!(OVERRIDABLE_FIELDS as readonly string[]).includes(key) || !names.includes(key) || typeof raw !== "string") {
      rejectedOverrides.push(key);
      continue;
    }
    set(key, raw, "rep");
  }

  const missing = names.filter((n) => n !== "additional_terms" && values[n] === "") as EsignMergeFieldName[];
  const legal = values.legal_description?.trim() ? values.legal_description : null;
  const closing = values.closing_date?.trim() ? values.closing_date : null;
  return {
    values,
    sources,
    missing,
    review: {
      sellerNames: values.seller_name ?? "",
      legalDescription: legal,
      price: values.offer_price ?? "",
      closingDate: closing,
      ownerOfRecordWarning: ownerWarning(c?.ownerOfRecord ?? null, i.lead.sellerName),
    },
    // Derived from the final canonical merged values so the document, projection and follow-up cannot diverge.
    economics: {
      priceCents: parseDollarsToCents(values.offer_price ?? "") ?? 0,
      closingDate: values.closing_date ?? "",
      earnestMoneyCents: parseDollarsToCents(values.earnest_money ?? "") ?? 0,
    },
    rejectedOverrides,
    blocked: missing.length > 0 || rejectedOverrides.length > 0,
  };
}
