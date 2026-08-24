"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { OPERATOR_TIME_ZONE } from "@/lib/messages/message-metrics";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

export type Message = Database["public"]["Tables"]["messages"]["Row"];

const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATOR_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: OPERATOR_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});
const LIVE_CLOCK_INTERVAL_MS = 30_000;

type Props = {
  /** Initial rows server-rendered so first paint is never blank. */
  initial: Message[];
  /** Contact + property ids define which rows belong in this thread. */
  contactId: string | null;
  conversationId?: string | null;
  propertyId: string | null;
  onLiveMessage?: (message: Message) => void;
  nowMs?: number;
};

export type LeadMessageScope = {
  contactId: string | null;
  conversationId: string | null;
  propertyId: string | null;
};

export function messageBelongsToThread(
  row: Message,
  scope: LeadMessageScope,
): boolean {
  if (scope.conversationId !== null) {
    return row.conversation_id === scope.conversationId;
  }
  const normalizedPropertyId =
    scope.propertyId && scope.propertyId.length > 0 ? scope.propertyId : null;
  return (
    row.contact_id === scope.contactId &&
    row.property_id === normalizedPropertyId
  );
}

/**
 * SMS conversation view for the lead detail page. Outbound bubbles on
 * the right, inbound on the left. Subscribes to the `messages` table
 * via Realtime (same subscribe-after-setAuth pattern that fixed the
 * jobs list) so replies and status transitions appear without refresh.
 *
 * Renders a "Today, October 14"-style date separator pill at every
 * day boundary so long threads scan-able. Outbound bubbles use the
 * primary token (#000000 in the warm-paper palette) to match the
 * messages-cockpit Stitch design.
 */
export function MessagesThread({
  initial,
  contactId,
  conversationId = null,
  propertyId,
  onLiveMessage,
  nowMs,
}: Props) {
  const [fallbackNowMs] = useState(Date.now);
  const renderNowMs = useLiveNow(nowMs ?? fallbackNowMs);
  const messages = useLeadMessages({
    initial,
    scope: { contactId, conversationId, propertyId },
    onLiveMessage,
  });
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contactId, conversationId, messages.length, propertyId]);

  if (messages.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        No messages in this conversation yet.
      </div>
    );
  }

  // Group messages by local-date string so we can drop a separator
  // pill at every day boundary. `toDateString()` is locale-stable for
  // grouping purposes (always YYYY-MM-DD-equivalent for the runtime tz).
  //
  // We also tag each message bubble with `isContinuation` (same direction
  // as the previous message item, no day-separator pill in between) and
  // `isLastInGroup` (next item is either a separator, end of list, or a
  // direction change). This drives the per-bubble margins + tail-rounding
  // + timestamp visibility — three short consecutive inbound replies now
  // read as a clear burst rather than a wall of text.
  type SepItem = { kind: "sep"; key: string; label: string };
  type MsgItem = {
    kind: "msg";
    msg: Message;
    isContinuation: boolean;
    isLastInGroup: boolean;
  };
  const items: Array<SepItem | MsgItem> = [];
  let prevDay: string | null = null;
  let prevDirection: Message["direction"] | null = null;
  for (const m of messages) {
    const day = zonedDateKey(new Date(m.created_at));
    if (day !== prevDay) {
      items.push({
        kind: "sep",
        key: `sep-${day}`,
        label: formatDayLabel(m.created_at, renderNowMs),
      });
      prevDay = day;
      // Day boundary always breaks the group — next bubble starts fresh.
      prevDirection = null;
    }
    const isContinuation =
      prevDirection !== null && prevDirection === m.direction;
    items.push({
      kind: "msg",
      msg: m,
      isContinuation,
      isLastInGroup: true, // patched in the second pass below
    });
    prevDirection = m.direction;
  }
  // Second pass: a message is "last in group" when the NEXT item is either
  // not a message or has a different direction (i.e. a separator follows
  // it, the list ends, or the sender flips). This is what lets us show
  // the timestamp only on the trailing bubble of each burst.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "msg") continue;
    const next = items[i + 1];
    it.isLastInGroup =
      !next || next.kind !== "msg" || next.msg.direction !== it.msg.direction;
  }
  const mostRecentOutboundId =
    [...items]
      .reverse()
      .find(
        (item): item is MsgItem =>
          item.kind === "msg" && item.msg.direction === "outbound",
      )?.msg.id ?? null;

  return (
    <div className="flex flex-col" data-testid="messages-thread">
      {items.map((it) =>
        it.kind === "sep" ? (
          <div
            key={it.key}
            className="flex justify-center mt-4 mb-1"
            data-testid="messages-thread-day-sep"
          >
            <span className="text-[11px] tabular-nums text-muted-foreground bg-muted border border-border px-3 py-1 rounded-full uppercase tracking-wider font-medium">
              {it.label}
            </span>
          </div>
        ) : (
          <MessageBubble
            key={it.msg.id}
            message={it.msg}
            isContinuation={it.isContinuation}
            isLastInGroup={it.isLastInGroup}
            isMostRecentOutbound={it.msg.id === mostRecentOutboundId}
          />
        ),
      )}
      <div ref={endRef} data-testid="messages-thread-end" />
    </div>
  );
}

