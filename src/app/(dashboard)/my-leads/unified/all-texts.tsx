"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { MyLeadSmsStrip } from "../_components/sms-strip";
import type { MyLeadDetailPanelProps } from "../_components/types";
import { RepSmsComposer, type RepSmsComposerTarget } from "../rep-sms-composer";
import type { WorkFacts } from "./contract";

/**
 * "Show all texts": the full text history (the existing strip, history only) with the existing composer
 * beneath it. The composer carries the reply-to stamp: the newest inbound shown in the loaded thread, captured by the
 * composer when the rep opens it (facts.latestInbound only detects that a newer reply needs a refresh first). This is a composition of
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
  /** The Broken item's exact record: the composer resumes / resends / checks THAT one, not the lead's saved submission. */
  target?: RepSmsComposerTarget;
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

/** The newest inbound text in the loaded thread (the one the rep can actually see), or null. */
function newestDisplayedInbound(state: AllTextsProps["state"]): { id: string; createdAt: string } | null {
  if (state.status !== "ready") return null;
  let newest: { id: string; createdAt: string } | null = null;
  for (const message of state.detail.messages.rows) {
    if (message.direction !== "inbound") continue;
    if (!newest || Date.parse(message.createdAt) > Date.parse(newest.createdAt)) newest = { id: message.id, createdAt: message.createdAt };
  }
  return newest;
}

export function AllTexts({ facts, state, onRetry, onLoadDetailPage, replyToPhone = null, onSent, defaultOpen = false, canCompose = true, target }: AllTextsProps) {
  const container = useRef<HTMLDivElement>(null);
  useFocusComposerTextarea(container);
  // The reply-to stamp is the newest inbound DISPLAYED in the loaded thread, never the classifier's latest: a reply that
  // arrived after the thread loaded must not be marked answered by a send the rep wrote without seeing it.
  const displayed = useMemo(() => newestDisplayedInbound(state), [state]);
  const ready = state.status === "ready";
  const loadedIds = useMemo(() => new Set(ready ? state.detail.messages.rows.map((m) => m.id) : []), [ready, state]);
  const newerId = facts.latestInbound?.messageId ?? null;
  const stale = ready && newerId !== null && !loadedIds.has(newerId);
  // Refresh the cached thread once per newer reply; the notice below has a manual Refresh too.
  const refreshedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!stale || !newerId || refreshedFor.current === newerId) return;
    refreshedFor.current = newerId;
    onRetry();
  }, [stale, newerId, onRetry]);
  // A composer that is already on screen keeps its own captured stamp (it never re-stamps mid-draft); a composer that
  // has not opened yet waits for a thread that is loaded and current. A thread that failed to load never mounts one:
  // with nothing displayed there is no stamp, and an unstamped send could mark an unseen reply handled.
  const [composerShown, setComposerShown] = useState(false);
  const showComposer = canCompose && ((ready && !stale) || composerShown);
  if (showComposer && !composerShown) setComposerShown(true);
  return (
    <div ref={container} data-testid={`all-texts-${facts.propertyId}`} className="min-w-0 space-y-3">
      <MyLeadSmsStrip state={state} onRetry={onRetry} onLoadDetailPage={onLoadDetailPage} />
      {canCompose && stale && (
        <div role="status" data-testid={`all-texts-stale-${facts.propertyId}`} className="flex flex-wrap items-center gap-2 rounded border border-amber-300 p-2 text-[12.5px]">
          <span>New reply arrived</span>
          <Button type="button" variant="outline" size="xs" onClick={onRetry}>
            Refresh
          </Button>
        </div>
      )}
      {showComposer && (
      <div className="flex flex-wrap items-start gap-2">
        <RepSmsComposer
          defaultOpen={defaultOpen}
          {...(target ? { target } : {})}
          propertyId={facts.propertyId}
          placement="action"
          replyToPhone={replyToPhone}
          inboundMessageId={displayed?.id ?? null}
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
