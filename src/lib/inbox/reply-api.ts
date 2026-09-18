import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { parseInboxReplyPrepareRequest, parseInboxActionAcceptance } from "./action-definition";
import { InvalidInboxActionError } from "./action-definition";
import { renderReviewedReply, ReplyTemplateError } from "./reply-template";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";
import { getOutboundSenderName } from "@/lib/messaging/sender-persona";
import { INBOX_REPLY_EXCLUSIONS, INBOX_REPLY_RECIPIENT_LIMIT, type AcceptedInboxReply, type InboxReplyExclusion, type InboxReplyReceipt, type InboxReplyReceiptState, type InboxReplyRecovery, type InboxReplyStatus, type InboxReplyTarget, type PreparedInboxReply, type PreparedInboxReplyItem } from "./reply-api-contract";

type ReplyDatabase = Omit<Database, "public"> & {
    public: Omit<Database["public"], "Functions"> & {
        Functions: Database["public"]["Functions"] & {
            inbox_capture_reply_recipients: {
                Args: { conversation_ids: string[] };
                Returns: Json;
            };
            inbox_freeze_reply_review: {
                Args: { canonical_input: string; idempotency_key: string };
                Returns: Json;
            };
            /** Loads an accepted metadata operation's immutable target/template
             * snapshot. The coordinator then uses the same current capture,
             * renderer, and freeze path as an ordinary reply preparation. */
            inbox_reply_source_context: {
                Args: { source_operation_id: string };
                Returns: Json;
            };
            inbox_accept_reply: {
                Args: { preparation_id: string; idempotency_key: string };
                Returns: Json;
            };
            inbox_recover_reply: {
                Args: { preparation_id: string; idempotency_key: string };
                Returns: Json;
            };
            inbox_reply_operation_status: {
                Args: { operation_id: string };
                Returns: Json;
            };
        };
    };
};
export type InboxReplyClient = Pick<SupabaseClient<ReplyDatabase>, "rpc">;

