"use client";

import { useEffect, useRef } from "react";

import { MyLeadSmsStrip } from "../_components/sms-strip";
import type { MyLeadDetailPanelProps } from "../_components/types";
import { RepSmsComposer } from "../rep-sms-composer";
import type { WorkFacts } from "./contract";

/**
 * "Show all texts": the full text history (the existing strip, history only) with the existing composer
 * beneath it. The composer carries the reply-to stamp: the newest inbound the classifier knows about
 * (facts.latestInbound.messageId), captured by the composer when the rep opens it. This is a composition of
 * existing components, not a new surface; the container supplies the detail state it already loads.
 */
export type AllTextsProps = {
  facts: Pick<WorkFacts, "propertyId" | "latestInbound">;
  /** The lead's detail state (messages group) from the container's loadMyLeadDetail. */
  state: MyLeadDetailPanelProps["state"];
  onRetry: () => void;
  onLoadDetailPage?: MyLeadDetailPanelProps["onLoadDetailPage"];
  /** The exact saved phone of an open Messages thread, when the container knows it. */
  replyToPhone?: string | null;
  /** After a send: reload the thread and refresh the row. */
  onSent?: (messageId?: string) => void;
  /** Show the composer open (Reply / Send text reveal it this way); "Show all texts" leaves it closed. */
  defaultOpen?: boolean;
  /** False while an owner views another rep: history only, no composer. Default true. */
  canCompose?: boolean;
};

/**
 * Focus the composer's textarea once, as soon as it exists (design-owner answer 9: Reply reveals the thread and focuses
 * the textarea; focus is enough, the composer is never opened for the rep). The composer renders its textarea only after
 * the rep opens it and its sender list loads, so this watches the container instead of assuming it is there on mount.
 * Focus is never taken from a field the rep is typing in elsewhere.
 */
function useFocusComposerTextarea(container: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const tryFocus = (): boolean => {
      const textarea = root.querySelector("textarea");
      if (!textarea) return false;
      // Never pull focus out of a field the rep is typing in elsewhere (the search box); buttons do not count.
      const active = document.activeElement;
      if (active instanceof HTMLElement && !root.contains(active) && active.matches("input, textarea, select, [contenteditable]")) return true;
      textarea.focus();
      return document.activeElement === textarea;
    };
    if (tryFocus()) return;
    const observer = new MutationObserver(() => {
      if (tryFocus()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [container]);
}

export function AllTexts({ facts, state, onRetry, onLoadDetailPage, replyToPhone = null, onSent, defaultOpen = false, canCompose = true }: AllTextsProps) {
  const container = useRef<HTMLDivElement>(null);
  useFocusComposerTextarea(container);
  return (
    <div ref={container} data-testid={`all-texts-${facts.propertyId}`} className="min-w-0 space-y-3">
      <MyLeadSmsStrip state={state} onRetry={onRetry} onLoadDetailPage={onLoadDetailPage} />
      {canCompose && (
      <div className="flex flex-wrap items-start gap-2">
        <RepSmsComposer
          defaultOpen={defaultOpen}
          propertyId={facts.propertyId}
          placement="action"
          replyToPhone={replyToPhone}
          inboundMessageId={facts.latestInbound?.messageId ?? null}
          onSent={(messageId) => {
            onRetry();
            onSent?.(messageId);
          }}
        />
      </div>
      )}
    </div>
  );
}
