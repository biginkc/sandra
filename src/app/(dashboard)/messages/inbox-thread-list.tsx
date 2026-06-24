"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { EscalationBadge } from "@/components/escalation-badge";
import { deriveSmsParties } from "@/lib/messages/sms-parties";
import type { Thread } from "@/lib/messages/list-threads";
import { formatPhoneE164 } from "@/lib/phone-format";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

import { useThrottledRefresh } from "./use-throttled-refresh";

type Message = Database["public"]["Tables"]["messages"]["Row"];
export type ThreadUpdate = {
  lastMessageBody: string;
  lastMessageDirection: Thread["lastMessageDirection"];
  lastMessageAt: string;
  unreadDelta: number;
  threadCustomerPhone: string | null;
  threadBusinessPhone: string | null;
};

type Props = {
  initial: Thread[];
  selectedThreadId: string | null;
  /** Used to mark threads assigned to the viewer with a data-attribute
   *  for tests + styling. The avatar circle itself shows contact
   *  initials regardless of assignment — assignment lives in the detail
   *  panel header. */
  currentUserId: string | null;
  /** Selection is owned by CockpitView so it can wrap the URL update +
   *  router.refresh() in useTransition; that's how the detail panel
   *  knows when to render a skeleton. The list just emits clicks. */
  onSelectThread: (threadId: string) => void;
};

/**
 * Conversation list — left rail of the cockpit. Click a thread to
 * surface it in the side panel (URL state: ?thread=<contactId>).
 *
 * Realtime: subscribes to INSERTs + UPDATEs on `messages`. Refreshes are
 * coalesced through useThrottledRefresh — during a bulk campaign the queue
 * worker flips a row every few seconds, and refreshing per event kept the
 * expensive cockpit page in a permanent server rebuild (frozen clicks,
 * blank panels — 2026-06-12 incident). The server stays the source of
 * truth; it's just consulted at a bounded rate.
 *
 * Existing thread rows update optimistically from Realtime INSERT payloads
 * (instant paint, unthrottled); the throttled refresh remains the
 * reconciliation path for new rows, assignment metadata, unknown sender
 * routing, and unread/read count edge cases.
 */
