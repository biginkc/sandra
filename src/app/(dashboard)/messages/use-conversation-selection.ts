"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const afterSelection = useRef<(() => void) | null>(null);
  const generation = useRef(0);
  const activeId = useRef(restoredId === undefined ? serverId : restoredId);
  const refreshFlight = useRef<{ controller: AbortController; dirty: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    generation.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    afterSelection.current = null;
    refreshFlight.current?.controller.abort();
    refreshFlight.current = null;
  }, []);
  const reset = useCallback(() => {
    cancel();
    activeId.current = null;
    setRefreshing(false);
    setRefreshError(null);
    // Navigation must clear the panel without reviving the previous server
    // selection while its destination is still loading.
    setSelection({ id: null, detail: null, loading: false, error: null });
  }, [cancel]);

  const loadSelection = useCallback(async (id: string | null) => {
    const currentGeneration = ++generation.current;
    activeId.current = id;
    requestRef.current?.abort();
    requestRef.current = null;
    afterSelection.current = null;
    refreshFlight.current?.controller.abort();
    refreshFlight.current = null;
    setRefreshing(false);
    setRefreshError(null);
    if (!id) {
      setSelection({ id: null, detail: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setSelection({ id, detail: null, loading: true, error: null });
    try {
      const response = await fetch(`/api/messages/thread-detail?thread=${encodeURIComponent(id)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Conversation did not load. Please retry.");
      const { detail } = await response.json() as { detail: InboxDetail | null };
      if (detail && detail.threadId !== id) throw new Error("Conversation did not load. Please retry.");
      if (generation.current !== currentGeneration) return;
      setSelection({ id, detail, loading: false, error: null });
      // Acknowledgement is independent of displaying the fetched conversation.
      // Reuse the DNC-aware, tenant-scoped action; never acknowledge a response
      // that lost a race to a newer click.
      if (detail) void markMessagesReadForThread(id).catch(() => undefined);
    } catch (error) {
      if (generation.current !== currentGeneration || controller.signal.aborted) return;
      setSelection({ id, detail: null, loading: false,
        error: error instanceof Error ? error.message : "Conversation did not load. Please retry." });
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        // An event can queue this callback while the fetch above is pending.
        const followUp = afterSelection.current as (() => void) | null;
        afterSelection.current = null;
        followUp?.();
      }
    }
  }, []);

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
        activeId.current = serverId;
        setRefreshing(false);
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

  const selectedId = selection ? selection.id : serverId;
  const revalidate = useCallback(function refresh(): void {
    // A send result from a removed composer may arrive after selecting B.
    if (!selectedId || activeId.current !== selectedId) return;
    if (requestRef.current) { afterSelection.current = refresh; return; }
    if (refreshFlight.current) { refreshFlight.current.dirty = true; return; }
    const expectedGeneration = generation.current;
    const flight = { controller: new AbortController(), dirty: false };
    refreshFlight.current = flight;
    setRefreshing(true);
    void (async () => {
      try {
        const response = await fetch(`/api/messages/thread-detail?thread=${encodeURIComponent(selectedId)}`, {
          cache: "no-store", signal: flight.controller.signal,
        });
        if (!response.ok) throw new Error("refresh failed");
        const { detail } = await response.json() as { detail: InboxDetail | null };
        if (!detail || detail.threadId !== selectedId) throw new Error("refresh unavailable");
        if (generation.current !== expectedGeneration || flight.controller.signal.aborted) return;
        setSelection({ id: selectedId, detail, loading: false, error: null });
        setRefreshError(null);
      } catch {
        if (generation.current === expectedGeneration && !flight.controller.signal.aborted) {
          setRefreshError("Message updates are unavailable. Refresh this conversation before replying.");
        }
      } finally {
        if (refreshFlight.current === flight) {
          refreshFlight.current = null;
          if (flight.dirty) refresh();
          else setRefreshing(false);
        }
      }
    })();
  }, [selectedId]);

  return {
    selectedId: selection ? selection.id : serverId,
    detail: selection ? selection.detail : serverDetail,
    loading: selection?.loading ?? false,
    error: selection?.error ?? null,
    select,
    reset,
    revalidate,
    refreshing,
    refreshError,
  };
}
