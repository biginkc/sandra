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
  /** auth.users.id → email for assignee initials. */
  assigneeEmails: Record<string, string>;
  currentUserId: string | null;
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
export function InboxThreadList({
  initial,
  selectedContactId,
  assigneeEmails,
  currentUserId,
}: Props) {
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
      className="bg-white border border-border rounded-xl overflow-hidden flex flex-col"
      data-testid="inbox-thread-list"
    >
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {threads.map((t) => {
          const selected = t.contactId === selectedContactId;
          const assigneeEmail = t.assigneeId
            ? assigneeEmails[t.assigneeId]
            : null;
          const isMine = t.assigneeId !== null && t.assigneeId === currentUserId;
          return (
            <button
              key={t.contactId}
              type="button"
              onClick={() => select(t.contactId)}
              data-testid={`inbox-thread-${t.contactId}`}
              data-selected={selected || undefined}
              data-assignee-id={t.assigneeId ?? undefined}
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
                <AssigneeAvatar
                  email={assigneeEmail}
                  isMine={isMine}
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

function AssigneeAvatar({
  email,
  isMine,
  contactId,
}: {
  email: string | null;
  isMine: boolean;
  contactId: string;
}) {
  if (!email) {
    return (
      <span
        title="Unassigned"
        data-testid={`inbox-thread-${contactId}-assignee`}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-dashed border-[#e5e1df] text-[8px] text-[#a8a29e]"
        aria-hidden
      >
        ·
      </span>
    );
  }
  const initials = initialsOf(email);
  return (
    <span
      title={isMine ? `Assigned to me (${email})` : `Assigned to ${email}`}
      data-testid={`inbox-thread-${contactId}-assignee`}
      data-assignee-mine={isMine || undefined}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
        isMine
          ? "bg-[#111827] text-white"
          : "bg-[#f5f5f4] border border-[#e5e1df] text-[#78716c]"
      }`}
    >
      {initials}
    </span>
  );
}

function initialsOf(email: string): string {
  const local = email.split("@")[0] ?? email;
  // jarrad.henry → JH; jarrad → JA; sole letter → uppercase
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}
