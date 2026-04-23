"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
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

  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const outbound = message.direction === "outbound";
  const status = message.status;

  return (
    <div
      className={
        outbound ? "flex justify-end" : "flex justify-start"
      }
    >
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
          outbound
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{message.body}</div>
        <div
          className={`mt-1 flex items-center gap-1.5 text-xs ${
            outbound ? "text-primary-foreground/70" : "text-muted-foreground"
          }`}
        >
          <span>
            {formatDistanceToNow(new Date(message.created_at), {
              addSuffix: true,
            })}
          </span>
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
          {!outbound && message.metadata &&
            typeof message.metadata === "object" &&
            "keyword" in message.metadata && (
              <Badge variant="destructive" className="text-[10px]">
                {String(
                  (message.metadata as { keyword: unknown }).keyword,
                ).toUpperCase()}
              </Badge>
            )}
        </div>
      </div>
    </div>
  );
}
