"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    generation.current++;
    requestRef.current?.abort();
  }, []);
  const reset = useCallback(() => {
    cancel();
    // Navigation must clear the panel without reviving the previous server
    // selection while its destination is still loading.
    setSelection({ id: null, detail: null, loading: false, error: null });
  }, [cancel]);

  const select = useCallback(async (id: string | null) => {
    const currentId = selection ? selection.id : serverId;
    const currentDetail = selection ? selection.detail : serverDetail;
    // Keep the composer mounted when the operator re-clicks its loaded row.
    // Failed/empty selections still allow a fresh request on retry.
    if (id && id === currentId && currentDetail && !selection?.loading) return;
    const currentGeneration = ++generation.current;
    requestRef.current?.abort();
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
    }
  }, [selection, serverId, serverDetail]);

  useEffect(() => {
    // A refresh/filter navigation supplies authoritative new props. Ignore an
    // older server render arriving while a newer local URL is selected.
    const urlId = new URLSearchParams(window.location.search).get("thread");
    if (urlId !== serverId) return;
    const expectedGeneration = generation.current;
    const timer = window.setTimeout(() => {
      if (generation.current === expectedGeneration) {
        cancel();
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
    selectedId: selection ? selection.id : serverId,
    detail: selection ? selection.detail : serverDetail,
    loading: selection?.loading ?? false,
    error: selection?.error ?? null,
    select,
    reset,
  };
}
