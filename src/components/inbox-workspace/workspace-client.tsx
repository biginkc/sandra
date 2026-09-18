"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { QueryClientProvider } from "@tanstack/react-query";
import { InboxWorkspace, type WorkspaceRow } from "./inbox-workspace";
import { workspaceId, type WorkspaceId, type WorkspaceTarget } from "./selection";
import { createWorkspaceSync, type SyncSnapshot, type WorkspaceScope } from "@/lib/inbox/workspace-sync";
import { createInboxQueryCache, type InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import { inboxViews, type InboxFilter, type InboxCounts } from "@/lib/inbox/filter-contract";
import { ConversationHistory, type InboxDetailSnapshot } from "./conversation-history";
import { UnknownSenderHistory, type UnknownSenderHistorySnapshot } from "./unknown-sender-history";
import { useInboxMetadataActions } from "./use-metadata-actions";
import { useInboxSavedActions } from "./saved-actions";
import { InboxReplyComposer } from "./reply-composer";
import { ConversationLinks } from "./conversation-links";
import { InboxKnownConversationActions, knownConversationActionContext } from "./known-conversation-actions";
import { InboxUnknownSenderActions } from "./unknown-sender-actions";

const labels: Record<InboxFilter["view"], string> = { active: "All", all: "All", mine: "Assigned to me", unassigned: "Unassigned", unread: "Unread", escalated: "Needs review", dispo: "Has outcome", needs_outcome: "Needs outcome", unknown: "Unknown senders", dismissed: "Dismissed" };
type Scope = WorkspaceScope & { generation: string; nextCursor: string | null; refreshed: boolean };
type Open = { id: WorkspaceId; generation: number; row?: WorkspaceRow; data?: InboxDetailSnapshot; unknownData?: UnknownSenderHistorySnapshot; error?: string };
type WorksetUpdates = { scopeId: string; orgId: string; requesterId: string; sessionId: string; accessEpoch: string; generation: string; hasUpdates: boolean; refreshRequired: boolean };
type SelectionReviewBackendItem = { kind: "conversation" | "unknown_sender_group"; id: string; status: "matching" | "outside_filter" | "unavailable"; name: string | null };
type SelectionReviewItem = { id: WorkspaceId; status: "matching_loaded" | "matching_unloaded" | "outside_filter" | "unavailable"; name: string };
type SelectionReviewState = { status: "loading" | "ready" | "error"; generation: string; ids: readonly WorkspaceId[]; filter: InboxFilter; items: SelectionReviewItem[]; error?: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function worksetStorageKey(identity: InboxQueryIdentity): string {
  return ["inbox-workset", identity.orgId, identity.userId, identity.sessionId, identity.accessEpoch]
    .map(value => encodeURIComponent(value))
    .join(":");
}

function readStoredWorksetId(identity: InboxQueryIdentity): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(worksetStorageKey(identity));
    return value && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeWorksetId(identity: InboxQueryIdentity, scopeId: string): void {
  if (typeof window === "undefined" || !UUID.test(scopeId)) return;
  try { window.sessionStorage.setItem(worksetStorageKey(identity), scopeId); } catch { /* storage is an optional reload optimization */ }
}

function clearStoredWorksetId(identity: InboxQueryIdentity): void {
  if (typeof window === "undefined") return;
  try { window.sessionStorage.removeItem(worksetStorageKey(identity)); } catch { /* storage is an optional reload optimization */ }
}

function newSelectionReviewGeneration(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const random = () => Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
  return `${random()}-${random().slice(0, 4)}-4${random().slice(0, 3)}-8${random().slice(0, 3)}-${random()}${random().slice(0, 4)}`;
}

function selectionTarget(id: WorkspaceId, orgId: string): { kind: SelectionReviewBackendItem["kind"]; id: string } {
  let parts: unknown;
  try { parts = JSON.parse(id); } catch { throw Error("The selection identity could not be verified."); }
  if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== orgId || !["conversation", "unknown_sender_group"].includes(parts[1] as string) || typeof parts[2] !== "string") throw Error("The selection identity could not be verified.");
  return { kind: parts[1] as SelectionReviewBackendItem["kind"], id: parts[2] };
}

function decodeSelectionReview(value: unknown, expected: readonly { kind: SelectionReviewBackendItem["kind"]; id: string }[], identity: InboxQueryIdentity, generation: string): SelectionReviewBackendItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("The selection review response was invalid.");
  const response = value as Record<string, unknown>;
  if (response.orgId !== identity.orgId || response.requesterId !== identity.userId || response.sessionId !== identity.sessionId || response.accessEpoch !== identity.accessEpoch || response.generation !== generation || !Array.isArray(response.items) || response.items.length !== expected.length) throw Error("The selection review response did not match this session.");
  return response.items.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw Error("The selection review item was invalid.");
    const item = candidate as Record<string, unknown>;
    const target = expected[index];
    if (item.kind !== target.kind || item.id !== target.id || !["matching", "outside_filter", "unavailable"].includes(item.status as string) || (item.name !== null && typeof item.name !== "string")) throw Error("The selection review item did not match this request.");
    return { kind: target.kind, id: target.id, status: item.status as SelectionReviewBackendItem["status"], name: item.name as string | null };
  });
}
function abortSelectionReview(sequence: { current: number }, request: { current: AbortController | null }) {
  sequence.current++;
  request.current?.abort();
  request.current = null;
}
function abortWorksetUpdates(sequence: { current: number }, request: { current: AbortController | null }) {
  sequence.current++;
  request.current?.abort();
  request.current = null;
}
function decodeWorksetUpdates(value: unknown, scope: Scope, identity: InboxQueryIdentity): WorksetUpdates {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("The workspace update response was invalid.");
  const response = value as Record<string, unknown>;
  if (response.scopeId !== scope.scopeId || response.orgId !== identity.orgId || response.requesterId !== identity.userId || response.sessionId !== identity.sessionId || response.accessEpoch !== identity.accessEpoch || response.generation !== scope.generation || typeof response.hasUpdates !== "boolean" || typeof response.refreshRequired !== "boolean") throw Error("The workspace update response did not match this scope.");
  return { scopeId: scope.scopeId, orgId: identity.orgId, requesterId: identity.userId, sessionId: identity.sessionId, accessEpoch: identity.accessEpoch, generation: scope.generation, hasUpdates: response.hasUpdates, refreshRequired: response.refreshRequired };
}

