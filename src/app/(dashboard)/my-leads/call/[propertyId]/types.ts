/**
 * Call screen data contract (TECH-PLAN-2026-10 §3.10, D7). Pure types: safe for client bundles.
 * Every section is independent and degrades alone so the page always renders.
 */
import type { CoachCallContext, ScriptBundle } from "@biginkc/coach";

import type { FactField } from "@/lib/call-facts/types";
import type { CompSale, LeadCompRow, VerifyReason } from "@/lib/comps/types";
import type { BuyerEntity, TitleCompany } from "@/lib/contract-defaults/resolve";
import type { QueueRow } from "@/lib/my-leads/queries";
import type { PrefillBase } from "./contract-card/contract-prefill";
import type { Database } from "@/lib/supabase/types";

export type Section<T> = { ok: true; data: T } | { ok: false; message: string };

export type CallScreenPhone = { slot: 1 | 2 | 3; value: string; type: string };

export type CallScreenLead = {
  propertyId: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  isTraining: boolean;
  homeowner: { contactId: string | null; name: string; email: string; phones: CallScreenPhone[] };
};

export type CallScreenScript = {
  ref: { slug: string; revision: number; digest: string };
  bundle: ScriptBundle;
  context: CoachCallContext;
};

/** `lead_comps` member columns (never `raw`). */
export type LeadCompPublic = Omit<LeadCompRow, "raw"> & { comps: CompSale[]; verify_reasons: VerifyReason[] };

export type CallScreenComps = {
  latest: LeadCompPublic | null;
  request: { status: string; trigger: string } | null;
  settings: { enabled: boolean; capped: boolean };
  valuation: { arv: number | null; rehab: number | null };
};

export type CallScreenNote = Database["public"]["Tables"]["lead_notes"]["Row"];
export type CallScreenMessage = Database["public"]["Tables"]["messages"]["Row"];

/** p3-send-card fills these; in p3-call-screen the loader always returns `{ ok: false }` for both. */
export type ContractCardState =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      testMode: boolean;
      templateId: string;
      sellerRoleName: string;
      signerRoles: readonly { name: string; order: number }[];
      sellerSigner: { name: string; emailAddress: string };
      prefillBase: PrefillBase;
      titleCompanies: TitleCompany[];
      buyerEntities: BuyerEntity[];
      selectedTitleCompanyId: string | null;
      selectedBuyerEntityId: string | null;
      todayCentral: string;
      tomorrowCentral: string;
    };
/** One proposed fact still awaiting a human tap, in display-priority order. */
export type CallFactChipData = { field: FactField; value: string; evidence: string };
export type LeadCallFactsView = { factId: string; chips: CallFactChipData[] };

export type CallScreenData = {
  viewer: { userId: string; orgId: string; isOwner: boolean };
  lead: CallScreenLead;
  queueRow: QueueRow;
  script: Section<CallScreenScript>;
  comps: Section<CallScreenComps>;
  notes: Section<CallScreenNote[]>;
  messages: Section<CallScreenMessage[]>;
  contract: Section<ContractCardState>;
  facts: Section<LeadCallFactsView | null>;
};

export const CALL_SCREEN_SCRIPT_SLUG = "closr-outbound";
