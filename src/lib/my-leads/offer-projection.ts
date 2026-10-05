import "server-only";

import { reportError } from "@/lib/errors/report";
import { createAdminClient } from "@/lib/supabase/admin";

import type { MyLeadsFlag } from "./flags";
import { getMyLeadsQueueRow, MyLeadsReadError, type MyLeadRowReason } from "./queries";
import { schemaReady } from "./schema-ready";
import type { AcquisitionMotivationResponse, AcquisitionTemperature } from "./types";

/**
 * Offer projection server library (TECH-PLAN-2026-10 §3.7). The contract card never logs an offer
 * itself: it creates a durable intent, sends through the existing eSign core, and the database
 * trigger/runner projects the offer once the document is confirmed sent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type RpcResult = PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
type AdminLike = {
  rpc(name: string, args?: Record<string, unknown>): RpcResult;
  from(table: string): Loose;
};
export type OfferProjectionDeps = {
  admin?: () => AdminLike;
  getRow?: typeof getMyLeadsQueueRow;
  reportError?: typeof reportError;
};
const adminOf = (deps?: OfferProjectionDeps) => (deps?.admin ?? (() => createAdminClient() as unknown as AdminLike))();

export type ProjectionState = "awaiting_send" | "pending" | "logged" | "conflict" | "failed" | "cancelled";

export type OfferPrecheck =
  | { ok: true; queueVersion: number; episodeId: string; motivationRecorded: boolean }
  | {
      ok: false;
      code: "NOT_IN_QUEUE" | "STALE_STATE" | "PENDING_OFFER_EXISTS" | "DNC_OR_UNAVAILABLE" | "FEATURE_DISABLED" | "OPEN_CONTRACT_EXISTS";
      message: string;
    };

export type ExistingOfferIntent = {
  projectionId: string;
  actorUserId: string;
  requestHash: string;
  submissionHash: string;
  sendPayload: Record<string, string>;
  state: ProjectionState;
  esignRequestId: string | null;
  offerId: string | null;
};

type Viewer = { userId: string; orgId: string; client: Loose };

const REASON_CODE: Record<MyLeadRowReason, "NOT_IN_QUEUE" | "DNC_OR_UNAVAILABLE"> = {
  not_found: "NOT_IN_QUEUE",
  unassigned: "NOT_IN_QUEUE",
  other_rep: "NOT_IN_QUEUE",
  no_active_episode: "NOT_IN_QUEUE",
  archived: "NOT_IN_QUEUE",
  closed_dead_dnc: "DNC_OR_UNAVAILABLE",
};
const TERMINAL_SHARED = new Set(["offer_declined", "under_contract", "closed", "dead"]);

/** For genuinely NEW intents only: a known intent must go through {@link resolveOfferIntent} first. */
export async function precheckOffer(viewer: Viewer, propertyId: string, deps: OfferProjectionDeps = {}): Promise<OfferPrecheck> {
  const getRow = deps.getRow ?? getMyLeadsQueueRow;
  let lookup;
  try {
    lookup = await getRow({ memberId: viewer.userId, propertyId });
  } catch (error) {
    if (error instanceof MyLeadsReadError && error.code === "FEATURE_DISABLED") return { ok: false, code: "FEATURE_DISABLED", message: "My Leads is not enabled yet." };
    throw error;
  }
  if (lookup.status === "unavailable") {
    const code = REASON_CODE[lookup.reason];
    return { ok: false, code, message: code === "NOT_IN_QUEUE" ? "That lead is not in your queue." : "That lead is closed, dead or do-not-contact." };
  }
  const row = lookup.row;
  if (TERMINAL_SHARED.has(row.sharedStatus) || row.stage === "under_contract") {
    return { ok: false, code: "STALE_STATE", message: "This lead changed. Refresh and try again." };
  }
  if (row.offer?.outcome === "pending") {
    return { ok: false, code: "PENDING_OFFER_EXISTS", message: "This lead already has a pending offer." };
  }
  const open = await viewer.client
    .from("acquisition_offer_projections")
    .select("id")
    .eq("org_id", viewer.orgId)
    .eq("property_id", propertyId)
    .in("state", ["awaiting_send", "pending", "conflict"])
    .limit(1);
  if (!open.error && Array.isArray(open.data) && open.data.length > 0) {
    return { ok: false, code: "OPEN_CONTRACT_EXISTS", message: "A contract is already open for this lead." };
  }
  return { ok: true, queueVersion: row.queueVersion, episodeId: row.assignmentEpisodeId, motivationRecorded: row.motivationKind != null };
}

