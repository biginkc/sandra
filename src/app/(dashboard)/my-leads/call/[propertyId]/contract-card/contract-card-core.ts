import { createHash } from "node:crypto";

import { buildContractPrefill, ECONOMIC_FIELDS, type PrefillBase, type PrefillInput } from "./contract-prefill";
import type { BuyerEntity, TitleCompany } from "@/lib/contract-defaults/resolve";
import type { EsignMergeFieldName } from "@/lib/esign/contracts";
import type { AcquisitionMotivationResponse, AcquisitionTemperature } from "@/lib/my-leads/types";

/**
 * Send-contract card server flow (TECH-PLAN-2026-10 §3.9, D8). Dependency-injected so tests use
 * fakes: no provider, eSign or database call happens here directly. The card NEVER imports
 * `send-contract.ts` or `website-template-registration.ts` (a static guard test checks this).
 *
 * Ordering: flag + readiness -> own-queue -> resolve the supplied intent FIRST (replay never
 * re-prechecks and never re-sends) -> precheck -> server-side prefill -> economics check ->
 * durable intent -> the existing eSign core `send`.
 */
export type SignerAssignment = Readonly<{ role: string; order: number; name: string; emailAddress: string }>;

/** A title company or buyer entity typed for this contract (no defaults exist; they vary by seller). */
export type NewTitleCompany = { name: string; closingAgentName: string; closingAgentPhone?: string; closingAgentAddress?: string; closingAgentEmail?: string };
export type NewBuyerEntity = { name: string; attorneyInFact?: string; phone?: string; email?: string };

export type SendContractCardInput = {
  propertyId: string;
  templateId: string;
  sendIntentId: string;
  priceCents: number;
  closingDate: string;
  titleCompanyId: string;
  buyerEntityId: string;
  /** null/undefined = the rep has not typed it; refused server-side (there is no default). */
  earnestMoneyCents: number | null;
  signers: readonly SignerAssignment[];
  overrides: Partial<Record<EsignMergeFieldName, string>>;
  /** Required only when the lead has no recorded motivation yet (the offer needs one). */
  motivation?: AcquisitionMotivationResponse | null;
  temperature?: AcquisitionTemperature;
  /** When set, `titleCompanyId` is "" and these values are used (and saved to the org list when the sender may). */
  titleCompanyNew?: NewTitleCompany;
  buyerEntityNew?: NewBuyerEntity;
};

export type SendContractCardResult =
  /** `typedNotSaved`: a typed title company or buyer entity was used on this contract only (the sender may not edit the org list). */
  | { status: "sent"; requestId: string; offer: "logged" | "pending" | "conflict"; code?: string; typedNotSaved?: boolean }
  | { status: "unconfirmed"; projectionId: string }
  | { status: "blocked"; code: string; message: string }
  /** `definitive`: the send definitively did not happen and the intent was released; the client may mint a new intent. */
  | { status: "failed"; message: string; definitive?: boolean };

export type ProjectionState = "awaiting_send" | "pending" | "logged" | "conflict" | "failed" | "cancelled";
export type ExistingOfferIntent = {
  projectionId: string;
  actorUserId: string;
  requestHash: string;
  submissionHash: string;
  sendPayload: Record<string, string>;
  state: ProjectionState;
  esignRequestId: string | null;
};
export type OfferPrecheck =
  | { ok: true; motivationRecorded?: boolean }
  | { ok: false; code: string; message: string };

/** Offer projection library (§3.6/3.7) is a separate slice; this is the seam it plugs into. */
export type OfferProjectionPort = {
  resolveIntent(viewer: Viewer, sendIntentId: string): Promise<ExistingOfferIntent | null>;
  precheck(viewer: Viewer, propertyId: string): Promise<OfferPrecheck>;
  createIntent(input: {
    orgId: string; propertyId: string; actorUserId: string; sendIntentId: string; requestHash: string;
    submissionHash: string; sendPayload: Record<string, string>; amountCents: number; closingDate: string;
    motivation: AcquisitionMotivationResponse | null; temperature: AcquisitionTemperature;
  }): Promise<{ projectionId: string } | { error: "OPEN_CONTRACT_EXISTS" | "PENDING_OFFER_EXISTS" | "IDEMPOTENCY_CONFLICT" | "FAILED" }>;
  projectNow(projectionId: string): Promise<{ state: ProjectionState; code?: string }>;
  abandon(projectionId: string): Promise<void>;
};

export type Viewer = { userId: string; orgId: string; isOwner: boolean };

export type SendContext = {
  prefillBase: PrefillBase;
  titleCompanies: PrefillInput["titleCompany"][];
  buyerEntities: PrefillInput["buyerEntity"][];
  todayCentral: string;
  tomorrowCentral: string;
};

