import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { parseInboxReplyPrepareRequest } from "./action-definition";
import { InvalidInboxActionError } from "./action-definition";
import { renderReviewedReply, ReplyTemplateError } from "./reply-template";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";
import { getOutboundSenderName } from "@/lib/messaging/sender-persona";
import { INBOX_REPLY_EXCLUSIONS, type InboxReplyExclusion, type InboxReplyTarget, type PreparedInboxReply, type PreparedInboxReplyItem } from "./reply-api-contract";

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

function failure(error: { code?: string; message?: string } | null): void {
    if (!error) return;
    if (error.code === "PGRST301" || error.code === "PGRST303")
        throw new InboxReplyApiError(401, "authentication_required");
    if (error.code === "42501") {
        if (["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(error.message ?? ""))
            throw new InboxReplyApiError(401, "authentication_required");
        if (["INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ORG_DENIED", "INBOX_ACTION_FORBIDDEN"].includes(error.message ?? ""))
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

function item(value: unknown, expectedBody: Map<string, string>): PreparedInboxReplyItem {
    const row = record(value);
    need(row.target !== null && typeof row.target === "object");
    const target = record(row.target);
    need((target.kind === "conversation" || target.kind === "unknown_sender_group") && typeof target.id === "string" && UUID.test(target.id));
    need(row.exclusion === null || (typeof row.exclusion === "string" && INBOX_REPLY_EXCLUSIONS.has(row.exclusion as InboxReplyExclusion)));
    const duplicateDestination = bool(row.duplicateDestination);
    if (row.exclusion !== null) {
        need(row.recipient === null || row.recipient === undefined);
        return { id: id(row.id), target: { kind: target.kind, id: target.id }, exclusion: row.exclusion as InboxReplyExclusion, recipient: null, duplicateDestination };
    }
    const recipient = record(row.recipient);
    const renderedBody = recipient.renderedBody;
    need(typeof renderedBody === "string");
    if (target.kind === "conversation") {
        const expected = expectedBody.get(target.id);
        need(expected !== undefined && expected === renderedBody);
    }
    return {
        id: id(row.id),
        target: { kind: target.kind, id: target.id },
        exclusion: null,
        recipient: {
            contactName: (() => { need(typeof recipient.contactName === "string"); return recipient.contactName; })(),
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

export function createInboxReplyRepository(client: InboxReplyClient) {
    return {
        async prepare(raw: string, signal: AbortSignal): Promise<PreparedInboxReply> {
            signal.throwIfAborted();
            let parsed: ReturnType<typeof parseInboxReplyPrepareRequest>;
            try {
                parsed = parseInboxReplyPrepareRequest(raw);
            } catch (error) {
                if (error instanceof InvalidInboxActionError)
                    throw new InboxReplyApiError(400, "invalid_reply");
                throw error;
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
            const row = record(freezeResult.data);
            need(Array.isArray(row.items));
            need(row.items.length === parsed.targets.length);
            const seenTargets = new Set<string>();
            const seenIds = new Set<string>();
            const items = row.items.map((raw: unknown) => {
                const decoded = item(raw, renderedBodyByConversation);
                const key = `${decoded.target.kind}:${decoded.target.id}`;
                need(!seenTargets.has(key));
                seenTargets.add(key);
                need(!seenIds.has(decoded.id));
                seenIds.add(decoded.id);
                return decoded;
            });
            for (const target of parsed.targets)
                need(seenTargets.has(`${target.kind}:${target.id}`));
            const eligible = items.filter(i => i.exclusion === null);
            const distinctDestinations = new Set(eligible.map(i => i.recipient?.to));
            const recipientCount = count(row.recipientCount, 500);
            need(recipientCount === distinctDestinations.size);
            need(Array.isArray(row.blockers) && row.blockers.every((b: unknown) => b === "empty" || b === "recipient_limit" || b === "duplicate_destination"));
            const blockers = row.blockers as readonly ("empty" | "recipient_limit" | "duplicate_destination")[];
            return {
                preparationId: id(row.preparationId),
                idempotencyKey: parsed.idempotencyKey,
                inputHash: (() => { need(typeof row.inputHash === "string" && /^[a-f0-9]{64}$/.test(row.inputHash)); return row.inputHash; })(),
                expiresAt: timestamp(row.expiresAt),
                items,
                recipientCount,
                blockers,
            };
        },
    };
}
