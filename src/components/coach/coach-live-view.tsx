"use client";

import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PhoneKeypad } from "@/components/softphone/phone-keypad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { DtmfDigit } from "@/lib/dialer/transport";
import { COACH_SECTIONS } from "@/lib/coach/section-manifest";
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
  CoachHoldTimer,
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
import { HoldTimer } from "./hold-timer";

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
    sectionBranchSelections,
    selectSectionBranch,
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
    const block = buildCoachSectionScriptBlock(
      activeSectionId,
      tokens,
      selectCtx,
      branchOverrides,
      sectionBranchSelections[activeSectionId] ?? null,
    );
    return {
      scriptBlock: block,
      selectedVariants: Object.fromEntries(
        (block?.branches ?? []).map((branch) => [branch.tag, branch.selected.key]),
      ),
    };
  }, [activeSectionId, branchOverrides, sectionBranchSelections, selectCtx, tokens]);
  const nextBlock = useMemo(
    () => nextSectionId
      ? buildCoachSectionScriptBlock(
        nextSectionId,
        tokens,
        selectCtx,
        branchOverrides,
        sectionBranchSelections[nextSectionId] ?? null,
      )
      : null,
    [branchOverrides, nextSectionId, sectionBranchSelections, selectCtx, tokens],
  );
  const activePhaseId = scriptBlock?.phaseId ?? "introduction";
  const recommendations = useCoachRecommendations({
    callId: session.callId,
    activeSectionId,
    selectedSectionBranch: scriptBlock?.selectedBranchTag ?? null,
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
        callName={callName}
        activePhaseId={activePhaseId}
        onSelectPhase={goToPhase}
        degraded={degraded}
        callStatus={callStatus}
        seconds={seconds}
        held={held}
        holdTimer={held ? state.holdTimer : null}
        fileNumber={tokens.file_number}
      />
      {callStatus === "audio_reconnecting" || callStatus === "audio_reconnect_required" ? (
        <div role="alert" data-testid="coach-audio-reconnect-warning" className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--coach-amber)] bg-card px-4 py-2 text-xs font-semibold text-[var(--coach-amber-text)]">
          <span>{callStatus === "audio_reconnecting" ? "Call live · reconnecting browser audio…" : "Call live · audio interrupted"}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onReconnectAudio ? (
              <button
                type="button"
                data-testid="coach-reconnect-audio"
                onClick={onReconnectAudio}
                disabled={callStatus === "audio_reconnecting"}
                className="rounded-md border border-[var(--coach-amber)] bg-card px-3 py-1.5 font-bold disabled:cursor-wait disabled:opacity-60"
              >
                Reconnect Audio
              </button>
            ) : null}
            <button
              type="button"
              data-testid="coach-warning-hangup"
              onClick={onHangup}
              className="rounded-md border border-destructive bg-destructive px-3 py-1.5 font-bold text-white"
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
          className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--coach-amber)] bg-card px-4 py-1.5 text-xs text-[var(--coach-amber-text)]"
        >
          <span>Reconnected — some coach events may have been missed while disconnected.</span>
          <button type="button" data-testid="dismiss-reconnect-gap" onClick={dismissReconnectGap} className="font-bold underline">
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto xl:grid xl:grid-cols-[380px_minmax(0,1fr)_320px] xl:overflow-hidden">
        <TranscriptFeed lines={state.transcript} degraded={degraded} />
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
          onSelectSectionBranch={selectSectionBranch}
        />
        <RecommendationsPanel
          {...recommendations}
          hasFinalSellerTranscript={state.transcript.some((line) => line.isFinal && line.speaker === "seller")}
        />
      </div>
      <CallControlDock
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
  callName,
  activePhaseId,
  onSelectPhase,
  degraded,
  callStatus,
  seconds,
  held,
  holdTimer,
  fileNumber,
}: {
  callName: string;
  activePhaseId: CoachPhaseId;
  onSelectPhase: (phaseId: CoachPhaseId) => void;
  degraded: boolean;
  callStatus: CoachCallStatus;
  seconds: number;
  held: boolean;
  holdTimer: CoachHoldTimer | null;
  fileNumber: ResolvedToken;
}) {
  const preConnectLabel = callStatus === "connecting" ? "Connecting…" : callStatus === "ringing" ? "Ringing…" : null;
  const timerLabel = held ? "On hold" : preConnectLabel ?? timerText(seconds);
  const currentPhaseIndex = COACH_PHASE_ORDER.indexOf(activePhaseId);
  const currentPhaseName = getScriptPhase(activePhaseId)?.name ?? activePhaseId;
  return (
    <div className="coach-top-bar shrink-0 border-b border-border">
      <div className="coach-identity">
        <span className="truncate text-[15px] font-extrabold">{callName}</span>
        <span data-testid="coach-file-number" aria-label="File number" className="font-mono text-xs tabular-nums">
          {`File number: ${fileNumber.value}`}
        </span>
      </div>
      <div className="coach-status" data-testid="coach-status-strip">
        <HoldTimer timer={holdTimer} />
        {preConnectLabel ? (
          <Badge variant="outline" data-testid="call-status-pill" className="h-5 text-[10px] text-muted-foreground">
            {preConnectLabel}
          </Badge>
        ) : null}
        {callStatus === "live" && !held ? (
          <Badge variant="outline" data-testid="coach-live-pill" className="h-5 gap-1 text-[11px]">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--coach-sky)]" aria-hidden />
            Live
          </Badge>
        ) : null}
        {degraded ? (
          <Badge variant="outline" data-testid="coach-connecting-pill" className="h-5 text-[10px] text-muted-foreground">
            Transcript connecting…
          </Badge>
        ) : null}
        <span className="font-mono text-base font-semibold tabular-nums" data-testid="coach-call-timer">{timerLabel}</span>
      </div>
      <ol className="flex min-w-0 items-center gap-1 overflow-x-auto px-4 pb-2" aria-label="Call phases" data-testid="coach-phase-scroller">
        {COACH_PHASE_ORDER.map((phaseId) => {
          const phase = getScriptPhase(phaseId);
          const fullName = phase?.name ?? phaseId;
          const isCurrent = phaseId === activePhaseId;
          const isComplete = COACH_PHASE_ORDER.indexOf(phaseId) < currentPhaseIndex;
          const suffix = isComplete ? " ✓" : "";
          return (
            <li key={phaseId} className="flex shrink-0 items-center">
              {isCurrent ? <span className="sr-only" data-testid="coach-current-phase">{`Phase · ${currentPhaseName}`}</span> : null}
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
                      ? "text-[var(--coach-sky)]"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {isComplete ? <span className="coach-phase-tick" aria-hidden>✓</span> : null}
                <span>{RAIL_LABEL[phaseId] ?? fullName}</span>
              </button>
              {phaseId !== COACH_PHASE_ORDER.at(-1) ? <span className={cn("coach-phase-connector", isComplete && "is-complete")} aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TranscriptFeed({ lines, degraded }: { lines: CoachTranscriptLine[]; degraded: boolean }) {
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
      className="flex h-48 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-[var(--coach-rail)] xl:h-auto xl:min-h-0 xl:border-r xl:border-b-0"
    >
      <div className="flex items-center justify-between px-5 pt-4 pb-2.5 text-[11px] font-extrabold tracking-[0.12em] text-muted-foreground uppercase">
        Transcript
        {!degraded ? <span className="text-[var(--coach-sky)] normal-case tracking-normal">● listening</span> : null}
      </div>
      <div ref={containerRef} data-testid="coach-transcript" className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pt-1.5 pb-3.5">
        {visibleLines.length === 0 ? (
          <p className="text-xs text-muted-foreground">Waiting for the call to start talking…</p>
        ) : null}
        {visibleLines.map((line) => (
          <p
            key={line.id}
            data-testid="transcript-line"
            data-final={line.isFinal}
            data-speaker={line.speaker}
            className={cn(
              "text-sm leading-snug",
              "text-foreground",
              !line.isFinal && "text-muted-foreground italic",
            )}
          >
            <span
              data-testid="transcript-speaker-label"
              className={cn(
                "mr-1.5 text-[10px] font-bold tracking-wide uppercase",
                line.speaker === "rep" ? "text-[var(--coach-sky)]" : "text-[var(--coach-amber)]",
              )}
            >
              {line.speaker === "rep" ? "Rep" : "Seller"}{!line.isFinal ? " · speaking…" : ""}
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
  onSelectSectionBranch,
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
  onSelectSectionBranch: (sectionId: CoachSectionScriptBlock["sectionId"], tag: string) => void;
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
      className="min-h-[28rem] min-w-0 flex-1 overflow-y-auto border-b border-border px-4 pt-7 md:px-8 xl:min-h-0 xl:border-b-0 xl:px-12"
      data-testid="coach-script-panel"
    >
      <div className="mx-auto flex min-h-full max-w-[820px] flex-col">
        {contextLoad.status === "error" ? (
          <div
            role="alert"
            data-testid="coach-context-error"
            className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--coach-amber)] bg-card px-3 py-2 text-xs text-[var(--coach-amber-text)]"
          >
            <span>Couldn&apos;t load lead details — showing the script with placeholders.</span>
            <Button type="button" variant="outline" size="xs" data-testid="coach-context-retry" onClick={onRetryContext}>
              Retry
            </Button>
          </div>
        ) : null}
        {degraded ? (
          <p className="mb-4 rounded-lg border border-[var(--coach-amber)] bg-card px-3 py-2 text-xs text-[var(--coach-amber-text)]" data-testid="coach-degraded-note">
            Live transcript is reconnecting. Keep following the current script — your place is saved.
          </p>
        ) : null}
        <section
          aria-label={`Current script — ${block.title}`}
          data-testid="current-script-card"
          className="min-w-0"
        >
          <h2 className="text-[11px] font-black tracking-[0.16em] text-muted-foreground uppercase">{block.phaseName} · <span data-testid="current-section-title">{block.title}</span></h2>
          <p className="sr-only" data-testid="current-phase-purpose">
            <span className="font-semibold text-foreground">Purpose:</span> {block.purpose}
          </p>
          {block.branchOptions.length > 1 ? (
            <div
              className="mt-3.5 grid grid-cols-4 gap-2"
              role="tablist"
              aria-label={`${block.title} spoken paths`}
              data-testid="section-path-options"
            >
              {block.branchOptions.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  role="tab"
                  aria-selected={tag === block.selectedBranchTag}
                  aria-label={`Use ${tag} spoken path for ${block.title}`}
                  data-testid={`section-path-${block.sectionId}-${tag}`}
                  onClick={() => onSelectSectionBranch(block.sectionId, tag)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                    tag === block.selectedBranchTag
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted",
                  )}
                >
                  {tag}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-[26px] space-y-5" data-testid="current-section-script">
            {block.branches.map((branch) => (
              <BranchCard
                key={branch.tag}
                branch={branch}
                onEditEntry={onEditEntry}
                isEntryTokenEditable={isEntryTokenEditable}
                onBeginEntryEdit={onBeginEntryEdit}
                onSelectVariant={(key) => onSelectVariant(branch.tag, key)}
              />
            ))}
          </div>
        </section>
        {nextBlock ? (
          <section className="mt-7 border-t border-border pt-[18px] pb-5" data-testid="next-section-preview">
            <div className="text-[11px] font-black tracking-[0.14em] text-[var(--coach-sky)] uppercase">
              Up next · {nextBlock.phaseName} — {nextBlock.title}
            </div>
            {nextSpokenLine ? (
              <p data-testid="next-section-preview-body" className="mt-2 line-clamp-2 text-[17px] leading-[1.5] text-[var(--coach-secondary)]">
                “{nextSpokenLine.segments
                  .map((segment) => (segment.kind === "tone" ? "" : segment.kind === "text" ? segment.value : segment.resolved.value))
                  .join("")}”
              </p>
            ) : null}
          </section>
        ) : null}
        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-4 pb-5" data-testid="section-navigation">
          <Button type="button" variant="outline" disabled={!canGoPrevious} onClick={onPrevious} data-testid="coach-back">
            <ChevronLeftIcon className="size-4" aria-hidden />
            Back
          </Button>
          <span className="font-mono text-xs text-muted-foreground">Section {COACH_SECTIONS.findIndex((section) => section.id === block.sectionId) + 1} of {COACH_SECTIONS.length}</span>
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
  recommendations,
  followUpQuestions,
  loadingMode,
  error,
  automaticLimitReached,
  followUpLimitReached,
  hasFinalSellerTranscript,
  requestFollowUp,
}: ReturnType<typeof useCoachRecommendations> & { hasFinalSellerTranscript: boolean }) {
  const followUpBusy = loadingMode === "follow_up";
  const failureMessage =
    error === "rate_limited"
      ? "The recommendation limit for this call has been reached."
      : error === "busy"
        ? "Sandra is already preparing a recommendation."
        : error
          ? "Recommendations are temporarily unavailable. Your script and transcript are unaffected."
          : null;
  return (
    <aside
      aria-label="Live recommendations"
      data-testid="coach-recommendations"
      className="min-h-64 shrink-0 border-l border-border bg-[var(--coach-rail)] p-4 xl:min-h-0 xl:overflow-y-auto"
    >
      <h2 className="text-[11px] font-extrabold tracking-[0.12em] text-muted-foreground uppercase">Coach</h2>
      {recommendations.length === 0 && followUpQuestions.length === 0 ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Sandra is listening for a meaningful homeowner response. Suggestions will appear here without changing your place in the script.
        </p>
      ) : null}
      {recommendations.length > 0 ? (
        <div className="mt-5" data-testid="automatic-recommendations">
          <ul className="mt-2 space-y-2">
            {recommendations.map((recommendation) => (
              <li key={recommendation} className="rounded-lg border border-border bg-card px-3 py-2 text-sm leading-relaxed">
                <div className="mb-1 text-[10px] font-extrabold tracking-[0.1em] text-muted-foreground uppercase">Consider saying</div>
                {recommendation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="mt-5 w-full"
        disabled={followUpBusy || !hasFinalSellerTranscript || followUpLimitReached}
        data-testid="follow-up-questions"
        onClick={() => void requestFollowUp()}
      >
        {loadingMode === "follow_up" ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null}
        Follow-up Questions
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
      {loadingMode === "automatic" ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground" data-testid="automatic-recommendations-loading">
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
          Preparing suggestions…
        </p>
      ) : null}
      {automaticLimitReached ? (
        <p className="mt-3 text-xs text-muted-foreground">Automatic suggestions have reached their limit for this call.</p>
      ) : null}
      {failureMessage ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground" data-testid="recommendation-error">
          {failureMessage}
        </p>
      ) : null}
    </aside>
  );
}

function BranchCard({
  branch,
  onEditEntry,
  isEntryTokenEditable,
  onBeginEntryEdit,
  onSelectVariant,
}: {
  branch: ScriptBranchBlock;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  isEntryTokenEditable: (token: CoachEntryToken) => boolean;
  onBeginEntryEdit: () => void;
  onSelectVariant: (key: string) => void;
}) {
  return (
    <div
      data-testid="script-branch"
      className="space-y-5"
    >
      {branch.variantOptions.length > 1 ? (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label={`${branch.tag} variant`}>
            {branch.variantOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={option.key === branch.selected.key}
                aria-label={`Use ${option.label ?? option.key} spoken fork for ${branch.tag}`}
                data-testid={`variant-${branch.tag}-${option.key}`}
                onClick={() => onSelectVariant(option.key)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-bold",
                  option.key === branch.selected.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {option.label ?? option.key}
              </button>
            ))}
          </div>
      ) : null}
      {branch.selected.tone ? (
        <div className="mb-2">
          <ToneChip text={branch.selected.tone} />
        </div>
      ) : null}
      <div className="space-y-5">
        {branch.selected.lines.map((line, index) => (
          <p
            key={index}
            className={cn(
              "whitespace-pre-line",
              line.type === "note"
                ? "text-[13px] text-[var(--coach-secondary)] italic"
                : "text-[27px] leading-[1.5] font-medium",
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
        <p className="mt-2 text-[13px] text-[var(--coach-secondary)] italic">
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
      className="inline-flex items-center rounded-full border-0 bg-[var(--coach-amber)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--coach-rail)]"
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
        className="mx-0.5 inline-flex items-center rounded-full border border-dashed border-border bg-transparent px-1.5 py-0 text-[11px] text-muted-foreground"
      >
        missing<span className="sr-only">{resolved.value}</span>
      </span>
    );
  }
  return (
    <span data-testid="token-resolved" className="font-bold text-[var(--coach-sky)]">
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
          ? "border-dashed border-[var(--coach-sky)] text-[var(--coach-sky)]"
          : "border-[var(--coach-sky)] text-[var(--coach-sky)]",
      )}
    >
      {resolved.isPlaceholder ? `+ ${ENTRY_TOKEN_LABEL[token]}` : resolved.value}
    </button>
  );
}

function CallControlDock({
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
    <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-[var(--coach-rail)] px-6 py-3">
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
