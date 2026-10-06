import "server-only";

import { loadCoachCallContext } from "@/lib/coach/coach-context-actions";
import { loadCachedCoachBundle } from "@/lib/coach/script-cache";
import { FACT_FIELDS } from "@/lib/call-facts/types";
import { LEAD_COMPS_MEMBER_COLUMNS } from "@/lib/comps/types";
import { reportError } from "@/lib/errors/report";
import { parseCallPromptPage, type CallPromptItem } from "@/lib/my-leads/call-state";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getMyLeadsQueueRow, myLeadsViewer, MyLeadsReadError, type MyLeadRowReason } from "@/lib/my-leads/queries";
import { schemaReady } from "@/lib/my-leads/schema-ready";

import {
  CALL_SCREEN_SCRIPT_SLUG,
  type CallScreenComps,
  type CallScreenData,
  type CallScreenLead,
  type ContractCardState,
  type CallScreenMessage,
  type CallScreenNote,
  type CallScreenPhone,
  type CallScreenScript,
  type LeadCallFactsView,
  type LeadCompPublic,
  type Section,
} from "./types";

import { loadContractCard } from "./contract-card/contract-card-actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_LIMIT = 50;

export type CallScreenLoad =
  | { status: "ok"; data: CallScreenData }
  | { status: "unavailable"; reason: MyLeadRowReason }
  | { status: "invalid" }
  | { status: "error"; message: string };

