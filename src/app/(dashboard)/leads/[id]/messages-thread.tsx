"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Message = Database["public"]["Tables"]["messages"]["Row"];

type Props = {
  /** Initial rows server-rendered so first paint is never blank. */
  initial: Message[];
  /** Contact + property ids define which rows belong in this thread. */
  contactId: string | null;
  propertyId: string;
};

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
export function MessagesThread({ initial, contactId, propertyId }: Props) {
  const [messages, setMessages] = useState<Message[]>(initial);
  const endRef = useRef<HTMLDivElement | null>(null);

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
        .channel(`messages:${propertyId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          (payload) => {
            const row = payload.new as Message;
            const belongs =
              row.property_id === propertyId ||
              (contactId && row.contact_id === contactId);
            if (belongs) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === row.id)) return prev;
                return [...prev, row].sort((a, b) =>
                  a.created_at.localeCompare(b.created_at),
                );
              });
            }
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "messages" },
          (payload) => {
            const row = payload.new as Message;
            setMessages((prev) =>
              prev.map((m) => (m.id === row.id ? row : m)),
            );
          },
        )
        .subscribe();
    };
    start();

    return () => {
      mounted = false;
      if (channel) supabase.removeChannel(channel);
    };
  }, [contactId, propertyId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contactId, messages.length, propertyId]);

  if (messages.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        No messages yet. Send an SMS to start a thread.
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
    const day = new Date(m.created_at).toDateString();
    if (day !== prevDay) {
      items.push({ kind: "sep", key: `sep-${day}`, label: formatDayLabel(m.created_at) });
      prevDay = day;
      // Day boundary always breaks the group — next bubble starts fresh.
      prevDirection = null;
    }
    const isContinuation = prevDirection !== null && prevDirection === m.direction;
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
          />
        ),
      )}
      <div ref={endRef} data-testid="messages-thread-end" />
    </div>
  );
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const monthDay = d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
  if (sameDay(d, today)) return `Today, ${monthDay}`;
  if (sameDay(d, yesterday)) return `Yesterday, ${monthDay}`;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

function MessageBubble({
  message,
  isContinuation,
  isLastInGroup,
}: {
  message: Message;
  isContinuation: boolean;
  isLastInGroup: boolean;
}) {
  const outbound = message.direction === "outbound";
  const status = message.status;
  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

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
      className={
        (outbound
          ? "flex flex-col items-end ml-auto max-w-[80%]"
          : "flex flex-col items-start max-w-[80%]") + ` ${wrapperSpacing}`
      }
      data-direction={outbound ? "outbound" : "inbound"}
      data-continuation={isContinuation ? "true" : "false"}
      data-testid="messages-thread-msg"
    >
      <div className={bubbleShape}>
        <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
          {message.body}
        </div>
      </div>
      {isLastInGroup ? (
      <div
        className={`mt-1 flex items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground ${
          outbound ? "mr-1" : "ml-1"
        }`}
      >
        <span>{time}</span>
        {outbound && status !== "sent" && status !== "delivered" && (
          <Badge
            variant={
              status === "failed"
                ? "destructive"
                : status === "queued" || status === "pending"
                  ? "secondary"
                  : "outline"
            }
            className="text-[10px]"
          >
            {status}
          </Badge>
        )}
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
        {outbound &&
          message.metadata &&
          typeof message.metadata === "object" &&
          (message.metadata as { generated_by?: unknown }).generated_by ===
            "ai_responder_v1" && (
            <Badge
              variant="outline"
              className="border-border text-muted-foreground text-[10px]"
              title={`AI-drafted · confidence ${
                typeof (message.metadata as { confidence?: unknown })
                  .confidence === "number"
                  ? ((message.metadata as { confidence: number }).confidence * 100).toFixed(0) + "%"
                  : "—"
              }`}
            >
              AI
            </Badge>
          )}
      </div>
      ) : null}
    </div>
  );
}
