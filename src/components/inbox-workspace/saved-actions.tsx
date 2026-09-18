"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import type { WorkspaceId } from "./selection";
import type { WorkspaceAction } from "./inbox-workspace";

/** Client-safe mirror of the server action definition. The server remains the
 * authority: this shape only drives bounded editing and display. */
export type SavedActionStep =
  | { type: "outcome"; value: string }
  | { type: "assign"; userId: string | null }
  | { type: "promote" }
  | { type: "dismiss_unknown" }
  | { type: "restore_unknown" }
  | { type: "review_reply"; text: string };

export interface SavedActionDefinition {
  version: 1;
  steps: readonly SavedActionStep[];
}

export interface SavedActionSummary {
  id: string;
  version: number;
  name: string;
  definition: SavedActionDefinition;
  createdAt: string;
}

type MetadataPrepared = {
  preparationId: string;
  idempotencyKey: string;
  expiresAt: string;
  definition: SavedActionDefinition;
  items: ReadonlyArray<{ id: string; target: Target; exclusion: string | null; propertyId?: string | null }>;
  eligibleCount: number;
  excludedCount: number;
  affectedPropertyCount?: number;
  effectCount?: number;
  smsSafetySummary?: { contacts: number; linkedProperties: number; activeEnrollments: number } | null;
  followUp?: { kind: "review_reply"; template: string };
};

type ReplyPrepared = {
  preparationId: string;
  idempotencyKey: string;
  expiresAt: string;
  items: ReadonlyArray<{ id: string; target: Target; exclusion: string | null; recipient: null | { contactName: string; propertyAddress: string; renderedBody: string; to: string } }>;
  recipientCount: number;
  blockers: readonly string[];
};

type Target = { kind: "conversation" | "unknown_sender_group"; id: string };
type Prepared = { kind: "metadata"; value: MetadataPrepared } | { kind: "reply"; value: ReplyPrepared };
type Draft = {
  saved: SavedActionSummary;
  ids: readonly WorkspaceId[];
  names: ReadonlyMap<string, string>;
  request: { idempotencyKey: string; targets: readonly Target[]; savedAction: { id: string; version: number } };
  stage: "preparing" | "prepared" | "accepting";
  prepared?: Prepared;
  operationId?: string;
  result?: string;
  error?: string;
  acceptAttempted?: boolean;
};
type FollowUpDraft = {
  request: { sourceOperationId: string; idempotencyKey: string; template: string };
  prepared?: ReplyPrepared;
  stage: "preparing" | "prepared" | "accepting" | "accepted";
  operationId?: string;
  result?: string;
  error?: string;
};
type Receipt = { operationId: string; kind: Prepared["kind"]; result?: string; error?: string };
type Assignee = { userId: string; label: string };

const outcomes = [
  ["wrong_number", "Wrong number"],
  ["bad_number", "Bad number"],
  ["not_interested", "Not interested"],
  ["needs_sequence", "Needs sequence"],
  ["nurture", "Follow up"],
  ["opted_out", "SMS opt-out"],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function definition(value: unknown): SavedActionDefinition | null {
  const row = object(value);
  if (!row || row.version !== 1 || !Array.isArray(row.steps) || row.steps.length < 1 || row.steps.length > 5) return null;
  const steps: SavedActionStep[] = [];
  const seen = new Set<string>();
  for (const raw of row.steps) {
    const step = object(raw);
    if (!step || typeof step.type !== "string" || seen.has(step.type)) return null;
    seen.add(step.type);
    if (step.type === "outcome" && typeof step.value === "string") steps.push({ type: "outcome", value: step.value });
    else if (step.type === "assign" && (step.userId === null || typeof step.userId === "string")) steps.push({ type: "assign", userId: step.userId as string | null });
    else if (["promote", "dismiss_unknown", "restore_unknown"].includes(step.type)) steps.push({ type: step.type as "promote" | "dismiss_unknown" | "restore_unknown" });
    else if (step.type === "review_reply" && typeof step.text === "string" && step.text.trim().length > 0 && step.text.length <= 1600) steps.push({ type: "review_reply", text: step.text });
    else return null;
  }
  const reply = steps.findIndex(step => step.type === "review_reply");
  if (reply >= 0 && reply !== steps.length - 1) return null;
  return { version: 1, steps };
}

function summary(value: unknown): SavedActionSummary | null {
  const row = object(value);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id) || typeof row.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.name !== "string" || !row.name.trim() || row.name.length > 120 || typeof row.createdAt !== "string") return null;
  const parsed = definition(row.definition);
  return parsed ? { id: row.id, version: row.version, name: row.name, definition: parsed, createdAt: row.createdAt } : null;
}