export function useLeadMessages({
  initial,
  scope,
  onLiveMessage,
}: {
  initial: Message[];
  scope: LeadMessageScope;
  onLiveMessage?: (message: Message) => void;
}): Message[] {
  const { contactId, conversationId, propertyId } = scope;
  const [messages, setMessages] = useState<Message[]>(() =>
    sortMessages(
      filterThreadMessages(initial, { contactId, conversationId, propertyId }),
    ),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A route transition can replace the thread underneath the live subscription.
    setMessages(
      sortMessages(
        filterThreadMessages(initial, {
          contactId,
          conversationId,
          propertyId,
        }),
      ),
    );
  }, [contactId, conversationId, initial, propertyId]);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const start = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel(`messages:${propertyId ?? "none"}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          (payload) => {
            const row = payload.new as Message;
            if (
              !messageBelongsToThread(row, {
                contactId,
                conversationId,
                propertyId,
              })
            )
              return;
            setMessages((previous) =>
              sortMessages([
                row,
                ...previous.filter((message) => message.id !== row.id),
              ]).slice(-200),
            );
            onLiveMessage?.(row);
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "messages" },
          (payload) => {
            const row = payload.new as Message;
            setMessages((previous) => {
              const alreadyPresent = previous.some(
                (message) => message.id === row.id,
              );
              if (
                !alreadyPresent &&
                !messageBelongsToThread(row, {
                  contactId,
                  conversationId,
                  propertyId,
                })
              ) {
                return previous;
              }
              return sortMessages([
                row,
                ...previous.filter((message) => message.id !== row.id),
              ]).slice(-200);
            });
          },
        )
        .subscribe();
    };
    void start();

    return () => {
      mounted = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [contactId, conversationId, onLiveMessage, propertyId]);

  return messages;
}

function useLiveNow(seedNowMs: number): number {
  const [clock, setClock] = useState({ seedNowMs, value: seedNowMs });
  if (clock.seedNowMs !== seedNowMs) {
    setClock({
      seedNowMs,
      value: Math.max(clock.value, seedNowMs),
    });
  }

  useEffect(() => {
    const tick = () => {
      setClock((current) => ({
        ...current,
        value: Math.max(current.value, Date.now()),
      }));
    };
    const intervalId = window.setInterval(tick, LIVE_CLOCK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return clock.value;
}

function filterThreadMessages(
  rows: Message[],
  scope: LeadMessageScope,
): Message[] {
  return rows.filter((row) => messageBelongsToThread(row, scope));
}

function sortMessages(rows: Message[]): Message[] {
  return [...rows].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
}

function formatDayLabel(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const today = new Date(nowMs);
  const dayKey = zonedDateKey(d);
  const todayKey = zonedDateKey(today);
  const yesterdayKey = previousDateKey(todayKey);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATOR_TIME_ZONE,
    month: "long",
    day: "numeric",
  }).format(d);
  if (dayKey === todayKey) return `Today, ${monthDay}`;
  if (dayKey === yesterdayKey) return `Yesterday, ${monthDay}`;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATOR_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: dayKey.slice(0, 4) !== todayKey.slice(0, 4) ? "numeric" : undefined,
  }).format(d);
}

function zonedDateKey(date: Date): string {
  const parts = DAY_KEY_FORMATTER.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDateKey(dateKey: string): string {
  const noonUtc = Date.parse(`${dateKey}T12:00:00.000Z`);
  return new Date(noonUtc - 86_400_000).toISOString().slice(0, 10);
}

export function MessageBubble({
  message,
  isContinuation,
  isLastInGroup,
  isMostRecentOutbound,
}: {
  message: Message;
  isContinuation: boolean;
  isLastInGroup: boolean;
  isMostRecentOutbound: boolean;
}) {
  const outbound = message.direction === "outbound";
  const time = TIME_FORMATTER.format(new Date(message.created_at));
  const outboundStatusBadge = getOutboundStatusBadge(message);
  const deliveryStatusLabel = getDeliveryStatusLabel(
    message,
    isMostRecentOutbound,
  );
  const aiGenerated = isAiGeneratedMessage(message);
  const showMetadataFooter = isLastInGroup || aiGenerated;

  // Per-bubble vertical spacing replaces the old blanket `gap-4` on the
  // container. A continuation bubble (same sender, same day) gets a
  // tighter `mt-1` so the burst reads as one beat; a fresh sender or
  // post-separator bubble gets `mt-3` to clearly delimit the boundary.
  // The very first message in the thread has no top margin (no `mt-0`
  // ambiguity — Tailwind ignores `mt-0`-equivalent absence).
  const wrapperSpacing = isContinuation ? "mt-1" : "mt-3 first:mt-0";

  // Drop the "tail" notch on continuation bubbles so each burst reads
  // as a stack with one tail. Outbound's tail is top-right; inbound's
  // top-left. Continuations get a fully-rounded top.
  const bubbleShape = outbound
    ? `bg-primary text-primary-foreground p-3 rounded-2xl${
        isContinuation ? "" : " rounded-tr-none"
      }`
    : `bg-muted text-foreground p-3 rounded-2xl border border-border${
        isContinuation ? "" : " rounded-tl-none"
      }`;

  return (
    <div
      className={cn(
        outbound
          ? "flex flex-col items-end ml-auto max-w-[80%]"
          : "flex flex-col items-start max-w-[80%]",
        wrapperSpacing,
        !outbound && message.read_at === null
          ? "rounded-2xl ring-2 ring-amber-300/70 ring-offset-2"
          : undefined,
      )}
      data-direction={outbound ? "outbound" : "inbound"}
      data-continuation={isContinuation ? "true" : "false"}
      data-testid="messages-thread-msg"
    >
      <div className={bubbleShape}>
        <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
          {message.body}
        </div>
      </div>
      {showMetadataFooter ? (
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground ${
            outbound ? "mr-1" : "ml-1"
          }`}
        >
          <span>{time}</span>
          {deliveryStatusLabel ? (
            <span
              className={cn(
                "font-medium",
                deliveryStatusLabel.tone === "destructive"
                  ? "text-destructive"
                  : undefined,
              )}
              data-testid="messages-thread-delivery-status"
            >
              {deliveryStatusLabel.label}
            </span>
          ) : null}
          {outboundStatusBadge ? (
            <Badge
              variant={outboundStatusBadge.variant}
              className="text-[10px]"
            >
              {outboundStatusBadge.label}
            </Badge>
          ) : null}
          {!outbound &&
            message.metadata &&
            typeof message.metadata === "object" &&
            "keyword" in message.metadata && (
              <Badge variant="destructive" className="text-[10px]">
                {String(
                  (message.metadata as { keyword: unknown }).keyword,
                ).toUpperCase()}
              </Badge>
            )}
          {aiGenerated ? <SandraReplyBadge message={message} /> : null}
        </div>
      ) : null}
      {!showMetadataFooter && deliveryStatusLabel ? (
        <div
          className={cn(
            `mt-1 text-[11px] font-medium ${outbound ? "mr-1" : "ml-1"}`,
            deliveryStatusLabel.tone === "destructive"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
          data-testid="messages-thread-delivery-status"
        >
          {deliveryStatusLabel.label}
        </div>
      ) : null}
    </div>
  );
}

