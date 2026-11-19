"use client";

import { MessageSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { agoLabel } from "./copy";

/** One text, already loaded by the container (derived from the loadMyLeadDetail messages group). */
export type ConversationMessage = {
  direction: "inbound" | "outbound";
  body: string;
  /** ISO timestamp. */
  at: string;
  /** Who sent it when it was not a person ("Us (drip)", "Us (campaign)", "Us (Sandra)"); null or absent = a person. */
  automation?: "drip" | "campaign" | "sandra" | null;
  /** Legacy flag: true tags "(drip)" when `automation` is not known. */
  automated?: boolean;
};

export type ConversationBoxState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; messages: readonly ConversationMessage[] };

/**
 * The last outbound and the last inbound text of a lead, one line each, newest at the bottom
 * (design v8 section 4). "Us" is tagged "(drip)", "(campaign)" or "(Sandra)" when automation sent it. A reply nobody has answered shows in blue.
 * There is deliberately no "They said" line. Pure presentation: the container loads the messages.
 */
export type ConversationBoxProps = {
  propertyId: string;
  state: ConversationBoxState;
  now: Date;
  /**
   * Whether the newest inbound is unanswered. Defaults to "the newest text overall is inbound";
   * pass facts.latestInbound && !facts.latestInbound.handled to use the classifier's answer.
   */
  unanswered?: boolean;
  /** Opens the all-texts thread with the composer. Hidden when there are no texts. */
  onShowAll: () => void;
  onRetry?: () => void;
};

const US_TAG = { drip: "Us (drip)", campaign: "Us (campaign)", sandra: "Us (Sandra)" } as const;

const oneLine = (body: string) => body.replace(/\s+/g, " ").trim();

export function ConversationBox({ propertyId, state, now, unanswered, onShowAll, onRetry }: ConversationBoxProps) {
  if (state.status === "loading") {
    return <p className="text-xs text-muted-foreground" role="status" data-testid={`conversation-loading-${propertyId}`}>Loading texts…</p>;
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert" data-testid={`conversation-error-${propertyId}`}>
        <span>Texts unavailable. {state.message}</span>
        {onRetry && <Button type="button" variant="outline" size="xs" onClick={onRetry}>Retry texts</Button>}
      </div>
    );
  }

  const byTime = [...state.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lastOut = [...byTime].reverse().find((m) => m.direction === "outbound") ?? null;
  const lastIn = [...byTime].reverse().find((m) => m.direction === "inbound") ?? null;
  if (!lastOut && !lastIn) {
    return <p className="text-xs text-muted-foreground" data-testid={`conversation-empty-${propertyId}`}>No texts yet.</p>;
  }
  const shown = [lastOut, lastIn].filter((m): m is ConversationMessage => m !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const newest = shown[shown.length - 1];
  const inboundUnanswered = unanswered ?? newest.direction === "inbound";

  return (
    <section aria-label="Latest texts" className="space-y-1.5" data-testid={`conversation-box-${propertyId}`}>
      <h3 className="inline-flex items-center gap-1.5 text-[10px] font-extrabold tracking-[0.08em] text-muted-foreground uppercase">
        <MessageSquare className="size-3" aria-hidden="true" />
        Texts
      </h3>
      <ul className="space-y-1">
        {shown.map((message) => {
          const isUnanswered = message.direction === "inbound" && inboundUnanswered;
          const who =
            message.direction === "outbound"
              ? message.automation
                ? US_TAG[message.automation]
                : message.automated
                  ? US_TAG.drip
                  : "Us"
              : "Them";
          return (
            <li
              key={`${message.direction}-${message.at}`}
              data-direction={message.direction}
              data-unanswered={isUnanswered || undefined}
              className={cn(
                "flex min-w-0 items-baseline gap-2 text-[12.5px]",
                isUnanswered ? "font-semibold text-blue-700 dark:text-blue-300" : "text-foreground",
              )}
            >
              <span className="shrink-0 font-bold">{who}:</span>{" "}
              <span className="min-w-0 flex-1 truncate">{oneLine(message.body) || "No text content"}</span>{" "}
              <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{agoLabel(message.at, now)}</span>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="link" size="xs" className="h-auto px-0 py-1 text-[11px]" data-testid={`conversation-show-all-${propertyId}`} onClick={onShowAll}>
        Show all texts
      </Button>
    </section>
  );
}