export class InboxReplyApiError extends Error {
    constructor(readonly status: number, readonly code = "action_unavailable") { super(code); }
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;
const DRAFT_RENDER_EXCLUSIONS = new Set<InboxReplyExclusion>(["missing_variable", "invalid_template", "invalid_body"]);
// The probe render exercises every template-supported variable with a
// non-empty placeholder so missing_variable can never surface here — any
// error this call throws is a template-wide defect (C3), never per-recipient
// data. Kept local: reply-template.ts intentionally does not export its
// VARIABLES set, so this placeholder map is redeclared explicitly instead of
// importing internals across the module boundary.
const PROBE_VARS: Record<string, string> = {
    first_name: "x", last_name: "x", property_address: "x", city: "x", state: "x",
    property_zip: "x", market: "x", my_first_name: "x", company_name: "x",
};

function need(value: unknown, status = 503): asserts value { if (!value) throw new InboxReplyApiError(status); }
function record(value: unknown): Record<string, unknown> { need(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function id(value: unknown): string { need(typeof value === "string" && UUID.test(value)); return value; }
function e164(value: unknown): string { need(typeof value === "string" && E164.test(value)); return value; }
function timestamp(value: unknown): string { need(typeof value === "string" && Number.isFinite(Date.parse(value))); return value; }
function count(value: unknown, max: number): number { need(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max); return Number(value); }
function bool(value: unknown): boolean { need(typeof value === "boolean"); return value; }
function requireReplyEnabled(): void {
    // The route gate is intentionally duplicated at the repository boundary:
    // action-api can hand off a single or mixed saved definition internally,
    // so a DB admission row alone must not make reply capture reachable while
    // the HTTP release flag is off.
    if (process.env.INBOX_REPLIES_SERVER_ENABLED !== "1")
        throw new InboxReplyApiError(404, "Not found");
}

function failure(error: { code?: string; message?: string } | null): void {
    if (!error) return;
    if (error.code === "PGRST301" || error.code === "PGRST303")
        throw new InboxReplyApiError(401, "authentication_required");
    if (error.code === "42501") {
        if (["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(error.message ?? ""))
            throw new InboxReplyApiError(401, "authentication_required");
        // Mirrors action-api.ts:60-68: membership/org/requester-forbidden AND
        // "unavailable" (preparation/operation not found or not this
        // requester's) both fail closed to the same 403 — never distinguish
        // "exists but not yours" from "doesn't exist".
        if (["INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ORG_DENIED", "INBOX_ACTION_FORBIDDEN", "INBOX_REPLY_PREPARATION_UNAVAILABLE", "INBOX_REPLY_OPERATION_UNAVAILABLE"].includes(error.message ?? ""))
            throw new InboxReplyApiError(403, "access_unavailable");
    }
    // Half-enabled (admission closed) must be indistinguishable from the flag
    // being off entirely (C1): identical status AND identical body.
    if (error.code === "55000")
        throw new InboxReplyApiError(404, "Not found");
    if (error.code === "P0001") {
        const conflicts: Record<string, string> = {
            INBOX_REPLY_PREPARATION_CHANGED: "preparation_changed",
            INBOX_REPLY_IDEMPOTENCY_MISMATCH: "idempotency_mismatch",
            INBOX_REPLY_PREPARATION_EXPIRED: "preparation_expired",
            INBOX_REPLY_PREPARATION_KEY_MISMATCH: "preparation_key_mismatch",
            INBOX_REPLY_KEY_REUSED: "key_reused",
            INBOX_REPLY_PREPARATION_ACCEPTED: "preparation_accepted",
            INBOX_REPLY_DESTINATION_IN_PROGRESS: "destination_in_progress",
            INBOX_REPLY_ATTEMPT_IDENTITY: "attempt_conflict",
            INBOX_REPLY_RECIPIENT_LIMIT: "recipient_limit",
        };
        if (error.message && conflicts[error.message])
            throw new InboxReplyApiError(409, conflicts[error.message]);
    }
    throw new InboxReplyApiError(503);
}

function captureItem(value: unknown): Record<string, unknown> {
    const row = record(value);
    need(typeof row.conversation_id === "string" && UUID.test(row.conversation_id));
    return row;
}

function draftFor(conversationId: string, template: string, capture: Record<string, unknown>): { conversationId: string; body: string; dependencies: Json; exclusion: null } | { conversationId: string; body: null; dependencies: Json; exclusion: InboxReplyExclusion } {
    const dependencies = capture.dependencies as Json;
    const variables = record(capture.variables);
    // C4: my_first_name is coordinator-supplied from getOutboundSenderName(),
    // merged over anything captured — it is never a frozen dependency, so a
    // sender-name change never invalidates an already-frozen preparation.
    const vars = { ...variables, my_first_name: getOutboundSenderName() } as Record<string, string | number | null | undefined>;
    try {
        const body = renderReviewedReply(template, vars);
        return { conversationId, body, dependencies, exclusion: null };
    } catch (error) {
        if (error instanceof ReplyTemplateError && DRAFT_RENDER_EXCLUSIONS.has(error.code as InboxReplyExclusion))
            return { conversationId, body: null, dependencies, exclusion: error.code as InboxReplyExclusion };
        throw error;
    }
}

function nonEmptyString(value: unknown): string { need(typeof value === "string" && value.length > 0); return value as string; }

// B1-1: validation is TOTAL — every field below is checked, and any failure
// (missing/malformed field, an impossible exclusion/recipient combination, a
// non-conversation target claiming eligibility) is a fail-closed 503. There is
// no partial-trust path: a forged or broken freeze response can never produce
// a partially-valid DTO.
function item(value: unknown, expectedBody: Map<string, string>, replayed: boolean): PreparedInboxReplyItem {
    const row = record(value);
    need(row.target !== null && typeof row.target === "object");
    const target = record(row.target);
    need((target.kind === "conversation" || target.kind === "unknown_sender_group") && typeof target.id === "string" && UUID.test(target.id));
    need(row.exclusion === null || (typeof row.exclusion === "string" && INBOX_REPLY_EXCLUSIONS.has(row.exclusion as InboxReplyExclusion)));
    const duplicateDestination = bool(row.duplicateDestination);
    if (row.exclusion !== null) {
        // recipient must be JSON null STRICTLY — view() always emits an
        // explicit `null` for an excluded item's recipient, never omits the
        // key, so `undefined` here is never legitimate.
        need(row.recipient === null);
        need(duplicateDestination === false);
        return { id: id(row.id), target: { kind: target.kind, id: target.id }, exclusion: row.exclusion as InboxReplyExclusion, recipient: null, duplicateDestination };
    }
    // An eligible item (exclusion === null) can only ever be a "conversation"
    // target: freeze() marks every non-conversation target 'unsupported_target'
    // (setup.sql:95), so an eligible non-conversation item can only be a
    // forged or broken response. Fail closed rather than special-case it.
    need(target.kind === "conversation");
    const recipient = record(row.recipient);
    const renderedBody = recipient.renderedBody;
    need(typeof renderedBody === "string" && renderedBody.trim().length > 0 && renderedBody.length <= 1600);
    // Frozen items are operator-authored intent at the same trust level as
    // the template. An authenticated caller can call freeze() directly, so
    // BOTH the literal body AND the per-recipient rendering exclusion
    // (missing_variable | invalid_template | invalid_body) may be client-
    // chosen — including bodies the TS renderer would reject (literal
    // "{{"/"}}"), and self-exclusions of the caller's own eligible rows.
    // Neither can widen a send: freeze consults a draft only for a
    // conversation the canonical capture already marked eligible, takes
    // recipient/from/to/dependencies from the capture, requires byte-equal
    // dependencies, and scopes rows by (org, requester, key). The renderer's
    // token validation is an authoring aid, not a safety control. Send
    // safety rests on canonical routes/eligibility/consent/deps/cap, re-run
    // at accept and claim (E4/D1/D5); a frozen exclusion is send-suppression
    // only, never send-authorization (P-GATE). This equality is a coordinator
    // self-check against a broken/altered freeze RESPONSE on a fresh freeze —
    // NOT proof of server rendering.
    if (!replayed) {
        const expected = expectedBody.get(target.id);
        need(expected !== undefined && expected === renderedBody);
    }
    return {
        id: id(row.id),
        target: { kind: target.kind, id: target.id },
        exclusion: null,
        recipient: {
            contactName: nonEmptyString(recipient.contactName),
            propertyAddress: (() => { need(typeof recipient.propertyAddress === "string"); return recipient.propertyAddress; })(),
            propertyId: id(recipient.propertyId),
            contactId: id(recipient.contactId),
            from: e164(recipient.from),
            to: e164(recipient.to),
            renderedBody,
        },
        duplicateDestination,
    };
}

/** Decode a freeze result completely before exposing it to the caller. Both
 * ordinary and metadata-follow-up preparations use the same coordinator
 * renderer and fresh-capture body equality. */
function decodePreparedReply(
    value: unknown,
    expectedIdempotencyKey: string,
    expectedTargets: readonly InboxReplyTarget[] | null,
    expectedBodies: Map<string, string>,
): PreparedInboxReply {
    const row = record(value);
    need(typeof row.idempotencyKey === "string" && row.idempotencyKey === expectedIdempotencyKey);
    const replayed = bool(row.replayed);
    need(Array.isArray(row.items));
    need(row.items.length === (expectedTargets?.length ?? row.items.length));
    need(row.items.length > 0 && row.items.length <= 500);
    const seenTargets = new Set<string>();
    const seenIds = new Set<string>();
    const items = row.items.map((raw: unknown) => {
        const decoded = item(raw, expectedBodies, replayed);
        const key = `${decoded.target.kind}:${decoded.target.id}`;
        need(!seenTargets.has(key));
        seenTargets.add(key);
        need(!seenIds.has(decoded.id));
        seenIds.add(decoded.id);
        return decoded;
    });
    if (expectedTargets) for (const target of expectedTargets)
        need(seenTargets.has(`${target.kind}:${target.id}`));
    const eligible = items.filter(i => i.exclusion === null);
    const distinctDestinations = new Set(eligible.map(i => i.recipient?.to));
    const recipientCount = count(row.recipientCount, 500);
    need(recipientCount === distinctDestinations.size);
    const destinationCounts = new Map<string, number>();
    for (const i of eligible) destinationCounts.set(i.recipient!.to, (destinationCounts.get(i.recipient!.to) ?? 0) + 1);
    let anyDuplicate = false;
    for (const i of eligible) {
        const isDuplicate = (destinationCounts.get(i.recipient!.to) ?? 0) >= 2;
        need(i.duplicateDestination === isDuplicate);
        if (isDuplicate) anyDuplicate = true;
    }
    need(eligible.length >= recipientCount);
    need(anyDuplicate ? eligible.length > recipientCount : eligible.length === recipientCount);
    need(Array.isArray(row.blockers) && row.blockers.every((b: unknown) => b === "empty" || b === "recipient_limit" || b === "duplicate_destination"));
    const blockers = row.blockers as readonly ("empty" | "recipient_limit" | "duplicate_destination")[];
    need(new Set(blockers).size === blockers.length);
    need(blockers.includes("empty") === (recipientCount === 0));
    need(blockers.includes("recipient_limit") === (recipientCount > INBOX_REPLY_RECIPIENT_LIMIT));
    need(blockers.includes("duplicate_destination") === anyDuplicate);
    return {
        preparationId: id(row.preparationId),
        idempotencyKey: expectedIdempotencyKey,
        inputHash: (() => { need(typeof row.inputHash === "string" && /^[a-f0-9]{64}$/.test(row.inputHash)); return row.inputHash; })(),
        expiresAt: timestamp(row.expiresAt),
        items,
        recipientCount,
        blockers,
    };
}

export function createInboxReplyRepository(client: InboxReplyClient) {
    return {
        async prepare(raw: string, signal: AbortSignal): Promise<PreparedInboxReply> {
            requireReplyEnabled();
            signal.throwIfAborted();
            let parsed: ReturnType<typeof parseInboxReplyPrepareRequest>;
            try {
                parsed = parseInboxReplyPrepareRequest(raw);
            } catch (error) {
                if (error instanceof InvalidInboxActionError)
                    throw new InboxReplyApiError(400, "invalid_reply");
                throw error;
            }
            if ("sourceOperationId" in parsed) {
                // The source operation is the only authority for the original
                // targets and final template. The context RPC performs the
                // accepted-operation/terminal/auth checks. Rendering then
                // deliberately continues through the exact same server
                // renderer + canonical capture + freeze path as an ordinary
                // reviewed reply; the client supplies none of those values.
                need(typeof parsed.sourceOperationId === "string");
                const sourceOperationId = parsed.sourceOperationId;
                const sourceResult = await retryReceiptTransaction(() => {
                    signal.throwIfAborted();
                    return client.rpc("inbox_reply_source_context", {
                        source_operation_id: sourceOperationId,
                    }).abortSignal(signal);
                });
                signal.throwIfAborted();
                failure(sourceResult.error);
                const source = record(sourceResult.data);
                need(source.sourceOperationId === sourceOperationId && Array.isArray(source.targets) && typeof source.template === "string");
                try {
                    // Re-apply the hardened legacy shape parser to server
                    // context before using it. This is a structural decoder,
                    // not a trust transfer from client input.
                    parsed = parseInboxReplyPrepareRequest(JSON.stringify({ idempotencyKey: parsed.idempotencyKey, targets: source.targets, template: source.template }));
                } catch {
                    throw new InboxReplyApiError(503);
                }
            }
            // C3: template-wide errors are rejected before any RPC, via a probe
            // render against every supported variable set non-empty. Any error
            // here (invalid syntax, an unsupported variable, or a template that
            // can never render a non-empty body) is a template-wide 400, never a
            // per-recipient exclusion.
            try {
                renderReviewedReply(parsed.template, PROBE_VARS);
            } catch (error) {
                if (error instanceof ReplyTemplateError)
                    throw new InboxReplyApiError(400, "invalid_template");
                throw error;
            }
            const conversationIds = parsed.targets.filter((t): t is InboxReplyTarget => t.kind === "conversation").map(t => t.id);
            let drafts: { conversationId: string; body: string | null; dependencies: Json; exclusion: InboxReplyExclusion | null }[] = [];
            let renderedBodyByConversation = new Map<string, string>();
            if (conversationIds.length > 0) {
                const captureResult = await retryReceiptTransaction(() => {
                    signal.throwIfAborted();
                    return client.rpc("inbox_capture_reply_recipients", { conversation_ids: conversationIds }).abortSignal(signal);
                });
                signal.throwIfAborted();
                failure(captureResult.error);
                const captured = record(captureResult.data);
                need(Array.isArray(captured.items));
                // Drafts are always built from THIS (the latest successful)
                // capture — never a stale one from an earlier aborted attempt —
                // because retryReceiptTransaction only returns the final result
                // and this render happens strictly after that return.
                const built: typeof drafts = [];
                const bodies = new Map<string, string>();
                for (const raw of captured.items) {
                    const capture = captureItem(raw);
                    need(typeof capture.conversation_id === "string");
                    // C5: drafts built ONLY for capture items with exclusion ===
                    // null. A capture-level exclusion is carried by the SQL freeze
                    // step directly from its own recomputed capture; no draft
                    // entry is emitted for it here.
                    if (capture.exclusion !== null) continue;
                    const draft = draftFor(capture.conversation_id, parsed.template, capture);
                    built.push(draft);
                    if (draft.exclusion === null) bodies.set(capture.conversation_id, draft.body as string);
                }
                drafts = built;
                renderedBodyByConversation = bodies;
            }
            const canonicalInput = JSON.stringify({
                targets: parsed.targets.map(t => ({ kind: t.kind, id: t.id })),
                drafts: drafts.map(d => ({ conversationId: d.conversationId, body: d.body, dependencies: d.dependencies, exclusion: d.exclusion })),
                template: parsed.template,
            });
            // C9: HTTP already caps request bytes at 131072 (targets+template
            // only); this is the separate assert on the full canonical envelope
            // (targets+drafts+template) the coordinator sends to freeze.
            need(Buffer.byteLength(canonicalInput, "utf8") <= 2 * 1024 * 1024);
            signal.throwIfAborted();
            const freezeResult = await retryReceiptTransaction(() => {
                signal.throwIfAborted();
                return client.rpc("inbox_freeze_reply_review", { canonical_input: canonicalInput, idempotency_key: parsed.idempotencyKey }).abortSignal(signal);
            });
            signal.throwIfAborted();
            failure(freezeResult.error);
            return decodePreparedReply(freezeResult.data, parsed.idempotencyKey, parsed.targets, renderedBodyByConversation);
        },
        async accept(raw: string, signal: AbortSignal): Promise<AcceptedInboxReply> {
            requireReplyEnabled();
            signal.throwIfAborted();
            let parsed: ReturnType<typeof parseInboxActionAcceptance>;
            try {
                parsed = parseInboxActionAcceptance(raw);
            } catch (error) {
                if (error instanceof InvalidInboxActionError)
                    throw new InboxReplyApiError(400, "invalid_reply");
                throw error;
            }
            const result = await retryReceiptTransaction(() => { signal.throwIfAborted(); return client.rpc("inbox_accept_reply", { preparation_id: parsed.preparationId, idempotency_key: parsed.idempotencyKey }).abortSignal(signal); });
            signal.throwIfAborted();
            failure(result.error);
            const row = record(result.data);
            need(id(row.preparation_id) === parsed.preparationId);
            return { preparationId: parsed.preparationId, idempotencyKey: parsed.idempotencyKey, operationId: id(row.operation_id) };
        },
        async recover(preparationId: string, idempotencyKey: string, signal: AbortSignal): Promise<InboxReplyRecovery> {
            need(UUID.test(preparationId) && UUID.test(idempotencyKey), 400);
            signal.throwIfAborted();
            const response = await retryReceiptTransaction(() => { signal.throwIfAborted(); return client.rpc("inbox_recover_reply", { preparation_id: preparationId, idempotency_key: idempotencyKey }).abortSignal(signal); });
            signal.throwIfAborted();
            failure(response.error);
            const row = record(response.data);
            if (row.state === "prepared" || row.state === "expired_not_accepted") {
                need(row.operation === null && row.preparationId === preparationId && row.idempotencyKey === idempotencyKey);
                return { state: row.state, preparationId, idempotencyKey };
            }
            need(row.state === "accepted");
            const operation = record(row.operation);
            need(operation.preparationId === preparationId && operation.idempotencyKey === idempotencyKey);
            return { state: "accepted", operation: { preparationId, idempotencyKey, operationId: id(operation.operationId) } };
        },
        async status(operationId: string, signal: AbortSignal): Promise<InboxReplyStatus> {
            need(UUID.test(operationId), 400);
            signal.throwIfAborted();
            const result = await client.rpc("inbox_reply_operation_status", { operation_id: operationId }).abortSignal(signal);
            signal.throwIfAborted();
            failure(result.error);
            const row = record(result.data);
            need(row.operationId === operationId && typeof row.preparationId === "string" && typeof row.dispatchComplete === "boolean"
                && Array.isArray(row.items) && row.items.length > 0 && row.items.length <= 500
                && Array.isArray(row.receipts) && row.receipts.length <= 500);
            const seenItemIds = new Set<string>();
            // The frozen items array was already validated at prepare() time;
            // replayed=true skips the fresh-render body-equality check (there
            // is no fresh render at status time), matching the B2 replay path.
            const items = row.items.map((raw: unknown) => {
                const decoded = item(raw, new Map(), true);
                need(!seenItemIds.has(decoded.id));
                seenItemIds.add(decoded.id);
                return decoded;
            });
            const RECEIPT_STATES = new Set<InboxReplyReceiptState>(["pending", "blocked", "dispatch_started", "uncertain", "provider_accepted", "delivered", "delivery_failed", "rejected_unsent", "confirmed_not_submitted"]);
            const TERMINAL_RECEIPT_STATES = new Set<InboxReplyReceiptState>(["provider_accepted", "delivered", "delivery_failed", "rejected_unsent", "confirmed_not_submitted"]);
            const seenReceiptItemIds = new Set<string>();
            const receipts: InboxReplyReceipt[] = row.receipts.map((raw: unknown) => {
                const r = record(raw);
                const itemId = id(r.itemId);
                need(!seenReceiptItemIds.has(itemId) && seenItemIds.has(itemId));
                seenReceiptItemIds.add(itemId);
                need(r.attemptId === null || (typeof r.attemptId === "string" && UUID.test(r.attemptId)));
                need(typeof r.version === "string" && /^(0|[1-9][0-9]{0,18})$/.test(r.version));
                need(typeof r.state === "string" && RECEIPT_STATES.has(r.state as InboxReplyReceiptState));
                need(r.reason === null || typeof r.reason === "string");
                return { itemId, attemptId: r.attemptId as string | null, version: r.version, state: r.state as InboxReplyReceiptState, reason: r.reason as string | null };
            });
            need(row.dispatchComplete === receipts.every(r => TERMINAL_RECEIPT_STATES.has(r.state)));
            return { operationId, preparationId: row.preparationId, dispatchComplete: row.dispatchComplete, items, receipts };
        },
    };
}
