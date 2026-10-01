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
import { useInboxMetadataActions } from "./use-metadata-actions";
import { InboxReplyComposer } from "./reply-composer";
import type { InboxReplyTarget } from "@/lib/inbox/reply-api-contract";
import type { InboxDripCounts, InboxDripMarker } from "@/lib/inbox/drip-markers";

const labels: Record<InboxFilter["view"], string> = { active: "All", all: "All", mine: "Assigned to me", unassigned: "Unassigned", unread: "Unread", escalated: "Needs review", dispo: "Has outcome", needs_outcome: "Needs outcome", in_drip: "In a drip", drip_replied: "Replied to drip", unknown: "Unknown senders", dismissed: "Dismissed" };
const isDripView = (view: InboxFilter["view"]) => view === "in_drip" || view === "drip_replied";
const WORKSET_MIN_INTERVAL_MS = 1100;
const WORKSET_RETRY_LIMIT = 5;
type Scope = WorkspaceScope & { nextCursor: string | null; refreshed: boolean };
type WorkspaceCounts = InboxCounts | InboxDripCounts;
type Open = { id: WorkspaceId; generation: number; row?: WorkspaceRow; data?: InboxDetailSnapshot; error?: string };
function replyTargetFromWorkspaceId(value: WorkspaceId, orgId: string): InboxReplyTarget {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== orgId || !["conversation", "unknown_sender_group"].includes(String(parsed[1])) || typeof parsed[2] !== "string") throw Error("The selected conversation is not eligible for reply review.");
  return { kind: parsed[1] as InboxReplyTarget["kind"], id: parsed[2] };
}
function replyTargetName(target: InboxReplyTarget): string { return `${target.kind}:${target.id}`; }
function replyTargetCount(ids: readonly WorkspaceId[], orgId: string): number {
  return ids.reduce((count, id) => {
    try { replyTargetFromWorkspaceId(id, orgId); return count + 1; } catch { return count; }
  }, 0);
}
export function InboxWorkspaceClient({ identity, initialFilter, actionsEnabled = false, repliesEnabled = false }: { identity: InboxQueryIdentity & { expiresAt: number }; initialFilter: InboxFilter; actionsEnabled?: boolean; repliesEnabled?: boolean }) {
  const [cache] = useState(() => createInboxQueryCache(identity));
  const [snapshot, setSnapshot] = useState<SyncSnapshot>({ state: "loading", rows: [] });
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState(initialFilter.search ?? "");
  const [selected, setSelected] = useState<readonly WorkspaceId[]>([]);
  const selectedRef = useRef<readonly WorkspaceId[]>([]);
  const [invalidatedIds, setInvalidatedIds] = useState<readonly WorkspaceId[]>([]);
  const activeOpen = useRef<WorkspaceId | null>(null);
  const [review, setReview] = useState(false);
  const [bulkReplyOpen, setBulkReplyOpen] = useState(false);
  const [opened, setOpened] = useState<Open | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [counts, setCounts] = useState<WorkspaceCounts>();
  const [countsError, setCountsError] = useState(false);
  const [dripMarkers, setDripMarkers] = useState(new Map<string, InboxDripMarker>());
  const markerAsOf = useRef(0);
  const markerGeneration = useRef(0);
  const markerRequest = useRef<AbortController | null>(null);
  const reconciliationRequest = useRef<AbortController | null>(null);
  const reconciliationPromise = useRef<Promise<void> | null>(null);
  const reconciliationAgain = useRef(false);
  const walkGeneration = useRef(0);
  const pagesShown = useRef(1);
  const liveScopeId = useRef<string | null>(null);
  const lastWorksetAt = useRef(0);
  const filterRef = useRef(initialFilter);
  const busyRef = useRef(true);
  const scope = useRef<Scope | null>(null);
  const sync = useRef<ReturnType<typeof createWorkspaceSync> | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const countsGeneration = useRef(0);
  const denied = useRef(false);
  const invalidateViews = useCallback(() => { sequence.current++; countsGeneration.current++; }, []);
  const [selectionNames, setSelectionNames] = useState(new Map<WorkspaceId, string>());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const clearActions = useRef<() => void>(() => {});
  const replaceSelected = useCallback((ids: readonly WorkspaceId[]) => {
    selectedRef.current = ids;
    setSelected(ids);
    if (ids.length < 2 || (repliesEnabled && replyTargetCount(ids, identity.orgId) < 2)) setBulkReplyOpen(false);
  }, [identity.orgId, repliesEnabled]);
  const accessLost = useCallback(() => {
    if (denied.current) return;
    denied.current = true; sequence.current++;
    request.current?.abort(); markerRequest.current?.abort(); reconciliationRequest.current?.abort(); clearActions.current(); cache.close();
    setSelectionNames(new Map()); replaceSelected([]); activeOpen.current = null; setOpened(null); setCounts(undefined); setDripMarkers(new Map()); setReview(false);
    sync.current?.revoke(); setSnapshot({ state: "permission_lost", rows: [] }); setBusy(false);
  }, [cache, replaceSelected]);
  /** A single item-scoped denial (404): only this target is affected. Invalidate its
   * cached detail, prune it from selection the same way the sync adapter's authoritative
   * onInvalidated does below (selected IDs must never silently become replacement rows,
   * nor resurrect once invalidatedIds clears on the next load()), and close its pane if
   * it is the one currently open — do not touch the rest of the workspace or latch
   * permission_lost. Stable across renders (a child effect keys off this reference —
   * see conversation-history.tsx). */
  const invalidateTarget = useCallback((target: WorkspaceTarget) => {
    const id = workspaceId(target);
    cache.invalidate("detail", id);
    setInvalidatedIds(previous => (previous.includes(id) ? previous : [...previous, id]));
    replaceSelected(selectedRef.current.filter(value => value !== id));
    setSelectionNames(previous => { if (!previous.has(id)) return previous; const next = new Map(previous); next.delete(id); return next; });
    if (activeOpen.current === id) { sequence.current++; activeOpen.current = null; setOpened(null); }
  }, [cache, replaceSelected]);
  const unavailable = useCallback((conversationId: string) =>
    invalidateTarget({ kind: "conversation", orgId: identity.orgId, conversationId }), [invalidateTarget, identity.orgId]);
  const unavailableSenderGroup = useCallback((senderGroupId: string) =>
    invalidateTarget({ kind: "unknown_sender_group", orgId: identity.orgId, senderGroupId }), [invalidateTarget, identity.orgId]);
  const metadata = useInboxMetadataActions({ enabled: actionsEnabled, selectionCount: selected.length, identity, orgId: identity.orgId, names: selectionNames, cache, onAccessLost: accessLost, onCompleted: () => { void refreshAfterAction(); } });
  useEffect(() => { clearActions.current = metadata.clear; }, [metadata.clear]);
  async function json<T>(url: string, init: RequestInit, signal: AbortSignal, notFound?: () => void, options?: { preserveAuthErrors?: boolean }): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), credentials: "same-origin", cache: "no-store", redirect: "error" });
    if ((response.status === 401 || response.status === 403) && !options?.preserveAuthErrors) { accessLost(); throw Error("Your access has changed. Reload the workspace."); }
    // A 404 here is item-scoped (see read-api.ts's fail()): only the caller-identified
    // target is unavailable, not the whole workspace. Only routes that resolve a single
    // item pass notFound; worksets/counts have no such case and fall through as before.
    if (response.status === 404 && notFound) { notFound(); throw new DOMException("This item is unavailable.", "AbortError"); }
    if (!response.ok) {
      const failure = Error(response.status === 429 ? "Please wait before refreshing this view." : "The request could not be completed. Try again.");
      Object.assign(failure, { status: response.status });
      throw failure;
    }
    const value = await response.json(); signal.throwIfAborted();
    if (denied.current) throw new DOMException("Access ended", "AbortError");
    return value as T;
  }
  function markerIds(ids: readonly WorkspaceId[]): string[] {
    const result: string[] = [];
    for (const value of ids) {
      try {
        const parts: unknown = JSON.parse(value);
        if (Array.isArray(parts) && parts[0] === identity.orgId && parts[1] === "conversation" && typeof parts[2] === "string") result.push(parts[2]);
      } catch { /* invalid workset identities are rejected by the sync adapter */ }
    }
    return [...new Set(result)];
  }
  async function refreshDripMarkers(ids: readonly string[]) {
    const token = ++markerGeneration.current;
    markerRequest.current?.abort();
    if (!ids.length) { setDripMarkers(new Map()); return; }
    const controller = new AbortController(); markerRequest.current = controller;
    try {
      const value = await json<{ orgId: string; asOf: string; rows: InboxDripMarker[] }>("/api/inbox/drip-markers", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: identity.orgId, conversationIds: ids }),
      }, controller.signal);
      const asOf = Date.parse(value.asOf);
      if (value.orgId !== identity.orgId || !Number.isFinite(asOf) || asOf < markerAsOf.current || token !== markerGeneration.current || denied.current) return;
      const next = new Map<string, InboxDripMarker>();
      for (const marker of value.rows) {
        if (marker.inDrip || marker.dripReplied) next.set(marker.conversationId, marker);
      }
      markerAsOf.current = asOf; setDripMarkers(next);
    } catch { /* marker decoration is fail-closed; the authenticated list remains usable */ }
  }
  async function loadCounts(next: InboxFilter, fresh = false) {
    const token = ++countsGeneration.current;
    setCounts(undefined); setCountsError(false);
    const key = JSON.stringify(next);
    try {
      const value = await cache.read<WorkspaceCounts>("counts", key, signal => {
        const params = new URLSearchParams({ orgId: identity.orgId, view: next.view, hide_noise: String(next.hide_noise ?? true), search: next.search ?? "" });
        return json(`/api/inbox/counts?${params}`, {}, signal);
      }, fresh);
      if (value.accessEpoch !== identity.accessEpoch) { accessLost(); return; }
      if (!denied.current && token === countsGeneration.current) setCounts(value);
    } catch { if (!denied.current && token === countsGeneration.current) setCountsError(true); }
  }

  function cancelReconciliation() {
    walkGeneration.current++;
    reconciliationAgain.current = false;
    reconciliationRequest.current?.abort();
  }

  function wait(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function statusOf(error: unknown): number | undefined {
    return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
  }

  async function waitForWorksetSlot(signal: AbortSignal) {
    await wait(Math.max(0, lastWorksetAt.current + WORKSET_MIN_INTERVAL_MS - Date.now()), signal);
  }

  async function postWorkset(next: InboxFilter, cursor: string | null, replacesScopeId: string | null, signal: AbortSignal, preserveAuthErrors = false): Promise<Scope> {
    const body = JSON.stringify({ orgId: identity.orgId, filter: next, cursor, limit: 500, replacesScopeId });
    for (let attempt = 0; attempt < WORKSET_RETRY_LIMIT; attempt++) {
      await waitForWorksetSlot(signal);
      try {
        const value = await json<Scope>("/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body }, signal, undefined, { preserveAuthErrors });
        if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.sessionId !== identity.sessionId || value.accessEpoch !== identity.accessEpoch || !(value.nextCursor === null || typeof value.nextCursor === "string") || typeof value.refreshed !== "boolean") throw Error("Invalid workspace response");
        signal.throwIfAborted();
        lastWorksetAt.current = Date.now();
        return value;
      } catch (failure) {
        if (signal.aborted || (failure instanceof DOMException && failure.name === "AbortError")) throw failure;
        if (statusOf(failure) !== 429 || attempt === WORKSET_RETRY_LIMIT - 1) throw failure;
        await wait(WORKSET_MIN_INTERVAL_MS * 2 ** attempt, signal);
      }
    }
    throw Error("Workset retry loop ended unexpectedly.");
  }

  async function load(next: InboxFilter, cursor: string | null = null) {
    if (denied.current) return;
    cancelReconciliation();
    request.current?.abort(); markerRequest.current?.abort();
    const controller = new AbortController(); request.current = controller;
    busyRef.current = true; filterRef.current = next; setBusy(true); setError(undefined); sync.current?.reset();
    void loadCounts(next);
    try {
      const value = await postWorkset(next, cursor, liveScopeId.current ?? scope.current?.scopeId ?? null, controller.signal);
      if (controller.signal.aborted) return;
      liveScopeId.current = value.scopeId;
      pagesShown.current = cursor === null ? 1 : pagesShown.current + 1;
      const nextScope: Scope = value;
      setInvalidatedIds([]); setDripMarkers(new Map()); sync.current!.replace(nextScope); scope.current = nextScope; setNextCursor(value.nextCursor); setFilter(next);
      void refreshDripMarkers(markerIds(value.orderedIds));
    } catch (failure) {
      if (!controller.signal.aborted && !denied.current) setError(failure instanceof Error ? failure.message : "Could not load conversations.");
    } finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  }
  async function reconcileWorkspace() {
    const next = filterRef.current;
    if (denied.current || !scope.current || !liveScopeId.current) return;
    if (reconciliationPromise.current) {
      reconciliationAgain.current = true;
      walkGeneration.current++;
      reconciliationRequest.current?.abort();
      return reconciliationPromise.current;
    }
    const promise = (async () => {
      do {
        reconciliationAgain.current = false;
        const generation = ++walkGeneration.current;
        const controller = new AbortController();
        reconciliationRequest.current = controller;
        try {
          const depth = Math.max(1, pagesShown.current);
          let cursor: string | null = null;
          let replacesScopeId: string | null = liveScopeId.current;
          let finalScope: Scope | null = null;
          let reached = 0;
          const currentWalk = () => generation === walkGeneration.current;
          for (let page = 1; page <= depth; page++) {
            const value = await postWorkset(next, cursor, replacesScopeId, controller.signal, true);
            // The newest successful step is the only safe replacement anchor,
            // including when a later step fails before the final page publishes.
            liveScopeId.current = value.scopeId; // walk step anchor
            replacesScopeId = value.scopeId;
            if (!currentWalk()) {
              if (reconciliationAgain.current) break;
              return;
            }
            finalScope = value;
            reached = page;
            if (value.nextCursor === null || page === depth) break;
            cursor = value.nextCursor;
          }
          if (!finalScope || !currentWalk()) {
            if (reconciliationAgain.current) continue;
            return;
          }
          if (reached < depth) pagesShown.current = reached;
          setError(undefined);
          scope.current = finalScope; setNextCursor(finalScope.nextCursor); sync.current?.replace(finalScope); void refreshDripMarkers(markerIds(finalScope.orderedIds));
        } catch (failure) {
          if (!controller.signal.aborted && generation === walkGeneration.current && !denied.current) setError(failure instanceof Error ? failure.message : "Could not refresh this view.");
        } finally {
          if (reconciliationRequest.current === controller) reconciliationRequest.current = null;
        }
      } while (reconciliationAgain.current && !denied.current);
    })();
    const settled = promise.finally(() => { if (reconciliationPromise.current === settled) reconciliationPromise.current = null; });
    reconciliationPromise.current = settled;
    return settled;
  }

  async function reconcileDripView() {
    if (denied.current || !isDripView(filterRef.current.view) || busyRef.current) return;
    await reconcileWorkspace();
  }
  useEffect(() => {
    // Each mount owns its transport and no browser persistence. A stale request
    // cannot publish after unmount even when the server completed its scope.
    const adapter = createWorkspaceSync({ origin: window.location.origin, onChange: next => { setSnapshot(next); void refreshDripMarkers(markerIds(next.rows.map(row => workspaceId(row.target)))); }, onProbe: () => { const ids = markerIds(sync.current?.getSnapshot().rows.map(row => workspaceId(row.target)) ?? []); void refreshDripMarkers(ids); void loadCounts(filterRef.current, true); void reconcileDripView(); }, onAccessBoundary: accessLost,
      onInvalidated: ids => {
        setInvalidatedIds(previous => [...new Set([...previous, ...ids])]);
        replaceSelected(selectedRef.current.filter(id => !ids.includes(id)));
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
      invalidateViews(); cancelReconciliation(); request.current?.abort(); markerRequest.current?.abort(); clearTimeout(expiry); adapter.reset(); sync.current = null;
      // React Strict Mode immediately installs another owned adapter; a real
      // unmount closes the cache once that synchronous replay is complete.
      queueMicrotask(() => { if (sync.current === null) cache.close(); });
    };
    // The server mounts a new component for a different authenticated identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function refreshAfterAction() {
    const openId = activeOpen.current;
    await reconcileWorkspace();
    if (denied.current) return;
    const ids = markerIds(scope.current?.orderedIds ?? []);
    await refreshDripMarkers(ids);
    if (openId && activeOpen.current === openId) await open(openId, true);
  }
  function select(ids: readonly WorkspaceId[]) {
    if (ids.length > 500) { setError("Select up to 500 conversations at a time."); return; }
    const names = new Map<WorkspaceId, string>();
    for (const id of ids) names.set(id, snapshot.rows.find(row => workspaceId(row.target) === id)?.name ?? selectionNames.get(id) ?? "Conversation outside this view");
    setSelectionNames(names); replaceSelected(ids);
  }
  async function open(id: WorkspaceId, fresh = false) {
    const generation = ++sequence.current; activeOpen.current = id;
    const row = snapshot.rows.find(value => workspaceId(value.target) === id);
    const parts: unknown = JSON.parse(id);
    setOpened({ id, generation, row });
    if (!Array.isArray(parts) || parts[0] !== identity.orgId || parts[1] !== "conversation") {
      setOpened({ id, generation, row, error: "Unknown sender details are not connected to this preview yet." }); return;
    }
    const conversationId = parts[2] as string;
    try {
      // A 404 here means this conversation became item-inaccessible between workset
      // capture and Open (dismissed, purged cursor, etc.) — remove it from the row/
      // selection via unavailable() instead of leaving a generic error under a stale row.
      const value = await cache.read<InboxDetailSnapshot>("detail", id, signal => json(`/api/inbox/conversations/${conversationId}/detail?orgId=${identity.orgId}`, {}, signal, () => unavailable(conversationId)), fresh);
      if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.conversationId !== conversationId || !Array.isArray(value.history) || value.history.length > 50) throw Error("Conversation response did not match the request.");
      if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, data: value });
    } catch (failure) { if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, error: failure instanceof Error ? failure.message : "Conversation unavailable." }); }
  }
  const selectedReplyTargets = repliesEnabled ? selected.flatMap(id => {
    try { return [replyTargetFromWorkspaceId(id, identity.orgId)]; } catch { return []; }
  }) : [];
  const replyNames = new Map(selectedReplyTargets.map(target => [replyTargetName(target), selectionNames.get(workspaceIdForReplyTarget(target)) ?? "Selected conversation"]));
  const openReplyNames = opened?.data ? new Map([[`conversation:${opened.data.conversationId}`, opened.row?.name ?? "Conversation"]]) : undefined;
  function workspaceIdForReplyTarget(target: InboxReplyTarget): WorkspaceId {
    return JSON.stringify([identity.orgId, target.kind, target.id]) as WorkspaceId;
  }
  const displayRows = snapshot.rows.map(row => {
    const marker = row.target.kind === "conversation" ? dripMarkers.get(row.target.conversationId) : undefined;
    return marker && marker.dripName ? { ...row, drip: { state: marker.dripReplied ? "replied" as const : "in_drip" as const, name: marker.dripName } } : row;
  });
  return <QueryClientProvider client={cache.client}>
    <InboxWorkspace scopeLabel={labels[filter.view]} rows={displayRows} invalidatedIds={invalidatedIds} selectedIds={selected} openId={opened?.id ?? null}
      onSelectionChange={select} onOpen={id => void open(id)} onCloseDetail={() => { sequence.current++; activeOpen.current = null; setOpened(null); }}
      onBack={() => { window.location.href = "/inbox/overview"; }} onReviewSelection={() => setReview(true)}
      replyUiEnabled={repliesEnabled} onBulkReply={() => setBulkReplyOpen(true)}
      actions={metadata.actions} onAction={metadata.prepare} connection={{ state: snapshot.state === "permission_lost" ? "permission_lost" : snapshot.state === "live" ? "live" : snapshot.state === "resync_required" ? "offline" : "updating", label: snapshot.state === "permission_lost" ? "Your access has changed. Reload to continue." : snapshot.state === "live" ? "Current workspace is synchronized" : snapshot.state === "resync_required" ? "Refresh this view to reconnect" : "Loading workspace…" }}
      listState={busy || snapshot.state === "loading" ? "loading" : "ready"} listError={error} onRetryList={() => void load(filter)}
      toolbar={<><form onSubmit={event => { event.preventDefault(); void load({ ...filter, search }); }}><label>Search <input aria-label="Search conversations" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} disabled={busy} /></label><button disabled={busy}>Search</button></form>
        <label>View <select value={filter.view} disabled={busy} onChange={event => void load({ ...filter, view: event.target.value as InboxFilter["view"] })}>{inboxViews.filter(view => view !== "active").map(view => <option key={view} value={view}>{labels[view]}</option>)}</select></label>
        <label><input type="checkbox" checked={filter.hide_noise ?? true} disabled={busy} onChange={event => void load({ ...filter, hide_noise: event.target.checked })} /> Hide DNC and test conversations</label>
        <span role="status">{(() => {
          const matching = counts && (isDripView(filter.view)
            ? (filter.view === "in_drip" ? ("inDrip" in counts ? counts.inDrip : undefined) : ("dripReplied" in counts ? counts.dripReplied : undefined))
            : ("counts" in counts ? counts.counts[filter.view === "active" ? "all" : filter.view] : undefined));
          return matching === undefined ? (countsError ? "Counts unavailable" : "Loading counts…") : `${matching} matching · counted ${new Date(counts?.asOf ?? Date.now()).toLocaleTimeString()}`;
        })()}</span>{countsError && <button type="button" onClick={() => void loadCounts(filter, true)}>Retry counts</button>}</>}
      pageControl={<><span>{snapshot.rows.length} loaded</span><button disabled={busy} onClick={() => void load(filter)}>Refresh view</button><button disabled={busy || !nextCursor} onClick={() => void load(filter, nextCursor)}>Next 500</button></>}
      detail={opened ? { targetId: opened.id, title: opened.row?.name ?? "Conversation", context: opened.row?.context, state: opened.error ? "error" : opened.data ? "ready" : "loading", error: opened.error, onRetry: () => void open(opened.id, true), content: opened.data ? <><ConversationHistory orgId={identity.orgId} conversationId={opened.data.conversationId} requestGeneration={opened.generation} snapshot={{ requestGeneration: opened.generation, data: opened.data }} visible onRefresh={() => void open(opened.id, true)} onAccessLost={accessLost} onUnavailable={unavailable} />{repliesEnabled && <InboxReplyComposer key={opened.data.conversationId} targets={[{ kind: "conversation", id: opened.data.conversationId }]} names={openReplyNames} routeKey={opened.data.captureGeneration} enabled />}</> : undefined } : undefined}
      activity={metadata.activity ?? (repliesEnabled ? undefined : <p>{actionsEnabled ? "Select an action to review eligible records. Replies and remaining individual tools are being connected." : "Bulk actions and remaining individual tools are being connected."}</p>)} />
    {metadata.review}
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>{selected.length} selected conversations</DialogTitle><DialogDescription>Remove any conversations that do not belong in this group, including those outside the current view.</DialogDescription><ul>{selected.map(id => <li className="flex items-center justify-between gap-4 py-2" key={id}>{selectionNames.get(id)}<button onClick={() => select(selected.filter(value => value !== id))}>Remove</button></li>)}</ul></DialogContent></Dialog>
    <Dialog open={repliesEnabled && bulkReplyOpen && selectedReplyTargets.length >= 2} onOpenChange={setBulkReplyOpen}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>Bulk reply review</DialogTitle><DialogDescription>Review every eligible destination before anything is sent. Excluded conversations stay visible with the server&apos;s reason.</DialogDescription>{selectedReplyTargets.length >= 2 && <InboxReplyComposer targets={selectedReplyTargets} names={replyNames} routeKey={selectedReplyTargets.map(replyTargetName).sort().join("|")} enabled onClose={() => setBulkReplyOpen(false)} />}</DialogContent></Dialog>
  </QueryClientProvider>;
}