/** Resolve a supplied send intent BEFORE any new-send precheck: null when it is genuinely new. */
export async function resolveOfferIntent(viewer: Viewer, sendIntentId: string): Promise<ExistingOfferIntent | null> {
  const { data, error } = await viewer.client
    .from("acquisition_offer_projections")
    .select("id, actor_user_id, request_hash, submission_hash, send_payload, state, esign_request_id, offer_id")
    .eq("org_id", viewer.orgId)
    .eq("send_intent_id", sendIntentId)
    .maybeSingle();
  if (error) throw new Error("offer intent lookup failed");
  if (!data) return null;
  const payload: Record<string, string> = {};
  if (data.send_payload && typeof data.send_payload === "object") {
    for (const [k, v] of Object.entries(data.send_payload as Record<string, unknown>)) if (typeof v === "string") payload[k] = v;
  }
  return {
    projectionId: String(data.id),
    actorUserId: String(data.actor_user_id),
    requestHash: String(data.request_hash),
    submissionHash: String(data.submission_hash),
    sendPayload: payload,
    state: data.state as ProjectionState,
    esignRequestId: (data.esign_request_id as string | null) ?? null,
    offerId: (data.offer_id as string | null) ?? null,
  };
}

export type CreateOfferIntentInput = {
  orgId: string;
  propertyId: string;
  actorUserId: string;
  sendIntentId: string;
  requestHash: string;
  submissionHash: string;
  sendPayload: Record<string, string>;
  amountCents: number;
  closingDate: string;
  motivation: AcquisitionMotivationResponse | null;
  temperature: AcquisitionTemperature;
};
export type CreateOfferIntentResult =
  | { projectionId: string }
  | { error: "OPEN_CONTRACT_EXISTS" | "PENDING_OFFER_EXISTS" | "IDEMPOTENCY_CONFLICT" | "FAILED" };

export async function createOfferIntent(input: CreateOfferIntentInput, deps: OfferProjectionDeps = {}): Promise<CreateOfferIntentResult> {
  const { data, error } = await adminOf(deps).rpc("fn_create_offer_projection", {
    p_org_id: input.orgId,
    p_property_id: input.propertyId,
    p_actor: input.actorUserId,
    p_send_intent_id: input.sendIntentId,
    p_request_hash: input.requestHash,
    p_submission_hash: input.submissionHash,
    p_send_payload: input.sendPayload,
    p_amount_cents: input.amountCents,
    p_closing_date: input.closingDate,
    p_motivation_kind: input.motivation?.kind ?? null,
    p_motivation_text: input.motivation?.kind === "specified" ? input.motivation.text : null,
    p_temperature: input.temperature,
  });
  if (error) {
    const text = `${error.message ?? ""}`;
    if (error.code === "23505" || text.includes("OPEN_CONTRACT_EXISTS")) return { error: "OPEN_CONTRACT_EXISTS" };
    if (text.includes("PENDING_OFFER_EXISTS")) return { error: "PENDING_OFFER_EXISTS" };
    if (text.includes("IDEMPOTENCY_CONFLICT")) return { error: "IDEMPOTENCY_CONFLICT" };
    return { error: "FAILED" };
  }
  return typeof data === "string" ? { projectionId: data } : { error: "FAILED" };
}

export type ProjectOfferResult = { state: ProjectionState; offerId?: string; code?: string };

