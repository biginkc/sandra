"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { PauseIcon, PlayIcon, SendIcon, Trash2Icon, PencilIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { callAction } from "@/lib/errors/call-action";
import { createClient } from "@/lib/supabase/client";

import {
  deleteQueuedMessage,
  listQueuedPage,
  releaseMessage,
  updateQueuedMessage,
} from "./actions";

export type QueuedRow = {
  id: string;
  body: string;
  fromAddress: string | null;
  toAddress: string | null;
  createdAt: string;
  /** Keyset-pagination cursor component — see listQueuedPage. */
  scheduledFor: string | null;
  propertyId: string | null;
  contactId: string | null;
  propertyAddress: string | null;
  contactName: string | null;
  contactPhone: string | null;
};

// Minimum cadence (seconds) between auto-sent messages. Carrier
// reputation rewards slow + deliberate; anything under 5s reads as
// scripted behavior. Max 300s (5 min) cap is a sanity bound for a
// foreground UI — anything longer should be a cron job.
const MIN_CADENCE_S = 5;
const MAX_CADENCE_S = 300;
const DEFAULT_CADENCE_S = 15;
const CADENCE_STORAGE_KEY = "sandra.queue.cadence";
/** Min gap between corrective fetches when live stats outrun the table. */
const CORRECTIVE_COOLDOWN_MS = 30_000;

