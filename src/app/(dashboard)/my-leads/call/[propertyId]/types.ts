/**
 * Call screen data contract (TECH-PLAN-2026-10 §3.10, D7). Pure types: safe for client bundles.
 * Every section is independent and degrades alone so the page always renders.
 */
import type { CallPromptItem } from "@/lib/my-leads/call-state";
import type { CoachCallContext, ScriptBundle } from "@biginkc/coach";

import type { ProviderData } from "@/lib/comps/provider-data";
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
export type LeadCompPublic = Omit<LeadCompRow, "raw"> & { comps: CompSale[]; verify_reasons: VerifyReason[]; providerData?: ProviderData | null };

export type CallScreenComps = {
  latest: LeadCompPublic | null;
  request: { status: string; trigger: string } | null;
  settings: { enabled: boolean; capped: boolean };
  valuation: { arv: number | null; rehab: number | null };
};

export type CallScreenNote = Database["public"]["Tables"]["lead_notes"]["Row"];
export type CallScreenMessage = Database["public"]["Tables"]["messages"]["Row"];

/** The lead's latest offer projection (contract send -> offer log), for status copy and recovery. */
export type ContractProjectionView = {
  id: string;
  state: "awaiting_send" | "pending" | "logged" | "conflict" | "failed" | "cancelled";
  conflictCode: string | null;
  requestId: string | null;
  /** The eSign request is `send_unknown`: Sandra is still checking with Dropbox Sign. */
  sendUnknown: boolean;
  amountCents: number;
  followUpAt: string | null;
  /** Amount of the lead's pending offer, shown when it blocks logging this contract's offer. */
  pendingOfferAmountCents: number | null;
};

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
      todayCentral: string;
      tomorrowCentral: string;
      projection?: ContractProjectionView | null;
      /** False when the lead has no recorded motivation yet: the card then collects one (the offer needs it). */
      motivationRecorded?: boolean;
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
  /** The rep's newest ended Sandra call on this lead that has no outcome yet: the one call this screen's prompt is for. */
  pendingCall?: CallPromptItem | null;
};

export const CALL_SCREEN_SCRIPT_SLUG = "closr-outbound";

/** Result of an offer recovery action (retry, supersede, reassign, cancel). None of them can send a contract. */
export type OfferRecoveryResult =
  | { ok: true; state: string; duplicate?: boolean }
  | { ok: false; code: string; message: string };

export type OfferConflictRow = {
  projectionId: string;
  propertyId: string;
  address: string | null;
  conflictCode: string | null;
  requestId: string | null;
  sentAt: string | null;
  amountCents: number;
  actorUserId: string;
  pendingOfferAmountCents: number | null;
};
