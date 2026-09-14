"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { PreparedInboxAction, PrepareInboxActionRequest, AcceptedInboxAction, InboxOperationStatus, InboxMetadataOutcome, InboxAssigneeChoice } from "@/lib/inbox/action-api-contract";
import { useInboxActionRecovery } from "./use-action-recovery";
import type { InboxQueryIdentity, createInboxQueryCache } from "@/lib/inbox/workspace-query";
import type { WorkspaceAction } from "./inbox-workspace";
import type { WorkspaceId } from "./selection";
const outcomes: readonly [
    InboxMetadataOutcome,
    string
][] = [["wrong_number", "Wrong number"], ["bad_number", "Bad number"], ["not_interested", "Not interested"], ["needs_sequence", "Needs sequence"], ["nurture", "Nurture"], ["opted_out", "SMS opt-out"]];
const exclusionLabels: Record<string, string> = { unsupported_target: "This sender group needs individual attention", unsupported_action: "This action is unavailable", permanent_dnc_not_enabled: "Permanent DNC is not available here", conversation_unavailable: "Conversation is no longer available", property_unavailable: "No eligible property is linked", property_locked: "The linked property cannot be changed", training_target: "Training records cannot be changed here", assignee_unavailable: "Assignee is unavailable", scope_too_large: "This selection is too large", source_baseline_unavailable: "Current data could not be verified" };
type Draft = {
    request: PrepareInboxActionRequest;
    names: ReadonlyMap<string, string>;
    prepared?: PreparedInboxAction;
    stage: "preparing" | "prepared" | "accepting";
    error?: string;
    acceptAttempted?: boolean;
    assigneeLabel?: string;
};
class ActionRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
}
interface Options {
    enabled: boolean;
    orgId: string;
    selectionCount: number;
    identity: InboxQueryIdentity;
    names: ReadonlyMap<WorkspaceId, string>;
    cache: ReturnType<typeof createInboxQueryCache>;
    onAccessLost: () => void;
    onCompleted: () => void;
}
/** Click and drop both call prepare; neither dispatches a mutation directly. */
export function useInboxMetadataActions(options: Options) {
    const [draft, setDraft] = useState<Draft | null>(null);
    const [receipt, setReceipt] = useState<InboxOperationStatus | null>(null);
    const [receiptNames, setReceiptNames] = useState<ReadonlyMap<string, string>>(new Map());
    const [operationId, setOperationId] = useState<string>();
    const [receiptError, setReceiptError] = useState(false);
    const [retry, setRetry] = useState(0);
    const [configuration, setConfiguration] = useState<{
        ids: readonly WorkspaceId[];
        mode: "assign" | "combined";
        outcome: InboxMetadataOutcome | "";
        assignee: string;
        members: readonly InboxAssigneeChoice[];
        loading: boolean;
        error?: string;
    } | null>(null);
    const generation = useRef(0), current = useRef<AbortController | null>(null), completed = useRef<string | undefined>(undefined);
    const recovery = useInboxActionRecovery({ identity: options.identity, enabled: options.enabled, onAccessLost: options.onAccessLost, onRecovered: value => { setOperationId(value.operationId); setReceipt(null); setReceiptError(false); setDraft(null); }, onExpired: () => setDraft(null) });
    const { clear: clearRecovery, completed: completeRecovery } = recovery;
    const latest = useRef(options);
    useEffect(() => { latest.current = options; }, [options]);
    useEffect(() => () => { generation.current++; current.current?.abort(); }, []);
    async function json<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
        const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), credentials: "same-origin", cache: "no-store", redirect: "error" });
        if (response.status === 401 || response.status === 403) {
            latest.current.onAccessLost();
            throw Error("Your access has changed.");
        }
        if (!response.ok)
            throw new ActionRequestError(response.status === 409 ? "The records changed. Prepare the action again." : "The request could not be completed. You can retry safely.", response.status);
        const value = await response.json();
        signal.throwIfAborted();
        return value;
    }
    async function prepareDraft(next: Draft) {
        const token = ++generation.current;
        current.current?.abort();
        const controller = new AbortController();
        current.current = controller;
        setDraft({ ...next, prepared: undefined, stage: "preparing", error: undefined });
        try {
            const value = await json<PreparedInboxAction>("/api/inbox/actions/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next.request) }, controller.signal);
            if (token !== generation.current || controller.signal.aborted)
                return;
            if (!value.preparationId || value.idempotencyKey !== next.request.idempotencyKey || !Array.isArray(value.items) || value.items.length !== next.request.targets.length || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() || [value.eligibleCount, value.excludedCount, value.affectedPropertyCount, value.effectCount].some(n => !Number.isSafeInteger(n) || n < 0) || value.eligibleCount + value.excludedCount !== value.items.length)
                throw Error("The action review could not be verified.");
            if (value.smsSafetySummary !== null && (!value.smsSafetySummary || [value.smsSafetySummary.contacts, value.smsSafetySummary.linkedProperties, value.smsSafetySummary.activeEnrollments].some(n => !Number.isSafeInteger(n) || n < 0)))
                throw Error("The SMS eligibility scope could not be verified.");
            const expected = new Set(next.request.targets.map(target => `${target.kind}:${target.id}`));
            if (JSON.stringify(value.definition) !== JSON.stringify(next.request.definition) || new Set(value.items.map(item => `${item.target.kind}:${item.target.id}`)).size !== expected.size || value.items.some(item => !expected.has(`${item.target.kind}:${item.target.id}`)))
                throw Error("The action review did not match this selection.");
            setDraft({ ...next, prepared: value, stage: "prepared" });
        }
        catch (error) {
            if (token === generation.current && !controller.signal.aborted)
                setDraft({ ...next, stage: "prepared", error: error instanceof Error ? error.message : "Action unavailable." });
        }
    }
    async function configure(ids: readonly WorkspaceId[], mode: "assign" | "combined") {
        const token = ++generation.current;
        current.current?.abort();
        const controller = new AbortController();
        current.current = controller;
        setConfiguration({ ids, mode, outcome: "", assignee: "", members: [], loading: true });
        try {
            const value = await options.cache.read<{
                members: InboxAssigneeChoice[];
            }>("context", "action-assignees", signal => json("/api/inbox/actions/assignees", {}, AbortSignal.any([signal, controller.signal])));
            if (token !== generation.current || controller.signal.aborted)
                return;
            if (!Array.isArray(value.members) || value.members.length > 400 || value.members.some(member => typeof member.userId !== "string" || typeof member.label !== "string"))
                throw Error("Assignee choices could not be verified.");
            setConfiguration({ ids, mode, outcome: "", assignee: "", members: value.members, loading: false });
        }
        catch {
            if (token === generation.current && !controller.signal.aborted)
                setConfiguration({ ids, mode, outcome: "", assignee: "", members: [], loading: false, error: "Assignee choices could not load. Try again." });
        }
    }
    function makeDraft(ids: readonly WorkspaceId[], steps: PrepareInboxActionRequest["definition"]["steps"], assigneeLabel?: string): Draft {
        const names = new Map<string, string>();
        const targets = ids.map(id => { const [org, kind, targetId] = JSON.parse(id); if (org !== options.orgId || !["conversation", "unknown_sender_group"].includes(kind))
            throw Error("Selection does not match this workspace."); names.set(`${kind}:${targetId}`, options.names.get(id) ?? "Selected conversation"); return { kind, id: targetId }; });
        return { stage: "preparing", names, assigneeLabel, request: { idempotencyKey: crypto.randomUUID(), targets, definition: { version: 1, steps } } };
    }
    function prepare(actionId: string, ids: readonly WorkspaceId[]) {
        if (!options.enabled || recovery.blocked || draft?.acceptAttempted || (operationId && !receipt?.completed) || !ids.length || ids.length > 500)
            return;
        if (actionId === "outcome-and-assignment" || actionId === "assign") {
            void configure(ids, actionId === "assign" ? "assign" : "combined");
            return;
        }
        const outcome = outcomes.find(([value]) => value === actionId)?.[0];
        if (!outcome && actionId !== "unassign")
            return;
        void prepareDraft(makeDraft(ids, outcome ? [{ type: "outcome", value: outcome }] : [{ type: "assign", userId: null }]));
    }
    async function accept() {
        if (!draft?.prepared || draft.stage !== "prepared" || draft.prepared.eligibleCount === 0)
            return;
        if (!draft.acceptAttempted && Date.parse(draft.prepared.expiresAt) <= Date.now()) {
            setDraft({ ...draft, error: "This review expired. Prepare it again." });
            return;
        }
        const token = ++generation.current;
        current.current?.abort();
        const controller = new AbortController();
        current.current = controller;
        const next = draft;
        const pair = { preparationId: next.prepared!.preparationId, idempotencyKey: next.request.idempotencyKey };
        recovery.remember(pair);
        setDraft({ ...next, stage: "accepting", acceptAttempted: true, error: undefined });
        try {
            const value = await json<AcceptedInboxAction>("/api/inbox/actions/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preparationId: next.prepared!.preparationId, idempotencyKey: next.request.idempotencyKey }) }, controller.signal);
            if (token !== generation.current || controller.signal.aborted)
                return;
            if (!value.operationId || !Number.isFinite(Date.parse(value.acceptedAt)))
                throw Error("The action response could not be verified. Retry with this same review.");
            setReceiptNames(next.names);
            recovery.accepted(value);
        }
        catch {
            if (token === generation.current && !controller.signal.aborted) {
                setDraft({ ...next, stage: "prepared", acceptAttempted: true, error: "We could not confirm whether this action started. Retry safely with this same review." });
                recovery.check(pair);
            }
        }
    }
    useEffect(() => {
        if (!operationId || !options.enabled)
            return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (controller.signal.aborted)
                return;
            if (document.visibilityState !== "visible") {
                timer = setTimeout(() => void poll(), 1000);
                return;
            }
            try {
                const value = await options.cache.read<InboxOperationStatus>("receipt", operationId, signal => json(`/api/inbox/operations/${encodeURIComponent(operationId)}`, {}, AbortSignal.any([signal, controller.signal])), true);
                if (controller.signal.aborted)
                    return;
                if (value.operationId !== operationId || !Array.isArray(value.items) || value.items.length > 500 || !Array.isArray(value.steps) || value.steps.length > 1000 || typeof value.completed !== "boolean")
                    throw Error("Invalid receipt");
                setReceipt(value);
                setReceiptError(false);
                if (value.completed) {
                    if (completed.current !== operationId) {
                        completed.current = operationId;
                        completeRecovery();
                        latest.current.onCompleted();
                    }
                }
                else
                    timer = setTimeout(() => void poll(), 1000);
            }
            catch {
                if (!controller.signal.aborted)
                    setReceiptError(true);
            }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
        // Authority/cache identity is owned by the parent workspace lifecycle.
    }, [operationId, options.cache, options.enabled, retry, completeRecovery]);
    const clear = useCallback(() => { generation.current++; current.current?.abort(); clearRecovery(); setDraft(null); setConfiguration(null); setReceipt(null); setReceiptNames(new Map()); setOperationId(undefined); setReceiptError(false); }, [clearRecovery]);
    const actions: readonly WorkspaceAction[] = options.enabled ? [{ id: "assign", label: "Assign", description: "Choose an assignee, then review the change." }, { id: "outcome-and-assignment", label: "Outcome + assignment", description: "Choose an outcome and an assignee, then review both changes." }, ...outcomes.map(([id, label]) => ({ id, label, description: id === "needs_sequence" ? "Set the outcome; this does not enroll a sequence." : "Review eligible conversations before applying." })), { id: "unassign", label: "Clear assignment", description: "Review linked properties before removing assignment." }].map(action => ({ ...action, pending: draft?.stage === "accepting", disabledReason: options.selectionCount > 500 ? "Select at most 500 conversations for this action. Review the selection to remove some." : recovery.blocked ? "Resolve the earlier action before starting another." : draft?.acceptAttempted ? "Resolve the current action before starting another." : operationId && !receipt?.completed ? "The current action is still running." : undefined })) : [];
    const configurationDialog = <Dialog open={!!configuration} onOpenChange={open => { if (!open) {
        generation.current++;
        current.current?.abort();
        setConfiguration(null);
    } }}><DialogContent><DialogTitle>{configuration?.mode === "assign" ? "Assign conversations" : "Outcome and assignment"}</DialogTitle><DialogDescription>Choose the change for the selected conversations, then check current eligibility.</DialogDescription>{configuration && <>{configuration.loading ? <p role="status">Loading assignees…</p> : configuration.error ? <><p role="alert">{configuration.error}</p><button type="button" onClick={() => void configure(configuration.ids, configuration.mode)}>Retry assignees</button></> : <>{configuration.mode === "combined" && <label>Outcome<select value={configuration.outcome} onChange={event => setConfiguration({ ...configuration, outcome: event.target.value as InboxMetadataOutcome })}><option value="">Choose an outcome</option>{outcomes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label>Assign to<select value={configuration.assignee} onChange={event => setConfiguration({ ...configuration, assignee: event.target.value })}><option value="">Choose an assignee</option><option value="unassigned">Unassigned</option>{configuration.members.map(member => <option key={member.userId} value={member.userId}>{member.label}</option>)}</select></label><button type="button" disabled={(configuration.mode === "combined" && !configuration.outcome) || !configuration.assignee} onClick={() => { if ((configuration.mode === "combined" && !configuration.outcome) || !configuration.assignee)
        return; const next = makeDraft(configuration.ids, [...(configuration.mode === "combined" && configuration.outcome ? [{ type: "outcome" as const, value: configuration.outcome }] : []), { type: "assign", userId: configuration.assignee === "unassigned" ? null : configuration.assignee }], configuration.members.find(member => member.userId === configuration.assignee)?.label); setConfiguration(null); void prepareDraft(next); }}>{configuration.mode === "assign" ? "Review assignment" : "Review both changes"}</button></>}</>}</DialogContent></Dialog>;
    const review = <>{configurationDialog}<Dialog open={!!draft} onOpenChange={open => { if (!open && draft?.stage !== "accepting") {
        generation.current++;
        current.current?.abort();
        setDraft(null);
    } }}><DialogContent showCloseButton={draft?.stage !== "accepting"} className="max-h-[85dvh] overflow-auto"><DialogTitle>Review bulk action</DialogTitle><DialogDescription>Check which conversations are eligible and what will change before applying.</DialogDescription>{draft?.stage === "preparing" ? <p role="status">Checking current records…</p> : draft && <>{draft.prepared && <><p>{draft.prepared.eligibleCount} eligible · {draft.prepared.excludedCount} excluded · {draft.prepared.affectedPropertyCount} linked properties · {draft.prepared.effectCount} changes</p>{draft.prepared.smsSafetySummary && <p role="note">This action affects SMS eligibility for {draft.prepared.smsSafetySummary.contacts} contacts across {draft.prepared.smsSafetySummary.linkedProperties} linked properties and {draft.prepared.smsSafetySummary.activeEnrollments} active sequence enrollments. Linked properties can extend beyond the selected conversations.</p>}<p>{draft.request.definition.steps.map(step => step.type === "outcome" ? `Outcome: ${outcomes.find(([value]) => value === step.value)?.[1] ?? step.value}` : step.userId ? `Assign to ${draft.assigneeLabel ?? "the chosen assignee"}` : "Clear assignment").join("; ")}</p><ul>{draft.prepared.items.map(item => <li key={item.id}>{draft.names.get(`${item.target.kind}:${item.target.id}`) ?? "Selected conversation"}: {item.exclusion ? exclusionLabels[item.exclusion] ?? "Needs individual attention" : "Eligible"}</li>)}</ul></>}{draft.error && <p role="alert">{draft.error}</p>}{(!draft.prepared || draft.error) && !draft.acceptAttempted && <button type="button" disabled={draft.stage === "accepting"} onClick={() => void prepareDraft({ ...draft, request: draft.prepared ? { ...draft.request, idempotencyKey: crypto.randomUUID() } : draft.request })}>Prepare again</button>}{draft.prepared && <button type="button" disabled={draft.stage === "accepting" || !draft.prepared.eligibleCount} onClick={() => void accept()}>{draft.stage === "accepting" ? "Applying…" : draft.acceptAttempted ? "Retry apply safely" : `Apply to ${draft.prepared.eligibleCount} conversations`}</button>}</>}</DialogContent></Dialog></>;
    const activity = operationId ? <section aria-label="Bulk action progress"><p role="status">{receipt?.completed ? `Action ${receipt.result ?? "finished"}` : "Action accepted. Checking progress…"}</p>{receipt && <p>{receipt.steps.filter(step => step.state === "succeeded").length} succeeded · {receipt.steps.filter(step => ["failed", "conflicted", "blocked"].includes(step.state)).length} need attention · {receipt.items.filter(item => item.state === "excluded").length} excluded</p>}{receipt && <details><summary>View conversation results</summary><ul>{receipt.items.map(item => <li key={item.id}>{receiptNames.get(`${item.target.kind}:${item.target.id}`) ?? "Selected conversation"}: {item.exclusion ? exclusionLabels[item.exclusion] ?? "Needs individual attention" : item.state === "conflicted" ? "Records changed before this action finished" : item.state === "blocked" ? "Needs attention before it can continue" : item.state}</li>)}</ul></details>}{receiptError && <><p role="alert">Progress is unavailable. The action may still be running.</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry progress</button></>}</section> : undefined;
    return { actions, prepare, review, activity: recovery.panel || activity ? <>{recovery.panel}{activity}</> : undefined, clear };
}