function SandraReplyBadge({ message }: { message: Message }) {
  const metadata = message.metadata as { confidence?: unknown };
  const confidence =
    typeof metadata.confidence === "number"
      ? `${(metadata.confidence * 100).toFixed(0)}%`
      : "unknown";

  return (
    <span
      className="inline-flex h-5 min-w-7 items-center justify-center rounded-full border border-[#e5e1df] bg-white px-1.5"
      title={`Sandra replied · confidence ${confidence}`}
      role="img"
      aria-label="Sandra replied"
      data-testid="messages-thread-sandra-reply-icon"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icon.png"
        alt=""
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0"
      />
    </span>
  );
}

function isAiGeneratedMessage(message: Message): boolean {
  if (message.direction !== "outbound") return false;
  const metadata = message.metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as { generated_by?: unknown }).generated_by === "ai_responder_v1"
  );
}

function getOutboundStatusBadge(message: Message): {
  label: string;
  variant: "secondary" | "outline";
} | null {
  if (message.direction !== "outbound") return null;

  switch (message.status) {
    case "queued":
    case "paused":
    case "pending":
    case "sent":
    case "delivered":
    case "failed":
      return null;
    default:
      return {
        label: message.status,
        variant: "outline",
      };
  }
}

function getDeliveryStatusLabel(
  message: Message,
  isMostRecentOutbound: boolean,
): {
  label: string;
  tone: "muted" | "destructive";
} | null {
  if (message.direction !== "outbound") return null;
  if (message.status === "failed") {
    return { label: "Not delivered", tone: "destructive" };
  }
  if (message.status === "queued") {
    return { label: "Queued · in Outbox", tone: "muted" };
  }
  if (message.status === "paused") {
    return { label: "Paused · in Outbox", tone: "muted" };
  }
  if (!isMostRecentOutbound) return null;

  switch (message.status) {
    case "pending":
      return { label: "Pending", tone: "muted" };
    case "sent":
      return { label: "Sent", tone: "muted" };
    case "delivered":
      return { label: "Delivered", tone: "muted" };
    default:
      return null;
  }
}
