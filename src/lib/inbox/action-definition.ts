import "server-only";
import { createHash } from "node:crypto";
import type { OutreachDispo } from "@/app/(dashboard)/messages/dispo-actions";
import { INBOX_REPLY_RECIPIENT_LIMIT } from "./reply-api-contract";

/** Transport ceilings, not authorization or production capacity guarantees. */
export const INBOX_ACTION_LIMITS = Object.freeze({ bytes: 128 * 1024, targets: 500, steps: 5, replyRecipients: INBOX_REPLY_RECIPIENT_LIMIT, textLength: 1600 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Matches setOutreachDispo's VALID_DISPOS. A label never authorizes enrollment,
// scheduling, or bypassing the existing opt-out/locked-property side effects.
// Parsing dnc preserves an intent only: its canonical property trigger creates
// a permanent DNC lock, so execution remains separately gated. opted_out is
// SMS suppression and requires complete consent/enrollment side effects.
const OUTCOMES = new Set<OutreachDispo>(["wrong_number", "bad_number", "not_interested", "needs_sequence", "nurture", "opted_out", "dnc"]);
export type InboxActionStep =
  | { type: "outcome"; value: OutreachDispo }
  | { type: "assign"; userId: string | null }
  | { type: "promote" }
  | { type: "dismiss_unknown" | "restore_unknown" }
  | { type: "review_reply"; text: string };
export interface InboxActionDefinition { version: 1; steps: readonly InboxActionStep[] }
export interface InboxActionTarget { kind: "conversation" | "unknown_sender_group"; id: string }
/** Supply only from a freshly authenticated server caller, never request JSON. */
export interface InboxActionAuthContext { organizationId: string; requesterId: string }
export interface SavedInboxActionSnapshot extends InboxActionAuthContext {
  id: string; version: number; definition: InboxActionDefinition;
}
export class InvalidInboxActionError extends Error {
  constructor() { super("Invalid Inbox action input"); this.name = "InvalidInboxActionError"; }
}
function valid(value: unknown): asserts value { if (!value) throw new InvalidInboxActionError(); }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  valid(Object.keys(result).length === fields.length && fields.every((key) => Object.hasOwn(result, key)));
  return result;
}
function uuid(value: unknown): string { valid(typeof value === "string" && UUID.test(value)); return value.toLowerCase(); }
function version(value: unknown): number { valid(Number.isSafeInteger(value) && Number(value) > 0); return Number(value); }
function persistentText(value: string): string {
  valid(!value.includes("\u0000"));
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      valid(next >= 0xdc00 && next <= 0xdfff);
    } else valid(code < 0xdc00 || code > 0xdfff);
  }
  return value;
}
function wire(raw: string): unknown {
  valid(typeof raw === "string" && Buffer.byteLength(raw, "utf8") <= INBOX_ACTION_LIMITS.bytes);
  try {
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse remains the grammar parser. Scan its already-valid JSON tokens
    // solely to reject duplicate decoded member names before last-value wins.
    // Existing read-boundary rejects duplicates via byte-canonical comparison;
    // action requests intentionally allow whitespace and arbitrary field order.
    const containers: (Set<string> | null)[] = [];
    const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\]]/g;
    for (const match of raw.matchAll(tokens)) {
      const token = match[0];
      if (token === "{") containers.push(new Set());
      else if (token === "[") containers.push(null);
      else if (token === "}" || token === "]") containers.pop();
      else {
        const text = persistentText(JSON.parse(token) as string);
        let next = match.index + token.length;
        while (/\s/.test(raw[next] ?? "") && next < raw.length) next++;
        if (raw[next] === ":") {
          const keys = containers[containers.length - 1];
          valid(keys && !keys.has(text)); keys.add(text);
        }
      }
    }
    return parsed;
  } catch { throw new InvalidInboxActionError(); }
}
function auth(context: InboxActionAuthContext): InboxActionAuthContext {
  return { organizationId: uuid(context.organizationId), requesterId: uuid(context.requesterId) };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function definition(input: unknown): InboxActionDefinition {
  const value = object(input, ["version", "steps"]);
  valid(value.version === 1 && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= INBOX_ACTION_LIMITS.steps);
  const seen = new Set<string>();
  const steps: InboxActionStep[] = value.steps.map((raw: unknown, index: number) => {
    valid(raw !== null && typeof raw === "object");
    const type = (raw as Record<string, unknown>).type;
    valid(typeof type === "string");
    const group = type === "restore_unknown" ? "dismiss_unknown" : type;
    valid(!seen.has(group)); seen.add(group);
    switch (type) {
      case "outcome": {
        const step = object(raw, ["type", "value"]);
        valid(OUTCOMES.has(step.value as OutreachDispo));
        return { type, value: step.value as OutreachDispo };
      }
      case "assign": {
        const step = object(raw, ["type", "userId"]);
        return { type, userId: step.userId === null ? null : uuid(step.userId) };
      }
      case "promote": case "dismiss_unknown": case "restore_unknown":
        object(raw, ["type"]); return { type };
      case "review_reply": {
        const step = object(raw, ["type", "text"]);
        valid(index === (value.steps as unknown[]).length - 1);
        valid(typeof step.text === "string");
        // Match immediate Inbox sendSmsFromLead: trim before the length check.
        // Normalize before review, never silently transform approved content.
        const text = persistentText(step.text).trim();
        valid(text.length > 0 && text.length <= INBOX_ACTION_LIMITS.textLength);
        // Repeat normalization/validation after personalization, before freezing
        // the preview. The provider send must equal that frozen reviewed text.
        return { type, text };
      }
      default: throw new InvalidInboxActionError();
    }
  });
  // Outcome then assignment is the supported dependent sequence. Do not reorder
  // user intent silently or attach sending to accepted metadata operations.
  const outcome = steps.findIndex((s) => s.type === "outcome");
  const assign = steps.findIndex((s) => s.type === "assign");
  valid(outcome < 0 || assign < 0 || outcome < assign);
  return freeze({ version: 1, steps });
}
export function parseInboxActionDefinition(raw: string): InboxActionDefinition { return definition(wire(raw)); }
function targets(input: unknown): InboxActionTarget[] {
  valid(Array.isArray(input) && input.length > 0 && input.length <= INBOX_ACTION_LIMITS.targets);
  const seen = new Set<string>();
  return input.map((raw) => {
    const target = object(raw, ["kind", "id"]);
    valid(target.kind === "conversation" || target.kind === "unknown_sender_group");
    const result: InboxActionTarget = { kind: target.kind, id: uuid(target.id) };
    const key = `${result.kind}:${result.id}`; valid(!seen.has(key)); seen.add(key);
    return result;
  }).sort((a, b) => `${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1);
}
function identity<T>(input: T) {
  // All callers construct exact, ordered objects first. Target/item order is set
  // semantics; step order and exact message content remain semantically significant.
  const canonicalInput = JSON.stringify(input);
  return freeze({ input, canonicalInput, inputHash: createHash("sha256").update("sandra:inbox:action:v1\0").update(canonicalInput).digest("hex") });
}
/** Parses intent only. Nothing returned by this function is send/DB authorization.
 * Resolve every target under current access; freeze actual property mapping,
 * versions, exact unknown message IDs and routes in the acceptance transaction.
 * Mixed/unsupported target-step pairs remain visible for per-target review. */
export function parseInboxActionIntent(raw: string, context: InboxActionAuthContext, saved?: SavedInboxActionSnapshot) {
  const value = wire(raw);
  const scoped = auth(context);
  const request = object(value, saved ? ["idempotencyKey", "targets", "savedAction"] : ["idempotencyKey", "targets", "definition"]);
  let copiedDefinition: InboxActionDefinition;
  let savedAction: { id: string; version: number } | null = null;
  if (saved) {
    const reference = object(request.savedAction, ["id", "version"]);
    const owner = auth(saved);
    valid(owner.organizationId === scoped.organizationId && owner.requesterId === scoped.requesterId);
    savedAction = { id: uuid(reference.id), version: version(reference.version) };
    valid(savedAction.id === uuid(saved.id) && savedAction.version === version(saved.version));
    copiedDefinition = definition(saved.definition); // detached immutable accepted-version copy
  } else copiedDefinition = definition(request.definition);
  const idempotencyKey = uuid(request.idempotencyKey);
  const result = identity({ purpose: "prepare_action" as const, ...scoped, targets: targets(request.targets), definition: copiedDefinition, savedAction });
  return freeze({ ...result, idempotencyKey, requiresAuthoritativePreparation: true as const });
}
/** Accept only references to a server-owned, reviewed snapshot; never client text,
 * recipient routes, consent flags or version claims. Check snapshot owner/expiry,
 * exact membership and all current dependencies transactionally before accepting. */
export function parseReviewedInboxReply(raw: string, context: InboxActionAuthContext) {
  const request = object(wire(raw), ["idempotencyKey", "previewId", "previewVersion", "itemIds"]);
  valid(Array.isArray(request.itemIds) && request.itemIds.length > 0 && request.itemIds.length <= INBOX_ACTION_LIMITS.replyRecipients);
  const itemIds = request.itemIds.map(uuid).sort(); valid(new Set(itemIds).size === itemIds.length);
  const idempotencyKey = uuid(request.idempotencyKey);
  return freeze({ ...identity({ purpose: "accept_reviewed_reply" as const, ...auth(context), previewId: uuid(request.previewId), previewVersion: version(request.previewVersion), itemIds }), idempotencyKey, requiresAuthoritativePreparation: true as const });
}
/** Use after lookup by UNIQUE(org, requester, idempotency key), in the same
 * acceptance transaction. This helper does not persist or prevent duplicate work. */
export function compareInboxActionIdentity(existingHash: string, requestedHash: string): "reuse_existing" | "conflict" {
  valid(/^[a-f0-9]{64}$/.test(existingHash) && /^[a-f0-9]{64}$/.test(requestedHash));
  return existingHash === requestedHash ? "reuse_existing" : "conflict";
}

/** Acceptance carries immutable references only; no fresh action data. */
export function parseInboxActionAcceptance(raw: string) {
  const request = object(wire(raw), ["preparationId", "idempotencyKey"]);
  return freeze({ preparationId: uuid(request.preparationId), idempotencyKey: uuid(request.idempotencyKey) });
}

/** Bulk-reply prepare intent only: which conversations, and the raw operator
 * template text. Never a rendered body, route, or recipient claim — the reply
 * coordinator (reply-api.ts) renders and freezes those separately, inside one
 * request. Deliberately independent of parseReviewedInboxReply, which parses
 * an acceptance reference to an already-frozen server-owned preview. */
export function parseInboxReplyPrepareRequest(raw: string): { idempotencyKey: string; targets: readonly InboxActionTarget[]; template: string } {
  const request = object(wire(raw), ["idempotencyKey", "targets", "template"]);
  valid(typeof request.template === "string");
  return freeze({ idempotencyKey: uuid(request.idempotencyKey), targets: targets(request.targets), template: persistentText(request.template) });
}
