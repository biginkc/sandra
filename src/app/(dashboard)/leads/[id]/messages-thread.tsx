"use client";

import { useEffect, useState } from "react";

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
  const items: Array<{ kind: "sep"; key: string; label: string } | { kind: "msg"; msg: Message }> = [];
  let prevDay: string | null = null;
  for (const m of messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== prevDay) {
      items.push({ kind: "sep", key: `sep-${day}`, label: formatDayLabel(m.created_at) });
      prevDay = day;
    }
    items.push({ kind: "msg", msg: m });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="messages-thread">
      {items.map((it) =>
        it.kind === "sep" ? (
          <div key={it.key} className="flex justify-center" data-testid="messages-thread-day-sep">
            <span className="text-[11px] tabular-nums text-muted-foreground bg-muted border border-border px-3 py-1 rounded-full uppercase tracking-wider font-medium">
              {it.label}
            </span>
          </div>
        ) : (
          <MessageBubble key={it.msg.id} message={it.msg} />
        ),
      )}
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

function MessageBubble({ message }: { message: Message }) {
  const outbound = message.direction === "outbound";
  const status = message.status;
  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className={
        outbound
          ? "flex flex-col items-end ml-auto max-w-[80%]"
          : "flex flex-col items-start max-w-[80%]"
      }
      data-direction={outbound ? "outbound" : "inbound"}
    >
      <div
        className={
          outbound
            ? "bg-primary text-primary-foreground p-3 rounded-2xl rounded-tr-none"
            : "bg-muted text-foreground p-3 rounded-2xl rounded-tl-none border border-border"
        }
      >
        <div className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
          {message.body}
        </div>
      </div>
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
    </div>
  );
}