/** Logs the offer when (and only when) the eSign request is confirmed sent; otherwise reports the state. */
export async function projectOfferNow(projectionId: string, deps: OfferProjectionDeps = {}): Promise<ProjectOfferResult> {
  const { data, error } = await adminOf(deps).rpc("fn_project_acquisition_offer", { p_projection_id: projectionId });
  if (error || !data || typeof data !== "object") throw new Error("offer projection failed");
  const r = data as { state?: ProjectionState; offerId?: string; code?: string | null };
  return { state: r.state ?? "pending", ...(r.offerId ? { offerId: r.offerId } : {}), ...(r.code ? { code: r.code } : {}) };
}

/** Releases an intent whose send failed before any eSign request was claimed. */
export async function abandonOfferIntent(projectionId: string, deps: OfferProjectionDeps = {}): Promise<void> {
  const { error } = await adminOf(deps).rpc("fn_abandon_offer_projection", { p_projection_id: projectionId });
  if (error) throw new Error("abandon offer intent failed");
}

export type SweepResult = { repaired: number; projected: number; conflicts: number; disabled?: "flag_off" | "not_ready" };
const OFFER_FLAG: MyLeadsFlag = "offer_projection";
const ALERT_AFTER_MS = 60 * 60 * 1000;

export async function sweepOfferProjections(
  limit = 10,
  deps: OfferProjectionDeps & { schemaReady?: typeof schemaReady; now?: () => Date } = {},
): Promise<SweepResult> {
  const report = deps.reportError ?? reportError;
  const none = { repaired: 0, projected: 0, conflicts: 0 };
  if (!(await (deps.schemaReady ?? schemaReady)("offer_projection"))) return { ...none, disabled: "not_ready" };
  const admin = adminOf(deps);
  const flags = await admin.from("my_leads_feature_flags").select("org_id").eq(OFFER_FLAG, true);
  const enabled = new Set<string>(flags.error ? [] : ((flags.data ?? []) as { org_id: string }[]).map((r) => r.org_id));
  if (enabled.size === 0) return { ...none, disabled: "flag_off" };

  const repairedRes = await admin.rpc("fn_offer_projection_repair");
  const repaired = repairedRes.error || typeof repairedRes.data !== "number" ? 0 : repairedRes.data;
  const dueRes = await admin.rpc("fn_offer_projection_due", { p_limit: limit });
  const ids = dueRes.error || !Array.isArray(dueRes.data) ? [] : (dueRes.data as unknown[]).filter((v): v is string => typeof v === "string");
  let projected = 0;
  for (const id of ids) {
    const meta = await admin.from("acquisition_offer_projections").select("org_id").eq("id", id).maybeSingle();
    if (meta.error || !meta.data || !enabled.has(meta.data.org_id)) continue;
    try {
      const r = await projectOfferNow(id, deps);
      if (r.state === "logged") projected += 1;
    } catch (error) {
      report(error instanceof Error ? error : new Error("offer projection sweep failed"), { tags: { surface: "offer_projection_sweep" } });
    }
  }
  // One alert per conflict that has been open for over an hour.
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - ALERT_AFTER_MS).toISOString();
  const conflictsRes = await admin
    .from("acquisition_offer_projections")
    .select("id, org_id, property_id, conflict_code")
    .eq("state", "conflict")
    .is("alerted_at", null)
    .lt("updated_at", cutoff);
  const conflicts = ((conflictsRes.error ? [] : conflictsRes.data) ?? []) as { id: string; org_id: string; property_id: string; conflict_code: string }[];
  let alerted = 0;
  for (const c of conflicts) {
    if (!enabled.has(c.org_id)) continue;
    const marked = await admin.from("acquisition_offer_projections").update({ alerted_at: new Date().toISOString() }).eq("id", c.id).is("alerted_at", null).select("id");
    if (marked.error || !marked.data || marked.data.length === 0) continue;
    report(new Error(`Offer projection conflict ${c.conflict_code}`), {
      tags: { surface: "offer_projection_conflict", code: c.conflict_code },
      extra: { projectionId: c.id, propertyId: c.property_id },
    });
    alerted += 1;
  }
  return { repaired, projected, conflicts: alerted };
}
