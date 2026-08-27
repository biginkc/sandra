"use client";

import { Loader2Icon, MicIcon, MicOffIcon, PauseIcon, PhoneOffIcon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PhoneKeypad } from "@/components/softphone/phone-keypad";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { DtmfDigit } from "@/lib/dialer/transport";
import {
  buildPhaseScriptBlock,
  CLOSR_SCRIPT,
  getScriptObjection,
  getScriptPhase,
  nextPhaseId,
  resolveObjectionOvercome,
  type BranchSelectContext,
  type PhaseScriptBlock,
  type ScriptBranchBlock,
} from "@/lib/coach/script-block";
import { resolveCoachTokens, resolveDisplayText } from "@/lib/coach/token-resolver";
import type {
  CoachCallContext,
  CoachEntryToken,
  CoachHoldTimer,
  CoachNudge,
  CoachObjectionCard,
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

export type CoachCallStatus = "connecting" | "ringing" | "live" | "ended" | "failed" | null;

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
  /** Shrinks back to the classic call popover — Esc does the same. The
   * popover surfaces an "Open live coach" button to reverse this. The
   * coach session itself (transcript, phase, gates, cards, entered
   * values) lives in the provider and is unaffected by this. */
  onCollapse: () => void;
};

const EMPTY_CALL_CONTEXT: CoachCallContext = {
  sellerName: null,
  propertyAddress: null,
  propertyCounty: null,
  repName: null,
  repPhoneE164: null,
  motivation: null,
  leadId: null,
  sellerPhoneE164: null,
  coldCallerName: null,
  yearBuilt: null,
  leadSource: null,
  occupancy: null,
};

const ENTRY_TOKEN_SET: ReadonlySet<string> = new Set(COACH_ENTRY_TOKENS);

const ENTRY_TOKEN_LABEL: Record<CoachEntryToken, string> = {
  closing_date: "closing date",
  offer_price: "offer price",
  net_to_seller: "net to seller",
};

const MAX_RENDERED_TRANSCRIPT_LINES = 200;

