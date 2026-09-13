import { createCollection } from "@tanstack/db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import type { WorkspaceRow } from "@/components/inbox-workspace/inbox-workspace";
import { workspaceId, type WorkspaceId } from "@/components/inbox-workspace/selection";

/** Proposed gateway DTO. No transcript, provider secret or arbitrary shape URL. */
export type WorkspaceSummary = {
  org_id: string;
  target_kind: "known_conversation" | "unknown_sender";
  target_id: string;
  name: string;
  context: string;
  preview: string;
  time_label: string;
  outcome_label: string;
  assigned_label: string;
  unread: boolean;
}
export interface WorkspaceScope {
  scopeId: string;
  orgId: string;
  requesterId: string;
  accessEpoch: string;
  /** Local authenticated session identity; never a bearer token. */
  sessionId: string;
  expiresAt: number;
  orderedIds: readonly WorkspaceId[];
}
export type SyncState = "loading" | "live" | "resync_required" | "permission_lost" | "closed";
export interface SyncSnapshot { state: SyncState; rows: readonly WorkspaceRow[] }
export interface WorkspaceSyncOptions {
  origin: string;
  fetch?: typeof fetch;
  onChange: (snapshot: SyncSnapshot) => void;
  /** Synchronously clear detail/query caches and selection on an auth boundary. */
  onAccessBoundary: () => void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function summaryRow(r: WorkspaceSummary): WorkspaceRow {
  if (!uuid.test(r.org_id) || !uuid.test(r.target_id) || !["known_conversation", "unknown_sender"].includes(r.target_kind)) throw Error("Invalid summary identity");
  for (const key of ["name", "context", "preview", "time_label", "outcome_label", "assigned_label"] as const) {
    if (typeof r[key] !== "string" || r[key].length > 2000) throw Error("Invalid bounded summary text");
  }
  if (typeof r.unread !== "boolean") throw Error("Invalid unread flag");
  return { target: r.target_kind === "known_conversation"
    ? { kind: "conversation", orgId: r.org_id, conversationId: r.target_id }
    : { kind: "unknown_sender_group", orgId: r.org_id, senderGroupId: r.target_id },
    name: r.name, context: r.context, preview: r.preview, timeLabel: r.time_label,
    outcomeLabel: r.outcome_label, assignedLabel: r.assigned_label, unread: r.unread };
}

/** Keep per-request cancellation independent from the workset lifetime. */
export function workspaceRequestSignal(request: RequestInfo | URL, init: RequestInit | undefined, scopeSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([scopeSignal, ...(init?.signal ? [init.signal] : []), ...(request instanceof Request ? [request.signal] : [])]);
}

/** One bounded collection at a time. Caller obtains each fresh scope from POST /worksets.
 * No persistence and no optimistic writes. Replacement disposes before opening its successor.
 * Gateway must independently authorize every request and bound response bytes/lease duration.
 */
export function createWorkspaceSync(options: WorkspaceSyncOptions) {
  const origin = new URL(options.origin).origin;
  let generation = 0;
  let current: WorkspaceScope | undefined;
  let dispose: (() => void) | undefined;
  let snapshot: SyncSnapshot = { state: "closed", rows: [] };
  const emit = (next: SyncSnapshot) => { snapshot = next; options.onChange(next); };
  function stop(state: SyncState, accessBoundary = false) {
    generation++;
    dispose?.(); dispose = undefined;
    if (accessBoundary) { current = undefined; options.onAccessBoundary(); }
    emit({ state, rows: [] });
  }
  function replace(input: WorkspaceScope) {
    if (!input || !Array.isArray(input.orderedIds)) {
      stop("resync_required", true); throw Error("Invalid workset membership");
    }
    const scope = { ...input, orderedIds: [...input.orderedIds] };
    // Invalid replacement cannot leave a previous tenant's rows visible.
    const authChanged = !!current && ["orgId", "requesterId", "sessionId", "accessEpoch"].some(k => current![k as keyof WorkspaceScope] !== scope[k as keyof WorkspaceScope]);
    stop("loading", authChanged);
    if (!uuid.test(scope.scopeId) || !uuid.test(scope.orgId) || !uuid.test(scope.requesterId) || !scope.sessionId || !scope.accessEpoch || !Number.isFinite(scope.expiresAt) || scope.expiresAt <= Date.now() || scope.expiresAt > Date.now() + 900_000 || scope.orderedIds.length > 500 || new Set(scope.orderedIds).size !== scope.orderedIds.length) {
      stop("resync_required"); throw Error("Invalid or expired bounded workset");
    }
    for (const id of scope.orderedIds) {
      let parts: unknown;
      try { parts = JSON.parse(id); } catch { stop("resync_required"); throw Error("Invalid workset identity"); }
      if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== scope.orgId || !["conversation", "unknown_sender_group"].includes(parts[1]) || typeof parts[2] !== "string" || !uuid.test(parts[2]) || JSON.stringify(parts) !== id) { stop("resync_required"); throw Error("Invalid workset identity"); }
    }
    current = scope;
    const token = generation;
    const active = () => token === generation;
    const controller = new AbortController();
    const fail = (state: SyncState) => { if (active()) stop(state, state === "permission_lost"); };
    const authorizedNow = () => {
      if (!active()) return false;
      if (Date.now() >= scope.expiresAt) { fail("resync_required"); return false; }
      return true;
    };
    const allowed = new Set(scope.orderedIds);
    const key = (r: WorkspaceSummary) => {
      if (!uuid.test(r.org_id) || !uuid.test(r.target_id) || !["known_conversation", "unknown_sender"].includes(r.target_kind)) { fail("permission_lost"); throw Error("Invalid summary identity"); }
      const id = workspaceId(r.target_kind === "known_conversation"
        ? {kind:"conversation",orgId:r.org_id,conversationId:r.target_id}
        : {kind:"unknown_sender_group",orgId:r.org_id,senderGroupId:r.target_id});
      if (r.org_id !== scope.orgId || !allowed.has(id)) { fail("permission_lost"); throw Error("Summary outside authorized workset"); }
      return id;
    };
    const transport: typeof fetch = async (request, init) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (url.origin !== origin || url.pathname !== `/api/inbox/sync/${scope.scopeId}`) throw Error("Sync request escaped same-origin scope");
      const response = await (options.fetch ?? fetch)(request, { ...init, signal: workspaceRequestSignal(request, init, controller.signal), credentials: "same-origin", redirect: "error", cache: "no-store" });
      if (!authorizedNow()) throw new DOMException("Obsolete workset", "AbortError");
      if (response.status === 401 || response.status === 403) { fail("permission_lost"); throw Error("Access lost"); }
      if (response.status === 409 || response.status === 410 || response.status === 413 || response.status === 429) { fail("resync_required"); throw Error("Fresh workset required"); }
      if (response.ok && response.status !== 204) {
        const messages: unknown = await response.clone().json();
        if (!authorizedNow()) throw new DOMException("Obsolete workset", "AbortError");
        if (!Array.isArray(messages) || messages.length > 2000) { fail("resync_required"); throw Error("Unbounded sync batch"); }
        for (const message of messages) {
          if (message?.headers?.control === "must-refetch") { fail("resync_required"); throw Error("Snapshot reset required"); }
          if (message?.headers?.operation === "insert") { summaryRow(message.value); key(message.value); }
        }
      }
      return response;
    };
    const collection = createCollection(electricCollectionOptions<WorkspaceSummary>({
      id: `inbox-${scope.scopeId}-${token}`, getKey: key, syncMode: "eager",
      shapeOptions: { url: `${origin}/api/inbox/sync/${scope.scopeId}`, signal: controller.signal, fetchClient: transport,
        onError: () => { fail("resync_required"); return undefined; } },
    }));
    const publish = () => {
      if (!authorizedNow()) return;
      try {
        const data = collection.toArray;
        if (data.length > 500) throw Error("Collection overflow");
        const indexed = new Map(data.map(r => [key(r), summaryRow(r)]));
        emit({ state: collection.status === "ready" ? "live" : "loading", rows: scope.orderedIds.flatMap(id => indexed.has(id) ? [indexed.get(id)!] : []) });
      } catch { fail("resync_required"); }
    };
    const subscription = collection.subscribeChanges(publish);
    const expiry = setTimeout(() => fail("resync_required"), scope.expiresAt - Date.now());
    dispose = () => { controller.abort(); clearTimeout(expiry); subscription.unsubscribe(); void collection.cleanup(); };
    void collection.preload().then(publish).catch(() => fail("resync_required"));
  }
  return { replace, getSnapshot: () => snapshot,
    reset: () => stop("resync_required"), revoke: () => stop("permission_lost", true),
    close: () => stop("closed", true) };
}
