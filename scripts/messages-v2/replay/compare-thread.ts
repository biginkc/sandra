import type { ReplayExport, ReplayInbound } from "./schema";

export const THREAD_WINDOW = 15;

export type ThreadMessage = { direction: "inbound" | "outbound"; body: string; sentAt: string };

/**
 * The conversation Jev would have seen: up to 15 prior messages in the same conversation (both
 * directions, oldest first) plus the inbound being classified, exactly like dispatch-bridge.ts.
 * Sources: pre-window history (tables.messages), earlier in-window inbound, and in-window outbound
 * (reference.outboundInWindow, which carries a body only in exports made by this version or later).
 */
export function buildThread(exp: ReplayExport, inbound: ReplayInbound): { thread: ThreadMessage[]; missingOutboundBodies: number } {
  const at = new Date(inbound.receivedAt).getTime();
  const seen = new Map<string, ThreadMessage & { ts: number }>();
  const sameThread = (conv: unknown) => (inbound.conversationId ? String(conv) === inbound.conversationId : false);
  let missing = 0;
  const add = (id: string, direction: unknown, body: unknown, when: unknown) => {
    const ts = new Date(String(when)).getTime();
    if (!(ts < at) || id === inbound.id) return;
    seen.set(id, { direction: direction === "inbound" ? "inbound" : "outbound", body: String(body ?? ""), sentAt: new Date(ts).toISOString(), ts });
  };
  for (const m of exp.tables.messages) if (sameThread(m.conversation_id)) add(String(m.id), m.direction, m.body, m.created_at);
  for (const m of exp.inbound) if (m.id !== inbound.id && inbound.conversationId && m.conversationId === inbound.conversationId) add(m.id, "inbound", m.body, m.receivedAt);
  for (const m of exp.reference.outboundInWindow) {
    if (!sameThread(m.conversation_id)) continue;
    if (typeof m.body !== "string") { if (new Date(String(m.created_at)).getTime() < at) missing++; continue; }
    add(String(m.id), "outbound", m.body, m.created_at);
  }
  const prior = [...seen.values()].sort((a, b) => a.ts - b.ts || a.sentAt.localeCompare(b.sentAt)).slice(-THREAD_WINDOW);
  return {
    thread: [...prior.map((m) => ({ direction: m.direction, body: m.body, sentAt: m.sentAt })), { direction: "inbound", body: inbound.body, sentAt: inbound.receivedAt }],
    missingOutboundBodies: missing,
  };
}