export function InboxWorkspaceClient({ identity, initialFilter, actionsEnabled = false, replyEnabled = false }: { identity: InboxQueryIdentity & { expiresAt: number }; initialFilter: InboxFilter; actionsEnabled?: boolean; replyEnabled?: boolean }) {
  const [cache] = useState(() => createInboxQueryCache(identity));
  const [snapshot, setSnapshot] = useState<SyncSnapshot>({ state: "loading", rows: [] });
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState(initialFilter.search ?? "");
  const [selected, setSelected] = useState<readonly WorkspaceId[]>([]);
  const [invalidatedIds, setInvalidatedIds] = useState<readonly WorkspaceId[]>([]);
  const activeOpen = useRef<WorkspaceId | null>(null);
  const [review, setReview] = useState(false);
  const [selectionReview, setSelectionReview] = useState<SelectionReviewState | null>(null);
  const selectionReviewRequest = useRef<AbortController | null>(null);
  const selectionReviewSequence = useRef(0);
  const [pageScope, setPageScope] = useState<Scope | null>(null);
  const [worksetUpdateLabel, setWorksetUpdateLabel] = useState<string>();
  const [worksetUpdateError, setWorksetUpdateError] = useState(false);
  const worksetUpdateRequest = useRef<AbortController | null>(null);
  const worksetUpdateSequence = useRef(0);
  const [opened, setOpened] = useState<Open | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [counts, setCounts] = useState<InboxCounts>();
  const [countsError, setCountsError] = useState(false);
  const scope = useRef<{ scopeId: string } | Scope | null>(null);
  const sync = useRef<ReturnType<typeof createWorkspaceSync> | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const countsGeneration = useRef(0);
  const denied = useRef(false);
  const invalidateViews = useCallback(() => { sequence.current++; countsGeneration.current++; }, []);
  const [selectionNames, setSelectionNames] = useState(new Map<WorkspaceId, string>());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const clearActions = useRef<() => void>(() => {});
  const accessLost = useCallback(() => {
    if (denied.current) return;
    denied.current = true; sequence.current++;
    request.current?.abort(); clearActions.current(); cache.close();
    clearStoredWorksetId(identity);
    selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null;
    worksetUpdateSequence.current++; worksetUpdateRequest.current?.abort(); worksetUpdateRequest.current = null;
    setSelectionNames(new Map()); setSelected([]); activeOpen.current = null; setOpened(null); setCounts(undefined); setReview(false);
    setSelectionReview(null); setPageScope(null); setWorksetUpdateLabel(undefined); setWorksetUpdateError(false);
    sync.current?.revoke(); setSnapshot({ state: "permission_lost", rows: [] }); setBusy(false);
  }, [cache, identity]);
  /** A single item-scoped denial (404): only this target is affected. Invalidate its
   * cached detail, prune it from selection the same way the sync adapter's authoritative
   * onInvalidated does below (selected IDs must never silently become replacement rows,
   * nor resurrect once invalidatedIds clears on the next load()), and close its pane if
   * it is the one currently open — do not touch the rest of the workspace or latch
   * permission_lost. Stable across renders (a child effect keys off this reference —
   * see conversation-history.tsx). */
  const invalidateTarget = useCallback((target: WorkspaceTarget) => {
    const id = workspaceId(target);
    selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null; setReview(false); setSelectionReview(null);
    cache.invalidate("detail", id);
    setInvalidatedIds(previous => (previous.includes(id) ? previous : [...previous, id]));
    setSelected(previous => previous.filter(value => value !== id));
    setSelectionNames(previous => { if (!previous.has(id)) return previous; const next = new Map(previous); next.delete(id); return next; });
    if (activeOpen.current === id) { sequence.current++; activeOpen.current = null; setOpened(null); }
  }, [cache]);
  const unavailable = useCallback((conversationId: string) =>
    invalidateTarget({ kind: "conversation", orgId: identity.orgId, conversationId }), [invalidateTarget, identity.orgId]);
  const unavailableSenderGroup = useCallback((senderGroupId: string) =>
    invalidateTarget({ kind: "unknown_sender_group", orgId: identity.orgId, senderGroupId }), [invalidateTarget, identity.orgId]);
  const metadata = useInboxMetadataActions({ enabled: actionsEnabled, selectionCount: selected.length, identity, orgId: identity.orgId, names: selectionNames, cache, onAccessLost: accessLost, onCompleted: () => { void load(filter); } });
  const saved = useInboxSavedActions({ enabled: actionsEnabled, identity, selectedIds: selected, names: selectionNames, onAccessLost: accessLost, onCompleted: () => { void load(filter); } });
  useEffect(() => { clearActions.current = metadata.clear; }, [metadata.clear]);
  async function json<T>(url: string, init: RequestInit, signal: AbortSignal, notFound?: () => void): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.status === 401 || response.status === 403) { accessLost(); throw Error("Your access has changed. Reload the workspace."); }
    // A 404 here is item-scoped (see read-api.ts's fail()): only the caller-identified
    // target is unavailable, not the whole workspace. Only routes that resolve a single
    // item pass notFound; worksets/counts have no such case and fall through as before.
    if (response.status === 404 && notFound) { notFound(); throw new DOMException("This item is unavailable.", "AbortError"); }
    if (!response.ok) throw Error(response.status === 429 ? "Please wait before refreshing this view." : "The request could not be completed. Try again.");
    const value = await response.json(); signal.throwIfAborted();
    if (denied.current) throw new DOMException("Access ended", "AbortError");
    return value as T;
  }
  async function loadCounts(next: InboxFilter, fresh = false) {
    const token = ++countsGeneration.current;
    setCounts(undefined); setCountsError(false);
    const key = JSON.stringify(next);
    try {
      const value = await cache.read<InboxCounts>("counts", key, signal => {
        const params = new URLSearchParams({ orgId: identity.orgId, view: next.view, hide_noise: String(next.hide_noise ?? true), search: next.search ?? "" });
        return json(`/api/inbox/counts?${params}`, {}, signal);
      }, fresh);
      if (value.accessEpoch !== identity.accessEpoch) { accessLost(); return; }
      if (!denied.current && token === countsGeneration.current) setCounts(value);
    } catch { if (!denied.current && token === countsGeneration.current) setCountsError(true); }
  }
  async function load(next: InboxFilter, cursor: string | null = null) {
    if (denied.current) return;
    selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null; setReview(false); setSelectionReview(null);
    worksetUpdateSequence.current++; worksetUpdateRequest.current?.abort(); worksetUpdateRequest.current = null; setPageScope(null); setWorksetUpdateLabel(undefined); setWorksetUpdateError(false);
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); sync.current?.reset();
    void loadCounts(next);
    try {
      const value = await json<Scope>("/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: identity.orgId, filter: next, cursor, limit: 500, ...(scope.current ? { replacesScopeId: scope.current.scopeId } : {}) }) }, controller.signal);
      if (controller.signal.aborted) return;
      if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.sessionId !== identity.sessionId || value.accessEpoch !== identity.accessEpoch) { accessLost(); return; }
      if (!(value.nextCursor === null || typeof value.nextCursor === "string") || typeof value.refreshed !== "boolean" || typeof value.generation !== "string" || value.generation.length === 0) throw Error("Invalid workspace response");
      setInvalidatedIds([]); sync.current!.replace(value); scope.current = value; storeWorksetId(identity, value.scopeId); setPageScope(value); setNextCursor(value.nextCursor); setFilter(next);
    } catch (failure) {
      if (!controller.signal.aborted && !denied.current) setError(failure instanceof Error ? failure.message : "Could not load conversations.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!pageScope || denied.current) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    worksetUpdateRequest.current = controller;
    const token = ++worksetUpdateSequence.current;
    const poll = async () => {
      try {
        const value = await json<unknown>(`/api/inbox/workset-updates?scopeId=${encodeURIComponent(pageScope.scopeId)}`, {}, controller.signal);
        if (!active || controller.signal.aborted || token !== worksetUpdateSequence.current || denied.current) return;
        const update = decodeWorksetUpdates(value, pageScope, identity);
        setWorksetUpdateError(false);
        setWorksetUpdateLabel(update.refreshRequired ? "Refresh required to check for new conversations" : update.hasUpdates ? "New conversations available · Refresh view" : undefined);
      } catch {
        if (active && !controller.signal.aborted && token === worksetUpdateSequence.current && !denied.current) setWorksetUpdateError(true);
      } finally {
        if (active && !controller.signal.aborted && token === worksetUpdateSequence.current && !denied.current) timer = setTimeout(() => void poll(), 15_000);
      }
    };
    void poll();
    return () => {
      active = false; abortWorksetUpdates(worksetUpdateSequence, worksetUpdateRequest); if (timer) clearTimeout(timer);
    };
    // The scope object is the complete identity fence for this polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageScope]);
  useEffect(() => {
    // Each mount owns its transport and memory cache. A stale request
    // cannot publish after unmount even when the server completed its scope. The
    // scope identity itself is retained in this tab so a normal reload/navigation
    // can atomically replace the prior server scope instead of consuming another
    // active generation. It is keyed by the full authenticated identity and is
    // never trusted as row or tenant authority.
    const rememberedScopeId = readStoredWorksetId(identity);
    if (rememberedScopeId) scope.current = { scopeId: rememberedScopeId };
    const adapter = createWorkspaceSync({ origin: window.location.origin, onChange: setSnapshot, onAccessBoundary: accessLost,
      onInvalidated: ids => {
        selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null; setReview(false); setSelectionReview(null);
        setInvalidatedIds(previous => [...new Set([...previous, ...ids])]);
        setSelected(previous => previous.filter(id => !ids.includes(id)));
        setSelectionNames(previous => new Map([...previous].filter(([id]) => !ids.includes(id))));
        for (const id of ids) cache.invalidate("detail", id);
        if (activeOpen.current && ids.includes(activeOpen.current)) { sequence.current++; activeOpen.current = null; setOpened(null); }
      } });
    sync.current = adapter;
    // The initial network subscription uses the same loading/error transition as explicit refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(initialFilter);
    const expiry = setTimeout(accessLost, Math.max(0, identity.expiresAt - Date.now()));
    return () => {
      invalidateViews(); request.current?.abort(); abortSelectionReview(selectionReviewSequence, selectionReviewRequest); abortWorksetUpdates(worksetUpdateSequence, worksetUpdateRequest); clearTimeout(expiry); adapter.reset(); sync.current = null;
      // React Strict Mode immediately installs another owned adapter; a real
      // unmount closes the cache once that synchronous replay is complete.
      queueMicrotask(() => { if (sync.current === null) cache.close(); });
    };
    // The server mounts a new component for a different authenticated identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function select(ids: readonly WorkspaceId[]) {
    if (ids.length > 500) { setError("Select up to 500 conversations at a time."); return; }
    if (review) { selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null; setReview(false); setSelectionReview(null); }
    const names = new Map<WorkspaceId, string>();
    for (const id of ids) names.set(id, snapshot.rows.find(row => workspaceId(row.target) === id)?.name ?? selectionNames.get(id) ?? "Conversation outside this view");
    setSelectionNames(names); setSelected(ids);
  }
  async function beginSelectionReview(ids: readonly WorkspaceId[], nextFilter: InboxFilter) {
    if (!ids.length || denied.current) return;
    selectionReviewRequest.current?.abort();
    const controller = new AbortController(); selectionReviewRequest.current = controller;
    const token = ++selectionReviewSequence.current;
    const generation = newSelectionReviewGeneration();
    const capturedIds = [...ids];
    setReview(true); setSelectionReview({ status: "loading", generation, ids: capturedIds, filter: nextFilter, items: [] });
    try {
      const targets = capturedIds.map(id => selectionTarget(id, identity.orgId));
      const batches = Array.from({ length: Math.ceil(targets.length / 100) }, (_, index) => targets.slice(index * 100, (index + 1) * 100));
      const responses = await Promise.all(batches.map(async batch => {
        const value = await json<unknown>("/api/inbox/selection-review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: identity.orgId, filter: nextFilter, targets: batch, generation }) }, controller.signal);
        return decodeSelectionReview(value, batch, identity, generation);
      }));
      if (token !== selectionReviewSequence.current || controller.signal.aborted || denied.current) return;
      const resident = new Set(snapshot.rows.map(row => workspaceId(row.target)));
      const items = responses.flat().map(item => ({
        id: workspaceId(item.kind === "conversation" ? { kind: "conversation", orgId: identity.orgId, conversationId: item.id } : { kind: "unknown_sender_group", orgId: identity.orgId, senderGroupId: item.id }),
        status: item.status === "matching" ? (resident.has(workspaceId(item.kind === "conversation" ? { kind: "conversation", orgId: identity.orgId, conversationId: item.id } : { kind: "unknown_sender_group", orgId: identity.orgId, senderGroupId: item.id })) ? "matching_loaded" : "matching_unloaded") : item.status,
        name: item.status === "unavailable" ? "Unavailable" : item.name ?? "Selected conversation",
      } satisfies SelectionReviewItem));
      setSelectionReview({ status: "ready", generation, ids: capturedIds, filter: nextFilter, items });
    } catch (failure) {
      if (controller.signal.aborted || token !== selectionReviewSequence.current || denied.current) return;
      setSelectionReview({ status: "error", generation, ids: capturedIds, filter: nextFilter, items: [], error: failure instanceof Error ? failure.message : "The selection could not be reviewed." });
    } finally {
      if (selectionReviewRequest.current === controller) selectionReviewRequest.current = null;
    }
  }
  function closeSelectionReview(open: boolean) {
    if (open) { setReview(true); return; }
    selectionReviewSequence.current++; selectionReviewRequest.current?.abort(); selectionReviewRequest.current = null; setReview(false); setSelectionReview(null);
  }
  function removeFromSelectionReview(id: WorkspaceId) {
    setSelected(previous => previous.filter(value => value !== id));
    setSelectionNames(previous => { if (!previous.has(id)) return previous; const next = new Map(previous); next.delete(id); return next; });
    setSelectionReview(previous => previous ? { ...previous, ids: previous.ids.filter(value => value !== id), items: previous.items.filter(item => item.id !== id) } : previous);
  }
  async function open(id: WorkspaceId, fresh = false) {
    const generation = ++sequence.current; activeOpen.current = id;
    const row = snapshot.rows.find(value => workspaceId(value.target) === id);
    const parts: unknown = JSON.parse(id);
    setOpened({ id, generation, row });
    if (!Array.isArray(parts) || parts[0] !== identity.orgId || !["conversation", "unknown_sender_group"].includes(parts[1] as string) || typeof parts[2] !== "string") {
      setOpened({ id, generation, row, error: "This conversation identity could not be verified." }); return;
    }
    const targetKind = parts[1] as "conversation" | "unknown_sender_group";
    const conversationId = parts[2] as string;
    if (targetKind === "unknown_sender_group") {
      try {
        const value = await cache.read<UnknownSenderHistorySnapshot>("detail", `unknown:${id}`, signal => json(`/api/inbox/unknown-senders/${conversationId}/history?orgId=${identity.orgId}`, {}, signal, () => unavailableSenderGroup(conversationId)), fresh);
        if (value.orgId !== identity.orgId || value.senderGroupId !== conversationId || !Array.isArray(value.history) || value.history.length > 50) throw Error("Unknown sender response did not match the request.");
        if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, unknownData: value });
      } catch (failure) { if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, error: failure instanceof Error ? failure.message : "Unknown sender unavailable." }); }
      return;
    }
    try {
      // A 404 here means this conversation became item-inaccessible between workset
      // capture and Open (dismissed, purged cursor, etc.) — remove it from the row/
      // selection via unavailable() instead of leaving a generic error under a stale row.
      const value = await cache.read<InboxDetailSnapshot>("detail", id, signal => json(`/api/inbox/conversations/${conversationId}/detail?orgId=${identity.orgId}`, {}, signal, () => unavailable(conversationId)), fresh);
      if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.conversationId !== conversationId || !Array.isArray(value.history) || value.history.length > 50) throw Error("Conversation response did not match the request.");
      if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, data: value });
    } catch (failure) { if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, error: failure instanceof Error ? failure.message : "Conversation unavailable." }); }
  }
  const actionItems = [...metadata.actions, ...saved.actions];
  const prepareAction = (actionId: string, ids: readonly WorkspaceId[]) => actionId.startsWith("saved:") ? void saved.prepare(actionId, ids) : void metadata.prepare(actionId, ids);
  return <QueryClientProvider client={cache.client}>
    <InboxWorkspace scopeLabel={labels[filter.view]} rows={snapshot.rows} invalidatedIds={invalidatedIds} selectedIds={selected} openId={opened?.id ?? null}
      onSelectionChange={select} onOpen={id => void open(id)} onCloseDetail={() => { sequence.current++; activeOpen.current = null; setOpened(null); }}
      onBack={() => { window.location.href = "/inbox/overview"; }} onReviewSelection={() => void beginSelectionReview(selected, filter)} newMessagesLabel={worksetUpdateLabel} onRefreshRows={() => void load(filter)}
      actions={actionItems} onAction={prepareAction} connection={{ state: snapshot.state === "permission_lost" ? "permission_lost" : snapshot.state === "live" ? "live" : snapshot.state === "resync_required" ? "offline" : "updating", label: snapshot.state === "permission_lost" ? "Your access has changed. Reload to continue." : snapshot.state === "live" ? "Current workspace is synchronized" : snapshot.state === "resync_required" ? "Refresh this view to reconnect" : "Loading workspace…" }}
      listState={busy || snapshot.state === "loading" ? "loading" : "ready"} listError={error} onRetryList={() => void load(filter)}
      toolbar={<><form onSubmit={event => { event.preventDefault(); void load({ ...filter, search }); }}><label>Search <input aria-label="Search conversations" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} disabled={busy} /></label><button disabled={busy}>Search</button></form>
        <label>View <select value={filter.view} disabled={busy} onChange={event => void load({ ...filter, view: event.target.value as InboxFilter["view"] })}>{inboxViews.filter(view => view !== "active").map(view => <option key={view} value={view}>{labels[view]}</option>)}</select></label>
        <label><input type="checkbox" checked={filter.hide_noise ?? true} disabled={busy} onChange={event => void load({ ...filter, hide_noise: event.target.checked })} /> Hide DNC and test conversations</label>
        <span role="status">{counts ? `${counts.counts[filter.view === "active" ? "all" : filter.view]} matching · counted ${new Date(counts.asOf).toLocaleTimeString()}` : countsError ? "Counts unavailable" : "Loading counts…"}</span>{countsError && <button type="button" onClick={() => void loadCounts(filter, true)}>Retry counts</button>}{actionsEnabled ? saved.picker : null}</>}
      pageControl={<><span>{snapshot.rows.length} loaded</span><button disabled={busy} onClick={() => void load(filter)}>Refresh view</button><button disabled={busy || !nextCursor} onClick={() => void load(filter, nextCursor)}>Next 500</button></>}
      detail={opened ? { targetId: opened.id, title: opened.row?.name ?? "Conversation", context: opened.row?.context, state: opened.error ? "error" : opened.data || opened.unknownData ? "ready" : "loading", error: opened.error, onRetry: () => void open(opened.id, true), headerActions: opened.data ? <ConversationLinks conversationId={opened.data.conversationId} /> : undefined, content: opened.data ? <><InboxKnownConversationActions key={opened.data.conversationId} context={knownConversationActionContext(opened.data, opened.row?.name ?? null)} currentUserId={identity.userId} onChanged={() => void open(opened.id, true)} /><ConversationHistory orgId={identity.orgId} conversationId={opened.data.conversationId} requestGeneration={opened.generation} snapshot={{ requestGeneration: opened.generation, data: opened.data }} visible onRefresh={() => void open(opened.id, true)} onAccessLost={accessLost} onUnavailable={unavailable} /><InboxReplyComposer key={`${identity.orgId}:${opened.data.conversationId}`} conversationId={opened.data.conversationId} identity={identity} enabled={replyEnabled} /></> : opened.unknownData ? <><UnknownSenderHistory key={opened.unknownData.senderGroupId} orgId={identity.orgId} senderGroupId={opened.unknownData.senderGroupId} requestGeneration={opened.generation} snapshot={{ requestGeneration: opened.generation, data: opened.unknownData }} visible onRefresh={() => void open(opened.id, true)} onAccessLost={accessLost} onUnavailable={unavailableSenderGroup} /><InboxUnknownSenderActions key={opened.unknownData.senderGroupId} fromAddress={opened.unknownData.rawSender} latestBody={opened.unknownData.history[0]?.body ?? ""} dismissed={filter.view === "dismissed"} onChanged={() => void load(filter)} /></> : undefined } : undefined}
      activity={<>{worksetUpdateError && <p role="status">New conversation check unavailable; retrying.</p>}{metadata.activity ?? <p>{actionsEnabled ? "Select an action to review eligible records." : "Bulk actions and remaining individual tools are being connected."}</p>}{saved.activity}</>} />
    {metadata.review}
    {saved.review}
    {actionsEnabled ? saved.builder : null}
    <Dialog open={review} onOpenChange={closeSelectionReview}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>{selected.length} selected conversations</DialogTitle><DialogDescription>Review each selected conversation against the current filter before continuing.</DialogDescription>{selectionReview?.status === "loading" && <p role="status">Checking selected conversations…</p>}{selectionReview?.status === "error" && <><p role="alert">{selectionReview.error}</p><button type="button" onClick={() => void beginSelectionReview(selectionReview.ids, selectionReview.filter)}>Retry review</button></>}{selectionReview?.status === "ready" && <p role="status">{selectionReview.items.filter(item => item.status === "outside_filter").length} outside this view · {selectionReview.items.filter(item => item.status === "unavailable").length} unavailable</p>}<ul>{selectionReview?.items.map(item => <li className="flex items-center justify-between gap-4 py-2" key={item.id}><span>{item.name} <small>({item.status.replace("_", " ")})</small></span><button type="button" disabled={selectionReview.status === "loading"} onClick={() => removeFromSelectionReview(item.id)}>Remove</button></li>)}</ul></DialogContent></Dialog>
  </QueryClientProvider>;
}
