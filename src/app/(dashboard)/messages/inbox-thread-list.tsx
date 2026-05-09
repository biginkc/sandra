"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { EscalationBadge } from "@/components/escalation-badge";
import type { Thread } from "@/lib/messages/list-threads";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Message = Database["public"]["Tables"]["messages"]["Row"];
type ThreadUpdate = {
  lastMessageBody: string;
  lastMessageDirection: Thread["lastMessageDirection"];
  lastMessageAt: string;
  unreadDelta: number;
};

type Props = {
  initial: Thread[];
  selectedContactId: string | null;
  /** Used to mark threads assigned to the viewer with a data-attribute
   *  for tests + styling. The avatar circle itself shows contact
   *  initials regardless of assignment — assignment lives in the detail
   *  panel header. */
  currentUserId: string | null;
  /** Selection is owned by CockpitView so it can wrap the URL update +
   *  router.refresh() in useTransition; that's how the detail panel
   *  knows when to render a skeleton. The list just emits clicks. */
  onSelectThread: (contactId: string) => void;
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
 * Existing thread rows update optimistically from Realtime INSERT payloads;
 * `router.refresh()` remains the reconciliation path for new rows, assignment
 * metadata, unknown sender routing, and unread/read count edge cases.
 */
export function InboxThreadList({
  initial,
  selectedContactId,
  currentUserId,
  onSelectThread,
}: Props) {
  const router = useRouter();
  const [threadUpdates, setThreadUpdates] = useState<Record<string, ThreadUpdate>>(
    {},
  );
  const threads = applyThreadUpdates(initial, threadUpdates);

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
          (payload) => {
            const row = payload.new as Message;
            setThreadUpdates((curr) => mergeThreadUpdate(curr, row));
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
      className="bg-white border border-border rounded-xl overflow-hidden flex flex-col"
      data-testid="inbox-thread-list"
    >
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {threads.map((t) => {
          const selected = t.contactId === selectedContactId;
          const isMine =
            t.assigneeId !== null && t.assigneeId === currentUserId;
          return (
            <button
              key={t.contactId}
              type="button"
              onClick={() => onSelectThread(t.contactId)}
              data-testid={`inbox-thread-${t.contactId}`}
              data-selected={selected || undefined}
              data-assignee-id={t.assigneeId ?? undefined}
              data-assignee-mine={isMine || undefined}
              className={`flex w-full flex-col items-start gap-1 p-4 text-left transition-colors ${
                selected
                  ? "border-l-4 border-[#111827] bg-[#f5f5f4]"
                  : "hover:bg-[#f5f5f4]/60"
              }`}
            >
              <div className="flex w-full items-start justify-between gap-2">
                <span className="truncate text-sm font-bold text-[#1c1917]">
                  {t.contactName ?? t.contactPhone ?? "Unknown contact"}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[#78716c]">
                  {formatDistanceToNow(new Date(t.lastMessageAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <div className="flex w-full items-center gap-2">
                <ContactAvatar
                  contactName={t.contactName}
                  contactPhone={t.contactPhone}
                  contactId={t.contactId}
                />
                {t.propertyAddress ? (
                  <span className="truncate text-[11px] italic text-[#78716c]">
                    {t.propertyAddress}
                  </span>
                ) : (
                  <span className="truncate text-[11px] italic text-[#a8a29e]">
                    No property linked
                  </span>
                )}
              </div>
              {t.needsHumanAttention && t.escalationReason ? (
                <div className="flex w-full">
                  <EscalationBadge reason={t.escalationReason} />
                </div>
              ) : null}
              <div className="flex w-full items-center justify-between gap-2">
                <span className="line-clamp-1 text-[13px] text-[#78716c]">
                  {t.lastMessageDirection === "outbound" ? "You: " : ""}
                  {t.lastMessageBody}
                </span>
                {t.unreadCount > 0 ? (
                  <Badge
                    variant="default"
                    className="h-4 min-w-4 shrink-0 px-1 text-[10px] bg-[#111827] text-white"
                    data-testid={`inbox-thread-${t.contactId}-unread`}
                  >
                    {t.unreadCount}
                  </Badge>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ContactAvatar({
  contactName,
  contactPhone,
  contactId,
}: {
  contactName: string | null;
  contactPhone: string | null;
  contactId: string;
}) {
  const initials = initialsOfContact(contactName, contactPhone);
  return (
    <span
      title={contactName ?? contactPhone ?? "Unknown contact"}
      data-testid={`inbox-thread-${contactId}-avatar`}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#f5f5f4] border border-[#e5e1df] text-[9px] font-bold text-[#78716c]"
    >
      {initials}
    </span>
  );
}

function mergeThreadUpdate(
  updates: Record<string, ThreadUpdate>,
  row: Message,
): Record<string, ThreadUpdate> {
  if (!row.contact_id || row.channel !== "sms" || row.status === "queued") {
    return updates;
  }

  const previous = updates[row.contact_id];
  return {
    ...updates,
    [row.contact_id]: {
      lastMessageBody: row.body,
      lastMessageDirection: row.direction as Thread["lastMessageDirection"],
      lastMessageAt: row.created_at,
      unreadDelta:
        (previous?.unreadDelta ?? 0) +
        (row.direction === "inbound" && row.read_at === null ? 1 : 0),
    },
  };
}

function applyThreadUpdates(
  threads: Thread[],
  updates: Record<string, ThreadUpdate>,
): Thread[] {
  if (Object.keys(updates).length === 0) return threads;

  const next = threads.map((thread) => {
    const update = updates[thread.contactId];
    if (!update) return thread;
    return {
      ...thread,
      lastMessageBody: update.lastMessageBody,
      lastMessageDirection: update.lastMessageDirection,
      lastMessageAt: update.lastMessageAt,
      unreadCount: thread.unreadCount + update.unreadDelta,
    };
  });

  return next.sort((a, b) => {
    const aUnread = a.unreadCount > 0 ? 1 : 0;
    const bUnread = b.unreadCount > 0 ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    return b.lastMessageAt.localeCompare(a.lastMessageAt);
  });
}

function initialsOfContact(
  name: string | null,
  phone: string | null,
): string {
  if (name) {
    // "Donna Harper-Bradley" → DH; "Maria" → MA; punctuation/whitespace
    // collapses so "Mary-Jane Smith" stays MS.
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0][0] ?? "";
      const last = parts[parts.length - 1][0] ?? "";
      return (first + last).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (phone) {
    // last 2 digits when there's no name — keeps the avatar visually
    // distinct from a literal "??" placeholder.
    const digits = phone.replace(/\D/g, "");
    return digits.slice(-2) || "·";
  }
  return "·";
}
