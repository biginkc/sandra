"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { beginBrowserTiming } from "@/lib/performance/browser-timing";
import { useSearchParams } from "next/navigation";
import type { InboxDetail } from "./inbox-detail-data";
import { markMessagesReadForThread } from "../leads/actions";

type Selection = {
  id: string | null;
  detail: InboxDetail | null;
  loading: boolean;
  error: string | null;
};

/** Local selection is deliberately not a cache. Every different thread reads fresh
 * authorized detail; an older response can never replace a newer selection. */
export function useConversationSelection(serverId: string | null, serverDetail: InboxDetail | null) {
  const searchParams = useSearchParams();
  // Back/forward can remount cached server props after the popstate event has
  // already fired. Native history changes preserve that older server snapshot.
  const [restoredId] = useState(() => {
    // Router context already describes the destination during rendering;
    // window.location is updated later by Next's history insertion effect.
    const urlId = searchParams.get("thread");
    return urlId !== serverId ? urlId : undefined;
  });
  const [selection, setSelection] = useState<Selection | null>(() =>
    restoredId === undefined ? null : {
      id: restoredId, detail: null, loading: restoredId !== null, error: null,
    });
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentId = useRef(restoredId === undefined ? serverId : restoredId);
  const timing = useRef<{ id: string; action: ReturnType<typeof beginBrowserTiming>; traceId?: string } | null>(null);
  const inFlight = useRef<{ id: string; dirty: boolean; promise: Promise<void> } | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    generation.current++;
    timing.current?.action.finish("cancelled");
    timing.current = null;
    requestRef.current?.abort();
    inFlight.current = null;
  }, []);
  const reset = useCallback(() => {
    cancel();
    currentId.current = null;
    setRevalidating(false);
    setRefreshError(null);
    // Navigation must clear the panel without reviving the previous server
    // selection while its destination is still loading.
    setSelection({ id: null, detail: null, loading: false, error: null });
  }, [cancel]);

  const loadSelection = useCallback(function load(id: string | null, preserve = false): Promise<void> {
    if (preserve && id && inFlight.current?.id === id) {
      inFlight.current.dirty = true;
      return inFlight.current.promise;
    }
    currentId.current = id;
    const currentGeneration = ++generation.current;
    if (!preserve) {
      timing.current?.action.finish("cancelled");
      timing.current = id ? { id, action: beginBrowserTiming("messages.selection") } : null;
    }
    requestRef.current?.abort();
    inFlight.current = null;
    setRefreshError(null);
    setRevalidating(preserve && id !== null);
    if (!id) {
      setSelection({ id: null, detail: null, loading: false, error: null });
      return Promise.resolve();
    }
    const controller = new AbortController();
    requestRef.current = controller;
    if (!preserve) setSelection({ id, detail: null, loading: true, error: null });
    const flight = { id, dirty: false, promise: Promise.resolve() };
    inFlight.current = flight;
    flight.promise = (async () => {
      try {
        const response = await fetch(`/api/messages/thread-detail?thread=${encodeURIComponent(id)}`, {
          cache: "no-store", signal: controller.signal,
        });
        if (timing.current?.id === id) timing.current.traceId = response.headers?.get("x-sandra-trace-id") ?? undefined;
        if (!response.ok) throw new Error("Conversation did not load. Please retry.");
        const { detail } = await response.json() as { detail: InboxDetail | null };
        if (detail && detail.threadId !== id) throw new Error("Conversation did not load. Please retry.");
        if (generation.current !== currentGeneration) return;
        setSelection({ id, detail, loading: false, error: null });
        // Revalidation must not generate another read acknowledgement/event.
        if (detail && !preserve) void markMessagesReadForThread(id).catch(() => undefined);
      } catch {
        if (generation.current !== currentGeneration || controller.signal.aborted) return;
        if (preserve) {
          // Keep the composer mounted and its draft intact, but block reply
          // until a successful authoritative retry replaces safety state.
          setRefreshError("Conversation updates did not load. Retry before replying.");
        } else {
          timing.current?.action.finish("failed");
          timing.current = null;
          setSelection({ id, detail: null, loading: false,
            error: "Conversation did not load. Please retry." });
        }
      } finally {
        if (generation.current === currentGeneration) {
          inFlight.current = null;
          setRevalidating(false);
          if (flight.dirty) void load(id, true);
        }
      }
    })();
    return flight.promise;
  }, []);

  const selectedId = selection ? selection.id : serverId;
  const revalidateSelectedDetail = useCallback(() => {
    // An old subscription/callback can fire between a click and effect cleanup.
    // It must never cancel the new selection to reload its previous thread.
    if (currentId.current !== selectedId) return Promise.resolve();
    return loadSelection(selectedId, true);
  }, [selectedId, loadSelection]);

  useEffect(() => {
    if (!selection || selection.loading || !timing.current || timing.current.id !== selection.id) return;
    timing.current.action.finish(selection.detail ? "completed" : "failed", timing.current.traceId);
    timing.current = null;
  }, [selection]);

  const select = useCallback(async (id: string | null) => {
    const currentId = selection ? selection.id : serverId;
    const currentDetail = selection ? selection.detail : serverDetail;
    // Keep the composer mounted when the operator re-clicks its loaded row.
    // Failed/empty selections still allow a fresh request on retry.
    if (id && id === currentId && currentDetail && !selection?.loading) return;
    await loadSelection(id);
  }, [selection, serverId, serverDetail, loadSelection]);

  useEffect(() => {
    if (restoredId === undefined) return;
    const expectedGeneration = generation.current;
    const timer = window.setTimeout(() => {
      if (generation.current === expectedGeneration) void loadSelection(restoredId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [restoredId, loadSelection]);

  useEffect(() => {
    // A refresh/filter navigation supplies authoritative new props. Ignore an
    // older server render arriving while a newer local URL is selected.
    const urlId = new URLSearchParams(window.location.search).get("thread");
    if (urlId !== serverId) return;
    const expectedGeneration = generation.current;
    const timer = window.setTimeout(() => {
      if (generation.current === expectedGeneration) {
        cancel();
        currentId.current = serverId;
        setRevalidating(false);
        setRefreshError(null);
        setSelection(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [serverId, serverDetail, cancel]);

  useEffect(() => {
    const onPopState = () => { void select(new URLSearchParams(window.location.search).get("thread")); };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, [select]);

  useEffect(() => cancel, [cancel]);

  return {
    selectedId,
    revalidateSelectedDetail,
    revalidating,
    refreshError,
    detail: selection ? selection.detail : serverDetail,
    loading: selection?.loading ?? false,
    error: selection?.error ?? null,
    select,
    reset,
  };
}
