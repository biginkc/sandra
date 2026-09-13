import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import { parseInboxActionIntent, parseInboxActionDefinition, InvalidInboxActionError } from "./action-definition";
import { retryReceiptTransaction } from "@/lib/messaging/receipt-persistence";
import type { InboxAssigneeChoice, AcceptedInboxAction, InboxActionExclusion, InboxMetadataStep, InboxOperationStatus, InboxStepState, PreparedInboxAction, PreparedInboxActionItem } from "./action-api-contract";
type ActionDatabase = Omit<Database, "public"> & {
    public: Omit<Database["public"], "Functions"> & {
        Functions: Database["public"]["Functions"] & {
            inbox_authorize_sync: {
                Args: {
                    org_id?: string;
                };
                Returns: Json;
            };
            inbox_prepare_action: {
                Args: {
                    canonical_input: string;
                    idempotency_key: string;
                };
                Returns: Json;
            };
            inbox_accept_action: {
                Args: {
                    preparation_id: string;
                    idempotency_key: string;
                };
                Returns: Json;
            };
            inbox_action_assignees: { Args: Record<string, never>; Returns: Json };
            inbox_recover_operation: { Args: { idempotency_key: string }; Returns: Json };
            inbox_operation_status: {
                Args: {
                    operation_id: string;
                };
                Returns: Json;
            };
        };
    };
};
export type InboxActionClient = Pick<SupabaseClient<ActionDatabase>, "rpc">;
export class InboxActionApiError extends Error {
    constructor(readonly status: number, readonly code = "action_unavailable") { super(code); }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const STATES = new Set<InboxStepState>(["pending", "running", "succeeded", "failed", "conflicted", "cancelled", "blocked"]);
const TERMINAL = new Set<InboxStepState>(["succeeded", "failed", "conflicted", "cancelled", "blocked"]);
const EXCLUSIONS = new Set<InboxActionExclusion>(["unsupported_target", "unsupported_action", "permanent_dnc_not_enabled", "conversation_unavailable", "property_unavailable", "property_locked", "training_target", "assignee_unavailable", "scope_too_large", "source_baseline_unavailable"]);
function need(value: unknown, status = 503): asserts value { if (!value)
    throw new InboxActionApiError(status); }
function record(value: unknown): Record<string, unknown> { need(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function id(value: unknown): string { need(typeof value === "string" && UUID.test(value)); return value; }
function timestamp(value: unknown): string { need(typeof value === "string" && Number.isFinite(Date.parse(value))); return value; }
function count(value: unknown, max: number): number { need(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max); return Number(value); }
function failure(error: {
    code?: string;
    message?: string;
} | null) {
    if (!error)
        return;
    if (error.code === "PGRST301" || error.code === "PGRST303")
        throw new InboxActionApiError(401, "authentication_required");
    if (error.code === "42501") {
        if (["INBOX_AUTH_REQUIRED", "INBOX_SESSION_EXPIRED", "INBOX_SESSION_REVOKED"].includes(error.message ?? ""))
            throw new InboxActionApiError(401, "authentication_required");
        if (["INBOX_MEMBERSHIP_AMBIGUOUS_OR_MISSING", "INBOX_ORG_DENIED", "INBOX_ACTION_FORBIDDEN"].includes(error.message ?? ""))
            throw new InboxActionApiError(403, "access_unavailable");
        if (["INBOX_ACTION_PREPARATION_UNAVAILABLE", "INBOX_ACTION_OPERATION_UNAVAILABLE"].includes(error.message ?? ""))
            throw new InboxActionApiError(404, "action_unavailable");
    }
    if (error.code === "P0001") {
        const conflicts: Record<string, string> = { INBOX_ACTION_PREPARATION_CHANGED: "preparation_changed", INBOX_ACTION_PREPARATION_EXPIRED_OR_EMPTY: "preparation_expired_or_empty", INBOX_ACTION_IDEMPOTENCY_MISMATCH: "idempotency_mismatch", "Preparation expired": "preparation_expired", "Idempotency conflict": "idempotency_conflict", INBOX_ACTION_ASSIGNEE_UNAVAILABLE: "assignee_unavailable", assignee_unavailable: "assignee_unavailable", permanent_dnc_not_enabled: "permanent_dnc_not_enabled" };
        if (error.message && conflicts[error.message])
            throw new InboxActionApiError(409, conflicts[error.message]);
    }
    throw new InboxActionApiError(503);
}
function serverDefinition(value: unknown) { try {
    return parseInboxActionDefinition(JSON.stringify(value));
}
catch {
    throw new InboxActionApiError(503);
} }
function item(value: unknown): PreparedInboxActionItem {
    const row = record(value), resolution = row.resolution === undefined ? row : record(row.resolution);
    need(row.kind === "conversation" || row.kind === "unknown_sender_group");
    need(row.exclusion_code === null || EXCLUSIONS.has(row.exclusion_code as InboxActionExclusion));
    const propertyId = resolution.property_id === null ? null : id(resolution.property_id);
    need(row.exclusion_code !== null || propertyId !== null);
    return { id: id(row.id), target: { kind: row.kind, id: id(row.target_id) }, propertyId, exclusion: row.exclusion_code as InboxActionExclusion | null };
}
export function createInboxActionRepository(client: InboxActionClient) {
    return {
        async prepare(raw: string, signal: AbortSignal): Promise<PreparedInboxAction> {
            signal.throwIfAborted();
            const authorization = await client.rpc("inbox_authorize_sync", {}).abortSignal(signal);
            failure(authorization.error);
            const actor = record(authorization.data);
            need(actor.session_active === true && actor.active_membership_count === 1, 403);
            let parsed: ReturnType<typeof parseInboxActionIntent>;
            try {
                parsed = parseInboxActionIntent(raw, { organizationId: id(actor.org_id), requesterId: id(actor.user_id) });
            }
            catch (error) {
                if (error instanceof InvalidInboxActionError)
                    throw new InboxActionApiError(400, "invalid_action");
                throw error;
            }
            need(parsed.input.definition.steps.length <= 2, 400);
            need(parsed.input.definition.steps.every((step, index) => step.type === "assign" || (step.type === "outcome" && step.value !== "dnc" && index === 0)), 400);
            const result = await retryReceiptTransaction(() => { signal.throwIfAborted(); return client.rpc("inbox_prepare_action", { canonical_input: parsed.canonicalInput, idempotency_key: parsed.idempotencyKey }).abortSignal(signal); });
            signal.throwIfAborted();
            failure(result.error);
            const row = record(result.data);
            need(row.idempotency_key === parsed.idempotencyKey && row.input_hash === parsed.inputHash && JSON.stringify(serverDefinition(row.definition)) === JSON.stringify(parsed.input.definition), 503);
            need(Array.isArray(row.items) && row.items.length === parsed.input.targets.length);
            const items = row.items.map(item), seen = new Set<string>(), targets = new Set(parsed.input.targets.map(t => `${t.kind}:${t.id}`));
            for (const value of items) {
                const key = `${value.target.kind}:${value.target.id}`;
                need(targets.delete(key) && !seen.has(value.id));
                seen.add(value.id);
            }
            const eligibleCount = items.filter(i => i.exclusion === null).length, affectedPropertyCount = count(row.affected_property_count, 500), effectCount = count(row.effect_count, 1000);
            need(affectedPropertyCount === new Set(items.filter(i => i.exclusion === null).map(i => i.propertyId)).size && effectCount === affectedPropertyCount * parsed.input.definition.steps.length);
            const hasSms = parsed.input.definition.steps.some(s => s.type === "outcome" && s.value === "opted_out");
            need(hasSms ? row.sms_safety_summary !== null : row.sms_safety_summary === null);
            const safety = hasSms ? record(row.sms_safety_summary) : null;
            const smsSafetySummary = safety ? { contacts: count(safety.contacts, 500), linkedProperties: count(safety.linked_properties, 250000), activeEnrollments: count(safety.active_enrollments, 250000) } : null;
            return { smsSafetySummary, preparationId: id(row.preparation_id), idempotencyKey: parsed.idempotencyKey, inputHash: parsed.inputHash, expiresAt: timestamp(row.expires_at), definition: parsed.input.definition as {
                    version: 1;
                    steps: InboxMetadataStep[];
                }, items, eligibleCount, excludedCount: items.length - eligibleCount, affectedPropertyCount, effectCount };
        },
        async accept(preparationId: string, idempotencyKey: string, signal: AbortSignal): Promise<AcceptedInboxAction> {
            need(UUID.test(preparationId) && UUID.test(idempotencyKey), 400);
            const result = await retryReceiptTransaction(() => { signal.throwIfAborted(); return client.rpc("inbox_accept_action", { preparation_id: preparationId, idempotency_key: idempotencyKey }).abortSignal(signal); });
            signal.throwIfAborted();
            failure(result.error);
            const row = record(result.data);
            return { operationId: id(row.operation_id), acceptedAt: timestamp(row.accepted_at) };
        },
        async assignees(signal: AbortSignal): Promise<readonly InboxAssigneeChoice[]> {
            signal.throwIfAborted();
            const response = await client.rpc("inbox_action_assignees", {}).abortSignal(signal);
            signal.throwIfAborted(); failure(response.error);
            const result = record(response.data); need(Array.isArray(result.members) && result.members.length <= 400);
            const seen = new Set<string>();
            return result.members.map(value => { const row = record(value), userId = id(row.user_id); need(!seen.has(userId) && typeof row.label === "string" && row.label.trim().length > 0 && row.label.length <= 320); seen.add(userId); return { userId, label: row.label }; });
        },
        async recover(idempotencyKey: string, signal: AbortSignal): Promise<AcceptedInboxAction | null> {
            need(UUID.test(idempotencyKey), 400); signal.throwIfAborted();
            const response = await client.rpc("inbox_recover_operation", { idempotency_key: idempotencyKey }).abortSignal(signal);
            signal.throwIfAborted(); failure(response.error); const row = record(response.data);
            if (row.operation === null) return null;
            const operation = record(row.operation); return { operationId: id(operation.operation_id), acceptedAt: timestamp(operation.accepted_at) };
        },
        async status(operationId: string, signal: AbortSignal): Promise<InboxOperationStatus> {
            need(UUID.test(operationId), 400);
            signal.throwIfAborted();
            const result = await client.rpc("inbox_operation_status", { operation_id: operationId }).abortSignal(signal);
            signal.throwIfAborted();
            failure(result.error);
            const row = record(result.data);
            need(row.operation_id === operationId && typeof row.completed === "boolean" && Array.isArray(row.steps) && row.steps.length > 0 && row.steps.length <= 1000 && Array.isArray(row.items) && row.items.length > 0 && row.items.length <= 500);
            const seen = new Set<string>();
            const steps = row.steps.map(value => {
                const step = record(value), stepId = id(step.id);
                need(!seen.has(stepId));
                seen.add(stepId);
                need((step.action === "outcome" || step.action === "assign") && STATES.has(step.state as InboxStepState));
                need(step.code === null || (typeof step.code === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(step.code)));
                need(typeof step.receipt_version === "string" && /^(0|[1-9][0-9]{0,18})$/.test(step.receipt_version) && BigInt(step.receipt_version) <= BigInt("9223372036854775807"));
                need(step.changed === null || typeof step.changed === "boolean");
                const state = step.state as InboxStepState;
                need(TERMINAL.has(state) === (BigInt(step.receipt_version) > BigInt(0)));
                need(state === "succeeded" ? step.code === null : !TERMINAL.has(state) || step.code !== null);
                return { id: stepId, action: step.action as "outcome" | "assign", state, code: step.code as string | null, receiptVersion: step.receipt_version, changed: step.changed as boolean | null };
            });
            const itemIds = new Set<string>();
            const items = row.items.map(value => { const source = record(value), decoded = item(value); need(!itemIds.has(decoded.id)); itemIds.add(decoded.id); need(Array.isArray(source.step_ids) && source.step_ids.length <= 2 && source.step_ids.every(s => typeof s === "string" && seen.has(s)) && new Set(source.step_ids).size === source.step_ids.length); need(source.state === "excluded" || STATES.has(source.state as InboxStepState)); need(source.code === null || typeof source.code === "string"); need(decoded.exclusion === null ? source.step_ids.length > 0 : source.state === "excluded" && source.step_ids.length === 0); return { ...decoded, stepIds: source.step_ids as string[], state: source.state as InboxStepState | "excluded", code: source.code as string | null }; });
            need(row.completed === steps.every(s => TERMINAL.has(s.state)));
            const expected = !row.completed ? null : steps.every(s => s.state === "succeeded") ? "succeeded" : steps.some(s => s.state === "succeeded") ? "partial" : steps.every(s => s.state === "cancelled") ? "cancelled" : "failed";
            need(row.result === expected);
            return { operationId, acceptedAt: timestamp(row.accepted_at), completed: row.completed, result: expected, items, steps };
        }
    };
}