function timerText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CoachLiveView(props: CoachLiveViewProps) {
  const { session, callName, callStatus, seconds, muted, held, holdPending, onDigit, onMute, onHold, onHangup, onCollapse } = props;
  const {
    state,
    dispatch,
    degraded,
    reconnectGap,
    dismissReconnectGap,
    scriptOutOfSync,
    contextLoad,
    retryContext,
    branchOverrides,
    selectVariant,
    setEntryField,
  } = session;
  const [keypadOpen, setKeypadOpen] = useState(false);

  // The script must always render, even mid-load or after a failed context
  // fetch — a static, all-placeholder script is still useful, and never an
  // infinite spinner.
  const activeContext = contextLoad.status === "ready" ? contextLoad.context : EMPTY_CALL_CONTEXT;
  const tokens: ResolvedTokens = useMemo(
    () => resolveCoachTokens(activeContext, state.entryFields),
    [activeContext, state.entryFields],
  );
  const selectCtx: BranchSelectContext = useMemo(
    () => ({ leadSource: activeContext.leadSource, occupancy: activeContext.occupancy }),
    [activeContext.leadSource, activeContext.occupancy],
  );

  const displayedPhaseId = state.overriddenPhaseId ?? state.currentPhaseId;
  const scriptBlock = buildPhaseScriptBlock(displayedPhaseId, tokens, selectCtx, branchOverrides);
  const upcomingId = nextPhaseId(displayedPhaseId);
  const nextBlock = upcomingId ? buildPhaseScriptBlock(upcomingId, tokens, selectCtx, branchOverrides) : null;
  const gateEntries = (scriptBlock?.gates ?? []).map((gate) => ({
    ...gate,
    cleared: state.gates[gate.id] ?? false,
  }));
  const latestObjection = state.objectionCards.at(-1);
  const hasActionableGuidance = latestObjection
    ? isActionableObjection(latestObjection, activeContext.occupancy)
    : state.nudges.length > 0;
  const showGuidance = !degraded && hasActionableGuidance;

  const onEditEntry = useCallback(
    (field: CoachEntryToken, value: string) => setEntryField(field, value),
    [setEntryField],
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
        currentPhaseId={state.currentPhaseId}
        displayedPhaseId={displayedPhaseId}
        onSelectPhase={(phaseId) => {
          // Local display jump only — logged for now, not sent to the server.
          console.info("[coach] manual phase override", { phaseId });
          dispatch({ type: "override_phase", phaseId });
        }}
        counter={scriptBlock?.counter ?? null}
        probeCount={state.probeCount}
        holdTimer={state.holdTimer}
        gates={gateEntries}
        degraded={degraded}
        callStatus={callStatus}
        seconds={seconds}
        held={held}
      />
      {scriptOutOfSync ? (
        <div
          role="alert"
          data-testid="coach-version-mismatch"
          className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
        >
          <span>
            Coach out of sync — the live coach is running script {scriptOutOfSync}, this view is on {CLOSR_SCRIPT.version}.
            Script lines below may not match what the coach is tracking.
          </span>
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
      <div className="flex min-h-0 flex-1">
        <TranscriptFeed lines={state.transcript} />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="coach-focus-stage">
          <GuidanceOverlay
            nudges={state.nudges}
            cards={state.objectionCards}
            tokens={tokens}
            occupancy={activeContext.occupancy}
            visible={!degraded}
            onDismissNudge={(nudgeId) => dispatch({ type: "dismiss_nudge", nudgeId })}
            onDismissObjection={(cardId) => dispatch({ type: "dismiss_objection", cardId })}
          />
          <ScriptPanel
            block={scriptBlock}
            nextBlock={nextBlock}
            degraded={degraded}
            suppressed={showGuidance}
            contextLoad={contextLoad}
            onRetryContext={retryContext}
            onEditEntry={onEditEntry}
            onBeginEntryEdit={() => setKeypadOpen(false)}
            onSelectVariant={onSelectVariant}
          />
        </div>
      </div>
      <GuidanceAnnouncer
        nudges={state.nudges}
        cards={state.objectionCards}
        tokens={tokens}
        occupancy={activeContext.occupancy}
      />
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

function resolvedTextForAnnouncement(text: string, tokens: ResolvedTokens): string {
  return resolveDisplayText(text, tokens)
    .map((segment) => {
      if (segment.kind === "text") return segment.value;
      if (segment.kind === "tone") return segment.label;
      return segment.resolved.value;
    })
    .join("");
}

/** Stays mounted before the first event so assistive technology observes
 * each nudge/card being inserted into an existing live region. */
function GuidanceAnnouncer({
  nudges,
  cards,
  tokens,
  occupancy,
}: {
  nudges: CoachNudge[];
  cards: CoachObjectionCard[];
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
}) {
  return (
    <div
      // role="alert" (not "status"): this is time-sensitive coaching, not a
      // routine status update, and its implicit aria-live="assertive"
      // matches that. Also keeps it a DISTINCT role from the softphone
      // toast's role="status" — the two are visually and semantically
      // different surfaces and must never collide under the same
      // accessible-role query.
      role="alert"
      aria-atomic="false"
      aria-relevant="additions text"
      data-testid="coach-guidance-announcer"
      className="sr-only"
    >
      {nudges.map((nudge) => (
        <span key={nudge.id}>{`Coach nudge: ${nudge.text}`}</span>
      ))}
      {cards.map((card) => {
        const objection = getScriptObjection(card.objectionId);
        const overcome = objection ? resolveObjectionOvercome(objection, occupancy) : null;
        if (!objection || !overcome) {
          return <span key={card.id}>New objection detected. Continue following the live script.</span>;
        }
        return (
          <span key={card.id}>
            {`New objection guidance. Acknowledge: ${resolvedTextForAnnouncement(objection.display.acknowledge, tokens)} Disarm: ${resolvedTextForAnnouncement(objection.display.disarm, tokens)} Overcome: ${resolvedTextForAnnouncement(overcome, tokens)}`}
          </span>
        );
      })}
    </div>
  );
}

function CoachTopBar({
  currentPhaseId,
  displayedPhaseId,
  onSelectPhase,
  counter,
  probeCount,
  holdTimer,
  gates,
  degraded,
  callStatus,
  seconds,
  held,
}: {
  currentPhaseId: CoachPhaseId;
  displayedPhaseId: CoachPhaseId;
  onSelectPhase: (phaseId: CoachPhaseId) => void;
  counter: { label: string; goal: number } | null;
  probeCount: number;
  holdTimer: CoachHoldTimer | null;
  gates: { id: string; display: string; cleared: boolean }[];
  degraded: boolean;
  callStatus: CoachCallStatus;
  seconds: number;
  held: boolean;
}) {
  const preConnectLabel = callStatus === "connecting" ? "Connecting…" : callStatus === "ringing" ? "Ringing…" : null;
  const timerLabel = held ? "On hold" : preConnectLabel ?? timerText(seconds);
  const currentPhaseIndex = COACH_PHASE_ORDER.indexOf(currentPhaseId);
  const currentPhaseName = getScriptPhase(currentPhaseId)?.name ?? currentPhaseId;
  const displayedPhaseName = getScriptPhase(displayedPhaseId)?.name ?? displayedPhaseId;
  return (
    <div className="shrink-0 border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs" data-testid="coach-status-strip">
        <Badge variant="secondary" data-testid="coach-current-phase" className="h-5 text-[10px]">
          {`Phase · ${currentPhaseName}`}
        </Badge>
        {displayedPhaseId !== currentPhaseId ? (
          <Badge variant="outline" data-testid="coach-viewing-phase" className="h-5 text-[10px]">
            {`Viewing · ${displayedPhaseName}`}
          </Badge>
        ) : null}
        {counter ? (
          <Badge variant="secondary" data-testid="probe-counter" className="h-5 text-[10px]">
            {`Probes ${probeCount}/${counter.goal}`}
          </Badge>
        ) : null}
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
            Coach connecting…
          </Badge>
        ) : null}
        {holdTimer ? <HoldTimerChip timer={holdTimer} /> : null}
        {gates.map((gate) => (
          <Badge
            key={gate.id}
            data-testid={`gate-${gate.id}`}
            variant={gate.cleared ? "secondary" : "destructive"}
            className="h-5 text-[10px]"
          >
            {gate.cleared ? "Concerns cleared" : gate.display}
          </Badge>
        ))}
      </div>
      <ol className="flex min-w-0 items-center gap-1 overflow-x-auto px-4 pb-2" aria-label="Call phases" data-testid="coach-phase-scroller">
        {COACH_PHASE_ORDER.map((phaseId) => {
          const phase = getScriptPhase(phaseId);
          const isCurrent = phaseId === currentPhaseId;
          const isDisplayed = phaseId === displayedPhaseId;
          const isComplete = COACH_PHASE_ORDER.indexOf(phaseId) < currentPhaseIndex;
          return (
            <li key={phaseId}>
              <button
                type="button"
                data-testid={`phase-rail-${phaseId}`}
                aria-current={isDisplayed ? "step" : undefined}
                onClick={() => onSelectPhase(phaseId)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide whitespace-nowrap uppercase transition-colors",
                  isDisplayed
                    ? "bg-primary text-primary-foreground"
                    : isComplete
                      ? "text-emerald-700 dark:text-emerald-400"
                      : isCurrent
                        ? "bg-emerald-600 text-white"
                        : "text-muted-foreground hover:bg-muted",
                )}
              >
                {phase?.name ?? phaseId}
                {isComplete ? " ✓" : ""}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function HoldTimerChip({ timer }: { timer: CoachHoldTimer }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - new Date(timer.startedAt).getTime()) / 1000));
  const remaining = Math.max(0, timer.durationS - elapsed);
  return (
    <Badge variant={remaining <= 30 ? "destructive" : "outline"} data-testid="hold-timer" className="h-5 text-[10px]">
      {`Hold ${timerText(remaining)}`}
    </Badge>
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
      className="hidden w-full max-w-xs shrink-0 flex-col overflow-hidden border-r border-border bg-muted/30 md:flex"
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
            <span className="mr-1.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
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
  suppressed,
  contextLoad,
  onRetryContext,
  onEditEntry,
  onBeginEntryEdit,
  onSelectVariant,
}: {
  block: PhaseScriptBlock | null;
  nextBlock: PhaseScriptBlock | null;
  degraded: boolean;
  suppressed: boolean;
  contextLoad: ContextLoadState;
  onRetryContext: () => void;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
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
      <main hidden={suppressed} className="flex flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="max-w-sm text-center">
          <Loader2Icon className="mx-auto mb-3 size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-semibold text-destructive">This call phase isn&apos;t recognized.</p>
          <p className="mt-1 text-xs text-muted-foreground">Use the phase rail above to jump to a known phase.</p>
        </div>
      </main>
    );
  }
  return (
    <main
      hidden={suppressed}
      className="flex-1 overflow-y-auto px-5 py-6 md:px-10 md:py-8"
      data-testid="coach-script-panel"
    >
      <div className={cn("mx-auto flex min-h-full max-w-4xl flex-col py-3", degraded ? "justify-start" : "justify-center")}>
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
          <p className="mb-4 text-xs text-muted-foreground" data-testid="coach-degraded-note">
            Live coaching hasn&apos;t connected yet — here&apos;s the full script, scroll manually.
          </p>
        ) : null}
        <section
          aria-label={`Say this — ${block.phaseName}`}
          data-testid="say-this-card"
          className="rounded-2xl border border-border border-l-4 border-l-primary bg-card px-5 py-5 shadow-sm md:px-8 md:py-7"
        >
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-extrabold tracking-[0.14em] text-primary uppercase">Say this</div>
              <div className="mt-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">{block.phaseName}</div>
            </div>
            {block.openingCues.length > 0 ? (
              <div className="flex flex-wrap justify-end gap-1.5">
                {block.openingCues.map((cue, index) => (
                  <ToneChip key={index} text={cue} />
                ))}
              </div>
            ) : null}
          </div>
          <p className="mb-3 text-sm text-muted-foreground italic">{block.purpose}</p>
          {degraded ? (
            <div className="divide-y divide-border/70" data-testid="full-phase-script">
              {block.branches.map((branch) => (
                <BranchCard
                  key={branch.tag}
                  branch={branch}
                  compact
                  onEditEntry={onEditEntry}
                  onBeginEntryEdit={onBeginEntryEdit}
                  onSelectVariant={(key) => onSelectVariant(branch.tag, key)}
                />
              ))}
            </div>
          ) : block.branches[0] ? (
            <BranchCard
              branch={block.branches[0]}
              onEditEntry={onEditEntry}
              onBeginEntryEdit={onBeginEntryEdit}
              onSelectVariant={(key) => onSelectVariant(block.branches[0].tag, key)}
            />
          ) : null}
          {!degraded && block.branches.length > 1 ? (
            <details data-testid="full-phase-script" className="mt-5 border-t border-border/70 pt-4 text-muted-foreground">
              <summary className="cursor-pointer text-xs font-bold tracking-wide uppercase">
                {`Full ${block.phaseName} script · ${block.branches.length - 1} more ${block.branches.length === 2 ? "section" : "sections"}`}
              </summary>
              <div className="mt-3 divide-y divide-border/70">
                {block.branches.slice(1).map((branch) => (
                  <BranchCard
                    key={branch.tag}
                    branch={branch}
                    compact
                    onEditEntry={onEditEntry}
                    onBeginEntryEdit={onBeginEntryEdit}
                    onSelectVariant={(key) => onSelectVariant(branch.tag, key)}
                  />
                ))}
              </div>
            </details>
          ) : null}
          {block.situationalCues.length > 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-border p-3">
              <div className="mb-1.5 text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
                If this happens…
              </div>
              <ul className="space-y-1">
                {block.situationalCues.map((cue) => (
                  <li key={cue.trigger} className="text-xs text-muted-foreground">
                    {cue.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
        {nextBlock ? (
          <div className="px-6 pt-5 opacity-45" data-testid="next-phase-preview">
            <div className="mb-1 text-[10px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
              Coming next · {nextBlock.phaseName}
            </div>
            <p className="text-base leading-relaxed">
              {nextBlock.branches[0]?.selected.lines[0]?.segments
                .map((segment) => (segment.kind === "tone" ? "" : segment.kind === "text" ? segment.value : segment.resolved.value))
                .join("")}
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function BranchCard({
  branch,
  compact = false,
  onEditEntry,
  onBeginEntryEdit,
  onSelectVariant,
}: {
  branch: ScriptBranchBlock;
  compact?: boolean;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
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
              compact ? "text-[15px] leading-relaxed" : "text-2xl leading-relaxed font-medium md:text-[26px]",
              line.type === "note" && "text-xs text-muted-foreground italic",
            )}
          >
            {line.segments.map((segment, segIndex) => {
              if (segment.kind === "text") return <span key={segIndex}>{segment.value}</span>;
              if (segment.kind === "tone") return <ToneChip key={segIndex} text={segment.label} />;
              return (
                <TokenChip
                  key={segIndex}
                  token={segment.token}
                  resolved={segment.resolved}
                  onEditEntry={onEditEntry}
                  onBeginEntryEdit={onBeginEntryEdit}
                />
              );
            })}
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
  onBeginEntryEdit,
}: {
  token: CoachToken;
  resolved: ResolvedToken;
  onEditEntry: (field: CoachEntryToken, value: string) => void;
  onBeginEntryEdit: () => void;
}) {
  if (ENTRY_TOKEN_SET.has(token)) {
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

function GuidanceOverlay({
  nudges,
  cards,
  tokens,
  occupancy,
  visible = true,
  onDismissNudge,
  onDismissObjection,
}: {
  nudges: CoachNudge[];
  cards: CoachObjectionCard[];
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
  visible?: boolean;
  onDismissNudge: (nudgeId: string) => void;
  onDismissObjection: (cardId: string) => void;
}) {
  if (nudges.length === 0 && cards.length === 0) return null;
  // Objections are the most specific live-call intervention, so the newest
  // objection wins. With no objection, the newest coaching nudge wins. Every
  // non-dominant item remains MOUNTED (only visually hidden): each owns an
  // absolute-expiry timer effect, and unmounting a queued item would freeze
  // that timer and let stale guidance resurface later.
  const latestObjection = cards.at(-1);
  const activeObjectionId = visible && latestObjection && isActionableObjection(latestObjection, occupancy)
    ? latestObjection.id
    : null;
  const activeNudgeId = visible && !latestObjection ? (nudges.at(-1)?.id ?? null) : null;
  const hasVisibleGuidance = activeObjectionId !== null || activeNudgeId !== null;

  if (!hasVisibleGuidance) {
    return (
      <div hidden aria-hidden="true" data-testid="coach-guidance-timers">
        <ObjectionOverlay
          cards={cards}
          activeCardId={null}
          tokens={tokens}
          occupancy={occupancy}
          onDismiss={onDismissObjection}
        />
        <NudgeOverlay nudges={nudges} activeNudgeId={null} onDismiss={onDismissNudge} />
      </div>
    );
  }
  return (
    <section
      data-testid="coach-guidance-stack"
      aria-label="Active coaching guidance"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-10 md:py-8"
    >
      <div className="mx-auto flex min-h-full max-w-4xl items-center py-3">
        <div className="w-full">
          <ObjectionOverlay
            cards={cards}
            activeCardId={activeObjectionId}
            tokens={tokens}
            occupancy={occupancy}
            onDismiss={onDismissObjection}
          />
          <NudgeOverlay nudges={nudges} activeNudgeId={activeNudgeId} onDismiss={onDismissNudge} />
        </div>
      </div>
    </section>
  );
}

function isActionableObjection(card: CoachObjectionCard, occupancy: CoachCallContext["occupancy"]): boolean {
  const objection = getScriptObjection(card.objectionId);
  return objection !== undefined && resolveObjectionOvercome(objection, occupancy) !== null;
}

function NudgeOverlay({
  nudges,
  activeNudgeId,
  onDismiss,
}: {
  nudges: CoachNudge[];
  activeNudgeId: string | null;
  onDismiss: (nudgeId: string) => void;
}) {
  if (nudges.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {nudges.map((nudge) => (
        <NudgeCard
          key={nudge.id}
          nudge={nudge}
          active={nudge.id === activeNudgeId}
          onDismiss={() => onDismiss(nudge.id)}
        />
      ))}
    </div>
  );
}

/** Owns its own auto-dismiss timer, scoped to this nudge's mount lifetime —
 * a sibling nudge appearing or disappearing never resets or cancels it
 * (same pattern as ObjectionCard). The timer's duration is computed from
 * `nudge.expiresAt` (set once, at insert time, in event-reducer.ts) rather
 * than a fixed TTL, so a remount — collapsing and reopening the coach view
 * unmounts every card — picks up the correctly-shrunk remaining time
 * instead of restarting the full duration. */
function NudgeCard({ nudge, active, onDismiss }: { nudge: CoachNudge; active: boolean; onDismiss: () => void }) {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const remaining = Math.max(0, nudge.expiresAt - Date.now());
    const timer = setTimeout(() => onDismissRef.current(), remaining);
    return () => clearTimeout(timer);
    // Intentionally mount-once — same pattern as ObjectionCard. expiresAt
    // itself never changes after insert, so there's nothing to re-derive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      data-testid="coach-nudge"
      data-active={active}
      hidden={!active}
      onClick={onDismiss}
      className="animate-in slide-in-from-left-4 w-full rounded-2xl border border-amber-300/60 border-l-4 border-l-amber-500 bg-card px-5 py-5 text-left shadow-sm md:px-8 md:py-7"
    >
      <span className="block text-[11px] font-extrabold tracking-[0.14em] text-amber-700 uppercase dark:text-amber-300">
        Coach nudge
      </span>
      <span className="mt-3 block text-2xl leading-relaxed font-semibold text-foreground">{nudge.text}</span>
      <span className="mt-5 block text-xs text-muted-foreground">Tap to dismiss and return to the script.</span>
    </button>
  );
}

function ObjectionOverlay({
  cards,
  activeCardId,
  tokens,
  occupancy,
  onDismiss,
}: {
  cards: CoachObjectionCard[];
  activeCardId: string | null;
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
  onDismiss: (cardId: string) => void;
}) {
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {cards.map((card) => (
        <ObjectionCard
          key={card.id}
          card={card}
          active={card.id === activeCardId}
          tokens={tokens}
          occupancy={occupancy}
          onDismiss={() => onDismiss(card.id)}
        />
      ))}
    </div>
  );
}

function ObjectionLine({ label, text, tokens }: { label: string; text: string; tokens: ResolvedTokens }) {
  const segments = resolveDisplayText(text, tokens);
  return (
    <p>
      <span className="font-bold">{label} — </span>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.value}</span>;
        if (segment.kind === "tone") return <ToneChip key={index} text={segment.label} />;
        // Objection text never contains the 3 rep-entry tokens today, but
        // fall back to plain-value rendering (no inline editor here) if
        // the script ever adds one — the card is transient, not the right
        // place to capture a deal value.
        return (
          <span key={index} data-testid="token-resolved" className="font-bold text-emerald-700 dark:text-emerald-400">
            {segment.resolved.value}
          </span>
        );
      })}
    </p>
  );
}

/** Owns its own auto-dismiss timer, scoped to this card's mount lifetime —
 * a sibling card appearing or disappearing never resets or cancels it. The
 * timer's duration is computed from `card.expiresAt` (set once, at insert
 * time, in event-reducer.ts) rather than a fixed TTL, so a remount —
 * collapsing and reopening the coach view unmounts every card — picks up
 * the correctly-shrunk remaining time instead of restarting the full 45s. */
function ObjectionCard({
  card,
  active,
  tokens,
  occupancy,
  onDismiss,
}: {
  card: CoachObjectionCard;
  active: boolean;
  tokens: ResolvedTokens;
  occupancy: CoachCallContext["occupancy"];
  onDismiss: () => void;
}) {
  const onDismissRef = useRef(onDismiss);
  // Keeps the ref current after every render — refs must not be written
  // during render itself, only in an effect or event handler.
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    const remaining = Math.max(0, card.expiresAt - Date.now());
    const timer = setTimeout(() => onDismissRef.current(), remaining);
    return () => clearTimeout(timer);
    // Intentionally mount-once: this card's lifetime timer must not be
    // rearmed or cleared by anything other than its own unmount/dismiss.
    // expiresAt never changes after insert, so there's nothing to re-derive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const objection = getScriptObjection(card.objectionId);
  const overcomeText = objection ? resolveObjectionOvercome(objection, occupancy) : null;
  return (
    <button
      type="button"
      data-testid="objection-card"
      data-active={active}
      hidden={!active}
      onClick={onDismiss}
      className="animate-in slide-in-from-right-4 w-full rounded-2xl border border-border border-l-4 border-l-primary bg-card px-5 py-5 text-left shadow-sm md:px-8 md:py-7"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="text-[11px] font-extrabold tracking-[0.14em] text-primary uppercase">Handle this objection</span>
        {objection?.display.tonality ? <ToneChip text={objection.display.tonality} /> : null}
      </div>
      {objection && overcomeText ? (
        <div className="space-y-3 text-base leading-relaxed md:text-lg">
          <ObjectionLine label="Acknowledge" text={objection.display.acknowledge} tokens={tokens} />
          <ObjectionLine label="Disarm" text={objection.display.disarm} tokens={tokens} />
          <ObjectionLine label="Overcome" text={overcomeText} tokens={tokens} />
          {objection.display.template ? (
            <p className="rounded-lg border border-dashed border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              {objection.display.template_note ?? "Live worked example — substitute the seller's real numbers."}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Keep following the live script while coaching refreshes.</p>
      )}
      <span className="mt-5 block text-xs text-muted-foreground">Tap to dismiss and return to the script.</span>
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
      // Guidance can hide the script and move focus to the dialog between
      // offer-entry keystrokes. The editor itself remains mounted under the
      // hidden script panel so its draft and blur/commit lifecycle survive;
      // use that mounted editor as the source of truth instead of trusting
      // only the key event's newly-moved target.
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