export type EsignSendResult =
  | { ok: true; data: { requestId: string } }
  | { ok: false; error: { code: string; message: string } };

export type ContractCardCoreDeps = {
  viewer(): Promise<Viewer>;
  flagOn(orgId: string): Promise<boolean>;
  projectionReady(): Promise<boolean>;
  ownsLead(viewer: Viewer, propertyId: string): Promise<boolean>;
  loadContext(viewer: Viewer, propertyId: string, templateId: string): Promise<SendContext | null>;
  projection: OfferProjectionPort;
  /** Saves a typed entity to the org list through the sender's own access. Returns false when not allowed or on error. */
  saveTitleCompany?(viewer: Viewer, value: NewTitleCompany): Promise<boolean>;
  saveBuyerEntity?(viewer: Viewer, value: NewBuyerEntity): Promise<boolean>;
  send(input: {
    propertyId: string; templateId: string; sendIntentId: string;
    signers: readonly SignerAssignment[]; mergeValues: Record<string, string>;
  }): Promise<EsignSendResult>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_KEYS = "buyerEntityId,closingDate,earnestMoneyCents,overrides,priceCents,propertyId,sendIntentId,signers,templateId,titleCompanyId";

const CREATE_ERROR_COPY: Record<"OPEN_CONTRACT_EXISTS" | "PENDING_OFFER_EXISTS" | "IDEMPOTENCY_CONFLICT", string> = {
  OPEN_CONTRACT_EXISTS: "A contract is already open for this lead.",
  PENDING_OFFER_EXISTS: "This lead already has a pending offer.",
  IDEMPOTENCY_CONFLICT: "This send was already started with different details.",
};
const blocked = (code: string, message: string): SendContractCardResult => ({ status: "blocked", code, message });
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function sortKeys<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) as T;
}

export function submissionHashOf(i: SendContractCardInput): string {
  return sha({
    p: i.propertyId, t: i.templateId, price: i.priceCents, d: i.closingDate, tc: i.titleCompanyId,
    b: i.buyerEntityId, e: i.earnestMoneyCents, s: i.signers.map((s) => sortKeys({ ...s })), o: sortKeys({ ...i.overrides }),
    ...(i.titleCompanyNew || i.buyerEntityNew ? { tn: i.titleCompanyNew ?? null, bn: i.buyerEntityNew ?? null } : {}),
    ...(i.motivation || i.temperature ? { m: i.motivation ?? null, tp: i.temperature ?? null } : {}),
  });
}

function validShape(input: unknown): input is SendContractCardInput {
  if (!input || typeof input !== "object") return false;
  const i = input as Record<string, unknown>;
  if (Object.keys(i).filter((k) => !["motivation", "temperature", "titleCompanyNew", "buyerEntityNew"].includes(k)).sort().join(",") !== INPUT_KEYS) return false;
  const text = (v: unknown) => v === undefined || typeof v === "string";
  const tn = i.titleCompanyNew as Record<string, unknown> | undefined;
  const bn = i.buyerEntityNew as Record<string, unknown> | undefined;
  if (tn !== undefined && !(tn && typeof tn === "object" && typeof tn.name === "string" && tn.name.trim() !== "" && typeof tn.closingAgentName === "string" && tn.closingAgentName.trim() !== "" && text(tn.closingAgentPhone) && text(tn.closingAgentAddress) && text(tn.closingAgentEmail))) return false;
  if (bn !== undefined && !(bn && typeof bn === "object" && typeof bn.name === "string" && bn.name.trim() !== "" && text(bn.attorneyInFact) && text(bn.phone) && text(bn.email))) return false;
  if ((tn !== undefined) !== (i.titleCompanyId === "") || (bn !== undefined) !== (i.buyerEntityId === "")) return false;
  if (i.motivation != null) {
    const m = i.motivation as Record<string, unknown>;
    const okKind = (m.kind === "specified" && typeof m.text === "string" && m.text.trim() !== "") || (m.kind === "no_motivation" && m.text === null);
    if (!okKind) return false;
  }
  if (i.temperature != null && !["hot", "warm", "cold"].includes(i.temperature as string)) return false;
  return (
    typeof i.propertyId === "string" && UUID.test(i.propertyId) &&
    typeof i.templateId === "string" && UUID.test(i.templateId) &&
    typeof i.sendIntentId === "string" && UUID.test(i.sendIntentId) &&
    typeof i.titleCompanyId === "string" && (UUID.test(i.titleCompanyId) || i.titleCompanyId === "") &&
    typeof i.buyerEntityId === "string" && (UUID.test(i.buyerEntityId) || i.buyerEntityId === "") &&
    Number.isInteger(i.priceCents) && (i.priceCents as number) > 0 &&
    Number.isInteger(i.earnestMoneyCents) && (i.earnestMoneyCents as number) >= 0 &&
    typeof i.closingDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(i.closingDate) &&
    Array.isArray(i.signers) && i.signers.length > 0 &&
    !!i.overrides && typeof i.overrides === "object" && !Array.isArray(i.overrides)
  );
}

