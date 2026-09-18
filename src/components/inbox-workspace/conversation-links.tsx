"use client";

import { useState } from "react";

/** Small, reversible detail affordances shared with the existing Messages
 * deep-link conventions. It does not infer a lead/property id from a summary
 * row, so it cannot open the wrong record. */
export function ConversationLinks({ conversationId }: { conversationId: string }) {
  const [status, setStatus] = useState<string>();
  const href = `/messages?thread=${encodeURIComponent(conversationId)}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      setStatus("Conversation link copied");
    } catch {
      setStatus("Could not copy conversation link");
    }
  }
  return <><a href={href}>Open in Messages</a><button type="button" onClick={() => void copy()}>Copy conversation link</button>{status && <span role="status">{status}</span>}</>;
}

