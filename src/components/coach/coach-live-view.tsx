"use client";

import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PhoneKeypad } from "@/components/softphone/phone-keypad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { DtmfDigit } from "@/lib/dialer/transport";
import { requestCoachRecommendations } from "@/lib/coach/recommendation-action";
import { useCoachRecommendations } from "@/lib/coach/recommendation-client";
import type { CoachRecommendationRequestFn } from "@/lib/coach/recommendation-types";
import {
  buildCoachSectionScriptBlock,
  getScriptPhase,
  type BranchSelectContext,
  type CoachSectionScriptBlock,
  type DisplayLine,
  type ScriptBranchBlock,
} from "@/lib/coach/script-block";
import { resolveCoachTokens, type DisplayTextSegment } from "@/lib/coach/token-resolver";
import type {
  CoachEntryToken,
  CoachPhaseId,
  CoachToken,
  CoachTranscriptLine,
  ResolvedToken,
  ResolvedTokens,
} from "@/lib/coach/types";
import { COACH_ENTRY_TOKENS, COACH_PHASE_ORDER } from "@/lib/coach/types";
import type { CoachSession, ContextLoadState } from "@/lib/coach/use-coach-session";
import { isNearTranscriptBottom } from "@/lib/coach/transcript-scroll";
import { cn } from "@/lib/utils";

export type CoachCallStatus = "connecting" | "ringing" | "live" | "audio_reconnecting" | "audio_reconnect_required" | "ended" | "failed" | null;

export type CoachLiveViewProps = {
  /** The persistent coach session — owned by the provider, not this view,
   * so collapsing/reopening the view never resets it. */
  session: CoachSession;
  callName: string;
  callStatus: CoachCallStatus;
  seconds: number;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onDigit: (digit: DtmfDigit) => void;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  onReconnectAudio?: () => void;
  /** Shrinks back to the classic call popover — Esc does the same. The
   * popover surfaces an "Open live coach" button to reverse this. The
   * coach session itself (transcript, phase, gates, cards, entered
   * values) lives in the provider and is unaffected by this. */
  onCollapse: () => void;
  /** Test/synthetic injection only. Production uses the authenticated
   * Sandra server action above. */
  recommendationRequest?: CoachRecommendationRequestFn;
};

const ENTRY_TOKEN_SET: ReadonlySet<string> = new Set(COACH_ENTRY_TOKENS);
const ALWAYS_EDITABLE_ENTRY_TOKEN_SET: ReadonlySet<CoachEntryToken> = new Set([
  "dream_outcome",
  "closing_date",
  "offer_price",
  "net_to_seller",
]);

/** Display-only shorthand for the phase rail — the mock's rail reads INTRO
 * · REVEAL · ASSESS · POSITION · OFFER · CLOSE, six short labels that leave
 * room on the top edge instead of the full phase.display names ("Secure
 * Positioning") crowding it. This is purely cosmetic: the underlying phase
 * id, `phaseName` (used for the Say This card / aria-labels elsewhere), and
 * the rail button's own accessible name all keep the full phase name — only
 * the rail button's VISIBLE text is shortened. Falls back to the full name
 * for any phase id not listed here, so a future phase never renders blank. */
const RAIL_LABEL: Partial<Record<CoachPhaseId, string>> = {
  introduction: "Intro",
  reveal: "Reveal",
  assessment: "Assess",
  secure_positioning: "Position",
  offer: "Offer",
  close: "Close",
};

const ENTRY_TOKEN_LABEL: Record<CoachEntryToken, string> = {
  motivation: "seller motivation",
  dream_outcome: "seller’s dream outcome",
  cold_caller_name: "cold caller name",
  closing_date: "closing date",
  offer_price: "offer price",
  net_to_seller: "net to seller",
};

const MAX_RENDERED_TRANSCRIPT_LINES = 200;

function timerText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Selects the line to present as "the thing to say" for a branch: the
 * first line whose type is "say" — or null when the branch's selected
 * variant has NO "say" line at all. Every call site that needs to show a
 * branch's spoken content (the dominant Say This line, the Coming Next
 * preview) must go through this, rather than indexing lines[0] directly —
 * a blind lines[0] can land on an internal type:"note" line (e.g. Close's
 * "If far apart — program pivot" branch leads with one: "Only for
 * novation prices on the calculator.", a note for the rep, not something
 * to say) and present it to the rep as speech.
 *
 * Deliberately does NOT fall back to lines[0] when no "say" line exists —
 * an all-note variant is not something the schema forbids (it only
 * requires >=1 line, not >=1 spoken one), so that fallback would still be
 * a live path to rendering a note as speech, just relocated rather than
 * fixed. Every caller must treat null as "nothing to show" and render
 * nothing, never substitute the first line regardless of its type. */