function targetFromSelection(id: WorkspaceId, orgId: string): Target {
  const value: unknown = JSON.parse(id);
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== orgId || !["conversation", "unknown_sender_group"].includes(value[1] as string) || typeof value[2] !== "string" || !UUID.test(value[2])) throw new Error("Selection does not match this workspace.");
  return { kind: value[1] as Target["kind"], id: value[2] };
}

function replyStep(definitionValue: SavedActionDefinition): Extract<SavedActionStep, { type: "review_reply" }> | null {
  const step = definitionValue.steps.length === 1 ? definitionValue.steps[0] : null;
  return step?.type === "review_reply" ? step : null;
}

function isReplyPrepared(value: unknown): value is ReplyPrepared {
  const row = object(value);
  return !!row && typeof row.preparationId === "string" && typeof row.idempotencyKey === "string" && Array.isArray(row.items) && Number.isSafeInteger(row.recipientCount) && Array.isArray(row.blockers);
}

function isMetadataPrepared(value: unknown): value is MetadataPrepared {
  const row = object(value);
  const followUp = row && row.followUp;
  const candidate = object(followUp);
  return !!row && typeof row.preparationId === "string" && typeof row.idempotencyKey === "string" && Array.isArray(row.items) && Number.isSafeInteger(row.eligibleCount) && Number.isSafeInteger(row.excludedCount) && (followUp === undefined || (!!candidate && candidate.kind === "review_reply" && typeof candidate.template === "string" && candidate.template.trim().length > 0 && candidate.template.length <= 1600));
}

function replyReceiptResult(value: unknown): string {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Reply progress could not be verified.");
  const rows = value.map(raw => {
    const row = object(raw);
    if (!row || typeof row.state !== "string" || (row.reason !== null && typeof row.reason !== "string")) throw new Error("Reply progress could not be verified.");
    return { state: row.state, reason: row.reason as string | null };
  });
  if (!rows.length) return "completed";
  const attention = rows.filter(row => !["provider_accepted", "delivered"].includes(row.state));
  if (!attention.length) return "succeeded";
  return attention.map(row => row.reason ? `${row.state}: ${row.reason}` : row.state).join(", ");
}

function decodePrepared(raw: unknown, request: Draft["request"]): Prepared {
  const envelope = object(raw);
  const value = envelope && "prepared" in envelope ? envelope.prepared : raw;
  const kind = envelope?.kind === "reply" || isReplyPrepared(value) ? "reply" : "metadata";
  if (kind === "reply" && isReplyPrepared(value)) {
    verifyPreparedTargets(value.items, request);
    if (value.idempotencyKey !== request.idempotencyKey || !Number.isFinite(Date.parse(value.expiresAt)) || value.recipientCount < 0 || value.recipientCount > request.targets.length) throw new Error("The reply review could not be verified.");
    return { kind, value };
  }
  if (isMetadataPrepared(value)) {
    verifyPreparedTargets(value.items, request);
    if (value.idempotencyKey !== request.idempotencyKey || !Number.isFinite(Date.parse(value.expiresAt)) || value.eligibleCount < 0 || value.excludedCount < 0 || value.eligibleCount + value.excludedCount !== value.items.length) throw new Error("The saved action review could not be verified.");
    return { kind: "metadata", value };
  }
  throw new Error("The saved action review could not be verified.");
}

