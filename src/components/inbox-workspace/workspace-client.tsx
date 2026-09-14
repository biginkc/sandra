"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { QueryClientProvider } from "@tanstack/react-query";
import { InboxWorkspace, type WorkspaceRow } from "./inbox-workspace";
import { workspaceId, type WorkspaceId } from "./selection";
import { createWorkspaceSync, type SyncSnapshot, type WorkspaceScope } from "@/lib/inbox/workspace-sync";
import { createInboxQueryCache, type InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import { inboxViews, type InboxFilter, type InboxCounts } from "@/lib/inbox/filter-contract";
import { ConversationHistory, type InboxDetailSnapshot } from "./conversation-history";

const labels: Record<InboxFilter["view"], string> = { active: "All", all: "All", mine: "Assigned to me", unassigned: "Unassigned", unread: "Unread", escalated: "Needs review", dispo: "Has outcome", needs_outcome: "Needs outcome", unknown: "Unknown senders", dismissed: "Dismissed" };
type Scope = WorkspaceScope & { nextCursor: string | null; refreshed: boolean };
type Open = { id: WorkspaceId; generation: number; row?: WorkspaceRow; data?: InboxDetailSnapshot; error?: string };
export function InboxWorkspaceClient({ identity, initialFilter }: { identity: InboxQueryIdentity & { expiresAt: number }; initialFilter: InboxFilter }) {
  const [cache] = useState(() => createInboxQueryCache(identity));
  const [snapshot, setSnapshot] = useState<SyncSnapshot>({ state: "loading", rows: [] });
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState(initialFilter.search ?? "");
  const [selected, setSelected] = useState<readonly WorkspaceId[]>([]);
  const [invalidatedIds, setInvalidatedIds] = useState<readonly WorkspaceId[]>([]);
  const activeOpen = useRef<WorkspaceId | null>(null);
  const [review, setReview] = useState(false);
  const [opened, setOpened] = useState<Open | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [counts, setCounts] = useState<InboxCounts>();
  const [countsError, setCountsError] = useState(false);
  const scope = useRef<Scope | null>(null);
  const sync = useRef<ReturnType<typeof createWorkspaceSync> | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const countsGeneration = useRef(0);
  const denied = useRef(false);
  const invalidateViews = useCallback(() => { sequence.current++; countsGeneration.current++; }, []);
  const [selectionNames, setSelectionNames] = useState(new Map<WorkspaceId, string>());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const accessLost = useCallback(() => {
    if (denied.current) return;
    denied.current = true; sequence.current++;
    request.current?.abort(); cache.close();
    setSelectionNames(new Map()); setSelected([]); activeOpen.current = null; setOpened(null); setCounts(undefined); setReview(false);
    sync.current?.revoke(); setSnapshot({ state: "permission_lost", rows: [] }); setBusy(false);
  }, [cache]);
  /** A single item-scoped denial (404): only this conversation is affected. Invalidate
   * its cached detail and close its pane if it is the one currently open — do not
   * touch the rest of the workspace or latch permission_lost. */
  const unavailable = useCallback((id: WorkspaceId) => {
    cache.invalidate("detail", id);
    setInvalidatedIds(previous => (previous.includes(id) ? previous : [...previous, id]));
    if (activeOpen.current === id) { sequence.current++; activeOpen.current = null; setOpened(null); }
  }, [cache]);
  async function json<T>(url: string, init: RequestInit, signal: AbortSignal): Promise<T> {
    const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (response.status === 401 || response.status === 403) { accessLost(); throw Error("Your access has changed. Reload the workspace."); }
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
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(undefined); sync.current?.reset();
    void loadCounts(next);
    try {
      const value = await json<Scope>("/api/inbox/worksets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: identity.orgId, filter: next, cursor, limit: 500, ...(scope.current ? { replacesScopeId: scope.current.scopeId } : {}) }) }, controller.signal);
      if (controller.signal.aborted) return;
      if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.sessionId !== identity.sessionId || value.accessEpoch !== identity.accessEpoch) { accessLost(); return; }
      if (!(value.nextCursor === null || typeof value.nextCursor === "string") || typeof value.refreshed !== "boolean") throw Error("Invalid workspace response");
      setInvalidatedIds([]); sync.current!.replace(value); scope.current = value; setNextCursor(value.nextCursor); setFilter(next);
    } catch (failure) {
      if (!controller.signal.aborted && !denied.current) setError(failure instanceof Error ? failure.message : "Could not load conversations.");
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  useEffect(() => {
    // Each mount owns its transport and no browser persistence. A stale request
    // cannot publish after unmount even when the server completed its scope.
    const adapter = createWorkspaceSync({ origin: window.location.origin, onChange: setSnapshot, onAccessBoundary: accessLost,
      onInvalidated: ids => {
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
      invalidateViews(); request.current?.abort(); clearTimeout(expiry); adapter.reset(); sync.current = null;
      // React Strict Mode immediately installs another owned adapter; a real
      // unmount closes the cache once that synchronous replay is complete.
      queueMicrotask(() => { if (sync.current === null) cache.close(); });
    };
    // The server mounts a new component for a different authenticated identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function select(ids: readonly WorkspaceId[]) {
    if (ids.length > 500) { setError("Select up to 500 conversations at a time."); return; }
    const names = new Map<WorkspaceId, string>();
    for (const id of ids) names.set(id, snapshot.rows.find(row => workspaceId(row.target) === id)?.name ?? selectionNames.get(id) ?? "Conversation outside this view");
    setSelectionNames(names); setSelected(ids);
  }
  async function open(id: WorkspaceId, fresh = false) {
    const generation = ++sequence.current; activeOpen.current = id;
    const row = snapshot.rows.find(value => workspaceId(value.target) === id);
    const parts: unknown = JSON.parse(id);
    setOpened({ id, generation, row });
    if (!Array.isArray(parts) || parts[0] !== identity.orgId || parts[1] !== "conversation") {
      setOpened({ id, generation, row, error: "Unknown sender details are not connected to this preview yet." }); return;
    }
    try {
      const value = await cache.read<InboxDetailSnapshot>("detail", id, signal => json(`/api/inbox/conversations/${parts[2]}/detail?orgId=${identity.orgId}`, {}, signal), fresh);
      if (value.orgId !== identity.orgId || value.requesterId !== identity.userId || value.conversationId !== parts[2] || !Array.isArray(value.history) || value.history.length > 50) throw Error("Conversation response did not match the request.");
      if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, data: value });
    } catch (failure) { if (sequence.current === generation && !denied.current) setOpened({ id, generation, row, error: failure instanceof Error ? failure.message : "Conversation unavailable." }); }
  }
  return <QueryClientProvider client={cache.client}>
    <InboxWorkspace scopeLabel={labels[filter.view]} rows={snapshot.rows} invalidatedIds={invalidatedIds} selectedIds={selected} openId={opened?.id ?? null}
      onSelectionChange={select} onOpen={id => void open(id)} onCloseDetail={() => { sequence.current++; activeOpen.current = null; setOpened(null); }}
      onBack={() => { window.location.href = "/inbox/overview"; }} onReviewSelection={() => setReview(true)}
      actions={[]} onAction={() => {}} connection={{ state: snapshot.state === "permission_lost" ? "permission_lost" : snapshot.state === "live" ? "live" : snapshot.state === "resync_required" ? "offline" : "updating", label: snapshot.state === "permission_lost" ? "Your access has changed. Reload to continue." : snapshot.state === "live" ? "Current workspace is synchronized" : snapshot.state === "resync_required" ? "Refresh this view to reconnect" : "Loading workspace…" }}
      listState={busy || snapshot.state === "loading" ? "loading" : "ready"} listError={error} onRetryList={() => void load(filter)}
      toolbar={<><form onSubmit={event => { event.preventDefault(); void load({ ...filter, search }); }}><label>Search <input aria-label="Search conversations" maxLength={100} value={search} onChange={event => setSearch(event.target.value)} disabled={busy} /></label><button disabled={busy}>Search</button></form>
        <label>View <select value={filter.view} disabled={busy} onChange={event => void load({ ...filter, view: event.target.value as InboxFilter["view"] })}>{inboxViews.filter(view => view !== "active").map(view => <option key={view} value={view}>{labels[view]}</option>)}</select></label>
        <label><input type="checkbox" checked={filter.hide_noise ?? true} disabled={busy} onChange={event => void load({ ...filter, hide_noise: event.target.checked })} /> Hide DNC and test conversations</label>
        <span role="status">{counts ? `${counts.counts[filter.view === "active" ? "all" : filter.view]} matching · counted ${new Date(counts.asOf).toLocaleTimeString()}` : countsError ? "Counts unavailable" : "Loading counts…"}</span>{countsError && <button type="button" onClick={() => void loadCounts(filter, true)}>Retry counts</button>}</>}
      pageControl={<><span>{snapshot.rows.length} loaded</span><button disabled={busy} onClick={() => void load(filter)}>Refresh view</button><button disabled={busy || !nextCursor} onClick={() => void load(filter, nextCursor)}>Next 500</button></>}
      detail={opened ? { targetId: opened.id, title: opened.row?.name ?? "Conversation", context: opened.row?.context, state: opened.error ? "error" : opened.data ? "ready" : "loading", error: opened.error, onRetry: () => void open(opened.id, true), content: opened.data ? <ConversationHistory orgId={identity.orgId} conversationId={opened.data.conversationId} requestGeneration={opened.generation} snapshot={{ requestGeneration: opened.generation, data: opened.data }} visible onRefresh={() => void open(opened.id, true)} onAccessLost={accessLost} onUnavailable={() => unavailable(opened.id)} /> : undefined } : undefined}
      activity={<p>Bulk actions and remaining individual tools are being connected.</p>} />
    <Dialog open={review} onOpenChange={setReview}><DialogContent className="max-h-[85dvh] overflow-auto"><DialogTitle>{selected.length} selected conversations</DialogTitle><DialogDescription>Remove any conversations that do not belong in this group, including those outside the current view.</DialogDescription><ul>{selected.map(id => <li className="flex items-center justify-between gap-4 py-2" key={id}>{selectionNames.get(id)}<button onClick={() => select(selected.filter(value => value !== id))}>Remove</button></li>)}</ul></DialogContent></Dialog>
  </QueryClientProvider>;
}
