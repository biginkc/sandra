"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxReadResponse } from "@/lib/inbox-v2/read-contract";

type Ready = Extract<InboxReadResponse, { status: "ready" }>;
type Row = { id: string; name: string | null; address: string | null; preview: string };
const CACHE_LIMIT = 20;
const CACHE_TTL_MS = 30_000;

/** Disposable read-only P0 surface: not an Inbox replacement or action authority. */
export function ReadExperiment({ rows }: { rows: Row[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Ready | null>(null);
  const [source, setSource] = useState<"network" | "memory" | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, { value: Ready; expires: number }>());
  const requestVersion = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const entries = cache.current;
    const invalidate = () => entries.clear();
    window.addEventListener("online", invalidate);
    window.addEventListener("pagehide", invalidate);
    return () => {
      pending.current?.abort();
      entries.clear();
      window.removeEventListener("online", invalidate);
      window.removeEventListener("pagehide", invalidate);
    };
  }, []);

  const open = useCallback(async (id: string, refresh = false) => {
    const version = ++requestVersion.current;
    pending.current?.abort();
    setSelected(id); setError(false); setDetail(null); setSource(null);
    const cached = cache.current.get(id);
    if (!refresh && cached && cached.expires > Date.now()) {
      cache.current.delete(id); cache.current.set(id, cached);
      setDetail(cached.value); setSource("memory"); setLoading(false);
      return;
    }
    cache.current.delete(id);
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    try {
      const response = await fetch(`/api/inbox-v2/detail?conversationId=${encodeURIComponent(id)}&pageSize=50`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) {
        cache.current.clear();
        throw new Error("Read unavailable");
      }
      const result: InboxReadResponse = await response.json();
      if (version !== requestVersion.current || controller.signal.aborted) return;
      if (result.status !== "ready" || result.conversationId !== id || !Array.isArray(result.messages)) throw new Error("Incorrect response identity");
      cache.current.set(id, { value: result, expires: Date.now() + CACHE_TTL_MS });
      while (cache.current.size > CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!);
      setDetail(result); setSource("network");
    } catch {
      if (version === requestVersion.current && !controller.signal.aborted) {
        // Middleware can redirect expired sessions to a successful HTML login page.
        // Failed parsing/identity validation must invalidate display caches too.
        cache.current.clear();
        setError(true);
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, []);

  return <main className="mx-auto max-w-7xl p-6">
    <h1 className="text-2xl font-semibold">P0 Inbox read experiment</h1>
    <p className="mb-4 text-sm">Read-only measurement surface, not the production Inbox. First 200 conversations; latest 50 messages.
      No actions or mark-read. No live updates. Display cache: at most 20 conversations for 30 seconds.</p>
    <div className="grid gap-4 md:grid-cols-[20rem_1fr]">
      <nav aria-label="Experiment conversations" className="max-h-[75vh] overflow-auto border" data-testid="experiment-list">
        {rows.map(row => <button type="button" key={row.id} data-testid="experiment-row" data-conversation-id={row.id}
          aria-pressed={selected === row.id} onClick={() => void open(row.id)}
          className={`block w-full border-b p-3 text-left ${selected === row.id ? "bg-blue-100 text-black" : ""}`}>
          <span className="block font-semibold">{row.name || "Unnamed contact"}</span>
          <span className="block text-xs">{row.address || "No linked property"}</span>
          <span className="block truncate text-sm">{row.preview}</span>
        </button>)}
      </nav>
      <section aria-label="Experiment conversation" aria-busy={loading}>
        {loading && <p role="status">Loading conversation…</p>}
        {error && <p role="alert">Conversation unavailable. Try opening it again.</p>}
        {!selected && <p>Select a conversation to measure its independent read.</p>}
        {detail && detail.conversationId === selected && <div data-testid="experiment-detail"
          data-conversation-id={detail.conversationId} data-read-source={source}>
          <h2 className="text-xl font-semibold">{detail.context.contactName || "Unnamed contact"}</h2>
          <p>{detail.context.propertyAddress}</p>
          <p className="text-xs">Conversation: {detail.conversationId}</p>
          <p className="text-xs">Display source: {source}. Context read: {detail.freshness.contextReadCompletedAt}</p>
          <button type="button" className="my-3 rounded border px-3 py-1" onClick={() => void open(detail.conversationId, true)}>Refresh conversation</button>
          <ol className="max-h-[65vh] space-y-3 overflow-auto" data-testid="experiment-history">
            {detail.messages.map(message => <li key={message.id} className="rounded border p-3" data-message-id={message.id}>
              <p className="text-xs">{message.direction} · {message.created_at} · {message.status}</p>
              <p className="whitespace-pre-wrap">{message.body}</p>
            </li>)}
          </ol>
          {detail.nextCursor && <p className="mt-3 text-sm">Older history exists; pagination UI is outside this measurement surface.</p>}
        </div>}
      </section>
    </div>
  </main>;
}