export function QueuePanel({
  initial,
  initialHasMore = false,
  totalQueued,
}: {
  initial: QueuedRow[];
  /** True when the server's first page was full — more rows exist beyond it. */
  initialHasMore?: boolean;
  /** Live total from queue stats, for the "X of Y loaded" readout. */
  totalQueued?: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<QueuedRow[]>(initial);
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  // Infinite scroll — a sentinel below the table loads the next keyset
  // page when it nears the viewport. hasMore comes from the server's
  // page-size+1 probe; loadingRef guards against overlapping fetches
  // (IntersectionObserver can fire repeatedly while the sentinel stays
  // visible during a slow fetch).
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = async () => {
    if (loadingRef.current) return;
    // Empty list → null cursor re-seeds from page 1 (dedup makes this
    // idempotent). Happens when live stats re-arm the sentinel on a
    // queue that grew from zero.
    const last = rowsRef.current[rowsRef.current.length - 1];
    const cursor = last
      ? { scheduledFor: last.scheduledFor, id: last.id }
      : null;
    loadingRef.current = true;
    setLoadingMore(true);
    try {
      const result = await callAction(listQueuedPage(cursor), {
        fallbackMessage: "Couldn't load more of the queue",
      });
      if (!result.ok) return;
      setHasMore(result.data.hasMore);
      // Dedup by id: realtime inserts or a queue that drained between
      // pages can hand us rows we already render.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...result.data.rows.filter((r) => !seen.has(r.id))];
      });
    } finally {
      loadingRef.current = false;
      setLoadingMore(false);
    }
  };
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  });

  // The live stats total can outrun the loaded set: another tab/user
  // queues a message (the realtime channel has no INSERT path — joined
  // display data isn't in the WAL payload), or rows became due after
  // the first paint. When the total exceeds what we hold and the
  // sentinel is retired, re-arm it so the table catches up instead of
  // contradicting the badge ("1 queued" over an empty table).
  //
  // Cooldown, not a value latch: at most one corrective fetch per 30s
  // (the stats cadence). An immediate unconditional re-arm would loop
  // on a stale-high total (fetch → hasMore=false → re-arm → fetch …);
  // a per-value latch would never recover when a REAL row later
  // appears at the same numeric total. While the contradiction
  // persists, the scheduled retry turns this into a slow bounded poll
  // that stops the moment table and badge agree.
  const lastCorrectiveAttemptRef = useRef(0);
  useEffect(() => {
    if (totalQueued === undefined || totalQueued <= rows.length || hasMore) {
      return undefined;
    }
    const sinceLast = Date.now() - lastCorrectiveAttemptRef.current;
    if (sinceLast >= CORRECTIVE_COOLDOWN_MS) {
      lastCorrectiveAttemptRef.current = Date.now();
      setHasMore(true);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      lastCorrectiveAttemptRef.current = Date.now();
      setHasMore(true);
    }, CORRECTIVE_COOLDOWN_MS - sinceLast);
    return () => window.clearTimeout(timeout);
  }, [totalQueued, rows.length, hasMore]);

  useEffect(() => {
    if (!hasMore) return;
    // jsdom (unit tests) has no IntersectionObserver; the panel still
    // renders, it just never auto-loads.
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMoreRef.current();
        }
      },
      // Start fetching one screen early so the scroll never visibly stalls.
      { rootMargin: "100% 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  // Auto-send controller state. Persists across page navigations via
  // localStorage so a half-sent batch survives accidental route changes.
  const [autoOn, setAutoOn] = useState(false);
  const [cadence, setCadence] = useState<number>(DEFAULT_CADENCE_S);
  const intervalRef = useRef<number | null>(null);
  // Always-current view of rows + the send closure, so the auto-send
  // interval tick reads the LATEST state without needing to be restarted
  // every time the queue changes. Restarting the interval on rows
  // change causes back-to-back immediate ticks and breaks cadence.
  const rowsRef = useRef<QueuedRow[]>(initial);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const sendOneRef = useRef<(row: QueuedRow) => Promise<boolean>>(
    async () => false,
  );

  useEffect(() => {
    const raw = localStorage.getItem(CADENCE_STORAGE_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= MIN_CADENCE_S && n <= MAX_CADENCE_S) {
        setCadence(n);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(CADENCE_STORAGE_KEY, String(cadence));
  }, [cadence]);

  // Realtime subscription — when a row transitions out of `queued`
  // (because Send Next picked it up or someone on another tab sent
  // it), remove it from our local list. New queued messages (from a
  // lead-detail composer in another tab) appear here automatically.
  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel("messages:queue")
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "messages" },
          (payload) => {
            const row = payload.new as { id: string; status: string };
            if (row.status !== "queued") {
              setRows((prev) => prev.filter((r) => r.id !== row.id));
            }
          },
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "messages" },
          (payload) => {
            const old = payload.old as { id: string };
            setRows((prev) => prev.filter((r) => r.id !== old.id));
          },
        )
        .subscribe();
    };
    start();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  // Keep the ref in sync with the latest sendOne closure so the
  // interval tick always calls the current version.
  useEffect(() => {
    sendOneRef.current = sendOne;
  });

  const sendOne = async (row: QueuedRow) => {
    const result = await callAction(releaseMessage(row.id), {
      fallbackMessage: "Send failed",
    });
    if (!result.ok) return false;
    const { outcome } = result.data;
    switch (outcome.status) {
      case "sent":
        toast.success("Sent", { description: row.toAddress ?? undefined });
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        return true;
      case "blocked_no_consent":
        toast.error("Blocked: no consent", { description: outcome.reason });
        return false;
      case "blocked_landline":
      case "blocked_terminal_dispo":
        toast.warning("Skipped", { description: outcome.reason });
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        return false;
      case "blocked_quiet_hours":
        toast.warning("Blocked: quiet hours", { description: outcome.reason });
        return false;
      case "provider_failed":
        toast.error("Provider error", { description: outcome.error });
        setRows((prev) => prev.filter((r) => r.id !== row.id));
        return false;
      default:
        toast.error(outcome.status);
        return false;
    }
  };

  const sendNext = () => {
    if (rows.length === 0) return;
    const next = rows[0];
    startTransition(async () => {
      await sendOne(next);
      router.refresh();
    });
  };

  // Auto-send loop. The interval itself only depends on [autoOn, cadence]
  // so it doesn't restart every time a row gets consumed — that earlier
  // mistake caused immediate back-to-back sends. Inside the tick we read
  // from rowsRef + sendOneRef to get the always-current values.
  useEffect(() => {
    if (!autoOn) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const first = rowsRef.current[0];
        if (!first) {
          setAutoOn(false);
          toast.info("Queue empty — auto-send stopped");
          return;
        }
        const ok = await sendOneRef.current(first);
        if (!ok) {
          setAutoOn(false);
          toast.warning("Auto-send paused", {
            description:
              "Last send didn't complete cleanly — review before resuming.",
          });
        }
      } finally {
        busy = false;
      }
    };
    // Fire immediately on start, then every `cadence` seconds.
    tick();
    intervalRef.current = window.setInterval(tick, cadence * 1000);
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoOn, cadence]);

  const saveEdit = () => {
    if (!editingId) return;
    startTransition(async () => {
      const result = await callAction(
        updateQueuedMessage(editingId, editBody),
        {
          successMessage: "Updated",
          fallbackMessage: "Update failed",
        },
      );
      if (result.ok) {
        setRows((prev) =>
          prev.map((r) => (r.id === editingId ? { ...r, body: editBody } : r)),
        );
        setEditingId(null);
        setEditBody("");
      }
    });
  };

  const deleteOne = (id: string) => {
    startTransition(async () => {
      const result = await callAction(deleteQueuedMessage(id), {
        successMessage: "Deleted",
        fallbackMessage: "Delete failed",
      });
      if (result.ok) {
        setRows((prev) => prev.filter((r) => r.id !== id));
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
        <div className="flex items-center gap-2">
          <Button
            onClick={sendNext}
            disabled={pending || rows.length === 0 || autoOn}
            size="sm"
          >
            <SendIcon className="size-3.5" />
            Send next
          </Button>
          <Button
            variant={autoOn ? "destructive" : "outline"}
            onClick={() => setAutoOn((v) => !v)}
            disabled={rows.length === 0 && !autoOn}
            size="sm"
          >
            {autoOn ? (
              <>
                <PauseIcon className="size-3.5" /> Pause auto-send
              </>
            ) : (
              <>
                <PlayIcon className="size-3.5" /> Auto-send
              </>
            )}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Label htmlFor="cadence" className="text-xs">
            Cadence
          </Label>
          <input
            id="cadence"
            type="number"
            min={MIN_CADENCE_S}
            max={MAX_CADENCE_S}
            value={cadence}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setCadence(Math.max(MIN_CADENCE_S, Math.min(MAX_CADENCE_S, n)));
              }
            }}
            disabled={autoOn}
            className="border-input w-20 rounded-md border px-2 py-1 text-sm disabled:opacity-50"
          />
          <span className="text-muted-foreground text-xs">
            seconds between sends ({MIN_CADENCE_S}–{MAX_CADENCE_S})
          </span>
        </div>

        <div className="text-muted-foreground ml-auto text-sm">
          {totalQueued !== undefined && totalQueued > rows.length
            ? `${rows.length} of ${totalQueued} loaded`
            : `${rows.length} queued`}
        </div>
      </div>

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[35%]">Property · Contact</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="w-[110px]">Queued</TableHead>
              <TableHead className="w-[150px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="text-muted-foreground py-8 text-center"
                >
                  No queued messages. Draft one from any lead page using the
                  Send SMS composer.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="font-medium">
                      {r.propertyAddress ?? "(no property)"}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {r.contactName ?? "(no contact)"} ·{" "}
                      <span className="font-mono">{r.toAddress}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {editingId === r.id ? (
                      <div className="flex flex-col gap-1">
                        <textarea
                          value={editBody}
                          onChange={(e) => setEditBody(e.target.value)}
                          className="border-input min-h-[60px] rounded-md border p-2 text-sm"
                        />
                        <div className="flex gap-2">
                          <Button size="sm" onClick={saveEdit} disabled={pending}>
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditingId(null);
                              setEditBody("");
                            }}
                            disabled={pending}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap break-words text-sm">
                        {r.body}
                      </div>
                    )}
                    <div className="text-muted-foreground mt-1 text-xs">
                      from{" "}
                      <span className="font-mono">
                        {r.fromAddress ?? "(default)"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDistanceToNow(new Date(r.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell className="text-right">
                    {editingId === r.id ? null : (
                      <div className="inline-flex gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Edit"
                          onClick={() => {
                            setEditingId(r.id);
                            setEditBody(r.body);
                          }}
                          disabled={pending || autoOn}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="Delete"
                          onClick={() => deleteOne(r.id)}
                          disabled={pending || autoOn}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            startTransition(async () => {
                              await sendOne(r);
                              router.refresh();
                            });
                          }}
                          disabled={pending || autoOn}
                        >
                          Send
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {hasMore && (
        <div
          ref={sentinelRef}
          data-testid="queue-load-more-sentinel"
          className="text-muted-foreground py-3 text-center text-xs"
        >
          {loadingMore ? "Loading more…" : "Scroll to load more"}
        </div>
      )}

      {autoOn && (
        <Badge variant="outline" className="w-fit text-xs">
          Auto-sending every {cadence}s · {rows.length} remaining
        </Badge>
      )}
    </div>
  );
}