/** Loose query surface: the Phase 3 tables are not in the generated `Database` type yet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;

type Deps = {
  viewer?: typeof myLeadsViewer;
  queueRow?: typeof getMyLeadsQueueRow;
  bundle?: (slug: string) => ReturnType<typeof loadCachedCoachBundle>;
  context?: typeof loadCoachCallContext;
  flag?: typeof getMyLeadsFlag;
  schemaReady?: typeof schemaReady;
  contractCard?: (propertyId: string) => Promise<ContractCardState>;
};

function failed<T>(message: string, error: unknown, operation: string): Section<T> {
  reportError(error instanceof Error ? error : new Error(message), {
    errorClass: "database",
    tags: { surface: "call_screen", operation },
  });
  return { ok: false, message };
}

async function section<T>(message: string, operation: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return failed<T>(message, error, operation);
  }
}

type PropertyRow = {
  id: string;
  org_id: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  market: string | null;
  is_training: boolean;
  homeowner_contact_id: string | null;
};
type ContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  entity_name: string | null;
  contact_type: string;
  email: string | null;
  phone_1: string | null;
  phone_1_type: string;
  phone_2: string | null;
  phone_2_type: string;
  phone_3: string | null;
  phone_3_type: string;
};

function phonesOf(contact: ContactRow | null): CallScreenPhone[] {
  if (!contact) return [];
  const slots: [1 | 2 | 3, string | null, string][] = [
    [1, contact.phone_1, contact.phone_1_type],
    [2, contact.phone_2, contact.phone_2_type],
    [3, contact.phone_3, contact.phone_3_type],
  ];
  return slots.filter((s): s is [1 | 2 | 3, string, string] => Boolean(s[1])).map(([slot, value, type]) => ({ slot, value, type }));
}

async function loadLead(client: LooseClient, orgId: string, propertyId: string): Promise<CallScreenLead | null> {
  const { data: property, error } = await client
    .from("properties")
    .select("id, org_id, address, city, state, zip, market, is_training, homeowner_contact_id")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!property) return null;
  const row = property as PropertyRow;
  let contact: ContactRow | null = null;
  if (row.homeowner_contact_id) {
    const result = await client
      .from("contacts")
      .select("id, first_name, last_name, entity_name, contact_type, email, phone_1, phone_1_type, phone_2, phone_2_type, phone_3, phone_3_type")
      .eq("id", row.homeowner_contact_id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (result.error) throw result.error;
    contact = (result.data as ContactRow | null) ?? null;
  }
  const name =
    contact?.contact_type === "entity"
      ? (contact.entity_name ?? "")
      : [contact?.first_name, contact?.last_name].filter(Boolean).join(" ");
  return {
    propertyId: row.id,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    market: row.market,
    isTraining: row.is_training === true,
    homeowner: { contactId: contact?.id ?? null, name, email: contact?.email ?? "", phones: phonesOf(contact) },
  };
}

async function loadScript(lead: CallScreenLead, deps: Deps): Promise<CallScreenScript> {
  const cached = await (deps.bundle ?? loadCachedCoachBundle)(CALL_SCREEN_SCRIPT_SLUG);
  if (!cached) throw new Error("No reviewed Closer Lab script is cached");
  const context = await (deps.context ?? loadCoachCallContext)({
    propertyId: lead.propertyId,
    sellerPhoneE164: lead.homeowner.phones[0]?.value ?? null,
    repPhoneE164: null,
  });
  return { ref: cached.ref, bundle: cached.bundle, context };
}

async function loadComps(client: LooseClient, orgId: string, propertyId: string, deps: Deps): Promise<CallScreenComps> {
  const ready = await (deps.schemaReady ?? schemaReady)("lead_comps");
  const flagOn = ready ? await (deps.flag ?? getMyLeadsFlag)(orgId, "comp_queue") : false;
  if (!ready) return { latest: null, request: null, settings: { enabled: false, capped: false }, valuation: { arv: null, rehab: null } };
  const [latest, request, settings, valuation] = await Promise.all([
    client.from("lead_comps").select(LEAD_COMPS_MEMBER_COLUMNS).eq("org_id", orgId).eq("property_id", propertyId)
      .order("fetched_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("comp_fetch_requests").select("status, trigger").eq("org_id", orgId).eq("property_id", propertyId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("org_comp_settings").select("monthly_call_cap").eq("org_id", orgId).maybeSingle(),
    client.from("lead_valuation_inputs").select("arv, rehab").eq("org_id", orgId).eq("property_id", propertyId).maybeSingle(),
  ]);
  for (const r of [latest, request, settings, valuation]) if (r.error) throw r.error;
  const cap = Number((settings.data as { monthly_call_cap?: unknown } | null)?.monthly_call_cap ?? 0);
  const req = request.data as { status: string; trigger: string } | null;
  const val = valuation.data as { arv: unknown; rehab: unknown } | null;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const latestRow = latest.data as (Record<string, unknown> & { as_is_value?: unknown; as_is_low?: unknown; as_is_high?: unknown; arv_estimate?: unknown }) | null;
  return {
    latest: latestRow
      ? ({ ...latestRow, as_is_value: num(latestRow.as_is_value), as_is_low: num(latestRow.as_is_low), as_is_high: num(latestRow.as_is_high), arv_estimate: num(latestRow.arv_estimate) } as unknown as LeadCompPublic)
      : null,
    request: req,
    settings: { enabled: flagOn && cap > 0, capped: req?.status === "capped" },
    valuation: { arv: num(val?.arv), rehab: num(val?.rehab) },
  };
}

async function loadNotes(client: LooseClient, propertyId: string): Promise<CallScreenNote[]> {
  const { data, error } = await client.from("lead_notes").select("*").eq("property_id", propertyId)
    .order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data ?? []) as CallScreenNote[];
}

/**
 * Same `or()` as `leads/[id]/page.tsx`. Deliberately NOT calling `markMessagesReadForProperty`:
 * it clears `has_unread_inbound`, which feeds ranking tier 2, and opening this screen is not an
 * acknowledgement (TECH-PLAN §3.10 open question).
 */
async function loadMessages(client: LooseClient, propertyId: string, contactId: string | null): Promise<CallScreenMessage[]> {
  const orFilter = contactId
    ? `property_id.eq.${propertyId},and(contact_id.eq.${contactId},property_id.is.null)`
    : `property_id.eq.${propertyId}`;
  const { data, error } = await client.from("messages").select("*").or(orFilter)
    .order("created_at", { ascending: false }).limit(HISTORY_LIMIT);
  if (error) throw error;
  return [...((data ?? []) as CallScreenMessage[])].reverse();
}

/** Flag-off, not-ready, or any failure is `{ ok: false }` and the layout omits the slot. */
/**
 * The latest finished, still-open call facts proposal for the lead, as chips. Null (nothing rendered)
 * until the schema exists or when there is nothing left to accept. Reads through the caller's RLS
 * client and never selects the job columns (token, lease), which members cannot read.
 */
