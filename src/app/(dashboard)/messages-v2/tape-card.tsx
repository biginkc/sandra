"use client";

import { MultiHouseBadge } from "@/components/leads/multi-house-badge";
import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
import { cn } from "@/lib/utils";

import { chicagoClock } from "./chicago-time";
import { hasUndoableJevAction, UndoJevButton, type UndoControls } from "./run-card";
import { deriveTape, type TapeTone } from "./tape";
import type { RunThread } from "./tape-data";
import type { RunLabel, RunWithSteps } from "./types";

const ENTER = "animate-in fade-in slide-in-from-top-1 duration-300";

export const TONE_CLASS: Record<TapeTone, string> = {
  hot: "bg-status-hot-bg text-status-hot-fg border-status-hot-border",
  no: "bg-status-contacted-bg text-status-contacted-fg border-status-contacted-border",
  later: "bg-status-cold-bg text-status-cold-fg border-status-cold-border",
  who: "bg-status-replying-bg text-status-replying-fg border-status-replying-border",
  stop: "bg-status-dead-bg text-status-dead-fg border-status-dead-border",
  unclear: "bg-status-contacted-bg text-status-contacted-fg border-status-contacted-border",
};

/** First name for a sentence; senders we could not match become "They". */
export function sellerWho(label: RunLabel | undefined): string {
  const name = label?.name;
  return !name || name.startsWith("Unknown") ? "They" : name;
}

function Meta({ run, label, houses }: { run: RunWithSteps; label: RunLabel | undefined; houses?: HomeownerHouses | null }) {
  return (
    <>
      <time dateTime={run.started_at} className="font-semibold text-foreground tabular-nums">
        {chicagoClock(run.started_at)}
      </time>
      <span className="font-semibold text-foreground">{label?.name ?? "Unknown sender"}</span>
      <MultiHouseBadge
        houses={houses}
        contactId={run.contact_id}
        ownerName={label?.name}
        currentPropertyId={run.property_id ?? undefined}
      />
      {label?.address && <span>· {label.address}</span>}
    </>
  );
}

function Thread({ run, thread, showReply }: { run: RunWithSteps; thread?: RunThread; showReply: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {thread?.lastOutbound && (
        <p data-testid="tape-ours" className="max-w-[70%] self-end rounded-2xl rounded-br-sm bg-secondary px-3 py-2 text-[13px] text-muted-foreground">
          {thread.lastOutbound}
        </p>
      )}
      {run.inbound_preview && (
        <p data-testid="tape-theirs" className="max-w-[70%] self-start rounded-2xl rounded-bl-sm bg-status-new-bg px-3 py-2">
          {run.inbound_preview}
        </p>
      )}
      {showReply && thread?.reply && (
        <p data-testid="tape-reply" className="max-w-[70%] self-end rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-[13px] text-primary-foreground">
          {thread.reply}
        </p>
      )}
    </div>
  );
}

/** One seller text on Sandra's tape: the text, what she decided in plain words, and what she did about it. */
export function TapeCard({
  run,
  label,
  thread,
  flagReason,
  flagPinned,
  undoControls,
  houses,
}: {
  run: RunWithSteps;
  label: RunLabel | undefined;
  /** "Owns N houses" for this run's homeowner, from the tape's one batched read. */
  houses?: HomeownerHouses | null;
  thread?: RunThread;
  /** True when flagReason is the waiting-list snapshot's reason: it then wins over the run's own reason and outcome. */
  flagPinned?: boolean;
  /** The hold's flag reason, only when this run is the hold's current run (see withEffectiveReason). */
  flagReason?: string | null;
  undoControls?: UndoControls;
}) {
  const view = deriveTape(run, sellerWho(label), flagReason, flagPinned);

  if (view.kind === "quiet") {
    return (
      <article
        data-testid="tape-card"
        data-kind="quiet"
        className={cn("flex flex-col gap-2 rounded-2xl border bg-card/60 px-5 py-3 text-sm", ENTER)}
      >
        <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-muted-foreground">
          <Meta run={run} label={label} houses={houses} />
        </div>
        {run.inbound_preview && <p className="text-muted-foreground">{run.inbound_preview}</p>}
        <p data-testid="tape-quiet" className="text-[13px] text-muted-foreground">
          {view.text}
        </p>
      </article>
    );
  }

  const reading = view.kind === "reading";
  const decided = view.kind === "decided" ? view : null;
  return (
    <article
      data-testid="tape-card"
      data-kind={view.kind}
      data-stage={decided?.stage ?? (reading ? "reading" : "error")}
      className={cn(
        "flex flex-col gap-2.5 rounded-2xl border bg-card px-5 py-4 text-sm",
        reading && "ring-[3px] ring-status-new-fg/15",
        ENTER,
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-muted-foreground">
        <Meta run={run} label={label} houses={houses} />
        {reading && (
          <span data-testid="tape-reading" className="ml-auto inline-flex items-center gap-1.5 font-medium text-status-new-fg">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-status-new-fg" />
            Sandra is reading…
          </span>
        )}
        {decided?.tag && (
          <span
            data-testid="tape-tag"
            className={cn("ml-auto rounded-full border px-2.5 py-0.5 font-medium", TONE_CLASS[decided.tag.tone])}
          >
            {decided.tag.label}
          </span>
        )}
      </div>

      <Thread run={run} thread={thread} showReply={decided?.stage === "sent"} />

      {decided && (
        <div className="flex flex-col gap-1 border-t pt-2 text-[13px]">
          <p data-testid="tape-sentence">
            <b>Sandra:</b> {decided.sentence}
          </p>
          {decided.did && (
            <div data-testid="tape-did" className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
              {decided.did}
              {undoControls && hasUndoableJevAction(run) && (
                <UndoJevButton inboundMessageId={run.inbound_message_id} controls={undoControls} />
              )}
            </div>
          )}
        </div>
      )}
      {view.kind === "error" && (
        <p data-testid="tape-sentence" className="border-t pt-2 text-[13px]">
          <b>Sandra:</b> {view.sentence}
        </p>
      )}
    </article>
  );
}