export function InboxThreadList({
  initial,
  selectedThreadId,
  currentUserId,
  onSelectThread,
}: Props) {
  const requestRefresh = useThrottledRefresh();
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
            requestRefresh();
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "messages" },
          () => requestRefresh(),
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "message_threads" },
          () => requestRefresh(),
        )
        .subscribe();
    })();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [requestRefresh]);


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
          const selected = t.threadId === selectedThreadId;
          const isMine =
            t.assigneeId !== null && t.assigneeId === currentUserId;
          return (
            <button
              key={t.threadId}
              type="button"
              onClick={() => onSelectThread(t.threadId)}
              data-testid={`inbox-thread-${t.threadId}`}
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
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {t.needsOutcome ? (
                    <span
                      role="img"
                      aria-label="Needs outcome"
                      title="Needs outcome"
                      className="h-2 w-2 shrink-0 rounded-full bg-[#f59e0b]"
                      data-testid={`inbox-thread-${t.threadId}-needs-outcome`}
                    />
                  ) : null}
                  <span className="min-w-0 truncate text-sm font-bold text-[#1c1917]">
                    {t.contactName ?? t.contactPhone ?? "Unknown contact"}
                  </span>
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
                  businessPhone={t.threadBusinessPhone}
                  avatarId={t.threadId}
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
                {t.threadCustomerPhone ? (
                  <span
                    className="max-w-[9rem] shrink-0 truncate rounded-full border border-[#e5e1df] bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[#57534e]"
                    title={`Texting ${t.threadCustomerPhone}`}
                    data-testid={`inbox-thread-${t.threadId}-phone`}
                  >
                    {formatPhoneE164(t.threadCustomerPhone)}
                  </span>
                ) : null}
              </div>
              {t.aiResponderStatus ? (
                <SandraThreadStatus
                  threadId={t.threadId}
                  status={t.aiResponderStatus}
                  reason={t.aiResponderReason}
                  deliveryStatus={t.aiLastDeliveryStatus}
                  deliveryError={t.aiLastDeliveryError}
                />
              ) : null}
              {t.needsHumanAttention &&
              t.escalationReason &&
              !(t.aiResponderStatus === "escalated" && t.aiResponderReason) ? (
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
                    data-testid={`inbox-thread-${t.threadId}-unread`}
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

function SandraThreadStatus({
  threadId,
  status,
  reason,
  deliveryStatus,
  deliveryError,
}: {
  threadId: string;
  status: NonNullable<Thread["aiResponderStatus"]>;
  reason: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
}) {
  const deliveryFailed = deliveryStatus === "failed";
  const deliveryLabel = deliveryStatus
    ? deliveryFailed
      ? `Delivery failed${deliveryError ? `: ${deliveryError}` : ""}`
      : `Delivery ${deliveryStatus}`
    : null;

  return (
    <div
      className="flex w-full flex-wrap items-center gap-1.5"
      data-testid={`inbox-thread-${threadId}-sandra-status`}
    >
      <span
        className="inline-flex items-center gap-1 rounded-full border border-[#e5e1df] bg-[#fafaf9] px-2 py-0.5 text-[11px] font-bold text-[#57534e]"
        title={status === "handled" ? "Sandra handled" : "Sandra escalated"}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/mascot.svg"
          alt=""
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0"
        />
        {status === "handled" ? "Sandra handled" : "Sandra escalated"}
      </span>
      {status === "escalated" && reason ? (
        <span
          className="rounded-full bg-[#fff7ed] px-2 py-0.5 text-[11px] font-bold text-[#9a3412]"
          title={reason}
          data-testid={`inbox-thread-${threadId}-sandra-reason`}
        >
          {reason}
        </span>
      ) : null}
      {deliveryLabel ? (
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
            deliveryFailed
              ? "bg-[#fef2f2] text-[#b91c1c]"
              : "bg-[#ecfdf5] text-[#047857]"
          }`}
          aria-label={deliveryLabel}
          title={deliveryLabel}
          data-testid={`inbox-thread-${threadId}-sandra-delivery`}
        >
          {deliveryFailed ? "Delivery failed" : deliveryLabel}
        </span>
      ) : null}
    </div>
  );
}

function ContactAvatar({
  contactName,
  contactPhone,
  businessPhone,
  avatarId,
}: {
  contactName: string | null;
  contactPhone: string | null;
  businessPhone: string | null;
  avatarId: string;
}) {
  const initials = initialsOfContact(contactName, contactPhone);
  return (
    <span
      title={[
        contactName ?? "Unknown contact",
        contactPhone ? `Texting ${contactPhone}` : null,
        businessPhone ? `via ${businessPhone}` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      data-testid={`inbox-thread-${avatarId}-avatar`}
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
  // Realtime payloads carry the post-trigger row, so conversation_id is
  // always stamped for contact-bearing SMS (migration 081). Anything
  // without one is unknown-sender traffic — not a thread row.
  if (
    !row.contact_id ||
    !row.conversation_id ||
    row.channel !== "sms" ||
    row.status === "queued"
  ) {
    return updates;
  }

  const threadId = row.conversation_id;
  const previous = updates[threadId];
  const parties = deriveSmsParties(row);
  return {
    ...updates,
    [threadId]: {
      lastMessageBody: row.body,
      lastMessageDirection: row.direction as Thread["lastMessageDirection"],
      lastMessageAt: row.created_at,
      threadCustomerPhone: parties.customerPhone,
      threadBusinessPhone: parties.businessPhone,
      unreadDelta:
        (previous?.unreadDelta ?? 0) +
        (row.direction === "inbound" && row.read_at === null ? 1 : 0),
    },
  };
}

/** Exported for tests — must stay order-aligned with the server sort in
 *  `listThreads` (recency-only) or the list reshuffles on every refresh. */
export function applyThreadUpdates(
  threads: Thread[],
  updates: Record<string, ThreadUpdate>,
): Thread[] {
  if (Object.keys(updates).length === 0) return threads;

  const next = threads.map((thread) => {
    const update = updates[thread.threadId];
    if (!update) return thread;
    return {
      ...thread,
      lastMessageBody: update.lastMessageBody,
      lastMessageDirection: update.lastMessageDirection,
      lastMessageAt: update.lastMessageAt,
      threadCustomerPhone: update.threadCustomerPhone,
      threadBusinessPhone: update.threadBusinessPhone,
      contactPhone: update.threadCustomerPhone,
      unreadCount: thread.unreadCount + update.unreadDelta,
    };
  });

  // Recency-only, matching the server sort in listThreads — reading a
  // thread must never reposition it.
  return next.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
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