export function selectSpokenLine(branch: ScriptBranchBlock | null | undefined): DisplayLine | null {
  if (!branch) return null;
  return branch.selected.lines.find((line) => line.type === "say") ?? null;
}

export function CoachLiveView(props: CoachLiveViewProps) {
  const {
    session,
    callName,
    callStatus,
    seconds,
    muted,
    held,
    holdPending,
    onDigit,
    onMute,
    onHold,
    onHangup,
    onReconnectAudio,
    onCollapse,
    recommendationRequest = requestCoachRecommendations,
  } = props;
  const {
    state,
    degraded,
    reconnectGap,
    dismissReconnectGap,
    contextLoad,
    retryContext,
    branchOverrides,
    selectVariant,
    setEntryField,
    activeSectionId,
    nextSectionId,
    canGoPrevious,
    canGoNext,
    goPreviousSection,
    goNextSection,
    goToPhase,
  } = session;
  const [keypadOpen, setKeypadOpen] = useState(false);

  // The script must always render, even mid-load or after a failed context
  // fetch. Failure state keeps any prepared call identity the dialer already
  // knew and leaves only genuinely unavailable values as placeholders.
  const activeContext = contextLoad.context;
  const tokens: ResolvedTokens = useMemo(
    () => resolveCoachTokens(activeContext, state.entryFields),
    [activeContext, state.entryFields],
  );
  const selectCtx: BranchSelectContext = useMemo(
    () => ({ leadSource: activeContext.leadSource, occupancy: activeContext.occupancy }),
    [activeContext.leadSource, activeContext.occupancy],
  );

  const { scriptBlock, selectedVariants } = useMemo(() => {
    const block = buildCoachSectionScriptBlock(activeSectionId, tokens, selectCtx, branchOverrides);
    return {
      scriptBlock: block,
      selectedVariants: Object.fromEntries(
        (block?.branches ?? []).map((branch) => [branch.tag, branch.selected.key]),
      ),
    };
  }, [activeSectionId, branchOverrides, selectCtx, tokens]);
  const nextBlock = useMemo(
    () => nextSectionId
      ? buildCoachSectionScriptBlock(nextSectionId, tokens, selectCtx, branchOverrides)
      : null,
    [branchOverrides, nextSectionId, selectCtx, tokens],
  );
  const activePhaseId = scriptBlock?.phaseId ?? "introduction";
  const recommendations = useCoachRecommendations({
    callId: session.callId,
    activeSectionId,
    branchOverrides: selectedVariants,
    transcript: state.transcript,
    request: recommendationRequest,
    continuity: session.recommendationContinuity,
  });

  const onEditEntry = useCallback(
    (field: CoachEntryToken, value: string) => setEntryField(field, value),
    [setEntryField],
  );
  const isEntryTokenEditable = useCallback(
    (token: CoachEntryToken) =>
      ALWAYS_EDITABLE_ENTRY_TOKEN_SET.has(token) ||
      (token === "motivation" && !activeContext.motivation?.trim()) ||
      (token === "cold_caller_name" && !activeContext.coldCallerName?.trim()),
    [activeContext.coldCallerName, activeContext.motivation],
  );
  const onSelectVariant = useCallback((tag: string, key: string) => selectVariant(tag, key), [selectVariant]);

  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (
          details.reason === "escape-key" &&
          details.event.target instanceof Element &&
          details.event.target.closest("[data-coach-entry-editor]")
        ) {
          details.cancel();
          return;
        }
        onCollapse();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="coach-live-view"
        // Base UI's default finalFocus ("trigger or previously focused
        // element") doesn't hold up here: production never opens this
        // dialog from a persistent trigger button — it's portaled in
        // directly once a call goes live, and by the time it closes, the
        // element that had focus beforehand may well have unmounted (the
        // call state that owned it has moved on). A function target is
        // resolved live, at close time, so it can't go stale the way a
        // ref captured at open time could — it looks up the header dialer
        // button, which is mounted in the app shell unconditionally
        // (unlike the classic popover's "reopen coach" button, which only
        // exists once the collapse this very focus-move is part of has
        // finished committing).
        finalFocus={() => document.querySelector<HTMLElement>('[data-testid="header-dialer-button"]') ?? false}
        className="inset-0 top-0 left-0 z-[80] flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-foreground ring-0 sm:max-w-none"
      >
      <DialogTitle className="sr-only">Live call coach</DialogTitle>
      <CoachTopBar
        activePhaseId={activePhaseId}
        onSelectPhase={goToPhase}
        degraded={degraded}
        callStatus={callStatus}
        seconds={seconds}
        held={held}
        fileNumber={tokens.file_number}
      />
      {callStatus === "audio_reconnecting" || callStatus === "audio_reconnect_required" ? (
        <div role="alert" data-testid="coach-audio-reconnect-warning" className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-950">
          <span>{callStatus === "audio_reconnecting" ? "Call live · reconnecting browser audio…" : "Call live · audio interrupted"}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onReconnectAudio ? (
              <button
                type="button"
                data-testid="coach-reconnect-audio"
                onClick={onReconnectAudio}
                disabled={callStatus === "audio_reconnecting"}
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-bold disabled:cursor-wait disabled:opacity-60"
              >
                Reconnect Audio
              </button>
            ) : null}
            <button
              type="button"
              data-testid="coach-warning-hangup"
              onClick={onHangup}
              className="rounded-md border border-red-300 bg-white px-3 py-1.5 font-bold text-red-700"
            >
              Hang Up
            </button>
          </div>
        </div>
      ) : null}
      {reconnectGap ? (
        <div
          role="status"
          data-testid="coach-reconnect-gap"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900"
        >
          <span>Reconnected — some coach events may have been missed while disconnected.</span>
          <button type="button" data-testid="dismiss-reconnect-gap" onClick={dismissReconnectGap} className="font-bold underline">
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[minmax(250px,0.8fr)_minmax(500px,2fr)_minmax(280px,0.9fr)] xl:overflow-hidden">
        <TranscriptFeed lines={state.transcript} />
        <ScriptPanel
          block={scriptBlock}
          nextBlock={nextBlock}
          degraded={degraded}
          contextLoad={contextLoad}
          canGoPrevious={canGoPrevious}
          canGoNext={canGoNext}
          onPrevious={goPreviousSection}
          onNext={goNextSection}
          onRetryContext={retryContext}
          onEditEntry={onEditEntry}
          isEntryTokenEditable={isEntryTokenEditable}
          onBeginEntryEdit={() => setKeypadOpen(false)}
          onSelectVariant={onSelectVariant}
        />
        <RecommendationsPanel
          {...recommendations}
          hasFinalSellerTranscript={state.transcript.some((line) => line.isFinal && line.speaker === "seller")}
        />
      </div>
      <CallControlDock
        callName={callName}
        callStatus={callStatus}
        muted={muted}
        held={held}
        holdPending={holdPending}
        onDigit={onDigit}
        onMute={onMute}
        onHold={onHold}
        onHangup={onHangup}
        onCollapse={onCollapse}
        keypadOpen={keypadOpen}
        onKeypadOpenChange={setKeypadOpen}
      />
      </DialogContent>
    </Dialog>
  );
}

