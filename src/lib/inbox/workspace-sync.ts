import { createCollection } from "@tanstack/db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import { reportError } from "@/lib/errors/report";
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
  unread: boolean | null;
}
export interface WorkspaceScope {
  scopeId: string;
  orgId: string;
  requesterId: string;
  accessEpoch: string;
  /** Local authenticated session identity; never a bearer token. */
  sessionId: string;
  expiresAt: number;
  /** Canonical creation time permits TTL validation without comparing different server clocks. */
  createdAt?: number;
  orderedIds: readonly WorkspaceId[];
}
export type SyncState = "loading" | "live" | "resync_required" | "permission_lost" | "closed";
export interface SyncSnapshot { state: SyncState; rows: readonly WorkspaceRow[] }
export interface WorkspaceSyncOptions {
  origin: string;
  fetch?: typeof fetch;
  onChange: (snapshot: SyncSnapshot) => void;
  /** Authoritative DELETE messages only; never infer deletion from paging/filter absence. */
  onInvalidated?: (ids: readonly WorkspaceId[]) => void;
  /** Synchronously clear detail/query caches and selection on an auth boundary. */
  onAccessBoundary: () => void;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function summaryRow(r: WorkspaceSummary): WorkspaceRow {
  if (!uuid.test(r.org_id) || !uuid.test(r.target_id) || !["known_conversation", "unknown_sender"].includes(r.target_kind)) throw Error("Invalid summary identity");
  for (const key of ["name", "context", "preview", "time_label", "outcome_label", "assigned_label"] as const) {
    if (typeof r[key] !== "string" || r[key].length > 2000) throw Error("Invalid bounded summary text");
  }
  if (typeof r.unread !== "boolean" && !(r.target_kind === "unknown_sender" && r.unread === null)) throw Error("Invalid unread flag");
  return { target: r.target_kind === "known_conversation"
    ? { kind: "conversation", orgId: r.org_id, conversationId: r.target_id }
    : { kind: "unknown_sender_group", orgId: r.org_id, senderGroupId: r.target_id },
    name: r.name, context: r.context, preview: r.preview, timeLabel: r.time_label,
    outcomeLabel: r.outcome_label, assignedLabel: r.assigned_label, unread: r.unread ?? undefined };
}

/** Keep per-request cancellation independent from the workset lifetime. */
export function workspaceRequestSignal(request: RequestInfo | URL, init: RequestInit | undefined, scopeSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([scopeSignal, ...(init?.signal ? [init.signal] : []), ...(request instanceof Request ? [request.signal] : [])]);
}

/** One bounded workset of at most five disjoint 100-row collections at a time. Caller obtains each fresh scope from POST /worksets.
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
    if (!uuid.test(scope.scopeId) || !uuid.test(scope.orgId) || !uuid.test(scope.requesterId) || !scope.sessionId || !scope.accessEpoch || !Number.isFinite(scope.expiresAt) || scope.expiresAt <= Date.now() || (scope.createdAt === undefined ? scope.expiresAt > Date.now() + 900_000 : !Number.isFinite(scope.createdAt) || scope.expiresAt < scope.createdAt || scope.expiresAt - scope.createdAt > 900_000) || scope.orderedIds.length > 500 || new Set(scope.orderedIds).size !== scope.orderedIds.length) {
      stop("resync_required"); throw Error("Invalid or expired bounded workset");
    }
    for (const id of scope.orderedIds) {
      let parts: unknown;
      try { parts = JSON.parse(id); } catch { stop("resync_required"); throw Error("Invalid workset identity"); }
      if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== scope.orgId || !["conversation", "unknown_sender_group"].includes(parts[1]) || typeof parts[2] !== "string" || !uuid.test(parts[2]) || JSON.stringify(parts) !== id) { stop("resync_required"); throw Error("Invalid workset identity"); }
    }
    const localDeadline = scope.createdAt === undefined ? scope.expiresAt : Math.min(scope.expiresAt, Date.now() + scope.expiresAt - scope.createdAt);
    current = scope;
    const token = generation;
    const active = () => token === generation;
    const controller = new AbortController();
    const fail = (state: SyncState) => { if (active()) stop(state, state === "permission_lost"); };
    const authorizedNow = () => {
      if (!active()) return false;
      if (Date.now() >= localDeadline) { fail("resync_required"); return false; }
      return true;
    };
    const partitions: { data: () => WorkspaceSummary[]; ready: () => boolean; cleanup: () => void }[] = [];
    let reported = false;
    const reportSyncFailure = (kind: "invalid_wire" | "transport_failure") => {
      if (reported || !active() || controller.signal.aborted) return;
      reported = true;
      const diagnostic = new Error("Inbox synchronization failed");
      diagnostic.name = "InboxSyncFailure";
      reportError(diagnostic, { errorClass: "transient", tags: { surface: "client", operation: "inbox_sync", kind } });
    };
    const publish = () => {
      if (!authorizedNow()) return;
      try {
        const data = partitions.flatMap(part => part.data());
        if (data.length > 500) throw Error("Collection overflow");
        const indexed = new Map(data.map(row => { const rendered = summaryRow(row); return [workspaceId(rendered.target), rendered] as const; }));
        if (indexed.size !== data.length) throw Error("Duplicate partition membership");
        const complete = partitions.length === Math.max(1, Math.ceil(scope.orderedIds.length / 100));
        emit({ state: complete && partitions.every(part => part.ready()) ? "live" : "loading", rows: scope.orderedIds.flatMap(id => indexed.has(id) ? [indexed.get(id)!] : []) });
      } catch { reportSyncFailure("invalid_wire"); fail("resync_required"); }
    };
    const expiry = setTimeout(() => fail("resync_required"), localDeadline - Date.now());
    dispose = () => { controller.abort(); clearTimeout(expiry); for (const part of partitions) part.cleanup(); };
    for (let partition = 0; partition < Math.max(1, Math.ceil(scope.orderedIds.length / 100)); partition++) {
      if (!active()) break;
      const allowed = new Set(scope.orderedIds.slice(partition * 100, (partition + 1) * 100));
    // Electric may replay historical updates/deletes before the initial
    // up-to-date marker. Those deletes describe rows that never belonged to
    // this client's current collection and must not invalidate a selection;
    // after the marker, deletes are live and authoritative.
    let initialCatchup = true;
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
      if (url.origin !== origin || url.pathname !== `/api/inbox/sync/${scope.scopeId}` || url.searchParams.get("partition") !== String(partition)) throw Error("Sync request escaped same-origin scope");
      const response = await (options.fetch ?? fetch)(request, { ...init, signal: workspaceRequestSignal(request, init, controller.signal), credentials: "same-origin", redirect: "error", cache: "no-store" });
      if (!authorizedNow()) throw new DOMException("Obsolete workset", "AbortError");
      if (response.status === 401 || response.status === 403) { fail("permission_lost"); throw Error("Access lost"); }
      if (response.status === 409 || response.status === 410 || response.status === 413 || response.status === 429) { fail("resync_required"); throw Error("Fresh workset required"); }
      if (response.ok && response.status !== 204) {
        const messages: unknown = await response.clone().json();
        if (!authorizedNow()) throw new DOMException("Obsolete workset", "AbortError");
        if (!Array.isArray(messages) || messages.length > 2000) { fail("resync_required"); throw Error("Unbounded sync batch"); }
        const removed: WorkspaceId[] = [];
        for (const message of messages) {
          if (message?.headers?.control === "must-refetch") { fail("resync_required"); throw Error("Snapshot reset required"); }
          if (message?.headers?.control === "up-to-date") initialCatchup = false;
          // Electric parses PostgreSQL wire strings (including boolean) using its schema.
          // Validate identity here; validate complete typed rows only after parsing/merge.
          if (message?.headers?.operation === "insert") key(message.value);
          if (message?.headers?.operation === "delete") {
            const id = key(message.value);
            if (!initialCatchup) removed.push(id);
          }
        }
        if (removed.length && authorizedNow()) options.onInvalidated?.([...new Set(removed)]);
      }
      return response;
    };
    const collection = createCollection(electricCollectionOptions<WorkspaceSummary>({
      id: `inbox-${scope.scopeId}-${token}-${partition}`, getKey: key, syncMode: "eager",
      shapeOptions: { url: `${origin}/api/inbox/sync/${scope.scopeId}?partition=${partition}`, signal: controller.signal, fetchClient: transport,
        onError: () => { reportSyncFailure("transport_failure"); fail("resync_required"); return undefined; } },
    }));
    const subscription = collection.subscribeChanges(publish);
    partitions.push({ data: () => {
      const rows = collection.toArray;
      if (rows.length > 100) throw Error("Partition overflow");
      for (const row of rows) key(row);
      return rows;
    }, ready: () => collection.status === "ready", cleanup: () => { subscription.unsubscribe(); void collection.cleanup(); } });
    void collection.preload().then(publish).catch(() => { reportSyncFailure("transport_failure"); fail("resync_required"); });
    }

  }
  return { replace, getSnapshot: () => snapshot,
    reset: () => stop("resync_required"), revoke: () => stop("permission_lost", true),
    close: () => stop("closed", true) };
}
