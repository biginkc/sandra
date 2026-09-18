import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { parseInboxActionDefinition, InvalidInboxActionError, type InboxActionAuthContext, type InboxActionDefinition, type SavedInboxActionSnapshot } from "./action-definition";

/** RPC surface for the personal saved-action definitions backend
 * (experiments/inbox-saved-actions/{setup,public-api}.sql). Personal
 * visibility only; durable metadata executors and the picker/builder remain
 * separate from this transport repository. */
type SavedActionDatabase = Omit<Database, "public"> & {
    public: Omit<Database["public"], "Functions"> & {
        Functions: Database["public"]["Functions"] & {
            inbox_saved_action_create: { Args: { name: string; definition: Json }; Returns: Json };
            inbox_saved_action_update: { Args: { id: string; name: string; definition: Json }; Returns: Json };
            inbox_saved_action_deactivate: { Args: { id: string }; Returns: Json };
            inbox_saved_action_list: { Args: Record<string, never>; Returns: Json };
            inbox_saved_action_get: { Args: { id: string; version: number }; Returns: Json };
        };
    };
};
export type InboxSavedActionClient = Pick<SupabaseClient<SavedActionDatabase>, "rpc">;

export class InboxSavedActionApiError extends Error {
    constructor(readonly status: number, readonly code = "saved_action_unavailable") { super(code); }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(value: unknown, status = 503): asserts value { if (!value) throw new InboxSavedActionApiError(status); }
function record(value: unknown): Record<string, unknown> { need(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function id(value: unknown): string { need(typeof value === "string" && UUID.test(value)); return value; }
function version(value: unknown): number { need(Number.isSafeInteger(value) && Number(value) > 0); return Number(value); }
function text(value: unknown): string { need(typeof value === "string"); return value; }

function failure(error: { code?: string; message?: string } | null): void {
    if (!error) return;
    if (error.code === "PGRST301" || error.code === "PGRST303")
        throw new InboxSavedActionApiError(401, "authentication_required");
    if (error.code === "42501") {
        if (["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(error.message ?? ""))
            throw new InboxSavedActionApiError(401, "authentication_required");
        if (["INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ORG_DENIED", "INBOX_ACTION_FORBIDDEN"].includes(error.message ?? ""))
            throw new InboxSavedActionApiError(403, "access_unavailable");
    }
    if (error.code === "P0001") {
        const notFound = new Set(["INBOX_SAVED_ACTION_NOT_FOUND"]);
        const conflicts: Record<string, string> = {
            INBOX_SAVED_ACTION_STALE_VERSION: "stale_version",
            INBOX_SAVED_ACTION_INVALID_NAME: "invalid_name",
            INBOX_SAVED_ACTION_INVALID_DEFINITION: "invalid_definition",
            INBOX_SAVED_ACTION_STEP_TYPE_DISABLED: "step_type_disabled",
            INBOX_SAVED_ACTION_STEP_COMBINATION_UNSUPPORTED: "step_combination_unsupported",
            INBOX_SAVED_ACTION_ASSIGNEE_UNAVAILABLE: "assignee_unavailable",
            INBOX_SAVED_ACTION_DEFINITION_MISMATCH: "saved_action_definition_mismatch",
            permanent_dnc_not_enabled: "permanent_dnc_not_enabled",
        };
        if (error.message && notFound.has(error.message)) throw new InboxSavedActionApiError(404, "saved_action_not_found");
        if (error.message && conflicts[error.message]) throw new InboxSavedActionApiError(409, conflicts[error.message]);
    }
    throw new InboxSavedActionApiError(503);
}

function definitionOf(value: unknown): InboxActionDefinition {
    try { return parseInboxActionDefinition(JSON.stringify(value)); }
    catch { throw new InboxSavedActionApiError(503); }
}

export interface SavedInboxActionSummary { id: string; version: number; name: string; definition: InboxActionDefinition; createdAt: string }

export function createInboxSavedActionRepository(client: InboxSavedActionClient) {
    return {
        async create(name: string, definition: InboxActionDefinition, signal: AbortSignal): Promise<SavedInboxActionSummary> {
            signal.throwIfAborted();
            const result = await client.rpc("inbox_saved_action_create", { name, definition: definition as unknown as Json }).abortSignal(signal);
            signal.throwIfAborted(); failure(result.error);
            const row = record(result.data);
            return { id: id(row.id), version: version(row.version), name: text(row.name), definition: definitionOf(row.definition), createdAt: text(row.created_at) };
        },
        async update(targetId: string, name: string, definition: InboxActionDefinition, signal: AbortSignal): Promise<SavedInboxActionSummary> {
            need(UUID.test(targetId), 400); signal.throwIfAborted();
            const result = await client.rpc("inbox_saved_action_update", { id: targetId, name, definition: definition as unknown as Json }).abortSignal(signal);
            signal.throwIfAborted(); failure(result.error);
            const row = record(result.data);
            return { id: id(row.id), version: version(row.version), name: text(row.name), definition: definitionOf(row.definition), createdAt: text(row.created_at) };
        },
        async deactivate(targetId: string, signal: AbortSignal): Promise<{ id: string; version: number }> {
            need(UUID.test(targetId), 400); signal.throwIfAborted();
            const result = await client.rpc("inbox_saved_action_deactivate", { id: targetId }).abortSignal(signal);
            signal.throwIfAborted(); failure(result.error);
            const row = record(result.data);
            return { id: id(row.id), version: version(row.version) };
        },
        async list(signal: AbortSignal): Promise<readonly SavedInboxActionSummary[]> {
            signal.throwIfAborted();
            const result = await client.rpc("inbox_saved_action_list", {}).abortSignal(signal);
            signal.throwIfAborted(); failure(result.error);
            const row = record(result.data);
            need(Array.isArray(row.items) && row.items.length <= 200);
            return row.items.map((raw: unknown) => {
                const item = record(raw);
                return { id: id(item.id), version: version(item.version), name: text(item.name), definition: definitionOf(item.definition), createdAt: text(item.created_at) };
            });
        },
        /** Resolves the EXACT stored immutable version, requester+org scoped,
         * re-validated (references/gated-step-types) at this call. */
        async get(targetId: string, targetVersion: number, signal: AbortSignal): Promise<SavedInboxActionSummary & { organizationId: string; requesterId: string }> {
            need(UUID.test(targetId) && Number.isSafeInteger(targetVersion) && targetVersion > 0, 400); signal.throwIfAborted();
            const result = await client.rpc("inbox_saved_action_get", { id: targetId, version: targetVersion }).abortSignal(signal);
            signal.throwIfAborted(); failure(result.error);
            const row = record(result.data);
            need(id(row.id) === targetId && version(row.version) === targetVersion, 503);
            return { id: id(row.id), version: version(row.version), name: text(row.name), definition: definitionOf(row.definition), createdAt: text(row.created_at), organizationId: id(row.org_id), requesterId: id(row.requester_id) };
        },
    };
}

/** The missing lookup glue: resolves a browser-supplied {id,version}
 * reference to the exact stored immutable snapshot for the CURRENT actor,
 * for use as parseInboxActionIntent's 3rd argument
 * (action-definition.README.md: "Resolve saved-action snapshots from an
 * authorized database lookup, then pass the exact stored version as the
 * third argument"). Fails closed on org/requester mismatch (a tampered
 * reference, or a snapshot belonging to someone else) even though the
 * underlying RPC is already requester-scoped — defense in depth, matching
 * parseInboxActionIntent's own owner check. */
export async function resolveSavedInboxActionSnapshot(client: InboxSavedActionClient, reference: { id: string; version: number }, actor: InboxActionAuthContext, signal: AbortSignal): Promise<SavedInboxActionSnapshot> {
    need(UUID.test(reference.id) && Number.isSafeInteger(reference.version) && reference.version > 0, 400);
    const row = await createInboxSavedActionRepository(client).get(reference.id, reference.version, signal);
    need(row.organizationId === actor.organizationId && row.requesterId === actor.requesterId, 403);
    return { organizationId: row.organizationId, requesterId: row.requesterId, id: row.id, version: row.version, definition: row.definition };
}

/** Sniffs raw request JSON for a `savedAction: {id, version}` reference
 * without trusting the result for anything but ROUTING: parseInboxActionIntent
 * independently re-validates the full envelope (exact required-key set,
 * given whether `saved` is passed), so a malformed/forged sniff here only
 * ever leads to a fail-closed InvalidInboxActionError downstream, never a
 * bypass. */
export function savedActionReferenceFromRaw(raw: string): { id: string; version: number } | null {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const savedAction = (value as Record<string, unknown>).savedAction;
    if (savedAction === undefined || savedAction === null || typeof savedAction !== "object" || Array.isArray(savedAction)) return null;
    const ref = savedAction as Record<string, unknown>;
    if (typeof ref.id !== "string" || !UUID.test(ref.id)) return null;
    if (!Number.isSafeInteger(ref.version) || Number(ref.version) <= 0) return null;
    return { id: ref.id, version: Number(ref.version) };
}

/** True only for a standalone saved definition whose sole step is
 * review_reply. Mixed definitions use reviewReplyFollowUp() after their
 * metadata prefix completes; this predicate is kept for the separate
 * standalone hand-off path. */
export function isReviewReplySavedDefinition(definition: InboxActionDefinition): definition is InboxActionDefinition & { steps: readonly [{ type: "review_reply"; text: string }] } {
    return definition.steps.length === 1 && definition.steps[0].type === "review_reply";
}

/** Returns the optional final reply handoff for a mixed metadata definition.
 * The returned template is a display hint from the already-resolved stored
 * definition; it never authorizes a send and is never used as a reply target
 * or rendered body. */
export function reviewReplyFollowUp(definition: InboxActionDefinition): { kind: "review_reply"; template: string } | undefined {
    const finalStep = definition.steps[definition.steps.length - 1];
    return finalStep?.type === "review_reply" ? { kind: "review_reply", template: finalStep.text } : undefined;
}

/** Builds the reply-prepare wire payload from ALREADY-VALIDATED values only:
 * `idempotencyKey`/`targets` must come from parseInboxActionIntent's parsed
 * result (the SAME hardened envelope validator — exact required-key set,
 * duplicate-decoded-key rejection, uuid/target shape+bounds — a normal
 * saved-action or inline request goes through), never from an ad-hoc
 * re-parse of the raw request body. This is what makes the review_reply
 * hand-off go through the identical envelope validation as every other
 * request this endpoint accepts, instead of bypassing it: an
 * invalid/oversized/malformed envelope never reaches this function at all
 * — parseInboxActionIntent already rejected it upstream with
 * InvalidInboxActionError. The rebuilt payload is still independently
 * re-validated by reply-api.ts's own parseInboxReplyPrepareRequest
 * (idempotencyKey/targets/template total-DTO check), so nothing here
 * skips that check either — it is layered validation, not a substitute for
 * it. Only ever reaches reply PREPARE, never accept/send — review_reply
 * saved actions still require the normal reviewed-reply accept step. */
export function buildReplyHandoffPayload(idempotencyKey: string, targets: readonly { kind: "conversation" | "unknown_sender_group"; id: string }[], definition: InboxActionDefinition): string {
    if (definition.steps.length !== 1 || definition.steps[0].type !== "review_reply") throw new InvalidInboxActionError();
    return JSON.stringify({ idempotencyKey, targets, template: definition.steps[0].text });
}