function CoachTopBar({
  activePhaseId,
  onSelectPhase,
  degraded,
  callStatus,
  seconds,
  held,
  fileNumber,
}: {
  activePhaseId: CoachPhaseId;
  onSelectPhase: (phaseId: CoachPhaseId) => void;
  degraded: boolean;
  callStatus: CoachCallStatus;
  seconds: number;
  held: boolean;
  fileNumber: ResolvedToken;
}) {
  const preConnectLabel = callStatus === "connecting" ? "Connecting…" : callStatus === "ringing" ? "Ringing…" : null;
  const timerLabel = held ? "On hold" : preConnectLabel ?? timerText(seconds);
  const currentPhaseIndex = COACH_PHASE_ORDER.indexOf(activePhaseId);
  const currentPhaseName = getScriptPhase(activePhaseId)?.name ?? activePhaseId;
  return (
    <div className="shrink-0 border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs" data-testid="coach-status-strip">
        <Badge variant="secondary" data-testid="coach-current-phase" className="h-5 text-[10px]">
          {`Phase · ${currentPhaseName}`}
        </Badge>
        <span
          data-testid="coach-file-number"
          aria-label="File number"
          className={cn(
            "font-mono text-xs tabular-nums",
            fileNumber.isPlaceholder ? "text-muted-foreground" : "font-semibold text-foreground",
          )}
        >
          {`File number: ${fileNumber.value}`}
        </span>
        <span
          className={cn("font-mono text-xs tabular-nums", held ? "font-semibold text-amber-700 dark:text-amber-400" : "text-muted-foreground")}
          data-testid="coach-call-timer"
        >
          {timerLabel}
        </span>
        {preConnectLabel ? (
          <Badge variant="outline" data-testid="call-status-pill" className="h-5 text-[10px] text-muted-foreground">
            {preConnectLabel}
          </Badge>
        ) : null}
        {callStatus === "live" && !held ? (
          <Badge variant="outline" data-testid="coach-live-pill" className="h-5 gap-1 border-emerald-200 text-[10px] text-emerald-700 dark:text-emerald-400">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
            Live
          </Badge>
        ) : null}
        {degraded ? (
          <Badge variant="outline" data-testid="coach-connecting-pill" className="h-5 text-[10px] text-muted-foreground">
            Transcript connecting…
          </Badge>
        ) : null}
      </div>
      <ol className="flex min-w-0 items-center gap-1 overflow-x-auto px-4 pb-2" aria-label="Call phases" data-testid="coach-phase-scroller">
        {COACH_PHASE_ORDER.map((phaseId) => {
          const phase = getScriptPhase(phaseId);
          const fullName = phase?.name ?? phaseId;
          const isCurrent = phaseId === activePhaseId;
          const isComplete = COACH_PHASE_ORDER.indexOf(phaseId) < currentPhaseIndex;
          const suffix = isComplete ? " ✓" : "";
          return (
            <li key={phaseId}>
              <button
                type="button"
                data-testid={`phase-rail-${phaseId}`}
                aria-current={isCurrent ? "step" : undefined}
                // Accessible name stays the full phase name (matching the
                // Say This card and the top-strip phase badges) even though
                // the visible label below is shortened.
                aria-label={`${fullName}${suffix}`}
                onClick={() => onSelectPhase(phaseId)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide whitespace-nowrap uppercase transition-colors",
                  isCurrent
                    ? "bg-primary text-primary-foreground"
                    : isComplete
                      ? "text-emerald-700 dark:text-emerald-400"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span>
                  {RAIL_LABEL[phaseId] ?? fullName}
                  {suffix}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TranscriptFeed({ lines }: { lines: CoachTranscriptLine[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottomRef.current = isNearTranscriptBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !wasAtBottomRef.current) return;
    el.scrollTo?.({ top: el.scrollHeight });
  }, [lines]);

  const visibleLines = lines.length > MAX_RENDERED_TRANSCRIPT_LINES
    ? lines.slice(lines.length - MAX_RENDERED_TRANSCRIPT_LINES)
    : lines;

  return (
    <aside
      aria-label="Live transcript"
      className="flex h-48 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-muted/30 xl:h-auto xl:min-h-0 xl:border-r xl:border-b-0"
    >
      <div className="border-b border-border px-4 py-2.5 text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Transcript
      </div>
      <div ref={containerRef} data-testid="coach-transcript" className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {visibleLines.length === 0 ? (
          <p className="text-xs text-muted-foreground">Waiting for the call to start talking…</p>
        ) : null}
        {visibleLines.map((line) => (
          <p
            key={line.id}
            data-testid="transcript-line"
            data-final={line.isFinal}
            className={cn(
              "text-sm leading-snug",
              line.speaker === "rep" ? "text-foreground" : "text-primary",
              !line.isFinal && "text-muted-foreground italic",
            )}
          >
            <span
              data-testid="transcript-speaker-label"
              className={cn(
                "mr-1.5 text-[10px] font-bold tracking-wide uppercase",
                // Two-tone speaker labels (mock parity): rep in the same
                // emerald accent used for resolved tokens/Live pill
                // elsewhere in this view, seller in the amber already
                // measured safe for coach-nudge-label. Reused, not invented
                // — see coach-live-contrast.spec.ts for both measurements
                // against this transcript's actual bg-muted/30 background.
                line.speaker === "rep" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300",
              )}
            >
              {line.speaker === "rep" ? "Rep" : "Seller"}
            </span>
            {line.text}
          </p>
        ))}
      </div>
    </aside>
  );
}

function ScriptPanel({
  block,
  nextBlock,
  degraded,
  contextLoad,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onRetryContext,
  onEditEntry,
  isEntryTokenEditable,
  onBeginEntryEdit,
  onSelectVariant,
}: {
  block: CoachSectionScriptBlock | null;
  nextBlock: CoachSectionScriptBlock | null;
  degraded: boolean;
  contextLoad: ContextLoadState;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onRetryContext: () => void;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  isEntryTokenEditable: (token: CoachEntryToken) => boolean;
  onBeginEntryEdit: () => void;
  onSelectVariant: (tag: string, key: string) => void;
}) {
  if (!block) {
    // Only reachable for a genuinely unknown/corrupt phase id slipping past
    // event validation — not for a load-in-progress or failed context,
    // which resolve against an all-placeholder context instead. A spinner
    // here would imply something is still loading, which is false: nothing
    // will ever resolve this. Say so plainly instead of wedging silently.
    return (
      <main className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-semibold text-destructive">This script section isn&apos;t recognized.</p>
          <p className="mt-1 text-xs text-muted-foreground">Use the phase rail above to return to a known section.</p>
        </div>
      </main>
    );
  }
  const nextSpokenLine = nextBlock ? selectSpokenLine(nextBlock.branches[0] ?? null) : null;
  return (
    <main
      className="min-h-[28rem] flex-1 overflow-y-auto border-b border-border px-4 py-5 md:px-8 xl:min-h-0 xl:border-r xl:border-b-0"
      data-testid="coach-script-panel"
    >
      <div className="mx-auto flex min-h-full max-w-4xl flex-col py-2">
        {contextLoad.status === "error" ? (
          <div
            role="alert"
            data-testid="coach-context-error"
            className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <span>Couldn&apos;t load lead details — showing the script with placeholders.</span>
            <Button type="button" variant="outline" size="xs" data-testid="coach-context-retry" onClick={onRetryContext}>
              Retry
            </Button>
          </div>
        ) : null}
        {degraded ? (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="coach-degraded-note">
            Live transcript is reconnecting. Keep following the current script — your place is saved.
          </p>
        ) : null}
        <section
          aria-label={`Current script — ${block.title}`}
          data-testid="current-script-card"
          className="rounded-2xl border border-border border-l-4 border-l-primary bg-card px-5 py-5 shadow-sm md:px-8 md:py-7"
        >
          <div className="mb-1 text-[11px] font-extrabold tracking-[0.14em] text-primary uppercase">Current script</div>
          <h2 className="text-xl font-bold" data-testid="current-section-title">{block.title}</h2>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="current-phase-purpose">
            <span className="font-semibold text-foreground">Purpose:</span> {block.purpose}
          </p>
          <div className="mt-5 divide-y divide-border/70" data-testid="current-section-script">
            {block.branches.map((branch) => (
              <BranchCard
                key={branch.tag}
                branch={branch}
                compact
                onEditEntry={onEditEntry}
                isEntryTokenEditable={isEntryTokenEditable}
                onBeginEntryEdit={onBeginEntryEdit}
                onSelectVariant={(key) => onSelectVariant(branch.tag, key)}
              />
            ))}
          </div>
        </section>
        {nextBlock ? (
          <section className="mx-2 mt-4 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3" data-testid="next-section-preview">
            <div className="text-[10px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
              Up next · {nextBlock.phaseName}
            </div>
            <h3 className="mt-1 text-sm font-semibold">{nextBlock.title}</h3>
            {nextSpokenLine ? (
              <p data-testid="next-section-preview-body" className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                {nextSpokenLine.segments
                  .map((segment) => (segment.kind === "tone" ? "" : segment.kind === "text" ? segment.value : segment.resolved.value))
                  .join("")}
              </p>
            ) : null}
          </section>
        ) : null}
        <div className="sticky bottom-0 mt-auto flex items-center justify-between gap-3 bg-background/95 pt-5 pb-1 backdrop-blur" data-testid="section-navigation">
          <Button type="button" variant="outline" disabled={!canGoPrevious} onClick={onPrevious} data-testid="coach-back">
            <ChevronLeftIcon className="size-4" aria-hidden />
            Back
          </Button>
          <Button type="button" disabled={!canGoNext} onClick={onNext} data-testid="coach-next">
            Next
            <ChevronRightIcon className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </main>
  );
}

function RecommendationsPanel({
  followUpQuestions,
  loadingMode,
  error,
  followUpLimitReached,
  hasFinalSellerTranscript,
  requestFollowUp,
}: ReturnType<typeof useCoachRecommendations> & { hasFinalSellerTranscript: boolean }) {
  const followUpBusy = loadingMode === "follow_up";
  const retryableError = Boolean(error && error !== "rate_limited" && error !== "busy");
  const failureMessage =
    error === "rate_limited"
      ? "The follow-up question limit for this call has been reached."
      : error === "busy"
        ? "Sandra is already preparing follow-up questions."
        : error
          ? "Follow-up questions are temporarily unavailable. Your script and transcript are unaffected."
          : null;
  return (
    <aside
      aria-label="Follow-up questions"
      data-testid="coach-recommendations"
      className="min-h-64 shrink-0 bg-muted/20 px-4 py-5 md:px-6 xl:min-h-0 xl:overflow-y-auto"
    >
      <div className="text-[11px] font-extrabold tracking-[0.14em] text-primary uppercase">Follow-up questions</div>
      <h2 className="mt-1 text-lg font-bold">Choose what to ask next</h2>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Ask Sandra for three transcript-grounded questions after the homeowner has shared a meaningful response. Nothing runs until you choose this button.
      </p>
      <Button
        type="button"
        variant="outline"
        className="mt-5 w-full"
        disabled={followUpBusy || !hasFinalSellerTranscript || followUpLimitReached}
        aria-busy={followUpBusy}
        data-testid="follow-up-questions"
        onClick={() => void requestFollowUp()}
      >
        {loadingMode === "follow_up" ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null}
        {followUpBusy
          ? "Preparing follow-up questions…"
          : retryableError
            ? "Retry Follow-up Questions"
            : "Follow-up Questions"}
      </Button>
      {!hasFinalSellerTranscript ? (
        <p className="mt-2 text-xs text-muted-foreground">Available after the homeowner has spoken.</p>
      ) : null}
      {followUpQuestions.length > 0 ? (
        <ol className="mt-4 space-y-2" data-testid="follow-up-question-options">
          {followUpQuestions.map((question) => (
            <li key={question} className="rounded-lg border border-border bg-card px-3 py-2 text-sm leading-relaxed">
              {question}
            </li>
          ))}
        </ol>
      ) : null}
      {failureMessage ? (
        <p role="alert" className="mt-3 text-xs text-muted-foreground" data-testid="recommendation-error">
          {failureMessage}
        </p>
      ) : null}
    </aside>
  );
}

function BranchCard({
  branch,
  compact = false,
  onEditEntry,
  isEntryTokenEditable,
  onBeginEntryEdit,
  onSelectVariant,
}: {
  branch: ScriptBranchBlock;
  compact?: boolean;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  isEntryTokenEditable: (token: CoachEntryToken) => boolean;
  onBeginEntryEdit: () => void;
  onSelectVariant: (key: string) => void;
}) {
  return (
    <div
      data-testid="script-branch"
      className={cn(
        "py-4 first:pt-0 last:pb-0",
        branch.critical && "my-3 rounded-xl bg-primary/5 px-3 first:mt-0 last:mb-0",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">{branch.tag}</span>
          {branch.autoSelected ? (
            <Badge variant="outline" className="text-[10px]">
              auto
            </Badge>
          ) : null}
        </div>
        {branch.variantOptions.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${branch.tag} variant`}>
            {branch.variantOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={option.key === branch.selected.key}
                data-testid={`variant-${branch.tag}-${option.key}`}
                onClick={() => onSelectVariant(option.key)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                  option.key === branch.selected.key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label ?? option.key}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {branch.selected.tone ? (
        <div className="mb-2">
          <ToneChip text={branch.selected.tone} />
        </div>
      ) : null}
      <div className="space-y-2">
        {branch.selected.lines.map((line, index) => (
          <p
            key={index}
            className={cn(
              "whitespace-pre-line",
              compact ? "text-[15px] leading-relaxed" : "text-2xl leading-relaxed font-medium md:text-[26px]",
              line.type === "note" && "text-xs text-muted-foreground italic",
            )}
          >
            <LineSegments
              segments={line.segments}
              onEditEntry={onEditEntry}
              isEntryTokenEditable={isEntryTokenEditable}
              onBeginEntryEdit={onBeginEntryEdit}
            />
          </p>
        ))}
      </div>
      {branch.trailingNote ? (
        <p className="mt-2 text-xs text-muted-foreground italic">
          {branch.trailingNote.map((segment, index) =>
            segment.kind === "text" ? (
              <span key={index}>{segment.value}</span>
            ) : segment.kind === "tone" ? (
              <ToneChip key={index} text={segment.label} />
            ) : (
              <TokenChip
                key={index}
                token={segment.token}
                resolved={segment.resolved}
                onEditEntry={onEditEntry}
                isEntryTokenEditable={isEntryTokenEditable}
                onBeginEntryEdit={onBeginEntryEdit}
              />
            ),
          )}
        </p>
      ) : null}
      {branch.holdAfter ? (
        <div className="mt-3 rounded-lg bg-muted px-3 py-1.5 text-center text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
          {branch.holdAfter}
        </div>
      ) : null}
    </div>
  );
}

/** Shared segment renderer for a single script line — text runs, inline
 * tone chips, and token chips (including the editable entry-token pills).
 * Used by both the trimmed "current line" in the Say This card and the
 * full-detail BranchCard inside the script expander, so the two never
 * drift out of sync on how a line's segments render. */
function LineSegments({
  segments,
  onEditEntry,
  isEntryTokenEditable,
  onBeginEntryEdit,
}: {
  segments: DisplayTextSegment[];
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  isEntryTokenEditable: (token: CoachEntryToken) => boolean;
  onBeginEntryEdit: () => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.value}</span>;
        if (segment.kind === "tone") return <ToneChip key={index} text={segment.label} />;
        return (
          <TokenChip
            key={index}
            token={segment.token}
            resolved={segment.resolved}
            onEditEntry={onEditEntry}
            isEntryTokenEditable={isEntryTokenEditable}
            onBeginEntryEdit={onBeginEntryEdit}
          />
        );
      })}
    </>
  );
}

function ToneChip({ text }: { text: string }) {
  return (
    <span
      data-testid="tone-chip"
      className="inline-flex items-center rounded-full border border-amber-300/60 bg-amber-400/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300"
    >
      {text}
    </span>
  );
}

function TokenChip({
  token,
  resolved,
  onEditEntry,
  isEntryTokenEditable,
  onBeginEntryEdit,
}: {
  token: CoachToken;
  resolved: ResolvedToken;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  isEntryTokenEditable: (token: CoachEntryToken) => boolean;
  onBeginEntryEdit: () => void;
}) {
  if (ENTRY_TOKEN_SET.has(token) && isEntryTokenEditable(token as CoachEntryToken)) {
    return (
      <EntryTokenChip
        token={token as CoachEntryToken}
        resolved={resolved}
        onBeginEdit={onBeginEntryEdit}
        onCommit={(value) => onEditEntry(token as CoachEntryToken, value)}
      />
    );
  }
  if (resolved.isPlaceholder) {
    return (
      <span
        data-testid="token-placeholder"
        className="mx-0.5 inline-flex items-center rounded-full border border-dashed border-muted-foreground/40 bg-muted px-1.5 py-0 text-[11px] text-muted-foreground"
      >
        missing
      </span>
    );
  }
  return (
    <span data-testid="token-resolved" className="font-bold text-emerald-700 dark:text-emerald-400">
      {resolved.value}
    </span>
  );
}

function EntryTokenChip({
  token,
  resolved,
  onBeginEdit,
  onCommit,
}: {
  token: CoachEntryToken;
  resolved: ResolvedToken;
  onBeginEdit: () => void;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(resolved.isPlaceholder ? "" : resolved.value);

  if (editing) {
    return (
      <input
        autoFocus
        data-coach-entry-editor
        data-testid={`entry-input-${token}`}
        aria-label={ENTRY_TOKEN_LABEL[token]}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onCommit(draft);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(draft);
            setEditing(false);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setEditing(false);
          }
        }}
        className="mx-0.5 inline-block w-28 rounded border border-primary bg-background px-1.5 py-0 text-[12px] outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      data-testid={`entry-chip-${token}`}
      onClick={() => {
        onBeginEdit();
        setDraft(resolved.isPlaceholder ? "" : resolved.value);
        setEditing(true);
      }}
      className={cn(
        "mx-0.5 inline-flex items-center rounded-full border px-1.5 py-0 text-[11px] font-semibold",
        resolved.isPlaceholder
          ? "border-dashed border-primary/50 text-primary"
          : "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
      )}
    >
      {resolved.isPlaceholder ? `+ ${ENTRY_TOKEN_LABEL[token]}` : resolved.value}
    </button>
  );
}

function CallControlDock({
  callName,
  callStatus,
  muted,
  held,
  holdPending,
  onDigit,
  onMute,
  onHold,
  onHangup,
  onCollapse,
  keypadOpen,
  onKeypadOpenChange,
}: {
  callName: string;
  callStatus: CoachCallStatus;
  muted: boolean;
  held: boolean;
  holdPending: boolean;
  onDigit: (digit: DtmfDigit) => void;
  onMute: () => void;
  onHold: () => void;
  onHangup: () => void;
  onCollapse: () => void;
  keypadOpen: boolean;
  onKeypadOpenChange: (open: boolean) => void;
}) {
  const live = callStatus === "live";

  // Parity with the classic popover's LiveView (softphone-provider.tsx),
  // which has had this since before the coach view existed. Guards against
  // the one interaction the popover never had to consider: this dialog has
  // a real Base UI focus trap AND a free-text entry-token editor
  // (EntryTokenChip) inside it. Typing "210000" into the offer-price field
  // must never also dial touch-tones into the live call — so, unlike the
  // popover, this listener bails whenever the keydown's target is an
  // editable field, not just whenever the keypad happens to be closed.
  useEffect(() => {
    if (!keypadOpen || held || callStatus !== "live") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!/^[0-9*#]$/.test(event.key) || event.repeat) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      // An entry editor can remain mounted while pointer focus moves to the
      // keypad. Treat the mounted editor as the source of truth instead of
      // trusting only the key event's newly moved target.
      if (document.querySelector("[data-coach-entry-editor]")) return;
      event.preventDefault();
      onDigit(event.key as DtmfDigit);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [callStatus, held, keypadOpen, onDigit]);

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-card px-4 py-3">
      {keypadOpen ? <PhoneKeypad onDigit={onDigit} disabled={held || holdPending || !live} /> : null}
      <div
        data-testid="coach-call-dock-row"
        className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Collapse to popover"
            data-testid="coach-collapse"
            onClick={onCollapse}
          >
            <XIcon className="size-4" aria-hidden />
            Collapse
          </Button>
          <div className="truncate text-sm font-bold">{callName}</div>
        </div>
        <div data-testid="coach-call-controls" className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <Button
            type="button"
            variant={muted ? "default" : "outline"}
            size="sm"
            aria-pressed={muted}
            disabled={callStatus !== "live"}
            data-testid="coach-mute"
            onClick={onMute}
          >
            {muted ? <MicOffIcon className="size-4" aria-hidden /> : <MicIcon className="size-4" aria-hidden />}
            {muted ? "Unmute" : "Mute"}
          </Button>
          <Button
            type="button"
            variant={keypadOpen ? "default" : "outline"}
            size="sm"
            aria-expanded={keypadOpen}
            disabled={held || holdPending || !live}
            data-testid="coach-keypad-toggle"
            onClick={() => onKeypadOpenChange(!keypadOpen)}
          >
            Keypad
          </Button>
          <Button
            type="button"
            variant={held ? "default" : "outline"}
            size="sm"
            aria-pressed={held}
            disabled={holdPending || callStatus !== "live"}
            data-testid="coach-hold"
            onClick={onHold}
          >
            {held ? <PlayIcon className="size-4" aria-hidden /> : <PauseIcon className="size-4" aria-hidden />}
            {held ? "Resume" : "Hold"}
          </Button>
          <Button type="button" variant="destructive" size="sm" data-testid="coach-hangup" onClick={onHangup}>
            <PhoneOffIcon className="size-4" aria-hidden />
            Hang up
          </Button>
        </div>
      </div>
    </div>
  );
}
