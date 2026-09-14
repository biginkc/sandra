import React, { useEffect, useMemo, useRef, useState } from "react";
import { FetchError } from "@electric-sql/client";
import { createRoot } from "react-dom/client";
import { createCollection, useLiveQuery } from "@tanstack/react-db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as selection from "../ui/selection.js";

type Summary = {
  org_id: string;
  conversation_id: string;
  property_id: string;
  last_preview: string;
  latest_message_at: string;
  outcome: string | null;
  assigned_user_id: string | null;
  revision: string | number;
};
type Workset = { id: string; ids: string[]; shapeUrl: string };
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Receipt = {
  state: string;
  receipts: { property_id: string; step: string; state: string }[];
};
const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const auth = {
  authorization: "Bearer synthetic-a",
  "content-type": "application/json",
};
const bulkHeaders = {
  "x-fixture-user": user,
  "content-type": "application/json",
};
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const target = (r: Summary): selection.Target => ({
  kind: "conversation",
  orgId: r.org_id,
  conversationId: r.conversation_id,
});
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let body: { error?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    if (!response.ok)
      throw new HttpError(response.status, `HTTP ${response.status}`);
    throw new Error("Unreadable response; result not confirmed");
  }
  if (!response.ok)
    throw new HttpError(
      response.status,
      body.error ?? `HTTP ${response.status}`,
    );
  return body as T;
}
function Root() {
  const [workset, setWorkset] = useState<Workset | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const currentId = useRef("");
  function denyAccess() {
    currentId.current = "";
    queryClient.clear();
    setWorkset(null);
    setError("Access denied. Local working data has been cleared.");
  }
  useEffect(() => {
    let canceled = false;
    let scope: Workset | undefined;
    json<Workset>("/sync/worksets", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ limit: 100 }),
    })
      .then((w) => {
        scope = w;
        if (!canceled) {
          currentId.current = w.id;
          setWorkset(w);
        } else
          void fetch(`/sync/worksets/${w.id}`, {
            method: "DELETE",
            headers: auth,
          });
      })
      .catch((e) => {
        if (!canceled) {
          if (e instanceof HttpError && (e.status === 401 || e.status === 403))
            denyAccess();
          else setError(String(e));
        }
      });
    return () => {
      canceled = true;
      if (scope)
        void fetch(`/sync/worksets/${scope.id}`, {
          method: "DELETE",
          headers: auth,
        });
    };
  }, [generation]);
  useEffect(() => {
    if (!workset) return;
    const timer = setTimeout(() => setGeneration((g) => g + 1), 45_000);
    return () => clearTimeout(timer);
  }, [workset]);
  if (error)
    return (
      <main className="boot" role="alert">
        Integration dependency unavailable: {error}
      </main>
    );
  if (!workset)
    return (
      <main className="boot">Opening a bounded synthetic working set…</main>
    );
  return (
    <Workspace
      workset={workset}
      onStreamError={(id, e) => {
        if (id !== currentId.current) return false;
        if (e instanceof FetchError && (e.status === 401 || e.status === 403)) {
          denyAccess();
        } else if (e instanceof FetchError && e.status === 410) {
          currentId.current = "";
          setGeneration((g) => g + 1);
        }
        return true;
      }}
    />
  );
}
function Workspace({
  workset,
  onStreamError,
}: {
  workset: Workset;
  onStreamError: (id: string, e: Error) => boolean;
}) {
  const [syncError, setSyncError] = useState("");
  const collection = useMemo(
    () =>
      createCollection(
        electricCollectionOptions<Summary>({
          id: `browser-${workset.id}`,
          getKey: (row) => row.conversation_id,
          syncMode: "eager",
          shapeOptions: {
            url: `${location.origin}/sync${new URL(workset.shapeUrl).pathname}`,
            headers: auth,
            onError: (e) => {
              if (onStreamError(workset.id, e))
                setSyncError(`Synchronization paused: ${e.message}`);
              return undefined;
            },
          },
        }),
      ),
    [workset.id],
  );
  useEffect(() => {
    setSyncError("");
    return () => {
      void collection.cleanup();
    };
  }, [collection]);
  const { data } = useLiveQuery((q) => q.from({ r: collection }));
  const byId = new Map(data.map((r) => [r.conversation_id, r]));
  const rows = workset.ids.flatMap((id) =>
    byId.has(id) ? [byId.get(id)!] : [],
  );
  const [state, setState] = useState(selection.initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [onlySelected, setOnlySelected] = useState(false);
  const selectedKeys = new Set(state.selected.map(selection.key));
  const visible = onlySelected
    ? rows.filter((r) => selectedKeys.has(selection.key(target(r))))
    : rows;
  const listRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 54,
    getItemKey: (i) => visible[i].conversation_id,
    overscan: 3,
  });
  const [operationId, setOperationId] = useState("");
  const [actionError, setActionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pendingCommand = useRef<{
    clientRequestId: string;
    conversationIds: string[];
    outcome: string;
    assignedUserId: string;
  } | null>(null);
  const receipt = useQuery({
    queryKey: ["operation", operationId],
    enabled: Boolean(operationId),
    queryFn: () =>
      json<Receipt>(`/bulk/operations/${operationId}`, {
        headers: bulkHeaders,
      }),
    refetchInterval: (query) =>
      ["completed", "partial"].includes(query.state.data?.state ?? "")
        ? false
        : 500,
  });
  function apply(next: selection.State) {
    stateRef.current = next;
    setState(next);
  }
  function point(e: React.PointerEvent): selection.Point {
    const container = listRef.current!;
    const bounds = container.getBoundingClientRect();
    return {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top + container.scrollTop,
    };
  }
  async function act(targets: readonly selection.Target[], retry = false) {
    if (
      syncError ||
      submitting ||
      (!retry &&
        (!targets.length || targets.length > 50 || pendingCommand.current)) ||
      (retry && !pendingCommand.current)
    )
      return;
    const ids = targets.flatMap((t) =>
      t.kind === "conversation" ? [t.conversationId] : [],
    );
    if (!pendingCommand.current)
      pendingCommand.current = {
        clientRequestId: crypto.randomUUID(),
        conversationIds: ids,
        outcome: "interested",
        assignedUserId: user,
      };
    setSubmitting(true);
    setActionError("");
    try {
      const accepted = await json<{ operationId: string }>("/bulk/operations", {
        method: "POST",
        headers: bulkHeaders,
        body: JSON.stringify(pendingCommand.current),
      });
      pendingCommand.current = null;
      setOperationId(accepted.operationId);
    } catch (e) {
      if (
        e instanceof HttpError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408
      ) {
        pendingCommand.current = null;
        setActionError(`Request rejected: ${e.message}`);
      } else
        setActionError(
          `Result not confirmed for ${pendingCommand.current?.conversationIds.length} conversations. Check the same request: ${String(e)}`,
        );
    } finally {
      setSubmitting(false);
    }
  }
  function pointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!(e.target instanceof Element) || e.target.closest("[data-control]"))
      return;
    const id = e.target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    const row = id ? byId.get(id) : undefined;
    if (!row && !e.shiftKey) return;
    apply(
      selection.begin(stateRef.current, {
        point: point(e),
        target: row ? target(row) : null,
        shift: e.shiftKey,
        eligible: visible.map(target),
        button: e.button,
      }),
    );
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function pointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!stateRef.current.gesture) return;
    const container = listRef.current!;
    const bounds = container.getBoundingClientRect();
    const geometry = [
      ...container.querySelectorAll<HTMLElement>("[data-row-id]"),
    ].flatMap((el) => {
      const row = byId.get(el.dataset.rowId!);
      if (!row) return [];
      const b = el.getBoundingClientRect();
      return [
        {
          target: target(row),
          left: b.left - bounds.left,
          right: b.right - bounds.left,
          top: b.top - bounds.top + container.scrollTop,
          bottom: b.bottom - bounds.top + container.scrollTop,
        },
      ];
    });
    const p = point(e);
    apply(selection.move(stateRef.current, p, geometry));
    const g = stateRef.current.gesture;
    if (rectRef.current && g?.mode === "rectangle") {
      Object.assign(rectRef.current.style, {
        display: "block",
        left: `${Math.min(g.origin.x, p.x)}px`,
        top: `${Math.min(g.origin.y, p.y)}px`,
        width: `${Math.abs(p.x - g.origin.x)}px`,
        height: `${Math.abs(p.y - g.origin.y)}px`,
      });
    }
  }
  function clearRect() {
    if (rectRef.current) rectRef.current.style.display = "none";
  }
  function pointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const before = stateRef.current;
    const actionDrop =
      before.gesture?.mode === "drag" &&
      document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-drop-action]");
    apply(selection.end(before));
    clearRect();
    if (actionDrop) void act(before.selected);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  }
  const activeId =
    state.active?.kind === "conversation" ? state.active.conversationId : null;
  const active = activeId ? byId.get(activeId) : null;
  return (
    <div
      className="workspace"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
          apply(selection.escape(stateRef.current));
          clearRect();
          e.preventDefault();
        }
      }}
    >
      <header>
        <strong>SANDRA · INBOX STACK LAB</strong>
        <span>Synthetic data · no customer messaging</span>
      </header>
      <div className="toolbar">
        <b>{rows.length} synchronized rows</b>
        <span>Electric → TanStack DB · fixed 100-ID working set</span>
        <label>
          <input
            type="checkbox"
            checked={onlySelected}
            onChange={(e) => setOnlySelected(e.target.checked)}
          />{" "}
          Show selected only
        </label>
      </div>
      {syncError && (
        <div role="alert" className="warning">
          {syncError}
        </div>
      )}
      <div className="panes">
        <section className="list-pane">
          <div className="selection-bar">
            <b data-testid="selection-count">
              {state.selected.length} selected
            </b>
            <button
              onClick={() => apply({ ...stateRef.current, selected: [] })}
            >
              Clear
            </button>
            <small>
              Click = one · Shift-click = toggle · Shift-drag = rectangle
            </small>
          </div>
          <div
            ref={listRef}
            className="list"
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={() => {
              apply(selection.cancel(stateRef.current));
              clearRect();
            }}
            onLostPointerCapture={() => {
              apply(selection.cancel(stateRef.current));
              clearRect();
            }}
          >
            <div
              style={{ height: virtual.getTotalSize(), position: "relative" }}
            >
              {virtual.getVirtualItems().map((item) => {
                const row = visible[item.index];
                const t = target(row);
                const selected = selectedKeys.has(selection.key(t));
                return (
                  <div
                    key={row.conversation_id}
                    data-row-id={row.conversation_id}
                    data-selected={selected}
                    data-open={activeId === row.conversation_id}
                    className="row"
                    tabIndex={0}
                    aria-label={row.last_preview}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === " ") {
                        apply(selection.toggle(stateRef.current, t));
                        e.preventDefault();
                      }
                      if (e.key === "Enter") {
                        apply(selection.open(stateRef.current, t));
                        e.preventDefault();
                      }
                    }}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: item.size,
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <input
                      data-control
                      type="checkbox"
                      aria-label={`Select ${row.last_preview}`}
                      checked={selected}
                      onChange={() =>
                        apply(selection.toggle(stateRef.current, t))
                      }
                    />
                    <span className="preview">
                      {row.last_preview}
                      <small>{row.conversation_id.slice(0, 8)}</small>
                    </span>
                    <span data-testid="outcome">
                      {row.outcome ?? "No outcome"}
                    </span>
                    <span>
                      {row.assigned_user_id ? "Assigned" : "Unassigned"}
                    </span>
                    <button
                      data-control
                      onClick={() => apply(selection.open(stateRef.current, t))}
                    >
                      Open
                    </button>
                  </div>
                );
              })}
              <div ref={rectRef} className="rectangle" />
            </div>
          </div>
        </section>
        <aside className="detail">
          <h2>Conversation inspection</h2>
          {active ? (
            <>
              <b>{active.last_preview}</b>
              <p>{active.conversation_id}</p>
              <p>Outcome: {active.outcome ?? "None"}</p>
              <p>Revision: {String(active.revision)}</p>
              <p className="muted">
                Synthetic summary inspection only. History, real authentication
                and mark-read are separate integration gates.
              </p>
            </>
          ) : (
            <p className="muted">
              Use Open or Enter. Selecting a row does not open it.
            </p>
          )}
        </aside>
        <aside className="actions">
          <h2>Click or drop</h2>
          <button
            data-drop-action
            disabled={
              Boolean(syncError) ||
              !state.selected.length ||
              state.selected.length > 50 ||
              submitting ||
              Boolean(pendingCommand.current)
            }
            onClick={() => void act(stateRef.current.selected)}
          >
            Outcome + assign {state.selected.length || ""}
          </button>
          <p className="muted">
            Select up to 50 conversations. Sets Interested, then assigns the
            synthetic lead. Accepted work runs through Restate.
          </p>
          {submitting && <p role="status">Submitting…</p>}
          {actionError && (
            <div role="alert">
              {actionError}
              {pendingCommand.current && (
                <button
                  disabled={submitting}
                  onClick={() => void act([], true)}
                >
                  Check same request
                </button>
              )}
            </div>
          )}
          {operationId && (
            <section data-testid="operation">
              <h3>Operation</h3>
              <p>{receipt.data?.state ?? "Checking result…"}</p>
              {receipt.isError && (
                <p>Status unavailable; server work may continue.</p>
              )}
              {receipt.data?.receipts.map((r) => (
                <p key={`${r.property_id}-${r.step}`}>
                  {r.step}: {r.state}
                </p>
              ))}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Root />
  </QueryClientProvider>,
);