function verifyPreparedTargets(items: readonly { target: Target }[], request: Draft["request"]): void {
  if (items.length !== request.targets.length) throw new Error("The saved action review did not match this selection.");
  const expected = new Set(request.targets.map(target => `${target.kind}:${target.id}`));
  const actual = new Set(items.map(item => `${item.target.kind}:${item.target.id}`));
  if (actual.size !== expected.size || [...expected].some(target => !actual.has(target))) throw new Error("The saved action review did not match this selection.");
}

interface Options {
  enabled: boolean;
  identity: InboxQueryIdentity;
  selectedIds: readonly WorkspaceId[];
  names: ReadonlyMap<WorkspaceId, string>;
  onAccessLost: () => void;
  onCompleted: () => void;
}

/** Saved action CRUD plus the reviewed prepare/accept/result lane. Definitions
 * are never executed from browser state: the action route receives only the
 * immutable id/version reference and re-resolves it server-side. */
export function useInboxSavedActions(options: Options) {
  const [items, setItems] = useState<readonly SavedActionSummary[]>([]);
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [listError, setListError] = useState<string>();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpDraft | null>(null);
  const [followUpReceipt, setFollowUpReceipt] = useState<Receipt | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [retry, setRetry] = useState(0);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<SavedActionSummary | null>(null);
  const [builderName, setBuilderName] = useState("");
  const [builderSteps, setBuilderSteps] = useState<SavedActionStep[]>([{ type: "outcome", value: "nurture" }]);
  const [builderError, setBuilderError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [assignees, setAssignees] = useState<readonly Assignee[]>([]);
  const [assigneesError, setAssigneesError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(options);
  latest.current = options;

  const requestJson = useCallback(async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(15_000)]) });
    if (response.status === 401 || response.status === 403) { latest.current.onAccessLost(); throw new Error("Your access has changed."); }
    if (!response.ok) throw new Error(response.status === 409 ? "This saved action changed. Refresh and try again." : "Saved actions are unavailable. Try again.");
    return response.status === 204 ? null : await response.json() as unknown;
  }, []);

  const load = useCallback(async () => {
    if (!latest.current.enabled) return;
    setListState("loading"); setListError(undefined);
    try {
      const raw = await requestJson("/api/inbox/saved-actions");
      if (!Array.isArray(raw) && !(object(raw)?.items && Array.isArray(object(raw)?.items))) throw new Error("Saved actions could not be verified.");
      const values = Array.isArray(raw) ? raw : (object(raw)!.items as unknown[]);
      if (values.length > 200) throw new Error("Saved actions could not be verified.");
      const parsed = values.map(summary);
      if (parsed.some(value => !value)) throw new Error("Saved actions could not be verified.");
      setItems(parsed as SavedActionSummary[]); setListState("ready");
    } catch (error) {
      if (!latest.current.enabled) return;
      setListState("error"); setListError(error instanceof Error ? error.message : "Saved actions are unavailable.");
    }
  }, [requestJson]);

  useEffect(() => { void load(); return () => { controller.current?.abort(); }; }, [load, options.enabled]);

  async function loadAssignees() {
    setAssigneesError(undefined);
    try {
      const response = await requestJson("/api/inbox/actions/assignees");
      const members = object(response)?.members;
      if (!Array.isArray(members) || members.length > 400 || members.some(member => { const row = object(member); return !row || typeof row.userId !== "string" || typeof row.label !== "string"; })) throw new Error("Assignee choices could not be verified.");
      setAssignees(members as Assignee[]);
    } catch (error) { setAssigneesError(error instanceof Error ? error.message : "Assignee choices could not load."); }
  }

  function openBuilder(value?: SavedActionSummary) {
    setEditing(value ?? null); setBuilderName(value?.name ?? ""); setBuilderSteps(value ? [...value.definition.steps] : [{ type: "outcome", value: "nurture" }]); setBuilderError(undefined); setBuilderOpen(true);
    void loadAssignees();
  }

  async function saveBuilder() {
    const name = builderName.trim();
    const def = definition({ version: 1, steps: builderSteps });
    if (!name || name.length > 120) { setBuilderError("Enter a name up to 120 characters."); return; }
    if (!def) { setBuilderError("Choose valid steps. A reply step must be the final step."); return; }
    setSaving(true); setBuilderError(undefined);
    try {
      const body = editing ? { id: editing.id, name, definition: def } : { name, definition: def };
      const value = await requestJson("/api/inbox/saved-actions", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const saved = summary(object(value)?.item ?? value);
      if (!saved) throw new Error("Saved action response could not be verified.");
      setItems(previous => editing ? previous.map(item => item.id === saved.id ? saved : item) : [saved, ...previous]);
      setSelectedActionId(`saved:${saved.id}:${saved.version}`); setBuilderOpen(false);
    } catch (error) { setBuilderError(error instanceof Error ? error.message : "Saved action could not be saved."); }
    finally { setSaving(false); }
  }

  async function remove(value: SavedActionSummary) {
    if (!window.confirm(`Delete saved action “${value.name}”?`)) return;
    setDeleteError(undefined);
    try {
      await requestJson("/api/inbox/saved-actions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: value.id }) });
      setItems(previous => previous.filter(item => item.id !== value.id));
      if (selectedActionId.startsWith(`saved:${value.id}:`)) setSelectedActionId("");
    } catch (error) { setDeleteError(error instanceof Error ? error.message : "Saved action could not be deleted."); }
  }

  function actionFromId(actionId: string) {
    const parts = actionId.split(":");
    if (parts.length !== 3 || parts[0] !== "saved" || !UUID.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
    return items.find(item => item.id === parts[1] && item.version === Number(parts[2])) ?? null;
  }

  async function prepare(actionId: string, ids: readonly WorkspaceId[]) {
    const saved = actionFromId(actionId);
    if (!saved || !options.enabled || !ids.length || ids.length > 500 || draft?.stage === "accepting" || draft?.operationId) return;
    const names = new Map<string, string>();
    let targets: Target[];
    try {
      targets = ids.map(id => { const target = targetFromSelection(id, options.identity.orgId); names.set(`${target.kind}:${target.id}`, options.names.get(id) ?? "Selected conversation"); return target; });
    } catch (error) { setListError(error instanceof Error ? error.message : "Selection does not match this workspace."); return; }
    const request = { idempotencyKey: crypto.randomUUID(), targets, savedAction: { id: saved.id, version: saved.version } };
    const next: Draft = { saved, ids, names, request, stage: "preparing" };
    controller.current?.abort();
    const preparationController = new AbortController();
    controller.current = preparationController;
    setDraft(next);
    try {
      const value = decodePrepared(await requestJson("/api/inbox/actions/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: preparationController.signal }), request);
      if (preparationController.signal.aborted) return;
      setDraft({ ...next, stage: "prepared", prepared: value });
    } catch (error) { if (!preparationController.signal.aborted) setDraft({ ...next, stage: "prepared", error: error instanceof Error ? error.message : "Saved action review unavailable." }); }
  }

  async function accept() {
    if (!draft?.prepared || draft.stage !== "prepared" || (draft.error && !draft.acceptAttempted)) return;
    const next = { ...draft, stage: "accepting" as const, acceptAttempted: true, error: undefined };
    setDraft(next);
    try {
      const recoveryPath = draft.prepared.kind === "reply" ? "/api/inbox/replies/recover" : "/api/inbox/actions/recover";
      const recovery = await fetch(`${recoveryPath}?preparationId=${encodeURIComponent(draft.prepared.value.preparationId)}&idempotencyKey=${encodeURIComponent(draft.request.idempotencyKey)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (recovery.ok) {
        const recovered = object(await recovery.json());
        const operation = recovered && object(recovered.operation);
        if (recovered?.state === "accepted" && operation && typeof operation.operationId === "string") {
          setDraft({ ...next, operationId: operation.operationId });
          return;
        }
        if (recovered?.state === "expired_not_accepted") throw new Error("This review expired. Prepare it again.");
      }
      if (Date.parse(draft.prepared.value.expiresAt) <= Date.now()) throw new Error("This review expired. Prepare it again.");
      const endpoint = draft.prepared.kind === "reply" ? "/api/inbox/replies/accept" : "/api/inbox/actions/accept";
      const value = object(await requestJson(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preparationId: draft.prepared.value.preparationId, idempotencyKey: draft.request.idempotencyKey }) }));
      if (!value || typeof value.operationId !== "string") throw new Error("The action response could not be verified. Retry with this same review.");
      setDraft({ ...next, operationId: value.operationId });
    } catch (error) { setDraft({ ...draft, stage: "prepared", acceptAttempted: true, error: error instanceof Error ? error.message : "We could not confirm whether this action started. Retry safely with this same review." }); }
  }

  async function prepareFollowUp() {
    const prepared = draft?.prepared?.kind === "metadata" ? draft.prepared.value : null;
    if (!draft?.operationId || !draft.result || !prepared?.followUp || followUp) return;
    const request = { sourceOperationId: draft.operationId, idempotencyKey: crypto.randomUUID(), template: prepared.followUp.template };
    setFollowUp({ request, stage: "preparing" });
    try {
      const raw = object(await requestJson("/api/inbox/replies/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) }));
      const value = raw && object(raw.prepared) ? raw.prepared : raw;
      if (!isReplyPrepared(value) || value.idempotencyKey !== request.idempotencyKey || !Number.isFinite(Date.parse(value.expiresAt)) || value.items.length > 500 || value.recipientCount < 0 || value.recipientCount > value.items.length) throw new Error("Reply review could not be verified.");
      setFollowUp({ request, stage: "prepared", prepared: value });
    } catch (error) { setFollowUp({ request, stage: "prepared", error: error instanceof Error ? error.message : "Reply review could not be prepared." }); }
  }

  async function acceptFollowUp() {
    if (!followUp?.prepared || followUp.stage !== "prepared" || followUp.prepared.recipientCount !== 1 || followUp.prepared.blockers.length || (followUp.error && !followUp.operationId)) return;
    const next = { ...followUp, stage: "accepting" as const, error: undefined };
    setFollowUp(next);
    try {
      const recovery = await fetch(`/api/inbox/replies/recover?preparationId=${encodeURIComponent(followUp.prepared.preparationId)}&idempotencyKey=${encodeURIComponent(followUp.request.idempotencyKey)}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (recovery.ok) {
        const recovered = object(await recovery.json());
        const operation = recovered && object(recovered.operation);
        if (recovered?.state === "accepted" && operation && typeof operation.operationId === "string") { setFollowUp({ ...next, stage: "accepted", operationId: operation.operationId }); return; }
        if (recovered?.state === "expired_not_accepted") throw new Error("This reply review expired. Prepare it again.");
      }
      if (Date.parse(followUp.prepared.expiresAt) <= Date.now()) throw new Error("This reply review expired. Prepare it again.");
      const value = object(await requestJson("/api/inbox/replies/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preparationId: followUp.prepared.preparationId, idempotencyKey: followUp.request.idempotencyKey }) }));
      if (!value || typeof value.operationId !== "string") throw new Error("The reply response could not be verified. Retry with this same review.");
      setFollowUp({ ...next, stage: "accepted", operationId: value.operationId });
    } catch (error) { setFollowUp({ ...followUp, stage: "prepared", error: error instanceof Error ? error.message : "We could not confirm whether this reply started. Retry safely with this same review." }); }
  }

  useEffect(() => {
    if (!draft?.operationId) return;
    const operationId = draft.operationId;
    const kind = draft.prepared?.kind;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const path = kind === "reply" ? `/api/inbox/replies/${encodeURIComponent(operationId)}` : `/api/inbox/operations/${encodeURIComponent(operationId)}`;
        const raw = object(await requestJson(path, { signal: abort.signal }));
        if (!raw) throw new Error("Progress response could not be verified.");
        const complete = kind === "reply" ? raw.dispatchComplete === true : raw.completed === true;
        if (complete) {
          const result = kind === "reply" ? replyReceiptResult(raw.receipts) : typeof raw.result === "string" ? raw.result : "completed";
          setReceipt({ operationId, kind: kind ?? "metadata", result });
          setDraft(current => current ? { ...current, result, error: undefined } : current);
          latest.current.onCompleted();
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!abort.signal.aborted) { setDraft(current => current ? { ...current, error: error instanceof Error ? error.message : "Progress is unavailable. The action may still be running." } : current); timer = setTimeout(() => void poll(), 2000); }
      }
    }
    void poll();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [draft?.operationId, draft?.prepared?.kind, requestJson]);

  useEffect(() => {
    if (!followUp?.operationId) return;
    const operationId = followUp.operationId;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const raw = object(await requestJson(`/api/inbox/replies/${encodeURIComponent(operationId)}`, { signal: abort.signal }));
        if (!raw || raw.operationId !== operationId || !Array.isArray(raw.receipts)) throw new Error("Reply progress could not be verified.");
        if (raw.dispatchComplete === true) {
          const result = replyReceiptResult(raw.receipts);
          setFollowUpReceipt({ operationId, kind: "reply", result });
          setFollowUp(current => current ? { ...current, result, error: undefined } : current);
          return;
        }
        timer = setTimeout(() => void poll(), 1000);
      } catch (error) { if (!abort.signal.aborted) { setFollowUp(current => current ? { ...current, error: error instanceof Error ? error.message : "Reply progress is unavailable." } : current); timer = setTimeout(() => void poll(), 2000); } }
    }
    void poll();
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [followUp?.operationId, requestJson]);

  const clear = useCallback(() => {
    controller.current?.abort();
    if (draft?.operationId) setReceipt({ operationId: draft.operationId, kind: draft.prepared?.kind ?? "metadata", result: draft.result, error: draft.error });
    if (followUp?.operationId) setFollowUpReceipt({ operationId: followUp.operationId, kind: "reply", result: followUp.result, error: followUp.error });
    setDraft(null);
    setFollowUp(null);
  }, [draft, followUp]);
  const actions: readonly WorkspaceAction[] = useMemo(() => items.map(item => ({ id: `saved:${item.id}:${item.version}`, label: item.name, description: `Saved action · ${item.definition.steps.length} step${item.definition.steps.length === 1 ? "" : "s"}`, disabledReason: !options.selectedIds.length ? "Select conversations first." : undefined, pending: draft?.stage === "accepting" })), [items, options.selectedIds.length, draft?.stage]);

  const picker = <div className="flex flex-wrap items-center gap-2" aria-label="Saved actions">
    <label>Saved action <select aria-label="Saved action" value={selectedActionId} onChange={event => setSelectedActionId(event.target.value)} disabled={listState === "loading" || !items.length}><option value="">Choose…</option>{items.map(item => <option key={`${item.id}:${item.version}`} value={`saved:${item.id}:${item.version}`}>{item.name}</option>)}</select></label>
    <button type="button" disabled={!selectedActionId || !options.selectedIds.length} onClick={() => void prepare(selectedActionId, options.selectedIds)}>Review saved action</button>
    <button type="button" onClick={() => openBuilder()}>Create saved action</button>
    <button type="button" onClick={() => void load()} disabled={listState === "loading"}>Refresh saved actions</button>
    {listState === "loading" && <span role="status">Loading saved actions…</span>}
    {listState === "error" && <span role="alert">{listError}</span>}
  </div>;

  const builder = <Dialog open={builderOpen} onOpenChange={setBuilderOpen}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>{editing ? "Edit saved action" : "Create saved action"}</DialogTitle><DialogDescription>Choose a bounded set of reviewed steps. The server validates and rechecks each referenced entity when you use it.</DialogDescription><label>Name<input aria-label="Saved action name" maxLength={120} value={builderName} onChange={event => setBuilderName(event.target.value)} /></label>{assigneesError && <p role="alert">{assigneesError}</p>}<div className="mt-3 space-y-3"><strong>Steps</strong>{builderSteps.map((step, index) => <div className="flex flex-wrap items-end gap-2" key={index}><label>Step {index + 1}<select aria-label={`Step ${index + 1} type`} value={step.type} onChange={event => { const type = event.target.value as SavedActionStep["type"]; setBuilderSteps(previous => previous.map((current, position) => position === index ? type === "outcome" ? { type, value: "nurture" } : type === "assign" ? { type, userId: null } : type === "review_reply" ? { type, text: "" } : { type } : current)); }}><option value="outcome">Outcome</option><option value="assign">Assignment</option><option value="promote">Move to lead</option><option value="dismiss_unknown">Dismiss unknown</option><option value="restore_unknown">Restore unknown</option><option value="review_reply">Reviewed reply</option></select></label>{step.type === "outcome" && <label>Outcome<select aria-label={`Step ${index + 1} outcome`} value={step.value} onChange={event => setBuilderSteps(previous => previous.map((current, position) => position === index ? { ...current, value: event.target.value } : current))}>{outcomes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{step.type === "assign" && <label>Assign to<select aria-label={`Step ${index + 1} assignee`} value={step.userId ?? ""} onChange={event => setBuilderSteps(previous => previous.map((current, position) => position === index ? { ...current, userId: event.target.value || null } : current))}><option value="">Unassigned</option>{assignees.map(member => <option key={member.userId} value={member.userId}>{member.label}</option>)}{step.userId && !assignees.some(member => member.userId === step.userId) && <option value={step.userId}>Current assignee</option>}</select></label>}{step.type === "review_reply" && <label className="min-w-[18rem]">Reply text<textarea aria-label={`Step ${index + 1} reply text`} maxLength={1600} value={step.text} onChange={event => setBuilderSteps(previous => previous.map((current, position) => position === index ? { ...current, text: event.target.value } : current))} /></label>}<button type="button" onClick={() => setBuilderSteps(previous => previous.filter((_, position) => position !== index))} disabled={builderSteps.length <= 1}>Remove</button></div>)}<button type="button" onClick={() => setBuilderSteps(previous => previous.length < 5 ? [...previous, { type: "outcome", value: "nurture" }] : previous)} disabled={builderSteps.length >= 5}>Add step</button></div>{builderError && <p role="alert">{builderError}</p>}<div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => setBuilderOpen(false)}>Cancel</button><button type="button" onClick={() => void saveBuilder()} disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Save action"}</button></div><div className="mt-5 border-t pt-3"><h3>Existing saved actions</h3>{items.length ? <ul>{items.map(item => <li key={item.id} className="flex items-center justify-between gap-3 py-1"><span>{item.name}</span><span className="flex gap-2"><button type="button" onClick={() => openBuilder(item)}>Edit</button><button type="button" onClick={() => void remove(item)}>Delete</button></span></li>)}</ul> : <p>No saved actions yet.</p>}{deleteError && <p role="alert">{deleteError}</p>}</div></DialogContent></Dialog>;

  const review = <Dialog open={!!draft} onOpenChange={open => { if (!open && draft?.stage !== "accepting" && followUp?.stage !== "accepting") clear(); }}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>Review saved action · {draft?.saved.name}</DialogTitle><DialogDescription>Check the authoritative eligibility result before applying this saved combination.</DialogDescription>{draft?.stage === "preparing" ? <p role="status">Checking current records…</p> : draft && !draft.prepared ? <p role="alert">{draft.error ?? "Saved action review unavailable."}</p> : draft?.prepared && <>{draft.prepared.kind === "reply" ? <><p>{draft.prepared.value.recipientCount} recipients · {draft.prepared.value.blockers.length ? `Blocked: ${draft.prepared.value.blockers.join(", ")}` : "Ready for reviewed send"}</p><ul>{draft.prepared.value.items.map(item => <li key={item.id}>{draft.names.get(`${item.target.kind}:${item.target.id}`) ?? "Selected conversation"}: {item.exclusion ?? (item.recipient ? `Ready for send to ${item.recipient.contactName}` : "Needs attention")}{item.recipient && <small className="block whitespace-pre-wrap">{item.recipient.renderedBody}</small>}</li>)}</ul></> : <><p>{draft.prepared.value.eligibleCount} eligible · {draft.prepared.value.excludedCount} excluded · {draft.prepared.value.effectCount ?? 0} changes</p><ul>{draft.prepared.value.items.map(item => <li key={item.id}>{draft.names.get(`${item.target.kind}:${item.target.id}`) ?? "Selected conversation"}: {item.exclusion ?? "Eligible"}</li>)}</ul>{draft.result && draft.prepared.value.followUp && !followUp && <button type="button" onClick={() => void prepareFollowUp()}>Review reply</button>}</>}{draft.error && <p role="alert">{draft.error}</p>}<button type="button" disabled={draft.stage === "accepting" || !!draft.operationId || (!!draft.prepared && (draft.prepared.kind === "reply" ? draft.prepared.value.recipientCount === 0 || draft.prepared.value.blockers.length > 0 : draft.prepared.value.eligibleCount === 0))} onClick={() => void accept()}>{draft.stage === "accepting" ? "Applying…" : draft.operationId ? "Accepted · checking progress…" : draft.acceptAttempted ? "Retry action safely" : "Accept reviewed action"}</button>{draft.operationId && <p role="status">Accepted. Checking durable progress…</p>}</>}{followUp?.stage === "preparing" && <p role="status">Checking reply recipients…</p>}{followUp && !followUp.prepared && followUp.stage !== "preparing" && <p role="alert">{followUp.error ?? "Reply review unavailable."}</p>}{followUp?.prepared && <section aria-label="Review saved reply"><h3>Review reply</h3><p>{followUp.prepared.recipientCount} recipients · {followUp.prepared.blockers.length ? `Blocked: ${followUp.prepared.blockers.join(", ")}` : "Ready for reviewed send"}</p><ul>{followUp.prepared.items.map(item => <li key={item.id}>{item.exclusion ?? (item.recipient ? `Ready to send to ${item.recipient.contactName}` : "Needs attention")}{item.recipient && <small className="block whitespace-pre-wrap">{item.recipient.renderedBody}</small>}</li>)}</ul>{followUp.error && <p role="alert">{followUp.error}</p>}<button type="button" disabled={followUp.stage === "accepting" || !!followUp.operationId || followUp.prepared.recipientCount !== 1 || followUp.prepared.blockers.length > 0} onClick={() => void acceptFollowUp()}>{followUp.stage === "accepting" ? "Accepting…" : followUp.operationId ? "Accepted · checking progress…" : "Accept reviewed reply"}</button></section>}</DialogContent></Dialog>;
  const activeReceipts = [draft?.operationId ? { operationId: draft.operationId, kind: draft.prepared?.kind ?? "metadata", result: draft.result, error: draft.error } : receipt, followUp?.operationId ? { operationId: followUp.operationId, kind: "reply" as const, result: followUp.result, error: followUp.error } : followUpReceipt].filter((value): value is Receipt => !!value);
  const activity: ReactNode = activeReceipts.length ? <>{activeReceipts.map((activeReceipt, index) => <section aria-label="Saved action progress" key={`${activeReceipt.operationId}:${index}`}><p role="status">{activeReceipt.error ?? (activeReceipt.result ? `Saved action ${activeReceipt.result}.` : "Saved action accepted. Checking durable progress…")}</p><a href={`${activeReceipt.kind === "reply" ? "/api/inbox/replies/" : "/api/inbox/operations/"}${encodeURIComponent(activeReceipt.operationId)}`}>Open action receipt</a></section>)}</> : null;
  return { items, actions, prepare, review, activity, picker, builder, clear, refresh: load, replyStep, isReplyAction: (actionId: string) => !!replyStep(actionFromId(actionId)?.definition ?? { version: 1, steps: [] }) };
}