export function createContractCardCore(deps: ContractCardCoreDeps) {
  async function mapSend(projectionId: string, requestInput: Parameters<ContractCardCoreDeps["send"]>[0], fresh: boolean): Promise<SendContractCardResult> {
    let sent: EsignSendResult;
    try {
      sent = await deps.send(requestInput);
    } catch {
      // The provider call may have happened: never a plain retry, never abandon the intent.
      return { status: "unconfirmed", projectionId };
    }
    if (sent.ok) {
      // The contract is out. From here a failure must never read as "retry".
      let projected: { state: ProjectionState; code?: string };
      try {
        projected = await deps.projection.projectNow(projectionId);
      } catch {
        return { status: "sent", requestId: sent.data.requestId, offer: "pending", code: "PROJECTION_ERROR" };
      }
      const offer = projected.state === "logged" ? "logged" : projected.state === "conflict" ? "conflict" : "pending";
      return { status: "sent", requestId: sent.data.requestId, offer, ...(projected.code ? { code: projected.code } : {}) };
    }
    // Never re-send on an unconfirmed or in-flight send; the reconciliation cron resolves it.
    if (sent.error.code === "SEND_UNKNOWN" || sent.error.code === "SEND_IN_PROGRESS") return { status: "unconfirmed", projectionId };
    if (fresh) {
      try { await deps.projection.abandon(projectionId); } catch { /* the sweep repairs an open slot */ }
    }
    return { status: "failed", message: sent.error.message, definitive: true };
  }

  async function sendContractCard(input: SendContractCardInput): Promise<SendContractCardResult> {
    if (input && typeof input === "object" && (input as { earnestMoneyCents?: unknown }).earnestMoneyCents == null) {
      return blocked("EARNEST_MONEY_MISSING", "Enter the earnest money amount.");
    }
    if (!validShape(input)) return blocked("INVALID_INPUT", "The contract details are invalid.");
    const viewer = await deps.viewer();
    if (!(await deps.flagOn(viewer.orgId)) || !(await deps.projectionReady())) {
      return blocked("FEATURE_DISABLED", "Send contract is not available yet.");
    }
    if (!(await deps.ownsLead(viewer, input.propertyId))) return blocked("NOT_IN_QUEUE", "That lead is not in your queue.");

    if (input.signers.some((s) => !s || !s.name?.trim() || !s.emailAddress?.trim())) {
      return blocked("SIGNER_INCOMPLETE", "Every signer needs a name and email.");
    }
    const submissionHash = submissionHashOf(input);
    const existing = await deps.projection.resolveIntent(viewer, input.sendIntentId);
    if (existing) {
      if (existing.actorUserId !== viewer.userId && !viewer.isOwner) return blocked("FORBIDDEN", "You cannot act on this send.");
      if (existing.submissionHash !== submissionHash) return blocked("IDEMPOTENCY_CONFLICT", "This send was already started with different details.");
      if (existing.state === "failed" || existing.state === "cancelled") // Definitive: the projection proves nothing was sent (failed before send) or the contract was
      // cancelled, so the client may mint a new intent. States where a send happened or might have
      // (awaiting_send, pending, logged, conflict) never reach here.
      return { status: "failed", message: "That send did not go through. Try again.", definitive: true };
      if (existing.state === "logged" || existing.state === "conflict" || existing.state === "pending") {
        if (existing.esignRequestId) {
          return { status: "sent", requestId: existing.esignRequestId, offer: existing.state === "pending" ? "pending" : existing.state };
        }
      }
      // Replay the STORED canonical payload; the core resolves its durable state with no provider call.
      return mapSend(existing.projectionId, {
        propertyId: input.propertyId, templateId: input.templateId, sendIntentId: input.sendIntentId,
        signers: input.signers, mergeValues: existing.sendPayload,
      }, false);
    }

    const pre = await deps.projection.precheck(viewer, input.propertyId);
    if (!pre.ok) return blocked(pre.code, pre.message);

    const ctx = await deps.loadContext(viewer, input.propertyId, input.templateId);
    if (!ctx) return blocked("TEMPLATE_UNAVAILABLE", "That contract template is not available.");
    const norm = (v: string | undefined) => (v ?? "").trim();
    const orNull = (v: string | undefined) => norm(v) || null;
    let titleCompany: TitleCompany | null;
    let titleToSave: NewTitleCompany | null = null;
    if (input.titleCompanyNew) {
      const t = input.titleCompanyNew;
      const same = ctx.titleCompanies.find((x) => x?.isActive && x.name.trim().toLowerCase() === norm(t.name).toLowerCase());
      titleCompany = {
        id: same?.id ?? "typed", name: norm(t.name), closingAgentName: norm(t.closingAgentName),
        closingAgentPhone: orNull(t.closingAgentPhone), closingAgentAddress: orNull(t.closingAgentAddress), closingAgentEmail: orNull(t.closingAgentEmail), isActive: true,
      };
      if (!same) titleToSave = t;
    } else {
      titleCompany = ctx.titleCompanies.find((t) => t?.id === input.titleCompanyId && t.isActive) ?? null;
    }
    let buyerEntity: BuyerEntity | null;
    let buyerToSave: NewBuyerEntity | null = null;
    if (input.buyerEntityNew) {
      const b = input.buyerEntityNew;
      const same = ctx.buyerEntities.find((x) => x?.isActive && x.name.trim().toLowerCase() === norm(b.name).toLowerCase());
      buyerEntity = { id: same?.id ?? "typed", name: norm(b.name), phone: orNull(b.phone), email: orNull(b.email), attorneyInFact: orNull(b.attorneyInFact), isActive: true };
      if (!same) buyerToSave = b;
    } else {
      buyerEntity = ctx.buyerEntities.find((b) => b?.id === input.buyerEntityId && b.isActive) ?? null;
    }
    if (!titleCompany) return blocked("TITLE_COMPANY_MISSING", "Choose a title company.");
    if (!buyerEntity) return blocked("BUYER_ENTITY_MISSING", "Choose a buyer entity.");
    for (const key of Object.keys(input.overrides)) {
      if ((ECONOMIC_FIELDS as readonly string[]).includes(key)) return blocked("ECONOMIC_OVERRIDE", "Price, closing date and earnest money are set only by their own fields.");
    }
    if (input.closingDate < ctx.tomorrowCentral) return blocked("CLOSING_DATE_PAST", "The closing date must be tomorrow or later.");

    const prefill = buildContractPrefill({
      ...ctx.prefillBase,
      settings: { ...ctx.prefillBase.settings, earnestMoneyCents: input.earnestMoneyCents },
      titleCompany, buyerEntity,
      rep: { priceCents: input.priceCents, closingDate: input.closingDate, overrides: input.overrides },
      todayCentral: ctx.todayCentral,
    });
    if (prefill.blocked) {
      return blocked("MISSING_FIELDS", prefill.missing.length ? `Still needed: ${prefill.missing.join(", ")}.` : "Some values were rejected.");
    }
    const e = prefill.economics;
    if (e.priceCents !== input.priceCents || e.closingDate !== input.closingDate || e.earnestMoneyCents !== input.earnestMoneyCents) {
      return blocked("ECONOMICS_MISMATCH", "The price, closing date or earnest money do not match the contract.");
    }
    const requestHash = sha({ v: prefill.values, s: input.signers, t: input.templateId });
    const created = await deps.projection.createIntent({
      orgId: viewer.orgId, propertyId: input.propertyId, actorUserId: viewer.userId, sendIntentId: input.sendIntentId,
      requestHash, submissionHash, sendPayload: prefill.values, amountCents: e.priceCents, closingDate: e.closingDate,
      motivation: input.motivation ?? null, temperature: input.temperature ?? null,
    });
    if ("error" in created) {
      return created.error === "FAILED"
        ? { status: "failed", message: "The send could not be started. Please retry." }
        : blocked(created.error, CREATE_ERROR_COPY[created.error]);
    }
    // Typed entities are saved for reuse only after the intent exists, through the sender's own access. A save
    // never changes what is sent: the contract values above already carry the typed values.
    let typedNotSaved = false;
    if (titleToSave) {
      const ok = deps.saveTitleCompany ? await deps.saveTitleCompany(viewer, titleToSave).catch(() => false) : false;
      if (!ok) typedNotSaved = true;
    }
    if (buyerToSave) {
      const ok = deps.saveBuyerEntity ? await deps.saveBuyerEntity(viewer, buyerToSave).catch(() => false) : false;
      if (!ok) typedNotSaved = true;
    }
    const result = await mapSend(created.projectionId, {
      propertyId: input.propertyId, templateId: input.templateId, sendIntentId: input.sendIntentId,
      signers: input.signers, mergeValues: prefill.values,
    }, true);
    return result.status === "sent" && typedNotSaved ? { ...result, typedNotSaved: true } : result;
  }

  return { sendContractCard };
}
