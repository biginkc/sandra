"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import type { Thread } from "@/lib/messages/list-threads";
import { createClient } from "@/lib/supabase/client";

type Props = {
  initial: Thread[];
  selectedContactId: string | null;
};

/**
 * Conversation list — left rail of the cockpit. Click a thread to
 * surface it in the side panel (URL state: ?thread=<contactId>).
 *
 * Realtime: subscribes to INSERTs on `messages`. On every relevant new
 * row, refreshes via router.refresh() so the server-rendered list
 * regenerates with new sort + unread counts. Keeps the client-side state
 * machine simple — the server is the source of truth.
 *
 * Threads are read straight off the prop (no local useState mirror) so
 * `router.refresh()` from the Realtime handler actually re-renders this
 * list with the new server payload. Mirroring into useState would freeze
 * the initial value and silently swallow refresh updates.
 */
export function InboxThreadList({ initial, selectedContactId }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const threads = initial;

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel("cockpit:thread-list")
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          () => {
            // Cheap path: re-render via server. Avoids re-implementing
            // the dedupe/sort/unread logic on the client.
            router.refresh();
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "messages" },
          () => router.refresh(),
        )
        .subscribe();
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [router]);

  const select = (contactId: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("thread", contactId);
    router.replace(`/messages?${sp.toString()}`);
    // Next 16 caches the RSC payload per route — query-string-only changes
    // hit the cache and skip the server render. Refresh forces a fetch so
    // the side-panel data updates when the user picks a different thread.
    router.refresh();
  };

  if (threads.length === 0) {
    return (
      <div
        className="border-border/60 text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm"
        data-testid="inbox-empty"
      >
        No conversations yet. Inbound messages will appear here.
      </div>
    );
  }

  return (
    <div
      className="border-border rounded-md border divide-y"
      data-testid="inbox-thread-list"
    >
      {threads.map((t) => {
        const selected = t.contactId === selectedContactId;
        return (
          <button
            key={t.contactId}
            type="button"
            onClick={() => select(t.contactId)}
            data-testid={`inbox-thread-${t.contactId}`}
            data-selected={selected || undefined}
            className={`flex w-full flex-col items-start gap-1 p-3 text-left transition-colors ${
              selected
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted/50"
            }`}
          >
            <div className="flex w-full items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">
                {t.contactName ?? t.contactPhone ?? "Unknown contact"}
              </span>
              <span className="text-muted-foreground shrink-0 text-[11px]">
                {formatDistanceToNow(new Date(t.lastMessageAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {t.lastMessageDirection === "outbound" ? "You: " : ""}
                {t.lastMessageBody}
              </span>
              {t.unreadCount > 0 ? (
                <Badge
                  variant="default"
                  className="h-4 min-w-4 shrink-0 px-1 text-[10px]"
                  data-testid={`inbox-thread-${t.contactId}-unread`}
                >
                  {t.unreadCount}
                </Badge>
              ) : null}
            </div>
            {t.propertyAddress ? (
              <span className="text-muted-foreground line-clamp-1 text-[11px]">
                {t.propertyAddress}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