async function loadFacts(client: LooseClient, orgId: string, propertyId: string, deps: Deps): Promise<LeadCallFactsView | null> {
  if (!(await (deps.schemaReady ?? schemaReady)("call_facts"))) return null;
  const { data, error } = await client
    .from("lead_call_facts")
    .select("id, facts, accepted, status")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("processing_state", "done")
    .in("status", ["proposed", "partially_accepted"])
    .order("extracted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const facts = (data.facts ?? {}) as Record<string, { value?: unknown; evidence?: unknown } | undefined>;
  const accepted = (data.accepted ?? {}) as Record<string, unknown>;
  const chips = FACT_FIELDS.filter((f) => !(f in accepted))
    .map((field) => ({ field, value: facts[field]?.value, evidence: facts[field]?.evidence }))
    .filter((c): c is { field: (typeof FACT_FIELDS)[number]; value: string; evidence: string } => typeof c.value === "string" && typeof c.evidence === "string");
  return chips.length === 0 ? null : { factId: String(data.id), chips };
}

async function loadContractSection(propertyId: string, deps: Deps): Promise<Section<ContractCardState>> {
  try {
    const state = await (deps.contractCard ?? loadContractCard)(propertyId);
    return state.enabled ? { ok: true, data: state } : { ok: false, message: state.reason };
  } catch {
    return { ok: false, message: "Send contract is not available." };
  }
}

/**
 * The newest ended, outcome-less Sandra call on this lead (the server's own pending attempt, so a call
 * that is already logged never appears). A read failure or a schema that has not landed is "no pending
 * call": the prompt then simply waits for the provider's end-of-call signal.
 */
async function loadPendingCall(client: LooseClient, orgId: string, propertyId: string, deps: Deps): Promise<CallPromptItem | null> {
  try {
    if (!(await (deps.schemaReady ?? schemaReady)("ack_prompts"))) return null;
    const { data, error } = await client.rpc("fn_list_unacknowledged_call_prompts", {
      p_org_id: orgId,
      p_limit: 20,
      p_before_ended: null,
      p_before_id: null,
    });
    if (error) return null;
    const mine = parseCallPromptPage(data).items.filter((item) => item.propertyId === propertyId && item.origin === "sandra");
    mine.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    return mine[0] ?? null;
  } catch {
    return null;
  }
}

/** Every section is independent and degrades alone; only the lead and its queue row are required. */
export async function loadCallScreen(propertyId: string, deps: Deps = {}): Promise<CallScreenLoad> {
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) return { status: "invalid" };
  try {
    const { client, ...viewer } = await (deps.viewer ?? myLeadsViewer)();
    const lookup = await (deps.queueRow ?? getMyLeadsQueueRow)({ memberId: viewer.userId, propertyId });
    if (lookup.status === "unavailable") return { status: "unavailable", reason: lookup.reason };
    const lead = await loadLead(client, viewer.orgId, propertyId);
    if (!lead) return { status: "unavailable", reason: "not_found" };
    const [script, comps, notes, messages] = await Promise.all([
      section<CallScreenScript>("The script could not be loaded.", "script", () => loadScript(lead, deps)),
      section<CallScreenComps>("Numbers could not be loaded.", "comps", () => loadComps(client, viewer.orgId, propertyId, deps)),
      section<CallScreenNote[]>("Notes could not be loaded.", "notes", () => loadNotes(client, propertyId)),
      section<CallScreenMessage[]>("Texts could not be loaded.", "messages", () => loadMessages(client, propertyId, lead.homeowner.contactId)),
    ]);
    return {
      status: "ok",
      data: {
        viewer,
        lead,
        queueRow: lookup.row,
        script,
        comps,
        notes,
        messages,
        contract: await loadContractSection(propertyId, deps),
        facts: await section<LeadCallFactsView | null>("Call facts could not be loaded.", "facts", () => loadFacts(client, viewer.orgId, propertyId, deps)),
        pendingCall: await loadPendingCall(client, viewer.orgId, propertyId, deps),
      },
    };
  } catch (error) {
    if (error instanceof MyLeadsReadError) {
      if (error.code === "NOT_FOUND") return { status: "unavailable", reason: "not_found" };
      return { status: "error", message: error.message };
    }
    reportError(error instanceof Error ? error : new Error("call screen load failed"), {
      errorClass: "database",
      tags: { surface: "call_screen", operation: "load" },
    });
    return { status: "error", message: "The call screen could not load. Please retry." };
  }
}
